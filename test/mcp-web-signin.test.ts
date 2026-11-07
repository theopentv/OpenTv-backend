import { getOAuthApi } from '@cloudflare/workers-oauth-provider';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@/env';
import worker from '@/index';
import { oauthOptions } from '@/mcp/oauth-options';
import { fakeBucket, freshDatabase, insertProfile, kv, makeEnv } from './harness';

// The provider's signature is not what is under test here: the trip, the
// nonce, the account lookup and the Allow step are.
const verify = vi.hoisted(() => vi.fn());
vi.mock('@/auth', async (orig) => ({ ...(await orig<typeof import('@/auth')>()), verifyIdToken: verify }));

const ORIGIN = 'https://api.opentv.test';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

async function send(env: Env, method: string, path: string, init: { form?: Record<string, string>; cookie?: string } = {}) {
  const headers = new Headers();
  if (init.cookie) headers.set('Cookie', init.cookie);
  let body: string | undefined;
  if (init.form) {
    headers.set('Content-Type', 'application/x-www-form-urlencoded');
    body = new URLSearchParams(init.form).toString();
  }
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`, { method, headers, body }), env, {
    waitUntil() {},
    passThroughOnException() {},
  } as unknown as ExecutionContext);
  return { status: res.status, text: await res.text(), headers: res.headers };
}

describe('linking Claude with Google or Apple', () => {
  let env: Env;
  let clientId: string;

  beforeEach(async () => {
    verify.mockReset();
    const fresh = freshDatabase();
    env = { ...makeEnv(fresh.db, undefined, fakeBucket()), OAUTH_KV: kv(), MCP_ORIGIN: ORIGIN, GOOGLE_WEB_CLIENT_ID: 'web-client' };
    const noop = { fetch: () => new Response(null) };
    env.OAUTH_PROVIDER = getOAuthApi(oauthOptions(ORIGIN, { apiHandler: noop, defaultHandler: noop }), env);
    insertProfile(fresh.raw, 'p1', 'amanda');
    fresh.raw.prepare('UPDATE profiles SET is_plus = 1 WHERE id = ?').run('p1');
    fresh.raw
      .prepare('INSERT INTO identities (provider, external_id, profile_id, email, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('google', 'g-sub-1', 'p1', 'amanda@example.com', new Date().toISOString());
    clientId = (await env.OAUTH_PROVIDER.createClient({ redirectUris: [REDIRECT], clientName: 'Claude', tokenEndpointAuthMethod: 'none' })).clientId;
  });

  async function open() {
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT,
      scope: 'mcp:read',
      state: 'st4te',
      code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      code_challenge_method: 'S256',
      resource: `${ORIGIN}/mcp`,
    });
    const res = await send(env, 'GET', `/authorize?${q}`);
    const handle = /name="handle" value="([^"]+)"/.exec(res.text)![1]!;
    const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    return { res, handle, cookie };
  }

  /** Out to Google: the state and nonce it was sent with. */
  async function leave(handle: string) {
    const out = await send(env, 'GET', `/authorize/google?handle=${encodeURIComponent(handle)}`);
    expect(out.status).toBe(302);
    const to = new URL(out.headers.get('Location')!);
    return { to, state: to.searchParams.get('state')!, nonce: to.searchParams.get('nonce')! };
  }

  it('shows Google only when its client is set, never Apple without a Services ID', async () => {
    const { res } = await open();
    expect(res.text).toContain('Continue with Google');
    expect(res.text).not.toContain('Continue with Apple');
    env.GOOGLE_WEB_CLIENT_ID = undefined;
    expect((await open()).res.text).not.toContain('Continue with Google');
  });

  it('sends Google our client, our callback, a state and a nonce', async () => {
    const { handle } = await open();
    const { to, state, nonce } = await leave(handle);
    expect(to.origin).toBe('https://accounts.google.com');
    expect(to.searchParams.get('client_id')).toBe('web-client');
    expect(to.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/authorize/google/callback`);
    expect(to.searchParams.get('response_mode')).toBe('form_post');
    expect(state).toHaveLength(48);
    expect(nonce).not.toBe(state);
  });

  it('a Google account linked to a member reaches Allow, and Allow links it', async () => {
    const { handle, cookie } = await open();
    const { state, nonce } = await leave(handle);
    verify.mockResolvedValue({ ok: true, token: { sub: 'g-sub-1', email: 'amanda@example.com', emailVerified: true } });
    const back = await send(env, 'POST', '/authorize/google/callback', { form: { state, id_token: 'x.y.z' } });
    expect(back.status).toBe(200);
    expect(back.text).toContain('amanda@example.com');
    // Checked against our own client and the nonce this trip carried.
    expect(verify.mock.calls[0]![4]).toEqual({ audience: 'web-client', nonce });
    const pending = /name="pending" value="([^"]+)"/.exec(back.text)![1]!;

    const ok = await send(env, 'POST', '/authorize', { form: { handle, via: 'web', pending, decision: 'approve' }, cookie });
    expect(ok.status).toBe(302);
    expect(new URL(ok.headers.get('Location')!).searchParams.get('code')).toBeTruthy();
    expect((await env.OAUTH_PROVIDER!.listUserGrants('p1')).items).toHaveLength(1);

    // The same pass cannot be used twice.
    const again = await send(env, 'POST', '/authorize', { form: { handle, via: 'web', pending, decision: 'approve' }, cookie });
    expect(again.status).not.toBe(302);
  });

  it('a Google account with no OpenTV account is told so, and nothing is made', async () => {
    const { handle } = await open();
    const { state } = await leave(handle);
    verify.mockResolvedValue({ ok: true, token: { sub: 'stranger', email: 's@example.com', emailVerified: true } });
    const back = await send(env, 'POST', '/authorize/google/callback', { form: { state, id_token: 'x.y.z' } });
    expect(back.status).toBe(404);
    expect(back.text).toContain('No OpenTV account uses this Google account');
    expect(back.text).not.toContain('name="pending"');
  });

  it('a state is single use, and a bad token is refused', async () => {
    const { handle } = await open();
    const { state } = await leave(handle);
    verify.mockResolvedValue({ ok: false, reason: 'bad_nonce' });
    expect((await send(env, 'POST', '/authorize/google/callback', { form: { state, id_token: 'x.y.z' } })).status).toBe(400);
    expect((await send(env, 'POST', '/authorize/google/callback', { form: { state, id_token: 'x.y.z' } })).text).toContain('expired');
  });

  it('a pass made for one page does not approve another', async () => {
    const first = await open();
    const { state } = await leave(first.handle);
    verify.mockResolvedValue({ ok: true, token: { sub: 'g-sub-1', email: null, emailVerified: false } });
    const pending = /name="pending" value="([^"]+)"/.exec((await send(env, 'POST', '/authorize/google/callback', { form: { state, id_token: 'x.y.z' } })).text)![1]!;
    const other = await open();
    const res = await send(env, 'POST', '/authorize', { form: { handle: other.handle, via: 'web', pending, decision: 'approve' }, cookie: other.cookie });
    expect(res.status).not.toBe(302);
  });
});
