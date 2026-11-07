import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

/**
 * The Worker's bindings and the per-request variables handlers set.
 *
 * Lives in its own file rather than in `index.ts` so that `jwks.ts`,
 * `session.ts` and the route modules can name the type without importing the
 * module that imports them.
 */
export type Env = {
  DB: D1Database;
  CACHE: KVNamespace;

  /** HS256 signing key for session tokens. `wrangler secret put` in production. */
  SESSION_SECRET: string;
  /** The iOS bundle id — the `aud` an Apple ID token must carry. */
  APPLE_BUNDLE_ID: string;
  /**
   * Comma-separated Google OAuth client ids: iOS, Android **and Web**. Android
   * sign-in returns the *web* client id as `aud`, which is the classic trap.
   */
  GOOGLE_CLIENT_IDS: string;

  /** Profile pictures and covers. Guarded everywhere it is touched. */
  AVATARS?: R2Bucket;

  /**
   * Library backups — one opaque ZIP per profile. See `routes/backup.ts`.
   *
   * Optional like every other capability: a deployment without it answers 503
   * on upload and "no backup" on the info route, so the app simply never
   * offers the row. Nothing else on the server reads this bucket.
   */
  BACKUPS?: R2Bucket;

  /**
   * The development Plus switch — see `routes/dev.ts`.
   *
   * UNSET IN PRODUCTION, and that is the whole guard: without it the route
   * 404s, so a deployment that never sets it does not have the feature. Set it
   * only where the tier is being tested before it can be bought:
   *   wrangler secret put DEV_PLUS_SECRET
   */
  DEV_PLUS_SECRET?: string;

  /**
   * Workers AI — translating comments, and nothing else.
   *
   * OPTIONAL, like every other capability here: absent means the Translate row
   * never appears rather than a route that 500s. It is also why translation is
   * allowed at all — the comment is already on this server, so running the
   * model here sends it nowhere new, which would not be true of Google
   * Translate or DeepL.
   */
  AI?: Ai;

  /**
   * Shared secret for the `/v1/admin/*` routes — moderation and the comment
   * image queue. `wrangler secret put ADMIN_SECRET`. Absent means the admin
   * surface is OFF (every admin route 404s), so a deployment without it
   * exposes nothing until the operator opts in by setting it.
   */
  ADMIN_SECRET?: string;

  /**
   * Sending email — verification and password resets.
   *
   * ALL OPTIONAL, and email sign-in works without them: an account is created
   * and a token issued whether or not a message can go out. Missing means "no
   * mail configured yet", never a failed signup. See `mail.ts`.
   */
  /** Cloudflare Email Sending binding (`send_email` in wrangler.jsonc). Preferred over Resend when present. */
  EMAIL?: { send(msg: { to: string; from: { email: string; name?: string }; subject: string; text: string; html: string }): Promise<unknown> };
  RESEND_API_KEY?: string;
  /** e.g. `OpenTV <noreply@theopentv.com>`. The domain must be onboarded for Email Sending (or verified with Resend). */
  MAIL_FROM?: string;
  /**
   * CommsUni's API key, and the reason it lives here rather than on the phone.
   *
   * `mobile/src/commsuni.ts` says it out loud: nothing in the app talks to
   * api.commsuni.tv directly. A key shipped inside an app binary is a
   * published key — anybody can pull it out of the IPA — and this one is a
   * live credential against somebody else's service, so the Worker proxies
   * every call and the phone never sees it.
   *
   * A SECRET, never a var. `wrangler secret put COMMSUNI_API_KEY`; locally,
   * `.dev.vars`, which is gitignored. Optional in the type because a
   * deployment without it must still start — every CommsUni route answers
   * `not_configured` rather than throwing, the same shape `mail.ts` uses for
   * an unset `RESEND_API_KEY`.
   */
  COMMSUNI_API_KEY?: string;
  /**
   * "off" closes email SIGN-UP, and nothing else.
   *
   * A kill switch rather than a code change, because the reason to use it is
   * always "right now": 1.3.0 shipped a claim that cannot succeed on an
   * unverified session, so every account made with an address was stranded on a
   * `user_p_…` handle it had no way to change. Blocking new ones for a day
   * costs a few sign-ups; letting them through costs those people their name.
   *
   * Sign-IN stays open — the people already stuck must still be able to get in
   * and be repaired by the next release. Apple and Google are unaffected: they
   * arrive verified, so the bug never applied to them.
   */
  EMAIL_SIGNUP?: string;
  /**
   * The admin dashboard's two credentials, both SECRETS — never vars, because
   * vars live in wrangler.jsonc and wrangler.jsonc lives in git.
   *
   * Unset means the door is closed: `/v1/admin/login` answers 503 rather than
   * comparing against undefined and letting anybody in.
   */
  ADMIN_EMAIL?: string;
  ADMIN_PASSWORD?: string;
  /** Deep links the emails point at. Defaults are the app's own scheme. */
  APP_LINK_BASE?: string;
  APP_RESET_LINK_BASE?: string;

  /**
   * Where a rescued TV Time comment photo is kept.
   *
   * OPTIONAL, and every use is guarded, for the same reason `AVATARS` is: a
   * missing binding must degrade to "this feature is off" rather than throw on
   * a request that had nothing to do with images.
   */
  COMMENT_IMAGES?: R2Bucket;

  /**
   * The exact string RevenueCat is configured to send as the `Authorization`
   * header of its webhook — RC has no signature scheme, only this shared
   * secret, so it IS the whole of the authentication.
   *
   * `wrangler secret put RC_WEBHOOK_SECRET`, and paste the same value into
   * RevenueCat → Integrations → Webhooks → Authorization header.
   *
   * Unset means the door is closed, exactly as with ADMIN_PASSWORD: the route
   * answers 503 rather than comparing against undefined and letting anybody
   * grant themselves Plus. A deployment that has not opted in has no webhook.
   */
  RC_WEBHOOK_SECRET?: string;
  /**
   * A RevenueCat SECRET API key (read-only is enough), for asking RevenueCat
   * directly whether a profile has Plus — the safety net under the webhook.
   * Unset: that check is skipped and everything else works as before.
   */
  RC_SECRET_API_KEY?: string;

  /**
   * SET ONLY BY `selfhost/server.ts`. Never on the hosted Worker.
   *
   * On somebody's own instance there is no RevenueCat and never will be, so
   * every profile reads `is_plus = 0` — and the routes that ask turned a
   * person's own server into one that told them to buy Plus from us to use
   * their own disk. Plus pays for the hosted side; a self-hoster is already
   * paying for theirs.
   *
   * It grants nothing on the client: `applyEntitlement` still refuses to let a
   * custom server claim Plus (see `plus.ts`), so this cannot be used to hand
   * strangers a paid tier — it only stops a server refusing its own owner.
   */
  SELF_HOSTED?: string;

  /**
   * The live room — one `EpisodeRoom` Durable Object per episode-night. See
   * `src/rooms.ts`.
   *
   * OPTIONAL like every capability: `selfhost/server.ts` runs on Node, which
   * has no Durable Object runtime, so it never sets this and every room route
   * answers `not_configured`. The app then never draws the pill.
   */
  ROOMS?: DurableObjectNamespace;

  /**
   * OpenTV inside Claude and ChatGPT (2.3.0) — see `src/mcp/` and `src/worker.ts`.
   *
   * `OAUTH_KV` is the OAuth library's own store: clients, grants, hashed
   * tokens, props encrypted under the token. Nothing of the library in it.
   * `OAUTH_PROVIDER` is not a binding: `OAuthProvider` puts its helpers on the
   * env it hands the Hono app, which is how `/authorize` and the connection
   * routes reach them. Both absent under Node (`selfhost/`, the tests unless a
   * suite adds them), where every MCP route answers `not_configured`.
   *
   * `MCP_ORIGIN` is the public origin the connector URL is built on. Tokens
   * are bound to `<origin>/mcp`, so it has to be the address people paste.
   */
  OAUTH_KV?: KVNamespace;
  OAUTH_PROVIDER?: OAuthHelpers;
  MCP_ORIGIN?: string;
  /**
   * Google and Apple on `/authorize` (7 Nov). Each button appears only once
   * its id is set: the web OAuth client with
   * `<MCP_ORIGIN>/authorize/google/callback` as a redirect URI, and an Apple
   * Services ID with `<MCP_ORIGIN>/authorize/apple/callback` as a return URL.
   */
  GOOGLE_WEB_CLIENT_ID?: string;
  APPLE_SERVICE_ID?: string;
};

/** What `requireAuth` puts on the context. */
export type Vars = {
  profileId: string;
  /** 'unverified' for an email account that has not entered its code yet. See
   *  `requireVerified` — the claim rides in the token so auth stays zero-I/O. */
  scope: 'full' | 'unverified';
  /** When the presented token was issued (seconds), and its revocation epoch. */
  tokenIat: number;
  tokenEpoch: number;
};

export type App = { Bindings: Env; Variables: Vars };
