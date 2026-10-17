import { Hono } from 'hono';
import type { App, Env } from '@/env';
import { fail } from '@/http';
import { constantTimeEqual } from '@/pure';
import { requireAuth } from '@/middleware';

/**
 * The RevenueCat webhook — the only thing on this server that may grant Plus.
 *
 * WHY A WEBHOOK AT ALL. The phone knows whether it has an entitlement, but the
 * phone is not a source this server can believe: if the client could set the
 * flag, Plus would be free within a week (docs/PLAN.md). RevenueCat talks to
 * Apple and Google, and this route is the one place its answer lands.
 *
 * WHAT IS STORED: one bit and one date. `is_plus`, and `plus_since` the first
 * time it was granted. Not the product, not the store, not the price, not the
 * receipt, not the period — none of it is needed to draw a badge or lift a cap,
 * and a table of what everybody pays is exactly the kind of thing this server
 * exists not to keep. Nothing here is logged beyond the event type; the body
 * carries amounts and country codes, and those must not reach the log.
 *
 * ALWAYS 200 ON A SHAPE WE UNDERSTOOD. RevenueCat retries a 4xx or 5xx for
 * hours, so "this event does not concern us" and "we have never heard of this
 * profile" both answer 200 with `matched: false`. The only failures that answer
 * an error are the ones a retry could genuinely fix or must not be waved
 * through: no secret configured (503), a wrong secret (401), unreadable body
 * (400).
 */
export const rc = new Hono<App>();

/** The entitlement id configured in RevenueCat. One product, one entitlement. */
const PLUS_ENTITLEMENT = 'plus';

/**
 * RevenueCat's own id for a user who was never identified — the app was signed
 * out of the community when it bought. There is no profile to attach it to, and
 * there may never be one; the app calls `logIn()` with the profile id at
 * sign-in and RC then sends an alias/TRANSFER we can act on.
 */
const ANON_PREFIX = '$RCAnonymousID:';

type RcEvent = {
  type?: unknown;
  app_user_id?: unknown;
  original_app_user_id?: unknown;
  aliases?: unknown;
  expiration_at_ms?: unknown;
  entitlement_id?: unknown;
  entitlement_ids?: unknown;
  transferred_from?: unknown;
  transferred_to?: unknown;
};

/**
 * GRANT on the four events that mean "there is money and access right now".
 *
 * PRODUCT_CHANGE is here because a plan switch (monthly → yearly) is not a
 * lapse; UNCANCELLATION because turning auto-renew back on is the opposite of
 * leaving.
 */
const GRANTS = new Set(['INITIAL_PURCHASE', 'RENEWAL', 'UNCANCELLATION', 'PRODUCT_CHANGE', 'NON_RENEWING_PURCHASE', 'SUBSCRIPTION_EXTENDED']);

/**
 * REVOKE ON EXPIRATION AND NOTHING ELSE, and this is the decision most easily
 * got wrong.
 *
 * CANCELLATION in RevenueCat means auto-renew was switched off — the person has
 * paid for a period they are still inside, and taking Plus away the moment they
 * cancel bills them for a month they cannot use. RC sends EXPIRATION when that
 * period actually ends, which is the event that means access ended.
 *
 * BILLING_ISSUE is a failed charge, not a lapse: the stores retry through a
 * grace period and the great majority recover. If it does not recover,
 * EXPIRATION follows and this route acts then. Being late to revoke costs a few
 * days of a feature; being early takes away something somebody paid for.
 */
const REVOKES = new Set(['EXPIRATION']);

/** True when the event names the entitlement this server sells. */
function namesPlus(ev: RcEvent): boolean {
  if (Array.isArray(ev.entitlement_ids)) return ev.entitlement_ids.includes(PLUS_ENTITLEMENT);
  return ev.entitlement_id === PLUS_ENTITLEMENT;
}

/** True when the value names at least one anonymous RevenueCat id. */
function hasAnonymous(value: unknown): boolean {
  const raw = Array.isArray(value) ? value : [value];
  return raw.some((v) => typeof v === 'string' && v.startsWith(ANON_PREFIX));
}

