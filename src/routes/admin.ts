import { EVENT_KEY, EVENTS, TEMPLATE_COLUMNS, templateOut, type TemplateRow } from '@/routes/links';
import { createMiddleware } from 'hono/factory';
import { Buffer } from 'node:buffer';
import { Hono } from 'hono';
import type { App, Env } from '@/env';
import { fail } from '@/http';
import { COMMSUNI_OFF_KEY } from '@/routes/commsuni';
import {
  constantTimeEqual,
  imageExtension,
  isHexColour,
  MAX_COVER_BYTES,
  nextScheduledChange,
  parseTemplateBlocks,
  resolveEvent,
  TEMPLATE_LAYOUTS,
  TEMPLATE_PERSONAS,
} from '@/pure';
import { sendMessagePush } from '@/push';
import { rcExtend } from '@/routes/rc';
import { supportOut, type SupportRow } from '@/routes/support-chat';
import { overBudget } from '@/rate-limit';

/**
 * The one page that looks at the whole server, and the smallest thing that can
 * be.
 *
 * SERVED BY THE WORKER, not Pages. The numbers live in D1 and only the Worker
 * can read them, so a page hosted anywhere else would need CORS opened on an
 * API that currently has none, and a token in browser storage where every
 * script on the page can read it. Same-origin costs one route and buys an
 * HttpOnly cookie that JavaScript cannot touch at all.
 *
 * COUNTS ONLY, DELIBERATELY. This reads how MANY comments exist, never what
 * they say; how many accounts, never whose. The rule the analytics module is
 * built on — shape, never content — is not weaker because the person looking
 * owns the server. A dashboard that lists other people's writing is a habit
 * that ends with reading it.
 *
 * NOT THE APP'S SESSION. An admin token is its own signature with its own
 * prefix, so a user token can never be replayed here and this cookie can never
 * act as a user. There is no admin flag on any profile — nothing to
 * accidentally grant.
 */
export const admin = new Hono<App>();

const COOKIE = 'otv_admin';
/** Short, because it protects a password typed into a browser on a laptop. */
const TTL_SECONDS = 12 * 60 * 60;
/** Five attempts an hour per address. A password in a form is guessable. */
const LOGIN_BUDGET = { limit: 5, windowSeconds: 3600 };

