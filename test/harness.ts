import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import type { Env } from '@/env';
import worker from '@/index';
import { d1 } from '@/adapters/d1-sqlite';

export { d1 };
import { sign } from '@/session';

/**
 * The in-memory database every test that touches SQL runs against.
 *
 * The schema is READ FROM THE MIGRATION FILES, never restated here. A copied
 * schema drifts from the real one the first time a migration lands, and a test
 * that passes against a schema production does not have is worse than no test.
 * **Every new migration goes in this list.**
 */
const MIGRATION_FILES = [
  '../migrations/0001_initial.sql',
  '../migrations/0002_comment_hidden.sql',
  '../migrations/0003_character_votes.sql',
  '../migrations/0004_score_distribution.sql',
  '../migrations/0005_emotion_votes.sql',
  '../migrations/0006_published_profile.sql',
  '../migrations/0007_profile_movie_stats.sql',
  '../migrations/0008_profile_title_fav_rank.sql',
  '../migrations/0009_push_tokens.sql',
  '../migrations/0010_list_item_poster.sql',
  '../migrations/0011_list_position.sql',
  '../migrations/0012_profile_cover.sql',
  '../migrations/0013_email_credentials.sql',
  '../migrations/0014_session_epoch.sql',
  '../migrations/0015_verify_code.sql',
  '../migrations/0016_comment_parent_index.sql',
  '../migrations/0017_plus_flag.sql',
  '../migrations/0018_profile_theme.sql',
  '../migrations/0019_profile_layout.sql',
  '../migrations/0020_follow_state.sql',
  '../migrations/0021_profile_hidden_sections.sql',
  '../migrations/0022_profile_widgets.sql',
  '../migrations/0023_comment_translations.sql',
  '../migrations/0024_links.sql',
  '../migrations/0025_shared_lists.sql',
  '../migrations/0026_last_seen.sql',
  '../migrations/0027_movie_uuids.sql',
  '../migrations/0028_movie_uuid_ids.sql',
  '../migrations/0029_imported_at.sql',
  '../migrations/0030_imported_at_by_burst.sql',
  '../migrations/0031_app_version.sql',
  '../migrations/0032_character_votes_per_episode.sql',
  '../migrations/0033_sync_ops.sql',
  '../migrations/0034_auto_verified.sql',
  '../migrations/0035_image_asset_id.sql',
  '../migrations/0036_commsuni_consent.sql',
  '../migrations/0037_title_names.sql',
  '../migrations/0038_profile_days.sql',
  '../migrations/0039_notification_body.sql',
  '../migrations/0040_emotion_votes_activity.sql',
  '../migrations/0041_comment_commsuni_id.sql',
  '../migrations/0042_profile_cover_frame.sql',
  '../migrations/0043_title_key_indexes.sql',
  '../migrations/0044_profile_stats_day_base.sql',
  '../migrations/0045_rc_anonymous_purchases.sql',
  '../migrations/0046_plus_thanked.sql',
  '../migrations/0047_shelf_seen.sql',
  '../migrations/0048_backup_sync_seen.sql',
  '../migrations/0049_joined_at.sql',
  '../migrations/0050_support_chat.sql',
  '../migrations/0051_publish_state.sql',
  '../migrations/0052_profile_publisher.sql',
  '../migrations/0053_profile_templates.sql',
  '../migrations/0054_devices.sql',
  '../migrations/0055_feed.sql',
  '../migrations/0056_together.sql',
  '../migrations/0057_support_push.sql',
  '../migrations/0058_plus_expires.sql',
  '../migrations/0059_blocks_blocked_index.sql',
  '../migrations/0060_backup_days.sql',
  '../migrations/0061_personal_offers.sql',
  '../migrations/0062_tvtime_thread_ids.sql',
];

export const MIGRATIONS = MIGRATION_FILES.map((p) =>
  readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8'),
);

export function freshDatabase(): { raw: Database.Database; db: D1Database } {
  const raw = new Database(':memory:');
  raw.pragma('foreign_keys = ON');
  for (const sql of MIGRATIONS) raw.exec(sql);
  return { raw, db: d1(raw) };
}

// ── the Worker, driven end to end ────────────────────────────────────────────

/**
 * `caches.default` does not exist outside workerd, and the edge-cached reads
 * (`GET /v1/aggregates`, `GET /v1/character-votes`) reach for it on every call.
 * A permanent MISS is the honest stand-in: it exercises the D1 path, which is
 * the half a test can be wrong about.
 */