/** Profile ids only: an anonymous RC id, or anything that is not a string, is not one. */
function profileIds(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : [value];
  return raw.filter((v): v is string => typeof v === 'string' && v.length > 0 && !v.startsWith(ANON_PREFIX));
}

/**
 * `plus_since` is set only when it is still null — the FIRST grant. A renewal
 * must not move it, or "member since" would read as today, every month.
 * Idempotent by construction: running the same event twice writes the same row.
 */
/** The thank-you's two versions; the community one names what they can now share. */
export function plusThanks(name: string | null, community: boolean): { subject: string; text: string } {
  const hi = name ? `Hi ${name},` : 'Hi there,';
  const joinLine = community
    ? ''
    : '\n\nIf you ever want to, you can also join the OpenTV community from Settings — rate episodes, comment and find the friends you had on TV Time. It is entirely optional.';
  return {
    subject: 'Thank you for getting OpenTV Plus',
    text:
      `${hi}\n\n` +
      'Thank you for getting OpenTV Plus. It means a lot for an app one person builds, and it is what keeps OpenTV free of ads and private for everyone.\n\n' +
      "Your Plus is on: Cloud Backup, Sync between your devices, themes, GIF banners and the rest. If anything ever says you need Plus, just reply to this email and I'll sort it out straight away." +
      joinLine +
      "\n\nI'd also love to know what made you get Plus. Was it Backup and Sync, the themes, or something else? It helps me decide what to build next.\n\n— Noddy",
  };
}

/**
 * THANK A NEW SUBSCRIBER, ONCE. Sent the first time a profile becomes a paying
 * one by any route (webhook, a claimed anonymous purchase, the daily check) —
 * never for a hand-given month, which is `plus_until`, not `is_plus`.
 * `plus_thanked_at` is stamped BEFORE sending, so a retry can never send twice;
 * a send that fails is simply not retried. From info@ so a reply reaches a
 * person. The address is the one they signed up with, or the one Apple or
 * Google shared (Apple's private relay forwards).
 */
async function thankNewSubscriber(env: Env, profileId: string): Promise<void> {
  if (!env.EMAIL) return;
  const nowIso = new Date().toISOString();
  const claim = await env.DB.prepare(
    'UPDATE profiles SET plus_thanked_at = ? WHERE id = ? AND is_plus = 1 AND plus_thanked_at IS NULL AND deleted_at IS NULL',
  )
    .bind(nowIso, profileId)
    .run();
  if (claim.meta.changes === 0) return;
  const who = await env.DB.prepare(
    `SELECT p.handle, p.display_name,
            COALESCE((SELECT c.email FROM email_credentials c WHERE c.profile_id = p.id AND c.verified_at IS NOT NULL),
                     (SELECT i.email FROM identities i WHERE i.profile_id = p.id AND i.email IS NOT NULL LIMIT 1)) AS email
       FROM profiles p WHERE p.id = ?`,
  )
    .bind(profileId)
    .first<{ handle: string; display_name: string | null; email: string | null }>();
  if (!who?.email) return;
  const community = !who.handle.startsWith('user_p_');
  const name = who.display_name && !who.display_name.startsWith('user_p_') ? who.display_name : null;
  const { subject, text } = plusThanks(name, community);
  const html = '<div>' + text.split('\n\n').map((p) => `<p>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>`).join('') + '</div>';
  try {
    await env.EMAIL.send({ to: who.email, from: { email: 'info@theopentv.com', name: 'Noddy — OpenTV' }, subject, text, html });
    console.log('[rc] thanked a new subscriber');
  } catch {
    console.log('[rc] thank-you failed');
  }
}

