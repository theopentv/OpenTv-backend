import { Buffer } from 'node:buffer';
import type { Env } from '@/env';
import { getKey } from '@/jwks';
import { verifyClaims, type IdTokenPayload, type Provider } from '@/pure';

/**
 * Apple / Google ID-token verification.
 *
 * Split deliberately (docs/IMPLEMENTATION.md §1b): the crypto is here, the
 * claim rules are `verifyClaims` in `pure.ts` where they are unit-tested.
 */

export type VerifiedToken = {
  sub: string;
  email: string | null;
  /** The provider's own claim that it has verified this address. Carried
   *  through because account LINKING turns on it — see `resolveProfile`. */
  emailVerified: boolean;
};
export type VerifyResult = { ok: true; token: VerifiedToken } | { ok: false; reason: string };

/** base64url → bytes. `nodejs_compat` is on; this is what it is on for. */
function decodeSegment(segment: string): Uint8Array {
  return new Uint8Array(Buffer.from(segment, 'base64url'));
}

function parseJson(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Apple: the bundle id. Google: every configured client id, comma-separated. */
function audiencesFor(env: Env, provider: Provider): string[] {
  if (provider === 'apple') return [env.APPLE_BUNDLE_ID ?? ''].filter((a) => a.length > 0);
  return (env.GOOGLE_CLIENT_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export async function verifyIdToken(
  env: Env,
  provider: Provider,
  token: string,
  nowMs: number,
  /** The browser sign-in on `/authorize`: its own client as the audience, and
   *  the nonce it sent, so a token minted for anything else is refused. */
  web?: { audience: string; nonce: string },
): Promise<VerifyResult> {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [h, p, s] = parts as [string, string, string];

  const header = parseJson(decodeSegment(h));
  if (!header) return { ok: false, reason: 'malformed_header' };

  // BEFORE anything else. `alg: none` and every HS variant are rejected here,
  // where the attacker's own header is the only thing that has been read.
  if (header.alg !== 'RS256') return { ok: false, reason: 'bad_alg' };
  if (typeof header.kid !== 'string' || header.kid.length === 0) {
    return { ok: false, reason: 'missing_kid' };
  }

  const key = await getKey(env, provider, header.kid);
  if (!key) return { ok: false, reason: 'unknown_kid' };

  const signature = decodeSegment(s);
  const signed = new TextEncoder().encode(`${h}.${p}`);
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, signed);
  if (!valid) return { ok: false, reason: 'bad_signature' };

  const payload = parseJson(decodeSegment(p));
  if (!payload) return { ok: false, reason: 'malformed_payload' };

  const audiences = web ? [web.audience] : audiencesFor(env, provider);
  const claims = verifyClaims(payload as IdTokenPayload, { provider, audiences }, nowMs);
  if (!claims.ok) return { ok: false, reason: claims.reason };
  if (web && (payload as { nonce?: unknown }).nonce !== web.nonce) return { ok: false, reason: 'bad_nonce' };

  return { ok: true, token: { sub: claims.sub, email: claims.email, emailVerified: claims.emailVerified } };
}