function b64url(bytes: Uint8Array | string): string {
  const buf = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : Buffer.from(bytes);
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmac(env: Env, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`admin:${env.SESSION_SECRET}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))));
}

async function issue(env: Env, nowMs: number): Promise<string> {
  const payload = b64url(JSON.stringify({ exp: Math.floor(nowMs / 1000) + TTL_SECONDS }));
  return `${payload}.${await hmac(env, payload)}`;
}

async function valid(env: Env, token: string | undefined, nowMs: number): Promise<boolean> {
  if (!token) return false;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;
  if (!constantTimeEqual(sig, await hmac(env, payload))) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as { exp: number };
    return typeof exp === 'number' && exp * 1000 > nowMs;
  } catch {
    return false;
  }
}

function cookieFrom(header: string | undefined): string | undefined {
  return header
    ?.split(';')
    .map((p) => p.trim())
    .find((p) => p.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
}

// ── POST /v1/admin/login ─────────────────────────────────────────────────────

admin.post('/admin/login', async (c) => {
  // NO PASSWORD CONFIGURED MEANS NO DOOR. An unset secret must refuse
  // everything rather than accept everything, which is what comparing against
  // undefined would quietly do.
  const expectedEmail = c.env.ADMIN_EMAIL;
  const expectedPassword = c.env.ADMIN_PASSWORD;
  if (!expectedEmail || !expectedPassword) {
    return fail(c, 503, 'unavailable', 'No administrator is configured.');
  }

  const ip = c.req.header('CF-Connecting-IP') ?? '0.0.0.0';
  if (await overBudget(c.env, 'admin', ip, LOGIN_BUDGET, Date.now())) {
    return fail(c, 429, 'rate_limited', 'Too many attempts. Try again later.');
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
  const password = typeof b.password === 'string' ? b.password : '';

  // Both compared, both constant-time, and the failure says neither which was
  // wrong nor that the address exists.
  const ok =
    constantTimeEqual(email, expectedEmail.trim().toLowerCase()) && constantTimeEqual(password, expectedPassword);
  if (!ok) return fail(c, 401, 'unauthenticated', 'Wrong email or password.');

  const token = await issue(c.env, Date.now());
  // HttpOnly: unreadable by any script on the page, so an injected one cannot
  // steal the session. SameSite=Strict: no other site can make an authenticated
  // request with it.
  c.header(
    'Set-Cookie',
    `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${TTL_SECONDS}`,
  );
  return c.json({ ok: true });
});

admin.post('/admin/logout', (c) => {
  c.header('Set-Cookie', `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`);
  return c.json({ ok: true });
});

// ── Google's test robots ─────────────────────────────────────────────────────

/*
 * THE PRE-LAUNCH REPORT SIGNS IN. Every upload to Play Console is run on
 * Google's test phones, which press "Continue with Google" with accounts shaped
 * `firstlast.12345@gmail.com` — two a release, found 29 Sep, ten of them over
 * a month, every one with nothing done. They are not people and must not count
 * as people. Both conditions, so a real member who happens to have that shape
 * of address but has ever rated or written anything is never mistaken for one.
 */
const robotSql = (a: string) => `(EXISTS (SELECT 1 FROM identities ri WHERE ri.profile_id = ${a}.id
      AND ri.provider = 'google' AND ri.email GLOB '[a-z]*.[0-9][0-9][0-9][0-9][0-9]@gmail.com')
    AND NOT EXISTS (SELECT 1 FROM ratings rr WHERE rr.author_id = ${a}.id)
    AND NOT EXISTS (SELECT 1 FROM comments rc WHERE rc.author_id = ${a}.id))`;

// ── the two heavy reads, remembered for ten minutes ──────────────────────────

/*
 * THE DASHBOARD WAS THE DATABASE'S BIGGEST READER. On 29 Sep, 16M rows read in
 * a day, and ~18M of the week's heaviest queries were this page: the stats
 * route counts whole tables and the people list runs correlated counts per
 * person, about 400k rows every time it was opened — over the free D1 cap on
 * its own after a dozen opens. The numbers do not need to be to the second.
 *
 * Kept in KV for ten minutes, keyed by the full URL (so each `?day=` is its
 * own copy) and by a version every dashboard WRITE bumps, so giving somebody
 * Plus or deciding a photo shows at once instead of ten minutes later.
 * Authorised first: a cached copy is never served to someone signed out.
 */
const ADMIN_CACHE_TTL = 600;
const ADMIN_CACHE_VER = 'admin:cachever';

async function adminCacheVersion(env: App['Bindings']): Promise<string> {
  return (await env.CACHE.get(ADMIN_CACHE_VER)) ?? '0';
}

/** Every admin write calls this, so the next read is fresh. */
async function bustAdminCache(env: App['Bindings']): Promise<void> {
  await env.CACHE.put(ADMIN_CACHE_VER, String(Date.now()));
}

const cachedRead = createMiddleware<App>(async (c, next) => {
  if (!(await valid(c.env, cookieFrom(c.req.header('Cookie')), Date.now()))) return next();
  const url = new URL(c.req.url);
  const key = `admin:v${await adminCacheVersion(c.env)}:${url.pathname}${url.search}`;
  const hit = await c.env.CACHE.get(key);
  if (hit) return c.body(hit, 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Admin-Cache': 'hit' });
  await next();
  if (c.res.status === 200) {
    const body = await c.res.clone().text();
    c.executionCtx.waitUntil(c.env.CACHE.put(key, body, { expirationTtl: ADMIN_CACHE_TTL }).catch(() => {}));
  }
});
/**
 * POST /v1/admin/users/:handle/message — a message from OpenTV to one person,
 * delivered as a push (the app has no inbox to show the row in). ONE WAY:
 * nothing replies to it. Plain text, 1–500 characters. `devices` says how many
 * phones will ring — 0 means push was never allowed and the row is all there is.
 */
admin.post('/admin/users/:handle/message', async (c) => {
  if (!(await valid(c.env, cookieFrom(c.req.header('Cookie')), Date.now()))) {
    return fail(c, 401, 'unauthenticated', 'Sign in first.');
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const text = typeof (body as { text?: unknown })?.text === 'string' ? (body as { text: string }).text.trim() : '';
  if (text.length < 1 || text.length > 500) return fail(c, 400, 'invalid_body', 'text must be 1–500 characters.');
  const row = await c.env.DB.prepare('SELECT id FROM profiles WHERE handle_lower = ? AND deleted_at IS NULL')
    .bind(c.req.param('handle').toLowerCase())
    .first<{ id: string }>();
  if (!row) return fail(c, 404, 'not_found', 'No such profile.');
  await c.env.DB.prepare(
    `INSERT INTO notifications (id, recipient_id, actor_id, kind, subject_type, subject_id, body, created_at)
     VALUES (?, ?, NULL, 'message', NULL, NULL, ?, ?)`,
  )
    .bind(crypto.randomUUID(), row.id, text, new Date().toISOString())
    .run();
  const devices = await c.env.DB.prepare(
    'SELECT COUNT(*) AS n FROM push_tokens WHERE profile_id = ? AND disabled_at IS NULL',
  )
    .bind(row.id)
    .first<{ n: number }>();
  const route = typeof (body as { route?: unknown })?.route === 'string' ? (body as { route: string }).route : null;
  c.executionCtx.waitUntil(sendMessagePush(c.env, row.id, text, route));
  return c.json({ ok: true, devices: devices?.n ?? 0 }, 200, { 'Cache-Control': 'no-store' });
});

/**
 * "Message the developer", the dashboard's half. Threads are keyed by profile
 * id, not handle: an account-only person has no handle to address.
 */
admin.get('/admin/support', async (c) => {
  if (!(await valid(c.env, cookieFrom(c.req.header('Cookie')), Date.now()))) return fail(c, 401, 'unauthenticated', 'Sign in first.');
  const rows = await c.env.DB.prepare(
    `SELECT m.profile_id, p.handle, p.display_name, p.joined_at,
            (SELECT body FROM support_messages WHERE profile_id = m.profile_id ORDER BY id DESC LIMIT 1) AS last_body,
            MAX(m.created_at) AS last_at,
            SUM(CASE WHEN m.from_dev = 0 AND m.seen_at IS NULL THEN 1 ELSE 0 END) AS unread
       FROM support_messages m LEFT JOIN profiles p ON p.id = m.profile_id
      GROUP BY m.profile_id ORDER BY last_at DESC LIMIT 100`,
  ).all();
  return c.json({ threads: rows.results }, 200, { 'Cache-Control': 'no-store' });
});

admin.get('/admin/support/:id', async (c) => {
  if (!(await valid(c.env, cookieFrom(c.req.header('Cookie')), Date.now()))) return fail(c, 401, 'unauthenticated', 'Sign in first.');
  const id = c.req.param('id');
  const rows = await c.env.DB.prepare('SELECT id, from_dev, body, created_at, seen_at, push FROM support_messages WHERE profile_id = ? ORDER BY id')
    .bind(id)
    .all<SupportRow & { seen_at: string | null; push: string | null }>();
  await c.env.DB.prepare('UPDATE support_messages SET seen_at = ? WHERE profile_id = ? AND from_dev = 0 AND seen_at IS NULL')
    .bind(new Date().toISOString(), id)
    .run();
  // The ticks: read beats delivered beats sent.
  return c.json({ messages: rows.results.map((r) => ({ ...supportOut(r), seenAt: r.seen_at, push: r.push })) }, 200, { 'Cache-Control': 'no-store' });
});

admin.post('/admin/support/:id', async (c) => {
  if (!(await valid(c.env, cookieFrom(c.req.header('Cookie')), Date.now()))) return fail(c, 401, 'unauthenticated', 'Sign in first.');
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const body = typeof (raw as { body?: unknown })?.body === 'string' ? (raw as { body: string }).body.trim() : '';
  if (body.length < 1 || body.length > 2000) return fail(c, 400, 'invalid_body', 'body must be 1–2000 characters.');
  const id = c.req.param('id');
  const who = await c.env.DB.prepare('SELECT id FROM profiles WHERE id = ? AND deleted_at IS NULL').bind(id).first<{ id: string }>();
  if (!who) return fail(c, 404, 'not_found', 'No such profile.');
  const at = new Date().toISOString();
  const ins = await c.env.DB.prepare('INSERT INTO support_messages (profile_id, from_dev, body, created_at) VALUES (?, 1, ?, ?) RETURNING id')
    .bind(id, body, at)
    .first<{ id: number }>();
  // The push opens the thread; its text is the reply, cut to a notification's
  // length. AWAITED, with the store's receipt, so the dashboard can say whether
  // it rang — a reply that silently reached nobody looked like one that did.
  const push = await sendMessagePush(c.env, id, body.length > 160 ? body.slice(0, 157) + '…' : body, '/support', true);
  const status = push.delivered > 0 ? 'delivered' : push.devices === 0 ? 'nophone' : push.accepted > 0 ? 'sent' : `failed:${push.errors[0] ?? 'unknown'}`.slice(0, 60);
  if (ins) await c.env.DB.prepare('UPDATE support_messages SET push = ? WHERE id = ?').bind(status, ins.id).run();
  return c.json({ ok: true, push }, 201, { 'Cache-Control': 'no-store' });
});

/** The dashboard's "Hard refresh": the next two reads come from the database. */
admin.post('/admin/cache/clear', async (c) => {
  if (!(await valid(c.env, cookieFrom(c.req.header('Cookie')), Date.now()))) {
    return fail(c, 401, 'unauthenticated', 'Sign in first.');
  }
  await bustAdminCache(c.env);
  await c.env.CACHE.delete(COUNTS_KEY);
  await c.env.CACHE.delete(TOTALS_KEY);
  return c.json({ ok: true }, 200, { 'Cache-Control': 'no-store' });
});

/** CommsUni on or off for everybody, at once. See `COMMSUNI_OFF_KEY`. */
admin.get('/admin/commsuni', async (c) => {
  if (!(await valid(c.env, cookieFrom(c.req.header('Cookie')), Date.now()))) {
    return fail(c, 401, 'unauthenticated', 'Sign in first.');
  }
  return c.json({ on: !(await c.env.CACHE.get(COMMSUNI_OFF_KEY)) }, 200, { 'Cache-Control': 'no-store' });
});

admin.post('/admin/commsuni', async (c) => {
  if (!(await valid(c.env, cookieFrom(c.req.header('Cookie')), Date.now()))) {
    return fail(c, 401, 'unauthenticated', 'Sign in first.');
  }
  const body = (await c.req.json().catch(() => ({}))) as { on?: unknown };
  if (typeof body.on !== 'boolean') return fail(c, 400, 'invalid_body', 'on must be true or false');
  if (body.on) await c.env.CACHE.delete(COMMSUNI_OFF_KEY);
  else await c.env.CACHE.put(COMMSUNI_OFF_KEY, '1');
  return c.json({ on: body.on }, 200, { 'Cache-Control': 'no-store' });
});

// The seasonal event — see EVENT_KEY in links.ts. One at a time, or none.
admin.get('/admin/event', async (c) => {
  if (!(await valid(c.env, cookieFrom(c.req.header('Cookie')), Date.now()))) {
    return fail(c, 401, 'unauthenticated', 'Sign in first.');
  }
  return c.json(await eventState(c.env), 200, { 'Cache-Control': 'no-store' });
});

/** What is stored, what the app is shown today, and — in auto — what comes next. */
async function eventState(env: Env) {
  const stored = (await env.CACHE.get(EVENT_KEY)) || null;
  const today = new Date().toISOString().slice(0, 10);
  return {
    mode: stored === 'auto' ? 'auto' : stored ? 'manual' : 'off',
    event: resolveEvent(stored, today),
    next: stored === 'auto' ? nextScheduledChange(today) : null,
  };
}

admin.post('/admin/event', async (c) => {
  if (!(await valid(c.env, cookieFrom(c.req.header('Cookie')), Date.now()))) {
    return fail(c, 401, 'unauthenticated', 'Sign in first.');
  }
  const body = (await c.req.json().catch(() => ({}))) as { event?: unknown };
  const ev = body.event;
  if (ev !== null && ev !== 'auto' && !(EVENTS as readonly unknown[]).includes(ev)) {
    return fail(c, 400, 'invalid_body', "event must be one of the events, 'auto', or null");
  }
  if (ev === null) await c.env.CACHE.delete(EVENT_KEY);
  else await c.env.CACHE.put(EVENT_KEY, ev as string);
  return c.json(await eventState(c.env), 200, { 'Cache-Control': 'no-store' });
});

// ── Profile templates (0053) ─────────────────────────────────────────────────

/**
 * The dashboard's half of "templates from the server": make one, hide it,
 * delete it. Delivery is `GET /v1/links` (links.ts), which sends the visible
 * ones to every member's phone — so a save here reaches phones within the
 * five minutes that read is cached, and nothing else has to happen.
 *
 * NO EDIT, on purpose. A template is one banner plus a shape; getting one
 * wrong is fixed by deleting it and saving another, and the banner's address
 * can then be cached for ever because it never changes under a phone.
 */
admin.get('/admin/templates', async (c) => {
  if (!(await valid(c.env, cookieFrom(c.req.header('Cookie')), Date.now()))) {
    return fail(c, 401, 'unauthenticated', 'Sign in first.');
  }
  // Hidden ones too: this is the list to un-hide them from.
  const rows = await c.env.DB.prepare(`SELECT ${TEMPLATE_COLUMNS} FROM profile_templates ORDER BY created_at DESC`).all<TemplateRow>();
  const origin = new URL(c.req.url).origin;
  return c.json({ items: rows.results.map((r) => templateOut(r, origin)) }, 200, { 'Cache-Control': 'no-store' });
});

/** The banner is a cover, so a cover's types and a cover's size. No GIF: the
 *  phone copies the banner through the same path as a bundled one, which is
 *  a still. */
const TEMPLATE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

admin.post('/admin/templates', async (c) => {
  if (!(await valid(c.env, cookieFrom(c.req.header('Cookie')), Date.now()))) {
    return fail(c, 401, 'unauthenticated', 'Sign in first.');
  }
  const bucket = c.env.COMMENT_IMAGES;
  if (!bucket) return fail(c, 503, 'unavailable', 'Image storage is not configured.');

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be multipart/form-data.');
  }
  const str = (k: string) => {
    const v = form.get(k);
    return typeof v === 'string' ? v.trim() : '';
  };

  // Every field checked against the app's own lists (pure.ts): a value the
  // phone does not know would make it leave the template out, silently, on
  // every phone — so the dashboard hears about it now instead.
  const name = str('name');
  if (name.length < 1 || name.length > 40) return fail(c, 400, 'invalid_body', 'name must be 1–40 characters.');
  const layout = str('layout');
  if (!(TEMPLATE_LAYOUTS as readonly string[]).includes(layout)) return fail(c, 400, 'invalid_body', 'layout must be classic, cards or poster.');
  const primary = str('primary').toUpperCase();
  const secondary = str('secondary').toUpperCase();
  if (!isHexColour(primary) || !isHexColour(secondary)) return fail(c, 400, 'invalid_body', 'Both colours must be #RRGGBB.');
  const persona = str('persona');
  if (!(TEMPLATE_PERSONAS as readonly string[]).includes(persona)) return fail(c, 400, 'invalid_body', 'persona must be one of the app\'s twelve.');
  const event = str('event') || null;
  if (event !== null && !(EVENTS as readonly string[]).includes(event)) return fail(c, 400, 'invalid_body', 'event must be one of the events, or empty.');
  const blocks = parseTemplateBlocks(str('blocks'));
  if (!blocks.ok) return fail(c, 400, 'invalid_body', `blocks: ${blocks.reason}.`);

  const file = form.get('image');
  if (!(file instanceof File)) return fail(c, 400, 'invalid_body', 'A banner image is required.');
  if (!TEMPLATE_IMAGE_TYPES.has(file.type)) return fail(c, 415, 'unsupported_type', `Type ${file.type || 'unknown'} is not a JPEG, PNG or WebP.`);
  if (file.size <= 0) return fail(c, 400, 'invalid_body', 'The image is empty.');
  if (file.size > MAX_COVER_BYTES) return fail(c, 413, 'too_large', `A banner is at most ${Math.floor(MAX_COVER_BYTES / 1_000_000)} MB.`);

  const id = crypto.randomUUID();
  const key = `templates/${id}.${imageExtension(file.type)}`;
  // The object BEFORE the row: a row whose banner is missing is a template
  // every phone downloads, fails on, and leaves out.
  await bucket.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });

  const row: TemplateRow = {
    id,
    name,
    layout,
    colours: JSON.stringify([primary, secondary]),
    blocks: JSON.stringify(blocks.blocks),
    persona,
    banner_key: key,
    event,
    hidden: 0,
    created_at: new Date().toISOString(),
  };
  await c.env.DB.prepare(`INSERT INTO profile_templates (${TEMPLATE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(row.id, row.name, row.layout, row.colours, row.blocks, row.persona, row.banner_key, row.event, row.hidden, row.created_at)
    .run();
  return c.json({ template: templateOut(row, new URL(c.req.url).origin) }, 201, { 'Cache-Control': 'no-store' });
});

/** Hide or show. Hidden stays stored and reaches nobody — the way to take a
 *  template back for a day without losing the banner. */
admin.post('/admin/templates/:id', async (c) => {
  if (!(await valid(c.env, cookieFrom(c.req.header('Cookie')), Date.now()))) {
    return fail(c, 401, 'unauthenticated', 'Sign in first.');
  }
  const body = (await c.req.json().catch(() => ({}))) as { hidden?: unknown };
  if (typeof body.hidden !== 'boolean') return fail(c, 400, 'invalid_body', 'hidden must be true or false.');
  const res = await c.env.DB.prepare('UPDATE profile_templates SET hidden = ? WHERE id = ?')
    .bind(body.hidden ? 1 : 0, c.req.param('id'))
    .run();
  if (!res.meta.changes) return fail(c, 404, 'not_found', 'No such template.');
  return c.json({ ok: true, hidden: body.hidden }, 200, { 'Cache-Control': 'no-store' });
});

admin.delete('/admin/templates/:id', async (c) => {
  if (!(await valid(c.env, cookieFrom(c.req.header('Cookie')), Date.now()))) {
    return fail(c, 401, 'unauthenticated', 'Sign in first.');
  }
  const id = c.req.param('id');
  const row = await c.env.DB.prepare('SELECT banner_key FROM profile_templates WHERE id = ?').bind(id).first<{ banner_key: string }>();
  if (!row) return fail(c, 404, 'not_found', 'No such template.');
  await c.env.DB.prepare('DELETE FROM profile_templates WHERE id = ?').bind(id).run();
  // The banner AFTER the row, best-effort: an orphan costs kilobytes, a row
  // pointing at nothing costs a template that fails on every phone. A phone
  // that already applied it keeps its copy — the look became that person's
  // own settings the moment they tapped Use it.
  if (c.env.COMMENT_IMAGES) {
    try {
      await c.env.COMMENT_IMAGES.delete(row.banner_key);
    } catch {
      /* orphan, swept later */
    }
  }
  return c.body(null, 204);
});

admin.use('/admin/stats', cachedRead);
admin.use('/admin/trends', cachedRead);
admin.use('/admin/users', cachedRead);
// Any change made from the dashboard makes both reads fresh again.
admin.use('/admin/users/*', async (c, next) => {
  await next();
  if (c.req.method === 'POST' && c.res.status < 300) await bustAdminCache(c.env);
});
admin.use('/admin/images/*', async (c, next) => {
  await next();
  if (c.req.method === 'POST' && c.res.status < 300) await bustAdminCache(c.env);
});

// ── GET /v1/admin/stats ──────────────────────────────────────────────────────

/*
 * WHOLE-TABLE TOTALS, CACHED FOR AN HOUR. Each reads every row of its table —
 * ~200k rows together, every time the stats card missed its cache — to print
 * five numbers that only go up. Hard refresh deletes the copy.
 */
const TOTALS_KEY = 'admin:totals';

async function tableTotals(env: App['Bindings']): Promise<Record<string, unknown>> {
  try {
    const hit = await env.CACHE.get<Record<string, unknown>>(TOTALS_KEY, 'json');
    if (hit) return hit;
  } catch {
    // fall through to the database
  }
  const row =
    (await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM comments WHERE deleted_at IS NULL) AS comments,
         (SELECT COUNT(*) FROM ratings)                           AS ratings,
         (SELECT COUNT(*) FROM character_votes)                   AS character_votes,
         (SELECT COUNT(*) FROM emotion_votes)                     AS emotion_votes,
         (SELECT COUNT(*) FROM comment_likes)                     AS likes`,
    ).first<Record<string, unknown>>()) ?? {};
  await env.CACHE.put(TOTALS_KEY, JSON.stringify(row), { expirationTtl: 3600 });
  return row;
}

admin.get('/admin/stats', async (c) => {
  if (!(await valid(c.env, cookieFrom(c.req.header('Cookie')), Date.now()))) {
    return fail(c, 401, 'unauthenticated', 'Sign in first.');
  }

  const row = await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM profiles pr WHERE deleted_at IS NULL AND NOT ${robotSql('pr')}) AS accounts,
       (SELECT COUNT(*) FROM profiles pr WHERE deleted_at IS NULL AND ${robotSql('pr')})     AS robots,
       (SELECT COUNT(*) FROM profiles WHERE deleted_at IS NOT NULL)                  AS deleted,
       -- ACTIVE MEMBERS, and the name is the honest one.
       --
       -- last_seen_at is stamped by GET /v1/me, which the app calls on every
       -- launch, so this counts members who OPENED THE APP rather than members
       -- who exist. It cannot count anybody else: a phone that declined the
       -- community never contacts this server, and measuring those people would
       -- mean breaking the promise that keeps them away from it.
       --
       -- Three windows because one number cannot tell "quiet today" from
       -- "gone" — a lone DAU figure drops every weekend and reads as decline.
       (SELECT COUNT(*) FROM profiles pr WHERE deleted_at IS NULL AND NOT ${robotSql('pr')}
          AND last_seen_at >= ?)                                                     AS active_today,
       (SELECT COUNT(*) FROM profiles pr WHERE deleted_at IS NULL AND NOT ${robotSql('pr')}
          AND last_seen_at >= ?)                                                     AS active_7d,
       (SELECT COUNT(*) FROM profiles pr WHERE deleted_at IS NULL AND NOT ${robotSql('pr')}
          AND last_seen_at >= ?)                                                     AS active_30d,
       (SELECT COUNT(*) FROM profiles WHERE deleted_at IS NULL
          AND handle LIKE 'user!_p!_%' ESCAPE '!')                                   AS placeholder_handles,
       -- PAYING AND GIVEN, COUNTED SEPARATELY, because one is revenue and the
       -- other is a favour. A single "Plus" number would read as a business
       -- doing better than it is: three of four Plus profiles being hand-outs
       -- is the fact worth seeing, and it disappears the moment they are added
       -- together.
       (SELECT COUNT(*) FROM profiles WHERE deleted_at IS NULL AND is_plus = 1)      AS plus_paying,
       -- A live grant on somebody who is NOT paying. Excluding subscribers
       -- keeps the two columns from double-counting the same person, which
       -- happens whenever a paying user was also given a month.
       (SELECT COUNT(*) FROM profiles WHERE deleted_at IS NULL
          AND (is_plus IS NULL OR is_plus = 0)
          AND plus_until IS NOT NULL AND plus_until > ?)                             AS plus_given,
       (SELECT COUNT(*) FROM identities WHERE provider = 'email')                    AS via_email,
       (SELECT COUNT(*) FROM identities WHERE provider = 'google')                   AS via_google,
       (SELECT COUNT(*) FROM identities WHERE provider = 'apple')                    AS via_apple,
       (SELECT COUNT(*) FROM email_credentials WHERE verified_at IS NULL)            AS unconfirmed,
       -- WRITTEN HERE, NOT ARRIVED HERE. Every window excludes rows carrying
       -- an imported_at (0029), because a member seeding a TV Time archive
       -- is one decision, not three thousand.
       --
       -- HOW MUCH IS HAPPENING, not how much exists. A total only ever goes up,
       -- so it cannot answer "is anyone here this week" — which is the question
       -- the totals above look like they answer and never do.
       --
       -- BY DAY, AND WITHOUT WRAPPING THE COLUMN. date('now', ...) is
       -- 'YYYY-MM-DD' and a stored timestamp is 'YYYY-MM-DDTHH:MM:SS.sssZ', so
       -- a plain >= compares them correctly as strings AND leaves created_at
       -- bare, which is the difference between a range scan and reading every
       -- row of a 72,000-row table three times.
       --
       -- NOT datetime('now', ...): that renders 'YYYY-MM-DD HH:MM:SS', a space
       -- where the stored value has a T, and a space sorts BEFORE a T — so
       -- every row would fall inside every window.
       --
       -- AN IMPORT IS NOT ACTIVITY. A seeded TV Time comment carries its
       -- ORIGINAL date in created_at (imported_at is when it arrived — see
       -- routes/import.ts), so a member uploading nine years of archive does
       -- not appear here as nine years of writing done today. That is the
       -- honest reading: they wrote it in 2019.
       (SELECT COUNT(*) FROM comments WHERE deleted_at IS NULL AND imported_at IS NULL
          AND created_at >= date('now'))                                AS comments_today,
       (SELECT COUNT(*) FROM comments WHERE deleted_at IS NULL AND imported_at IS NULL
          AND created_at >= date('now', '-6 days'))                     AS comments_7d,
       (SELECT COUNT(*) FROM comments WHERE deleted_at IS NULL AND imported_at IS NULL
          AND created_at >= date('now', '-29 days'))                    AS comments_30d,
       (SELECT COUNT(*) FROM ratings
          WHERE imported_at IS NULL AND created_at >= date('now'))                              AS ratings_today,
       (SELECT COUNT(*) FROM ratings
          WHERE imported_at IS NULL AND created_at >= date('now', '-6 days'))                   AS ratings_7d,
       (SELECT COUNT(*) FROM ratings
          WHERE imported_at IS NULL AND created_at >= date('now', '-29 days'))                  AS ratings_30d,
       (SELECT COUNT(*) FROM character_votes
          WHERE imported_at IS NULL AND created_at >= date('now'))                              AS characters_today,
       (SELECT COUNT(*) FROM character_votes
          WHERE imported_at IS NULL AND created_at >= date('now', '-6 days'))                   AS characters_7d,
       (SELECT COUNT(*) FROM character_votes
          WHERE imported_at IS NULL AND created_at >= date('now', '-29 days'))                  AS characters_30d,
       -- HOW MANY PEOPLE, which is the only one of these that cannot be moved
       -- by a single import. Six members seeding their TV Time archives put
       -- 8,335 of one week's 8,393 ratings on the board, each of them in a
       -- single day: a row count answers "how big was somebody's archive", and
       -- a person count answers "was anybody here". Only the second is a
       -- measure of the community.
       --
       -- Comments are counted BOTH ways above and here because a comment keeps
       -- its original date, so its rows are already honest; the people number
       -- is still the more useful one, and the two together say whether a
       -- week was many people once or one person many times.
       (SELECT COUNT(DISTINCT author_id) FROM ratings
          WHERE imported_at IS NULL AND created_at >= date('now'))                              AS raters_today,
       (SELECT COUNT(DISTINCT author_id) FROM ratings
          WHERE imported_at IS NULL AND created_at >= date('now', '-6 days'))                   AS raters_7d,
       (SELECT COUNT(DISTINCT author_id) FROM ratings
          WHERE imported_at IS NULL AND created_at >= date('now', '-29 days'))                  AS raters_30d,
       (SELECT COUNT(DISTINCT author_id) FROM comments WHERE deleted_at IS NULL AND imported_at IS NULL
          AND created_at >= date('now'))                                AS commenters_today,
       (SELECT COUNT(DISTINCT author_id) FROM comments WHERE deleted_at IS NULL AND imported_at IS NULL
          AND created_at >= date('now', '-6 days'))                     AS commenters_7d,
       (SELECT COUNT(DISTINCT author_id) FROM comments WHERE deleted_at IS NULL AND imported_at IS NULL
          AND created_at >= date('now', '-29 days'))                    AS commenters_30d,
       -- voter_id, not author_id: this table names the column for what a
       -- character vote is.
       (SELECT COUNT(DISTINCT voter_id) FROM character_votes
          WHERE imported_at IS NULL AND created_at >= date('now'))                              AS voters_today,
       (SELECT COUNT(DISTINCT voter_id) FROM character_votes
          WHERE imported_at IS NULL AND created_at >= date('now', '-6 days'))                   AS voters_7d,
       (SELECT COUNT(DISTINCT voter_id) FROM character_votes
          WHERE imported_at IS NULL AND created_at >= date('now', '-29 days'))                  AS voters_30d,
       -- The list repair. calls is phones that asked, films is entries
       -- actually named -- the second is the one that says whether the
       -- catalogue is any good, because a call that resolves nothing still
       -- counts as a call.
       (SELECT COALESCE(n, 0) FROM counters WHERE key = 'list_repair_calls')        AS repair_calls,
       (SELECT COALESCE(n, 0) FROM counters WHERE key = 'list_repair_films')        AS repair_films,
       (SELECT COUNT(*) FROM movie_uuids)                                           AS catalogue_films,
       -- ACCEPTED ONLY, like every other count of this table: a pending row is
       -- a question nobody has answered, and counting it would inflate the one
       -- number this page has for how connected the community actually is.
       (SELECT COUNT(*) FROM follows WHERE state = 'accepted')                       AS follows,
       (SELECT COUNT(*) FROM lists)                                                  AS lists,
       (SELECT COUNT(*) FROM comment_images)                                         AS images,
       (SELECT COUNT(*) FROM comment_images WHERE scan_status = 'pending')            AS images_pending,
       (SELECT COUNT(*) FROM comment_images WHERE scan_status = 'clean')              AS images_clean,
       (SELECT COUNT(*) FROM push_tokens)                                            AS push_devices,
       -- The queue that has a clock on it: a report unanswered for 24 hours is
       -- the one number here worth being woken up about.
       (SELECT COUNT(*) FROM reports WHERE resolved_at IS NULL)                      AS open_reports`,
  )
    // Midnight UTC, seven days, thirty days — bound rather than interpolated,
    // in the order the three windows appear above.
    .bind(
      `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`,
      new Date(Date.now() - 7 * 864e5).toISOString(),
      new Date(Date.now() - 30 * 864e5).toISOString(),
      // `plus_given` compares against now, not a window.
      new Date().toISOString(),
    )
    .first<Record<string, number>>();

  // Joins per day for the last fortnight — enough to see whether an
  // announcement did anything, and small enough to draw as bars.
  const joins = await c.env.DB.prepare(
    `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n
       FROM profiles
      WHERE deleted_at IS NULL AND created_at >= date('now', '-13 days')
      GROUP BY day ORDER BY day`,
  ).all<{ day: string; n: number }>();

  return c.json({ totals: { ...(await tableTotals(c.env)), ...row }, joins: joins.results ?? [] }, 200, {
    'Cache-Control': 'no-store',
  });
});