export async function setPlus(env: Env, profileId: string, on: boolean, nowIso: string): Promise<boolean> {
  const res = on
    ? await env.DB.prepare(
        `UPDATE profiles SET is_plus = 1, plus_since = COALESCE(plus_since, ?)
          WHERE id = ? AND deleted_at IS NULL`,
      )
        .bind(nowIso, profileId)
        .run()
    : await env.DB.prepare('UPDATE profiles SET is_plus = 0 WHERE id = ? AND deleted_at IS NULL')
        .bind(profileId)
        .run();
  if (on && res.meta.changes > 0) await thankNewSubscriber(env, profileId);
  return res.meta.changes > 0;
}

/** The store's own end date, kept for gifting after it (`plus_expires_at`). */
export async function notePlusExpiry(env: Env, profileId: string, expiresIso: string | null): Promise<void> {
  if (!expiresIso) return;
  await env.DB.prepare('UPDATE profiles SET plus_expires_at = ? WHERE id = ? AND deleted_at IS NULL').bind(expiresIso, profileId).run();
}

rc.post('/rc/webhook', async (c) => {
  // NO SECRET CONFIGURED MEANS NO WEBHOOK, the same rule the admin door
  // follows: an unset secret must refuse everything rather than accept
  // everything, which is what comparing against undefined would quietly do.
  const expected = c.env.RC_WEBHOOK_SECRET;
  if (!expected) return fail(c, 503, 'unavailable', 'No webhook secret is configured.');

  // RevenueCat has no signatures — it sends back the literal string configured
  // in its dashboard. Compared constant-time all the same: this header is the
  // only thing between a stranger and free Plus for every account.
  if (!constantTimeEqual(c.req.header('Authorization') ?? '', expected)) {
    return fail(c, 401, 'unauthenticated', 'Bad webhook secret.');
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const ev = (((body ?? {}) as Record<string, unknown>).event ?? {}) as RcEvent;
  const type = typeof ev.type === 'string' ? ev.type : '';
  // The type, and only the type. The body around it carries price, currency,
  // country and store — none of that goes anywhere near the log.
  console.log(`[rc] ${type || 'unknown'}`);

  const nowIso = new Date().toISOString();

  // ── TRANSFER: the subscription moved between two accounts ─────────────────
  //
  // The flag moves with it, rather than being granted afresh: if the source
  // never had Plus (an anonymous id, or an account whose subscription had
  // already lapsed) the destination gets nothing. Sources are cleared either
  // way — that side of a transfer is always a loss of access.
  if (type === 'TRANSFER') {
    const from = profileIds(ev.transferred_from);
    const to = profileIds(ev.transferred_to);
    let had = false;
    for (const id of from) {
      const row = await c.env.DB.prepare('SELECT is_plus FROM profiles WHERE id = ? AND deleted_at IS NULL')
        .bind(id)
        .first<{ is_plus: number }>();
      if (row?.is_plus === 1) had = true;
      await setPlus(c.env, id, false, nowIso);
    }
    /*
     * A PURCHASE MADE BEFORE SIGNING IN, which is the one this route used to
     * lose for ever.
     *
     * Buy while signed out and RevenueCat books it against an anonymous id.
     * INITIAL_PURCHASE then names a buyer with no profile, so it is ignored —
     * correctly, there is nothing to attach it to. Signing in later aliases
     * that id onto the profile and RC sends this TRANSFER. Reading "the source
     * never had Plus" off a row that CANNOT exist meant the destination got
     * nothing, and the person stayed unpaid-for on the server no matter how
     * long they kept paying the store. Found in production: one subscriber,
     * seventeen days of renewals, `is_plus = 0`, and every Plus account on the
     * server a hand-grant.
     *
     * Only when NO source resolved to a profile. A transfer away from a real
     * account that had lapsed still grants nothing — that source is a row we
     * can read, and the answer it gives is the truth.
     *
     * The risk is the mirror of the bug: an anonymous subscription that had
     * already expired would grant a month it should not. RevenueCat sends
     * EXPIRATION for that, and this route revokes on it — so the wrong answer
     * corrects itself, while the old wrong answer never did.
     */
    if (!had && from.length === 0 && hasAnonymous(ev.transferred_from)) had = true;
    let matched = false;
    for (const id of to) if (await setPlus(c.env, id, had, nowIso)) matched = true;
    return c.json({ ok: true, matched });
  }

  const grant = GRANTS.has(type) && namesPlus(ev);
  const revoke = REVOKES.has(type);
  // Everything else — an event type we do not act on, or one about an
  // entitlement that is not ours — is understood and ignored.
  if (!grant && !revoke) return c.json({ ok: true, matched: false });

  /*
   * WHO BOUGHT IT. The app user id first, then every other id RevenueCat knows
   * for the same customer (`original_app_user_id`, `aliases`): a purchase made
   * anonymously and aliased afterwards names the profile there.
   */
  const [profileId] = [...profileIds(ev.app_user_id), ...profileIds(ev.original_app_user_id), ...profileIds(ev.aliases)];
  if (!profileId) {
    /*
     * STILL ANONYMOUS: KEEP IT. This used to return here and forget the
     * purchase — a paying customer (3 Oct) then had no Plus on the server for
     * Cloud Backup or Sync. Remembered by its anonymous id until the phone that
     * made it signs in and names that id (`/v1/me/plus-check`).
     */
    const anon = [ev.app_user_id, ev.original_app_user_id, ...(Array.isArray(ev.aliases) ? ev.aliases : [])].filter(
      (v): v is string => typeof v === 'string' && v.startsWith(ANON_PREFIX),
    );
    const exp = typeof ev.expiration_at_ms === 'number' ? new Date(ev.expiration_at_ms).toISOString() : null;
    for (const id of new Set(anon)) {
      await c.env.DB.prepare(
        `INSERT INTO rc_anon_purchases (rc_id, active, expires_at, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (rc_id) DO UPDATE SET active = excluded.active, expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
      )
        .bind(id, grant ? 1 : 0, exp, nowIso)
        .run();
      // Already claimed by a profile: the event applies to it too.
      const claimed = await c.env.DB.prepare('SELECT claimed_by FROM rc_anon_purchases WHERE rc_id = ?').bind(id).first<{ claimed_by: string | null }>();
      if (claimed?.claimed_by) {
        await setPlus(c.env, claimed.claimed_by, grant, nowIso);
        await notePlusExpiry(c.env, claimed.claimed_by, exp);
      }
    }
    return c.json({ ok: true, matched: false, kept: anon.length > 0 });
  }

  const matched = await setPlus(c.env, profileId, grant, nowIso);
  await notePlusExpiry(c.env, profileId, typeof ev.expiration_at_ms === 'number' ? new Date(ev.expiration_at_ms).toISOString() : null);
  /*
   * SAY SO WHEN AN EVENT WE ACTED ON CHANGED NOTHING. A grant naming a profile
   * this server has never heard of is either a purchase made under an id that
   * was never aliased, or a deleted account — and it is the shape that cost a
   * real subscriber seventeen days of Plus while every dashboard read "Sent"
   * and every response read 200. The id stays out of the log, like the price
   * and the country do; the count is what makes it findable.
   */
  if (!matched) console.log(`[rc] ${type} unmatched`);
  return c.json({ ok: true, matched });
});

/**
 * Does RevenueCat itself say this profile has Plus? Null when it cannot be
 * asked (no key, network, an unknown customer) — never treated as "no".
 */
export async function rcSaysPlus(env: Env, profileId: string): Promise<boolean | null> {
  if (!env.RC_SECRET_API_KEY) return null;
  try {
    const res = await fetch(`https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(profileId)}`, {
      headers: { Authorization: `Bearer ${env.RC_SECRET_API_KEY}` },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { subscriber?: { entitlements?: Record<string, { expires_date?: string | null }> } };
    const ent = body.subscriber?.entitlements?.[PLUS_ENTITLEMENT];
    if (!ent) return false;
    await notePlusExpiry(env, profileId, ent.expires_date ?? null);
    return ent.expires_date == null || Date.parse(ent.expires_date) > Date.now();
  } catch {
    return null;
  }
}

/**
 * POST /v1/me/plus-check { rc_ids?: string[], device_plus?: boolean }
 *
 * The phone, on launch and after a purchase, saying two things:
 *
 *  - THE ANONYMOUS IDS IT HAS BOUGHT UNDER. A purchase kept in
 *    `rc_anon_purchases` is attached to this profile — once, to one profile.
 *    The ids are RevenueCat's random ones, which only the phone that made the
 *    purchase holds.
 *  - WHAT THE STORE TOLD IT (`device_plus`). Stored for the dashboard to flag a
 *    disagreement; it grants nothing on its own, because a phone can lie.
 *
 * And then, with a RevenueCat secret key configured, the server asks
 * RevenueCat itself — the safety net for anything the webhook missed.
 */
rc.post('/me/plus-check', requireAuth, async (c) => {
  let b: { rc_ids?: unknown; device_plus?: unknown };
  try {
    b = (await c.req.json()) as typeof b;
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const me = c.get('profileId');
  const nowIso = new Date().toISOString();
  if (typeof b.device_plus === 'boolean') {
    await c.env.DB.prepare('UPDATE profiles SET device_plus = ?, device_plus_at = ? WHERE id = ? AND deleted_at IS NULL')
      .bind(b.device_plus ? 1 : 0, nowIso, me)
      .run();
  }
  const ids = Array.isArray(b.rc_ids)
    ? b.rc_ids.filter((v): v is string => typeof v === 'string' && v.startsWith(ANON_PREFIX) && v.length <= 80).slice(0, 5)
    : [];
  let granted = false;
  for (const id of ids) {
    const row = await c.env.DB.prepare('SELECT active, expires_at, claimed_by FROM rc_anon_purchases WHERE rc_id = ?')
      .bind(id)
      .first<{ active: number; expires_at: string | null; claimed_by: string | null }>();
    if (!row || (row.claimed_by && row.claimed_by !== me)) continue;
    if (!row.claimed_by) await c.env.DB.prepare('UPDATE rc_anon_purchases SET claimed_by = ? WHERE rc_id = ? AND claimed_by IS NULL').bind(me, id).run();
    if (row.active === 1 && (row.expires_at == null || row.expires_at > nowIso)) granted = (await setPlus(c.env, me, true, nowIso)) || granted;
    await notePlusExpiry(c.env, me, row.expires_at);
  }
  const rcPlus = await rcSaysPlus(c.env, me);
  if (rcPlus === true) granted = (await setPlus(c.env, me, true, nowIso)) || granted;
  return c.json({ ok: true, granted, checked_with_revenuecat: rcPlus !== null });
});

/**
 * GET /v1/me/offer — this person's personal offer, while it runs.
 *
 * `{ offer: { offer_id, ends_at } }` or `{ offer: null }`. Only a signed-in
 * phone asks, and only from the paywall. Ended and used offers answer null,
 * and never come back (see the admin route). The dashboard's label stays
 * on the server.
 */
rc.get('/me/offer', requireAuth, async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT offer_id, ends_at FROM personal_offers
      WHERE profile_id = ? AND ends_at > ? AND consumed_at IS NULL
      ORDER BY ends_at LIMIT 1`,
  )
    .bind(c.get('profileId'), new Date().toISOString())
    .first<{ offer_id: string; ends_at: string }>();
  return c.json({ offer: row ?? null }, 200, { 'Cache-Control': 'no-store' });
});

/**
 * POST /v1/me/offer/used — the phone bought through it, so it is spent.
 * Trusting the phone here is safe: the only thing it can do is take its own
 * offer away.
 */
rc.post('/me/offer/used', requireAuth, async (c) => {
  await c.env.DB.prepare(
    'UPDATE personal_offers SET consumed_at = ? WHERE profile_id = ? AND consumed_at IS NULL AND ends_at > ?',
  )
    .bind(new Date().toISOString(), c.get('profileId'), new Date().toISOString())
    .run();
  return c.json({ ok: true }, 200, { 'Cache-Control': 'no-store' });
});

export type StoreExtend =
  | { ok: true; store: 'app_store' | 'play_store'; expires: string | null }
  | { ok: false; status: 400 | 409 | 502; message: string };

/**
 * GIVE A PAYING SUBSCRIBER TIME AT THE STORE, not on this server. A
 * `plus_until` gift to somebody Apple or Google is billing does nothing: the
 * store keeps charging on its own date and the gift sits inside a period they
 * already paid for. Moving the store's renewal date is the only gift that is
 * real, and it is what RevenueCat → Customers → "Extend subscription" does by
 * hand — this is the same call, so the dashboard can do it in one click.
 *
 * Apple: `/extend` by the store transaction id, 1–90 days, at most twice a year
 * per customer, and Apple emails them. Google: `/defer` by the subscription id
 * (the product id before the colon), 1–365 days, and NO webhook follows — so
 * the new end date is written here from the response instead of waiting.
 *
 * `null`: nothing to extend at a store (no key, not subscribed, a promotional
 * grant) — the caller falls back to `plus_until`.
 */
export async function rcExtend(env: Env, profileId: string, days: number): Promise<StoreExtend | null> {
  if (!env.RC_SECRET_API_KEY) return null;
  const base = `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(profileId)}`;
  const auth = { Authorization: `Bearer ${env.RC_SECRET_API_KEY}`, 'Content-Type': 'application/json' };
  type Sub = { store?: string; store_transaction_id?: string | number; expires_date?: string | null };
  type Body = { subscriber?: { entitlements?: Record<string, { expires_date?: string | null; product_identifier?: string }>; subscriptions?: Record<string, Sub> } };

  let body: Body;
  try {
    const res = await fetch(base, { headers: auth });
    if (!res.ok) return { ok: false, status: 502, message: `RevenueCat answered ${res.status} when asked about this customer.` };
    body = (await res.json()) as Body;
  } catch {
    return { ok: false, status: 502, message: 'Could not reach RevenueCat.' };
  }
  const ent = body.subscriber?.entitlements?.[PLUS_ENTITLEMENT];
  if (!ent?.product_identifier || (ent.expires_date && Date.parse(ent.expires_date) <= Date.now())) return null;
  const sub = body.subscriber?.subscriptions?.[ent.product_identifier];

  let url: string;
  let payload: Record<string, number>;
  if (sub?.store === 'app_store') {
    if (days > 90) return { ok: false, status: 400, message: 'Apple allows at most 90 days (3 months) per extension.' };
    if (sub.store_transaction_id == null) return { ok: false, status: 502, message: 'RevenueCat gave no Apple transaction id.' };
    url = `${base}/subscriptions/${encodeURIComponent(String(sub.store_transaction_id))}/extend`;
    payload = { extend_by_days: days, extend_reason_code: 1 }; // 1 = Customer Satisfaction
  } else if (sub?.store === 'play_store') {
    url = `${base}/subscriptions/${encodeURIComponent(ent.product_identifier.split(':')[0] ?? '')}/defer`;
    payload = { extend_by_days: days };
  } else {
    return null;
  }

  try {
    const res = await fetch(url, { method: 'POST', headers: auth, body: JSON.stringify(payload) });
    const text = await res.text();
    if (!res.ok) {
      // RC's own words: "two extensions a year", a billing-retry state, or a key
      // without write access — each needs a person to read it, not a retry.
      let msg = text.slice(0, 300);
      try {
        msg = (JSON.parse(text) as { message?: string }).message ?? msg;
      } catch {
        /* not JSON */
      }
      return { ok: false, status: res.status === 400 ? 409 : 502, message: `RevenueCat refused (${res.status}): ${msg}` };
    }
    const after = (JSON.parse(text) as Body).subscriber?.entitlements?.[PLUS_ENTITLEMENT]?.expires_date ?? null;
    await notePlusExpiry(env, profileId, after);
    return { ok: true, store: sub.store, expires: after };
  } catch {
    return { ok: false, status: 502, message: 'Could not reach RevenueCat.' };
  }
}