const noCache = {
  async match() {
    return undefined;
  },
  async put() {
    /* the response is consumed and dropped */
  },
};
(globalThis as unknown as { caches: unknown }).caches = { default: noCache };

/**
 * An R2 bucket that keeps what it is given, in a Map.
 *
 * `stored` is exposed so a test can assert the bytes and the content type
 * actually reached storage rather than trusting the 200.
 *
 * `get` EXISTS NOW, and the note that used to sit here — "only `put` is
 * implemented because only `put` is called" — was true when it was written and
 * quietly stopped being true when `GET /v1/comments/:id/image` was added. The
 * effect was not a failing test but an ABSENT one: the route that serves every
 * picture in the app had no coverage at all, and the first test to reach for it
 * got a 500 from a missing method rather than an answer about the route.
 *
 * The bytes are kept, not just their length, because a serving test that
 * cannot compare what came back to what went in is only testing the status
 * code.
 */
type Stored = { size: number; type?: string; custom?: Record<string, string> };

export function fakeBucket(): R2Bucket & { stored: Map<string, Stored> } {
  const stored = new Map<string, Stored>();
  const bytes = new Map<string, Uint8Array>();
  return {
    stored,
    async put(
      key: string,
      value: ArrayBuffer,
      opts?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> },
    ) {
      stored.set(key, {
        size: value.byteLength,
        type: opts?.httpMetadata?.contentType,
        custom: opts?.customMetadata,
      });
      bytes.set(key, new Uint8Array(value));
      return {} as never;
    },
    async get(key: string) {
      const body = bytes.get(key);
      // A miss is `null`, exactly as R2 answers it — the route treats that as a
      // 404, and a stub that threw instead would hide that branch.
      if (!body) return null;
      return { body, httpMetadata: { contentType: stored.get(key)?.type } } as never;
    },
    // `head` and `delete` exist because the backup routes use them: an info
    // route that never downloads the ZIP, and a delete that must stay
    // idempotent. A stub missing either turns a real branch into a TypeError.
    async head(key: string) {
      const meta = stored.get(key);
      if (!meta) return null;
      return {
        size: meta.size,
        uploaded: new Date('2026-09-10T00:00:00.000Z'),
        customMetadata: meta.custom ?? {},
      } as never;
    },
    async delete(key: string) {
      stored.delete(key);
      bytes.delete(key);
    },
    // `list` arrived with per-device backup keys. Before that the routes only
    // ever addressed one known key per profile; now they have to ask what is
    // there, and a harness without this turns that question into a TypeError.
    async list(opts?: { prefix?: string }) {
      const prefix = opts?.prefix ?? '';
      const objects = [...stored.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([key, meta]) => ({
          key,
          size: meta.size,
          uploaded: new Date('2026-09-10T00:00:00.000Z'),
          customMetadata: meta.custom ?? {},
        }));
      return { objects, truncated: false } as never;
    },
  } as unknown as R2Bucket & { stored: Map<string, Stored> };
}