// ── GET /v1/admin/users ──────────────────────────────────────────────────────

/**
 * WHO IS HERE — and the line this route sits on.
 *
 * The stats route reads how many; this one reads who. That is a real step, and
 * it is taken deliberately rather than by accident: an owner needs to see that
 * an account is stuck on a placeholder handle, or that somebody registered and
 * never confirmed, and neither is answerable by a count.
 *
 * WHAT IT STILL WILL NOT SHOW: a single word anybody wrote. Comment bodies,
 * ratings, what they watched — none of it is selected here, and the counts
 * beside each person say how much, never what. Moderation reads content
 * through the report queue, where somebody has asked for it to be read.
 */
/*
 * THE LIFETIME COUNTS, CACHED FOR A DAY ON THEIR OWN.
 *
 * They were most of the D1 bill: an importer has thousands of comments and
 * ratings, and every count reads each one, so one miss of the people list was
 * ~200k rows. They barely move and the dashboard only needs them roughly right,
 * so they live under their own key that dashboard writes do NOT bust (giving
 * Plus changes none of them). Somebody new since the copy was made is counted
 * on their own and folded in. Hard refresh deletes it.
 */
const COUNTS_KEY = 'admin:counts';
const COUNTS_MAX_AGE_MS = 24 * 60 * 60 * 1000;
type Counts = Record<string, Record<string, unknown>>;

