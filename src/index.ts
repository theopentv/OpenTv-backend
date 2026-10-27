import { supportChat } from '@/routes/support-chat';
import { Hono } from 'hono';
import type { App, Env } from '@/env';
import { fail } from '@/http';
import { runMaintenance } from '@/jobs';
import { verifyScoped } from '@/session';
import { auth } from '@/routes/auth';
import { avatars } from '@/routes/avatars';
import { backup } from '@/routes/backup';
import { sync } from '@/routes/sync';
import { blocks } from '@/routes/blocks';
import { characterVotes } from '@/routes/characters';
import { images } from '@/routes/images';
import { published } from '@/routes/published';
import { comments } from '@/routes/comments';
import { commsuni } from '@/routes/commsuni';
import { emailAuth } from '@/routes/email-auth';
import { feed } from '@/routes/feed';
import { follows } from '@/routes/follows';
import { seeding } from '@/routes/import';
import { notifications } from '@/routes/notifications';
import { push } from '@/routes/push';
import { web } from '@/routes/web';
import { profiles } from '@/routes/profiles';
import { ratings } from '@/routes/ratings';
import { rc } from '@/routes/rc';
import { freeMonth } from '@/routes/free-month';
import { ADMIN_PAGE } from '@/admin-page';
import { admin } from '@/routes/admin';
import { reconcile } from '@/routes/reconcile';
import { reports } from '@/routes/reports';
import { dev } from '@/routes/dev';
import { sharedLists } from '@/routes/shared-lists';
import { movieNames } from '@/routes/movie-names';
import { links } from '@/routes/links';
import { translate } from '@/routes/translate';
import { rooms } from '@/routes/rooms';

export type { Env } from '@/env';
// The live room's Durable Object class. wrangler finds it by this export.
export { EpisodeRoom } from '@/rooms';

const app = new Hono<App>();

/**
 * Liveness. Touches D1 as well as the Worker, because "the Worker is up" and
 * "the database is reachable" fail independently and the difference is the
 * first thing worth knowing at 2am.
 *
 * The only route outside /v1: it is infrastructure, not API.
 */
app.get('/health', async (c) => {
  try {
    await c.env.DB.prepare('SELECT 1').first();
    return c.json({ ok: true, db: true });
  } catch {
    return c.json({ ok: true, db: false }, 503);
  }
});

/**
 * Every API route is mounted under /v1 from day one. Adding a prefix later
 * means a client-side flag day, and this ships to phones that update slowly
 * and to phones that never update.
 */
const v1 = new Hono<App>();

/**
 * AN UNCONFIRMED EMAIL ACCOUNT DOES NOTHING AND SEES NOBODY.
 *
 * Enforced here, once, in front of every route, rather than by adding a
 * middleware to each router — a gate you have to remember to fit is a gate
 * somebody eventually forgets, and the cost of forgetting is an unverified
 * account with the run of the API.
 *
 * It acts only when a token is PRESENT and carries the `unverified` claim, so
 * anonymous requests are unaffected and no unauthenticated route changes
 * behaviour. (Public profile reads are open to anyone with or without a token,
 * by design — this stops the APP from browsing people on an unconfirmed
 * account, which is what a signed-in user can actually do.)
 *
 * The allow-list is the way out and the way back: read your own state, ask for
 * another email, confirm, or delete the account. Nothing else.
 */
/**
 * METHOD AND PATH, never path alone. Listing `/v1/me` on its own let
 * `PATCH /v1/me` through — an unconfirmed account could still edit its display
 * name, bio and links, which is most of what a spam account wants. A test
 * caught it; the allow-list is now exact.
 *
 * `DELETE /v1/me` is here because nobody should be stuck in an account they
 * regret, and that is worth more than anything this gate protects.
 */
const UNVERIFIED_ALLOWED = new Set([
  'GET /v1/me',
  'DELETE /v1/me',
  'POST /v1/me/email/resend',
  'POST /v1/auth/email/verify',
  // Throwing other sessions out is a SECURITY action, and gating one behind a
  // step somebody has not finished is how "someone else is in my account"
  // becomes "and I could not do anything about it".
  'POST /v1/me/sessions/revoke',
]);

v1.use('*', async (c, next) => {
  const header = c.req.header('Authorization') ?? '';
  const match = /^Bearer (.+)$/.exec(header.trim());
  if (match) {
    const session = await verifyScoped(c.env, match[1]!, Date.now());
    if (session?.scope === 'unverified') {
      const path = new URL(c.req.url).pathname;
      if (!UNVERIFIED_ALLOWED.has(`${c.req.method} ${path}`)) {
        return fail(c, 403, 'email_unverified', 'Confirm your email address first.');
      }
    }
  }
  await next();
  return;
});