/** The smallest KV that behaves: get/put/delete over a Map, per environment. */
export function kv(): KVNamespace {
  const store = new Map<string, string>();
  return {
    // The TYPE ARGUMENT MATTERS. Real KV parses when asked for 'json' and
    // returns a string otherwise; a stub that always returns the string makes
    // every `get(key, 'json')` read as a miss — which silently disabled the
    // rate limiters under test while they worked perfectly in production.
    async get(key: string, type?: string) {
      const raw = store.get(key) ?? null;
      if (raw === null || type !== 'json') return raw;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
  } as unknown as KVNamespace;
}

export function makeEnv(db: D1Database, bucket?: R2Bucket, backups?: R2Bucket): Env {
  return {
    DB: db,
    // A real little KV, because the auth path now reads it: the session epoch
    // lives here, and `{}` meant every `get` threw and every revocation was
    // silently a no-op — a test suite that could not fail on the one thing
    // revocation exists to do.
    CACHE: kv(),
    SESSION_SECRET: 'test-secret-not-a-real-one',
    /* A CONFIGURED INSTANCE IS THE DEFAULT THESE TESTS DESCRIBE. Without this
       the suite would silently become a self-hosted box with no mail, where
       registrations confirm themselves -- a real path, tested on its own, but
       not the one every other assertion here is about. */
    MAIL_FROM: 'OpenTV <test@example.com>',
    RESEND_API_KEY: 'test-key-never-called',
    APPLE_BUNDLE_ID: 'com.insightfy.opentv',
    GOOGLE_CLIENT_IDS: '',
    // Absent unless a suite asks for it, so every other suite keeps proving the
    // guard: no binding must mean "off", never a crash.
    COMMENT_IMAGES: bucket,
    BACKUPS: backups,
  };
}

/**
 * A request whose body is BYTES, not JSON — what a phone uploading a backup
 * ZIP actually sends. `call` stringifies its body, which turns a Uint8Array
 * into `{"0":80,"1":75,...}` and a size test into nonsense.
 */
export async function callBytes(
  env: Env,
  method: string,
  path: string,
  body: Uint8Array | undefined,
  opts: { token?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; json: any; bytes: Uint8Array }> {
  const headers = new Headers(opts.headers ?? {});
  if (opts.token) headers.set('Authorization', `Bearer ${opts.token}`);
  if (body) headers.set('Content-Type', 'application/zip');
  const res = await worker.fetch(
    // A GET may not carry one at all — `new Request` throws rather than
    // ignoring it, which is how this helper first failed on its own read tests.
    new Request(`https://api.opentv.test${path}`, { method, headers, body }),
    env,
    { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
  );
  const raw = new Uint8Array(await res.arrayBuffer());
  let json: unknown = null;
  try {
    json = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    json = null;
  }
  return { status: res.status, json, bytes: raw };
}

/** A multipart request — the shape `POST /v1/comments/image` takes. `headers`
 *  is for the dashboard's uploads, which sign in with a cookie, not a token. */
export async function callForm(
  env: Env,
  path: string,
  form: FormData,
  token?: string,
  extra: Record<string, string> = {},
): Promise<{ status: number; json: any }> {
  const headers = new Headers(extra);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  // Content-Type is deliberately NOT set: fetch derives it from the FormData,
  // including the multipart boundary, which a hand-written header would omit.
  const res = await worker.fetch(
    new Request(`https://api.opentv.test${path}`, { method: 'POST', headers, body: form }),
    env,
    { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
  );
  const text = await res.text();
  return { status: res.status, json: text.length === 0 ? null : JSON.parse(text) };
}

/** A real session token for a profile id — signed by the same code the Worker verifies with. */
export async function tokenFor(env: Env, profileId: string): Promise<string> {
  return (await sign(env, profileId, Date.now())).token;
}

export type CallOptions = { token?: string; body?: unknown; headers?: Record<string, string> };

/** One request through the actual Worker: routing, middleware, error envelope and all. */
export async function call(
  env: Env,
  method: string,
  path: string,
  opts: CallOptions = {},
): Promise<{ status: number; json: any; text: string; headers: Headers }> {
  const headers = new Headers(opts.headers ?? {});
  if (opts.token) headers.set('Authorization', `Bearer ${opts.token}`);
  if (opts.body !== undefined) headers.set('Content-Type', 'application/json');

  const res = await worker.fetch(
    new Request(`https://api.opentv.test${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }),
    env,
    { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
  );

  const text = await res.text();
  // HEADERS AND RAW TEXT AS WELL AS JSON. A route can be entirely correct in its
  // body and wrong in what it sets — an auth cookie without HttpOnly is the
  // example that prompted this — and a helper that throws the headers away
  // cannot be asked. `json` stays null for a body that is not JSON, so a route
  // answering HTML is testable rather than a parse error.
  let json: unknown = null;
  if (text.length > 0) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { status: res.status, json, text, headers: res.headers };
}

// ── row helpers, shared by every SQL-backed suite ────────────────────────────

export function insertProfile(
  raw: Database.Database,
  id: string,
  handle: string,
  deletedAt: string | null = null,
): void {
  // A community MEMBER by default — every older test means one (0049) — when
  // the schema has the column; tests that stop at an early migration do not.
  const member = (raw.prepare("SELECT 1 FROM pragma_table_info('profiles') WHERE name = 'joined_at'").get() as unknown) != null;
  raw
    .prepare(
      member
        ? `INSERT INTO profiles (id, handle, handle_lower, created_at, deleted_at, joined_at)
           VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z', ?, '2026-01-01T00:00:00.000Z')`
        : `INSERT INTO profiles (id, handle, handle_lower, created_at, deleted_at)
           VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z', ?)`,
    )
    .run(id, handle, handle.toLowerCase(), deletedAt);
}

export function insertBlock(raw: Database.Database, blocker: string, blocked: string): void {
  raw
    .prepare(
      `INSERT INTO blocks (blocker_id, blocked_id, created_at)
       VALUES (?, ?, '2026-01-01T00:00:00.000Z')`,
    )
    .run(blocker, blocked);
}