async function lifetimeCounts(env: App['Bindings'], ids: string[]): Promise<Counts> {
  let cached: { at: number; rows: Counts } | null = null;
  try {
    cached = await env.CACHE.get<{ at: number; rows: Counts }>(COUNTS_KEY, 'json');
  } catch {
    cached = null;
  }
  const copy = cached && Date.now() - cached.at <= COUNTS_MAX_AGE_MS ? cached : { at: Date.now(), rows: {} as Counts };
  const missing = ids.filter((id) => !(id in copy.rows));
  if (missing.length > 0) {
    // D1 refuses more than 100 bound parameters in one statement.
    for (let i = 0; i < missing.length; i += 90) {
      const part = missing.slice(i, i + 90);
      const holes = part.map(() => '?').join(',');
      const res = await env.DB.prepare(
        `SELECT p.id,
            (SELECT COUNT(*) FROM comments  x WHERE x.author_id = p.id AND x.deleted_at IS NULL) AS comments,
            (SELECT COUNT(*) FROM ratings   x WHERE x.author_id = p.id) AS ratings,
            /* The other two halves of a vote. A rating is a number, a feeling
               is a face, and a character is who they picked -- three separate
               tables and three separate decisions, so a person who never
               scores anything but taps faces constantly reads as inactive
               against the ratings column alone. */
            (SELECT COUNT(*) FROM emotion_votes   x WHERE x.author_id = p.id) AS feelings,
            (SELECT COUNT(*) FROM character_votes x WHERE x.voter_id  = p.id) AS characters,
            (SELECT COUNT(*) FROM follows   x WHERE x.followee_id = p.id AND x.state = 'accepted') AS followers,
            (SELECT COUNT(*) FROM lists     x WHERE x.owner_id = p.id) AS lists,
            -- How many of their photographs the rescue actually caught. Zero
            -- against thousands of comments means their import ran after TV
            -- Time's CDN died, and those pictures are gone for good.
            (SELECT COUNT(*) FROM comment_images ci
               JOIN comments cm ON cm.id = ci.comment_id
              WHERE cm.author_id = p.id) AS images
         FROM profiles p
        WHERE p.id IN (${holes})`,
      )
        .bind(...part)
        .all<Record<string, unknown>>();
      for (const r of res.results ?? []) copy.rows[r.id as string] = r;
    }
    await env.CACHE.put(COUNTS_KEY, JSON.stringify(copy), {
      expirationTtl: Math.max(60, Math.ceil((copy.at + COUNTS_MAX_AGE_MS - Date.now()) / 1000)),
    });
  }
  return copy.rows;
}