// BEFORE `auth`, which owns `/me` and `/me/*` and hangs requireAuth off both.
// A router that claims a prefix should not be the one deciding what a path it
// has no handler for means.
v1.route('/', avatars);
v1.route('/', backup);
v1.route('/', sync);
// Before `auth` for the same reason avatars is: that router claims `/auth/*`
// shapes and `/me/*`, and should not be the one deciding what a path it has no
// handler for means.
v1.route('/', emailAuth);
v1.route('/', auth);
v1.route('/', ratings);
// Before `comments`, so POST /v1/comments/import is never read as a comment on
// a thread keyed "import" — and before it now also carries POST
// /v1/ratings/import, which for the same reason must precede nothing else.
v1.route('/', seeding);
v1.route('/', characterVotes);
v1.route('/', images);
v1.route('/', published);
v1.route('/', comments);
v1.route('/', commsuni);
v1.route('/', translate);
v1.route('/', links);
v1.route('/', movieNames);
v1.route('/', dev);
v1.route('/', sharedLists);
v1.route('/', rooms);
v1.route('/', reports);
v1.route('/', blocks);
v1.route('/', follows);
v1.route('/', feed);
v1.route('/', profiles);
v1.route('/', notifications);
v1.route('/', push);
v1.route('/', reconcile);
// Machine-to-machine, authenticated by its own shared secret rather than by a
// session — it belongs to no user, so it sits with `admin` rather than in the
// social routers.
v1.route('/', rc);
v1.route('/', freeMonth);
v1.route('/', supportChat);
v1.route('/', admin);

// ── the dashboard page ───────────────────────────────────────────────────────
//
// Outside /v1 because it is not the API: a browser asks for it by typing the
// address. Served by the Worker rather than Pages so it is same-origin with
// the routes it reads — no CORS to open, and the session can be an HttpOnly
// cookie that no script on the page can read. `noindex` is in the page's own
// meta; this header says it again for anything that only reads headers.
app.get('/admin/dashboard', (c) =>
  c.html(ADMIN_PAGE, 200, { 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-store' }),
);

/*
 * THE SAME PAGE AT dashboard.theopentv.com, because /admin/dashboard on the
 * workers.dev host is a URL nobody can remember or type.
 *
 * Only the ROOT of that subdomain, and only for that hostname. The route in
 * wrangler.jsonc sends every path on it to this Worker, so `/v1/admin/login`
 * and the rest of the API answer there too — which is the point, since the
 * session is a same-origin HttpOnly cookie. Anything else on the subdomain
 * falls through to the API's own 404 rather than serving a page.
 */
app.get('/', (c) =>
  new URL(c.req.url).hostname === 'dashboard.theopentv.com'
    ? c.html(ADMIN_PAGE, 200, { 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-store' })
    : c.notFound(),
);

/*
 * THE PUBLIC WEB PAGE, mounted at the ROOT rather than under /v1 — a profile
 * link is something a person types and shares, and `/v1/` in it would be an
 * API detail leaking into somebody's signature. Read-only and anonymous; see
 * `routes/web.ts`.
 */
app.route('/', web);

app.route('/v1', v1);
/**
 * /v2 IS /v1 — an alias, not a fork. It marks the Plus era in client requests
 * without splitting the API: the same router answers both prefixes, so nothing
 * is maintained twice and the two can never disagree. A real v2 happens the
 * day an existing route has to change meaning, and not before. The Plus-era
 * app calls /v2; every shipped build keeps calling /v1; both hit this code.
 */
app.route('/v2', v1);

/**
 * The safety net. Every route builds its failures with `fail()`, but an
 * *unhandled* throw — a D1 error mid-request, an unforeseen bug — would
 * otherwise return Hono's default 500, which is not the `{error:{code,message}}`
 * envelope the app parses and can echo the raw error text (a SQL message, a
 * stack) straight back to the client. So: log the real thing server-side, where
 * Workers observability keeps it, and hand the client a generic, conforming,
 * leak-free 500.
 */
app.onError((err, c) => {
  console.error('[unhandled]', err instanceof Error ? err.stack ?? err.message : String(err));
  return fail(c, 500, 'internal', 'Something went wrong.');
});

/**
 * Unknown routes answer in the same envelope, so the app's error handling —
 * which switches on `error.code` — never meets a shape it cannot read.
 */
app.notFound((c) => fail(c, 404, 'not_found', 'No such route.'));

/**
 * The 04:00 UTC cron (docs/IMPLEMENTATION.md Step 5). All the work lives in
 * `src/jobs.ts`; this is only the wiring. It awaits rather than handing the
 * promise to `waitUntil`: a scheduled handler that returns early can have its
 * remaining I/O cancelled, and `--test-scheduled` would then answer the curl
 * before the night's work had landed.
 */
const scheduled: ExportedHandlerScheduledHandler<Env> = async (event, env) => {
  console.log(`[maintenance] triggered by cron "${event.cron}"`);
  await runMaintenance(env);
};

export default { fetch: app.fetch, scheduled };