admin.get('/admin/users', async (c) => {
  if (!(await valid(c.env, cookieFrom(c.req.header('Cookie')), Date.now()))) {
    return fail(c, 401, 'unauthenticated', 'Sign in first.');
  }

  const res = await c.env.DB.prepare(
    `SELECT p.id,
            p.handle,
            p.display_name,
            p.created_at,
            -- PLUS, BOTH WAYS IT CAN BE TRUE. is_plus is the flag the
            -- RevenueCat webhook owns; plus_until is the hand-grant escape
            -- hatch. The dashboard shows which of the two it is, because
            -- "paying" and "given a month by Mahmood" are different facts and
            -- a single green tick would hide the difference.
            p.is_plus,
            p.plus_until,
            p.plus_since,
            p.device_plus,
            p.backup_at,
            p.backup_bytes,
            p.sync_at,
            -- Stamped by GET /v1/me, which the app calls on every launch. It
            -- is the closest thing this server has to "still using it", and
            -- it is a DATE, not a history: nothing records the launch before
            -- this one.
            p.last_seen_at,
            p.app_version,
            p.publish_state,
            -- The address only where the person typed one into this app. A
            -- provider's copy is Apple's or Google's to show, not ours to
            -- collect a list of.
            c.email,
            c.verified_at IS NULL AND c.profile_id IS NOT NULL AS unconfirmed,
            (SELECT GROUP_CONCAT(provider) FROM identities i WHERE i.profile_id = p.id) AS providers,
            CASE WHEN ${robotSql('p')} THEN 1 ELSE 0 END AS robot,
            /*
             * WHAT THEY HAVE WATCHED, which this dashboard could not say at all.
             *
             * There is no watch history on this server and there is not going
             * to be -- that is the promise the app makes in six languages, and
             * it is why "show me the episode they watched today" has no answer
             * here. What a phone does send, when somebody publishes a profile,
             * is the TOTALS: how many episodes, how many films. Those are real
             * and they were sitting unread in profile_stats.
             *
             * So the columns say what is actually known -- a lifetime count,
             * not an event -- and a profile that has never published simply has
             * none, which is the truth about it rather than a zero.
             *
             * NOT IN THE 24-HOUR COPY with the counts: these move every time a
             * phone publishes, and a cached "not published" outlived the
             * publish by a day. One primary-key row per person, so live is cheap.
             */
            (SELECT episodes_watched FROM profile_stats ps WHERE ps.profile_id = p.id) AS episodes_watched,
            (SELECT movies_count     FROM profile_stats ps WHERE ps.profile_id = p.id) AS movies_watched,
            -- When the phone last published those totals: the only trace a
            -- library change leaves here (added shows, marked episodes).
            (SELECT updated_at       FROM profile_stats ps WHERE ps.profile_id = p.id) AS library_at,
            (SELECT day_base_episodes FROM profile_stats ps WHERE ps.profile_id = p.id) AS day_base_episodes,
            (SELECT day_base_movies   FROM profile_stats ps WHERE ps.profile_id = p.id) AS day_base_movies,
            -- A TV Time import leaves imported ratings or comments here even
            -- when the totals never arrived: "imported, not sent yet".
            CASE WHEN EXISTS (SELECT 1 FROM ratings r WHERE r.author_id = p.id AND r.imported_at IS NOT NULL)
                   OR EXISTS (SELECT 1 FROM comments m WHERE m.author_id = p.id AND m.imported_at IS NOT NULL)
                 THEN 1 ELSE 0 END AS imported_archive,
            p.joined_at,
            -- An account only publishes nothing; its Sync changes today, counted.
            (SELECT COUNT(*) FROM sync_ops so WHERE so.profile_id = p.id
                AND so.ts >= CAST(strftime('%s', date('now')) AS INTEGER) * 1000) AS sync_today
       FROM profiles p
       LEFT JOIN email_credentials c ON c.profile_id = p.id
      WHERE p.deleted_at IS NULL
      ORDER BY p.created_at DESC
      LIMIT 1000`,
  ).all<Record<string, unknown>>();

  /*
   * WHAT THEY DID TODAY, as its own query rather than four more correlated
   * subqueries on the one above.
   *
   * WHY IT IS SEPARATE. The columns beside each person are lifetime counts, so
   * they scan a whole table per row — acceptable once. Repeating that shape
   * four times with a date filter would multiply a 200-row page by four scans
   * of a 76,000-row table for an answer that concerns a handful of rows. This
   * reads TODAY first, which is small by definition, and the route joins it in
   * memory.
   *
   * IMPORTS EXCLUDED, the same rule the activity windows use: somebody seeding
   * a TV Time archive is one decision, not three thousand, and a dashboard that
   * cannot tell them apart says the community is busy on the day one person
   * signed up.
   *
   * OPENING IS NOT DOING. `last_seen_at` already says they launched the app;
   * this says whether anything came of it, which is the difference between a
   * number that flatters and a number that informs.
   */
  /*
   * TODAY IS DECIDED HERE, NOT IN THE BROWSER. The stats cards count a UTC day;
   * the page was working midnight out from the reader's own clock, and three
   * hours east of UTC those are different days for three hours every night.
   */
  const todayUtc = new Date().toISOString().slice(0, 10);
  /*
   * ANY DAY, NOT ONLY TODAY. `?day=YYYY-MM-DD` steps the table back through
   * the day log (0038); anything else, or a day in the future, is today.
   */
  const asked = c.req.query('day') ?? '';
  const day = /^\d{4}-\d{2}-\d{2}$/.test(asked) && asked <= todayUtc && !isNaN(Date.parse(asked)) ? asked : todayUtc;
  const nextDay = new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const midnightUtc = `${day}T00:00:00.000Z`;
  const openedOn = new Set(
    ((
      await c.env.DB.prepare('SELECT profile_id FROM profile_days WHERE day = ?').bind(day).all<{ profile_id: string }>()
    ).results ?? []).map((r) => r.profile_id),
  );

  const acted = await c.env.DB.prepare(
    `SELECT kind, who, target_source, target_key, season, episode, detail
       FROM (
         SELECT 'comment' AS kind, author_id AS who, target_source, target_key, season, episode, NULL AS detail,
                created_at
           FROM comments
          WHERE deleted_at IS NULL AND imported_at IS NULL AND created_at >= ? AND created_at < ?
         UNION ALL
         SELECT 'rating', author_id, target_source, target_key, season, episode, CAST(score AS TEXT), created_at
           FROM ratings WHERE imported_at IS NULL AND created_at >= ? AND created_at < ?
         UNION ALL
         SELECT 'character', voter_id, target_source, target_key, season, episode, character_name, created_at
           FROM character_votes WHERE imported_at IS NULL AND created_at >= ? AND created_at < ?
         UNION ALL
         SELECT 'emotion', author_id, target_source, target_key, season, episode, emotion, created_at
           FROM emotion_votes WHERE imported_at IS NULL AND created_at >= ? AND created_at < ?
         UNION ALL
         -- Titles newly on somebody's PUBLIC shelf (0047): what they chose to
         -- show, never what they watched.
         SELECT 'added', profile_id, 'title', target_key, NULL, NULL, kind, first_seen_at
           FROM shelf_seen WHERE first_seen_at >= ? AND first_seen_at < ?
       )
      ORDER BY created_at DESC
      LIMIT 1500`,
  )
    .bind(day, nextDay, day, nextDay, day, nextDay, day, nextDay, day, nextDay)
    .all<{
    kind: string;
    who: string;
    target_source: string;
    target_key: string;
    season: number | null;
    episode: number | null;
    detail: string | null;
  }>();

  /*
   * NAMES, FROM EVERYWHERE A MEMBER HAS ALREADY SENT ONE.
   *
   * The server has no catalogue: it cannot turn 319947 into a title, and by
   * design it never will. What it has is every place a PHONE sent a name
   * alongside a key, and there are three of them — the shelves on a profile,
   * the items in a published list, the items in a shared list, and -- since
   * 0037 -- `title_names`, which the rating and comment routes fill from the
   * write itself. That last one is the only one that does not depend on
   * somebody having SHELVED the title, which is what a library over 250 shows
   * cannot do for all of them. A name for a key is a fact about the catalogue,
   * not about the person who happened to send it ("289590 is Severance"), so
   * any one of the four names everybody's rows.
   *
   * IT ASKED ONLY THE FIRST, which is why the dashboard printed "319947 S1E1".
   * A shelf holds what somebody chose to SHOW on their profile; commenting on
   * an episode of a show you have not put on your shelf is completely ordinary,
   * and for those the server held a name in a list table it never looked at.
   *
   * Only the keys in today's rows are asked for. A join across the whole of
   * any of these would read tens of thousands of rows to label a dozen events.
   */
  const keys = [...new Set((acted.results ?? []).map((r) => r.target_key))];
  const names = new Map<string, string>();
  // IN BATCHES OF 24: each key is bound four times (one per table), and D1
  // refuses more than 100 parameters a statement. A day with a shelf of new
  // titles (27 on 3 Oct) made one query of 108 and emptied the people list.
  for (let i = 0; i < keys.length; i += 24) {
    const part = keys.slice(i, i + 24);
    const slots = part.map(() => '?').join(',');
    const found = await c.env.DB.prepare(
      `SELECT target_key, MIN(name) AS name FROM (
         SELECT target_key, name  FROM profile_titles    WHERE name  IS NOT NULL AND target_key IN (${slots})
         UNION ALL
         SELECT target_key, title FROM list_items        WHERE title IS NOT NULL AND target_key IN (${slots})
         UNION ALL
         SELECT target_key, title FROM shared_list_items WHERE title IS NOT NULL AND target_key IN (${slots})
         UNION ALL
         SELECT target_key, name  FROM title_names       WHERE target_key IN (${slots})
       )
       GROUP BY target_key`,
    )
      .bind(...part, ...part, ...part, ...part)
      .all<{ target_key: string; name: string }>();
    for (const row of found.results ?? []) names.set(row.target_key, row.name);
  }

  const byId = new Map<
    string,
    { kind: string; title: string; where: string; detail: string | null; tvdbId: string | null }[]
  >();
  for (const r of acted.results ?? []) {
    const list = byId.get(r.who) ?? [];
    // A season of -1 is this schema's "the whole title", not season minus one.
    const where =
      r.season != null && r.season >= 0 && r.episode != null && r.episode >= 0
        ? `S${r.season}E${r.episode}`
        : '';
    const named = names.get(r.target_key);
    list.push({
      kind: r.kind,
      title: named ?? r.target_key,
      where,
      detail: r.detail,
      /*
       * A WAY OUT WHEN NOBODY HAS SENT A NAME.
       *
       * The three tables above hold a name only if some phone put this title
       * on a shelf or in a list. Rating an episode of a show you have done
       * neither with is ordinary, and then there is nothing on this server
       * that knows what 319947 is -- so the dashboard prints the key.
       *
       * It can still be one click instead of a copy-paste: a bare TheTVDB id
       * has a canonical page. Only when the key is unnamed and actually looks
       * like a TheTVDB series id; a `title` key is a slug and a TMDB one is a
       * different catalogue.
       */
      tvdbId: !named && r.target_source === 'tvdb' && /^\d+$/.test(r.target_key) ? r.target_key : null,
    });
    byId.set(r.who, list);
  }

  const counts = await lifetimeCounts(c.env, (res.results ?? []).map((u) => String(u.id)));
  const items = (res.results ?? []).map((u) => ({
    ...counts[String(u.id)],
    ...u,
    // The day log answers for any day; last_seen_at still answers for today,
    // so a member stamped before 0038 existed is not missed.
    opened_today:
      openedOn.has(String(u.id)) ||
      (day === todayUtc && typeof u.last_seen_at === 'string' && u.last_seen_at >= midnightUtc),
    today: byId.get(String(u.id)) ?? [],
    // Last publish only, so a past day says yes only if nothing came after it.
    library_on_day: typeof u.library_at === 'string' && u.library_at.slice(0, 10) === day,
  }));

  return c.json({ items, day, today: todayUtc }, 200, { 'Cache-Control': 'no-store' });
});

/**
 * POST /v1/admin/users/:handle/plus — give somebody Plus, or take it back.
 *
 * `plus_until` AND NEVER `is_plus`. The flag belongs to the RevenueCat webhook
 * and means "this person is paying"; writing it by hand would make the server
 * believe in a subscription that does not exist, and the next webhook would
 * overwrite it anyway. The date is the hand-grant lane — `plusEntitled()` reads
 * `is_plus === 1 || isPlus(plus_until, now)`, so a grant is a real entitlement
 * that expires on its own with nothing to revoke and no card anywhere near it.
 *
 * EXTENDING ADDS TO WHAT IS LEFT, rather than replacing it. Somebody with three
 * weeks remaining who is given a month should end up with seven weeks, not
 * four: the alternative silently takes time away from the person being given
 * something, which is the opposite of the intent every time this is used.
 * An expired or absent grant starts from today instead.
 *
 * `months: 0` REMOVES the grant. There is no separate delete route because
 * there is no separate action — the whole feature is one date.
 */
admin.post('/admin/users/:handle/plus', async (c) => {
  if (!(await valid(c.env, cookieFrom(c.req.header('Cookie')), Date.now()))) {
    return fail(c, 401, 'unauthenticated', 'Sign in first.');
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const months = (body as { months?: unknown })?.months;
  if (typeof months !== 'number' || !Number.isInteger(months) || months < 0 || months > 12) {
    return fail(c, 400, 'invalid_body', 'months must be a whole number from 0 to 12.');
  }

  const handle = c.req.param('handle').toLowerCase();
  const row = await c.env.DB.prepare(
    'SELECT id, plus_until, is_plus FROM profiles WHERE handle_lower = ? AND deleted_at IS NULL',
  )
    .bind(handle)
    .first<{ id: string; plus_until: string | null; is_plus: number | null }>();
  if (!row) return fail(c, 404, 'not_found', 'No such profile.');

  /*
   * A PAYING SUBSCRIBER GETS THE TIME AT THE STORE. `plus_until` would sit
   * inside a period they already paid for while Apple or Google billed them on
   * the usual date; moving the store's renewal date is the gift that is real.
   * `null` from rcExtend (no key, promotional, lapsed) falls through to the
   * date below, exactly as before.
   */
  if (months > 0 && row.is_plus === 1) {
    const ext = await rcExtend(c.env, row.id, months === 12 ? 365 : months * 30);
    if (ext && !ext.ok) return fail(c, ext.status, 'store_refused', ext.message);
    if (ext?.ok) {
      return c.json({ handle, via: ext.store, plus_expires_at: ext.expires }, 200, { 'Cache-Control': 'no-store' });
    }
  }

  if (months === 0) {
    await c.env.DB.prepare('UPDATE profiles SET plus_until = NULL WHERE id = ?').bind(row.id).run();
    return c.json({ handle, plus_until: null }, 200, { 'Cache-Control': 'no-store' });
  }

  const now = Date.now();
  const current = row.plus_until ? Date.parse(row.plus_until) : NaN;
  const from = new Date(Number.isFinite(current) && current > now ? current : now);
  /*
   * setMonth HANDLES THE SHORT ONES. Adding a month to 31 January lands on
   * 3 March rather than throwing, which is the behaviour anybody granting
   * "a month" expects and the reason this is not arithmetic on milliseconds.
   */
  from.setMonth(from.getMonth() + months);
  const until = from.toISOString();

  await c.env.DB.prepare('UPDATE profiles SET plus_until = ? WHERE id = ?').bind(until, row.id).run();
  return c.json({ handle, plus_until: until }, 200, { 'Cache-Control': 'no-store' });
});

/** A store offer identifier: Apple's promotional offer id, or Play's offer id
 *  / tag. Both stores allow letters, digits, dots, dashes and underscores. */
const OFFER_ID = /^[A-Za-z0-9._:-]{1,100}$/;
/** A month at most. A countdown of weeks is not a countdown any more. */
const MAX_OFFER_HOURS = 24 * 30;

/**
 * POST /v1/admin/users/:handle/offer — a personal offer with a real end.
 *
 * Body `{ offer_id, hours, label? }`. The person's paywall shows "A special
 * offer for you" with a countdown to `ends_at` and buys through that store
 * offer (`GET /v1/me/offer`).
 *
 * THE END NEVER MOVES, which is what makes the countdown honest (Apple treats a
 * timer that restarts as a deceptive one). So: a second offer while one is
 * running is refused rather than replacing it, and the same offer id can never
 * be given to the same person twice — not even after it ran out, because
 * "it ended, and here it is again" is the restarting timer by another route.
 * `hours: 0` ends a running offer NOW, the only way to undo a mistake; it
 * shortens, never lengthens.
 */
admin.post('/admin/users/:handle/offer', async (c) => {
  if (!(await valid(c.env, cookieFrom(c.req.header('Cookie')), Date.now()))) {
    return fail(c, 401, 'unauthenticated', 'Sign in first.');
  }
  let body: { offer_id?: unknown; hours?: unknown; label?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const { hours } = body;
  if (typeof hours !== 'number' || !Number.isInteger(hours) || hours < 0 || hours > MAX_OFFER_HOURS) {
    return fail(c, 400, 'invalid_body', `hours must be a whole number from 0 to ${MAX_OFFER_HOURS}.`);
  }
  const row = await c.env.DB.prepare('SELECT id FROM profiles WHERE handle_lower = ? AND deleted_at IS NULL')
    .bind(c.req.param('handle').toLowerCase())
    .first<{ id: string }>();
  if (!row) return fail(c, 404, 'not_found', 'No such profile.');
  const now = new Date();
  const nowIso = now.toISOString();

  if (hours === 0) {
    const r = await c.env.DB.prepare(
      'UPDATE personal_offers SET ends_at = ? WHERE profile_id = ? AND ends_at > ? AND consumed_at IS NULL',
    )
      .bind(nowIso, row.id, nowIso)
      .run();
    return c.json({ ended: r.meta.changes ?? 0 }, 200, { 'Cache-Control': 'no-store' });
  }

  const offerId = typeof body.offer_id === 'string' ? body.offer_id.trim() : '';
  if (!OFFER_ID.test(offerId)) return fail(c, 400, 'invalid_body', 'offer_id must be the store offer identifier.');
  const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 80) : null;

  const running = await c.env.DB.prepare(
    'SELECT offer_id, ends_at FROM personal_offers WHERE profile_id = ? AND ends_at > ? AND consumed_at IS NULL',
  )
    .bind(row.id, nowIso)
    .first<{ offer_id: string; ends_at: string }>();
  if (running) {
    return fail(c, 409, 'offer_running', `${running.offer_id} is running until ${running.ends_at}. End it first (hours 0).`);
  }
  const endsAt = new Date(now.getTime() + hours * 3600_000).toISOString();
  // OR IGNORE + changes: the primary key answers "given before" in one statement.
  const r = await c.env.DB.prepare(
    `INSERT OR IGNORE INTO personal_offers (profile_id, offer_id, label, ends_at, created_at) VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(row.id, offerId, label, endsAt, nowIso)
    .run();
  if (!r.meta.changes) return fail(c, 409, 'offer_given', 'This person has had this offer before; it cannot start again.');
  return c.json({ offer_id: offerId, ends_at: endsAt }, 200, { 'Cache-Control': 'no-store' });
});

// ── Image review ────────────────────────────────────────────────────────────

/**
 * THE ONLY WAY AN IMAGE BECOMES VISIBLE.
 *
 * `GET /v1/comments/:id/image` serves `clean` and nothing else, and nothing in
 * the codebase writes `clean` except the route below — one person, signed in,
 * having looked at the picture. There is no default and no "approve everything
 * from this user, including later": each would make an image public without
 * being seen, which is the single thing this queue exists to prevent. The page
 * can filter to one member and "Show all" what it rendered (20 Oct, for
 * imported TV Time archives of hundreds of GIFs); later uploads stay pending.
 *
 * The reviewer sees the picture through `GET /v1/admin/image/:id`, which is
 * cookie-gated and serves ANY status — that is the whole job. It is the one
 * place in the server where an unreviewed image is readable, and it is readable
 * by exactly the person who has to decide about it.
 */
admin.get('/admin/images', async (c) => {
  if (!(await valid(c.env, cookieFrom(c.req.header('Cookie')), Date.now()))) {
    return fail(c, 401, 'unauthenticated', 'Sign in first.');
  }
  const status = c.req.query('status') ?? 'pending';
  if (!['pending', 'clean', 'blocked'].includes(status)) {
    return fail(c, 400, 'invalid_body', 'Unknown status.');
  }

  // ONE PERSON'S QUEUE. Filtering by handle lets the page show everything one
  // member has waiting (an imported TV Time archive can be hundreds of GIFs),
  // so "Show all" can clear exactly those, after they have been on screen.
  // Later uploads are untouched: they arrive pending like any other.
  const handle = (c.req.query('handle') ?? '').trim().toLowerCase().replace(/^@/, '');
  const res = await c.env.DB.prepare(
    `SELECT ci.comment_id, ci.is_gif, ci.scan_status, ci.created_at,
            p.handle,
            -- WHO SENT IT, because the two kinds of picture in this queue
            -- arrive by different doors and deserve different attention. A
            -- rescued TV Time photograph was taken years ago by somebody who
            -- has since imported their own archive; a Plus subscriber's upload
            -- is new, was chosen deliberately, and is the one a stranger will
            -- see on a public thread. Same review, different weight.
            (p.is_plus = 1 OR (p.plus_until IS NOT NULL AND p.plus_until > ?)) AS by_plus,
            cm.target_source, cm.target_key, cm.season, cm.episode,
            -- The caption, because a picture is judged with the sentence it was
            -- attached to. Trimmed: this is a queue, not a reading list.
            substr(cm.body, 1, 140) AS body
       FROM comment_images ci
       JOIN comments cm ON cm.id = ci.comment_id
       JOIN profiles p  ON p.id  = cm.author_id
      WHERE ci.scan_status = ? AND cm.deleted_at IS NULL
        AND (? = '' OR p.handle_lower = ?)
      ORDER BY ci.created_at DESC
      LIMIT ${handle ? 1000 : 200}`,
  )
    .bind(new Date().toISOString(), status, handle, handle)
    .all<Record<string, unknown>>();

  return c.json({ items: res.results ?? [] }, 200, { 'Cache-Control': 'no-store' });
});

/**
 * SHOW EVERYTHING CURRENTLY IN THE QUEUE.
 *
 * REGISTERED BEFORE `/admin/images/:id`, ON PURPOSE. Hono matches in order, and
 * after it `:id` took "bulk" as a comment id: it updated nothing and answered
 * ok, so the button refreshed and nothing was shown (found 20 Oct).
 *
 * A bulk approve is exactly what the per-image queue was built to avoid, so it
 * takes the ids rather than a status: the page sends the pictures it has
 * rendered, which means the button can only clear images that were on screen.
 * There is no "approve all pending" — an image uploaded a minute ago, by
 * somebody who joined a minute ago, is not covered by a decision made before it
 * existed.
 *
 * Capped at the page size for the same reason.
 */
admin.post('/admin/images/bulk', async (c) => {
  if (!(await valid(c.env, cookieFrom(c.req.header('Cookie')), Date.now()))) {
    return fail(c, 401, 'unauthenticated', 'Sign in first.');
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const b = (body ?? {}) as { ids?: unknown; status?: unknown };
  const status = b.status;
  if (status !== 'clean' && status !== 'blocked') {
    return fail(c, 400, 'invalid_body', 'status must be clean or blocked.');
  }
  const ids = Array.isArray(b.ids) ? b.ids.filter((v): v is string => typeof v === 'string') : [];
  if (ids.length === 0) return fail(c, 400, 'invalid_body', 'ids are required.');
  if (ids.length > 200) return fail(c, 400, 'invalid_body', 'At most 200 at a time.');

  const now = new Date().toISOString();
  const res = await c.env.DB.batch(
    ids.map((id) =>
      c.env.DB.prepare(
        // `AND scan_status = 'pending'` so this can never silently reverse a
        // decision already made about an image, in either direction.
        "UPDATE comment_images SET scan_status = ?, scanned_at = ? WHERE comment_id = ? AND scan_status = 'pending'",
      ).bind(status, now, id),
    ),
  );

  const changed = res.reduce((n, r) => n + (r.meta?.changes ?? 0), 0);
  return c.json({ ok: true, status, changed });
});

admin.post('/admin/images/:id', async (c) => {
  if (!(await valid(c.env, cookieFrom(c.req.header('Cookie')), Date.now()))) {
    return fail(c, 401, 'unauthenticated', 'Sign in first.');
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const status = (body as { status?: unknown }).status;
  // Deliberately not 'pending': a decision can be changed from clean to blocked
  // or back, but nothing returns an image to "nobody has looked at this yet".
  if (status !== 'clean' && status !== 'blocked') {
    return fail(c, 400, 'invalid_body', 'status must be clean or blocked.');
  }

  const now = new Date().toISOString();
  const id = c.req.param('id');
  const res = await c.env.DB.prepare(
    'UPDATE comment_images SET scan_status = ?, scanned_at = ? WHERE comment_id = ?',
  )
    .bind(status, now, id)
    .run();

  if (!res.meta.changes) return fail(c, 404, 'not_found', 'No such image.');

  /**
   * THE DECISION IS ABOUT THE GIF, NOT THIS COPY OF IT.
   *
   * Uploads inherit a decision already made about their asset, which handles
   * everybody who picks a GIF AFTER a moderator has ruled on it. This is the
   * other direction: the people who picked it BEFORE, and are sitting in the
   * queue behind the row just decided. Without this, approving a popular
   * reaction GIF clears one comment and leaves forty identical ones to be
   * clicked through one at a time -- which is the per-person moderation this
   * whole change exists to stop.
   *
   * Only rows still waiting. A row a moderator has already ruled on
   * individually is a considered decision, and a later ruling about the asset
   * in general should not quietly overwrite it.
   */
  let alsoDecided = 0;
  const asset = await c.env.DB.prepare('SELECT asset_id FROM comment_images WHERE comment_id = ?')
    .bind(id)
    .first<{ asset_id: string | null }>();
  if (asset?.asset_id) {
    const spread = await c.env.DB.prepare(
      `UPDATE comment_images SET scan_status = ?, scanned_at = ?
        WHERE asset_id = ? AND scan_status = 'pending'`,
    )
      .bind(status, now, asset.asset_id)
      .run();
    alsoDecided = spread.meta.changes ?? 0;
  }
  // Reported so the moderation screen can say "and 12 others" rather than
  // leaving somebody to wonder why the queue jumped.
  return c.json({ ok: true, status, also_decided: alsoDecided });
});

/** The picture itself, at any status, to the one person who must look at it. */
admin.get('/admin/image/:id', async (c) => {
  if (!(await valid(c.env, cookieFrom(c.req.header('Cookie')), Date.now()))) {
    return fail(c, 401, 'unauthenticated', 'Sign in first.');
  }
  const bucket = c.env.COMMENT_IMAGES;
  if (!bucket) return fail(c, 503, 'unavailable', 'Image storage is not configured.');

  const row = await c.env.DB.prepare('SELECT r2_key FROM comment_images WHERE comment_id = ?')
    .bind(c.req.param('id'))
    .first<{ r2_key: string }>();
  if (!row) return fail(c, 404, 'not_found', 'No image.');

  const object = await bucket.get(row.r2_key);
  if (!object) return fail(c, 404, 'not_found', 'No image.');

  return new Response(object.body, {
    headers: {
      'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream',
      // Never cached: a reviewed image changes status, and a stale copy in a
      // browser is a decision made about the wrong picture.
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});

// ── GET /v1/admin/trends?days=14|30|90 ───────────────────────────────────────

/*
 * NINE LINES OVER TIME, and the period before each, so a number can be read as
 * better or worse rather than only as big or small. Counts per UTC day, never
 * who: joins (robots left out, as on the cards), members who opened the app
 * (profile_days — kept 90 days, so the period before a 90-day view is partly
 * empty and the page says so), and comments and ratings written in the app
 * (imports left out, as on the cards). Cached like the stats.
 */
export const TREND_DAYS = [14, 30, 90] as const;

admin.get('/admin/trends', async (c) => {
  if (!(await valid(c.env, cookieFrom(c.req.header('Cookie')), Date.now()))) {
    return fail(c, 401, 'unauthenticated', 'Sign in first.');
  }
  const asked = Number(c.req.query('days'));
  const days = (TREND_DAYS as readonly number[]).includes(asked) ? asked : 30;
  const since = new Date(Date.now() - (2 * days - 1) * 864e5).toISOString().slice(0, 10);
  // `p` is how many people, `apple`/`google` how new members signed in — still
  // counts, never who.
  type Row = { day: string; n: number; p?: number; apple?: number; google?: number };
  const db = c.env.DB;
  const [joins, opened, comments, ratings, deletes, plus, returned, syncs, backups] = await Promise.all([
    db.prepare(
      `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n,
              SUM(EXISTS (SELECT 1 FROM identities i WHERE i.profile_id = pr.id AND i.provider = 'apple')) AS apple,
              SUM(EXISTS (SELECT 1 FROM identities i WHERE i.profile_id = pr.id AND i.provider = 'google')) AS google
         FROM profiles pr
        WHERE deleted_at IS NULL AND created_at >= ? AND NOT ${robotSql('pr')}
        GROUP BY day`,
    ).bind(since).all<Row>(),
    db.prepare('SELECT day, COUNT(*) AS n FROM profile_days WHERE day >= ? GROUP BY day').bind(since).all<Row>(),
    db.prepare(
      `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n, COUNT(DISTINCT author_id) AS p FROM comments
        WHERE imported_at IS NULL AND deleted_at IS NULL AND created_at >= ? GROUP BY day`,
    ).bind(since).all<Row>(),
    db.prepare(
      `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n, COUNT(DISTINCT author_id) AS p FROM ratings
        WHERE imported_at IS NULL AND created_at >= ? GROUP BY day`,
    ).bind(since).all<Row>(),
    // Accounts their owners deleted, by the day they did it. A deleted profile
    // is kept 30 days and then purged (jobs.ts), so only the last 30 days can
    // be counted; the page says so instead of drawing empty days as zero.
    db.prepare(
      `SELECT substr(deleted_at, 1, 10) AS day, COUNT(*) AS n FROM profiles pr
        WHERE deleted_at IS NOT NULL AND deleted_at >= ? AND NOT ${robotSql('pr')}
        GROUP BY day`,
    ).bind(since).all<Row>(),
    // First store purchase of Plus (rc.ts sets plus_since once). Gifts set
    // plus_until instead, so they are not counted here.
    db.prepare(
      `SELECT substr(plus_since, 1, 10) AS day, COUNT(*) AS n FROM profiles pr
        WHERE plus_since IS NOT NULL AND plus_since >= ? AND NOT ${robotSql('pr')}
        GROUP BY day`,
    ).bind(since).all<Row>(),
    // Of the people who joined on a day, how many opened the app the next day
    // (d1) and within the next seven (d7), from profile_days. Counts only.
    db.prepare(
      `SELECT substr(pr.created_at, 1, 10) AS day, COUNT(*) AS joined,
              SUM(EXISTS (SELECT 1 FROM profile_days d WHERE d.profile_id = pr.id
                            AND d.day = date(substr(pr.created_at, 1, 10), '+1 day'))) AS d1,
              SUM(EXISTS (SELECT 1 FROM profile_days d WHERE d.profile_id = pr.id
                            AND d.day > substr(pr.created_at, 1, 10)
                            AND d.day <= date(substr(pr.created_at, 1, 10), '+7 day'))) AS d7
         FROM profiles pr
        WHERE deleted_at IS NULL AND created_at >= ? AND NOT ${robotSql('pr')}
        GROUP BY day`,
    ).bind(since).all<{ day: string; joined: number; d1: number; d7: number }>(),
    db.prepare(
      `SELECT substr(created_at, 1, 10) AS day, COUNT(DISTINCT profile_id) AS n FROM sync_ops
        WHERE created_at >= ? GROUP BY day`,
    ).bind(since).all<Row>(),
    db.prepare('SELECT day, COUNT(*) AS n FROM backup_days WHERE day >= ? GROUP BY day').bind(since).all<Row>(),
  ]);
  // A day's next-day return is only known once that next day is over, so the
  // last two days are left out rather than drawn as zero.
  const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  const returnedRows = (returned.results ?? [])
    .filter((r) => r.day < yesterday && r.joined > 0)
    .map((r) => ({ day: r.day, n: Math.round((100 * r.d1) / r.joined), joined: r.joined, d1: r.d1, d7: r.d7 }));
  // Plus in use: people who backed up and people whose phones synced, one bar.
  const usage = new Map<string, { day: string; n: number; b: number; s: number }>();
  for (const r of backups.results ?? []) usage.set(r.day, { day: r.day, n: r.n, b: r.n, s: 0 });
  for (const r of syncs.results ?? []) {
    const u = usage.get(r.day) ?? { day: r.day, n: 0, b: 0, s: 0 };
    u.s = r.n; u.n = u.b + u.s; usage.set(r.day, u);
  }
  const first = await db.prepare('SELECT MIN(day) AS d FROM profile_days').first<{ d: string | null }>();
  return c.json(
    {
      days,
      today: new Date().toISOString().slice(0, 10),
      openedSince: first?.d ?? null,
      series: {
        joins: joins.results ?? [],
        opened: opened.results ?? [],
        comments: comments.results ?? [],
        ratings: ratings.results ?? [],
        deletes: deletes.results ?? [],
        plus: plus.results ?? [],
        returned: returnedRows,
        method: joins.results ?? [],
        usage: [...usage.values()],
      },
    },
    200,
    { 'Cache-Control': 'no-store' },
  );
});
