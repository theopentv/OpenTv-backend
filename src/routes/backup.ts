import { Hono, type Context } from 'hono';
import type { App } from '@/env';
import { fail } from '@/http';
import { hasPlus, requireAuth } from '@/middleware';
import { plusOn, readDevice } from '@/pure';

/**
 * The library, kept somewhere that is not the phone.
 *
 * WHY THIS EXISTS, GIVEN THE WHOLE APP IS BUILT NOT TO NEED IT. The phone's
 * SQLite database is still the source of truth and nothing here changes that.
 * But a decade of watch history that exists on exactly one device is one
 * dropped phone away from gone, and iCloud and Google Drive each solve that for
 * half the users and neither solves it for somebody moving between the two.
 * This is the third destination, and it is the only one that crosses.
 *
 * WHAT IS ACTUALLY STORED: one object per profile, overwritten in place — the
 * same TV Time-format ZIP `exporter.ts` builds, byte for byte, the same one
 * iCloud and Drive already hold. No new format, no server-side parsing, and no
 * watch-history TABLE: this server still cannot answer "what did they watch",
 * because the answer is a ZIP it never opens.
 *
 * ⚠️ STORED AS SENT, NOT ENCRYPTED BY US. The bytes travel over TLS and sit in
 * R2 at rest, but a copy of somebody's library is on this server, readable by
 * whoever holds the R2 credentials — which is a real change from "your library
 * never leaves your phone" and must be said plainly wherever it is offered.
 * That is why the whole feature is opt-in and off by default, why the settings
 * row says it in those words, and why `DELETE` below exists and is not gated on
 * anything. If this is ever encrypted on the device, only the phone changes:
 * this route already treats the body as opaque.
 *
 * PLUS GATES WRITING, NEVER READING. Uploading needs a subscription; getting
 * the copy back and deleting it do not. A backup that becomes unreachable when
 * a card expires is not a backup, it is a hostage — and the one promise this
 * project cannot break is that a user's own history is theirs.
 */

export const backup = new Hono<App>();

/**
 * ONE OBJECT PER DEVICE, not per profile.
 *
 * It was per profile — `backups/<profileId>.zip`, overwritten in place — and
 * that is a last-writer-wins race between a reader's own phones. Watched on
 * 21 Sep: the cloud copy went from a 1,260-episode library to a 1,042-episode
 * one and back again, twice, in an afternoon, because two devices at slightly
 * different sync states each believed they were backing up "the" library.
 *
 * It was survivable only because each device still had its own copy locally.
 * The case it was never survivable for is the one the feature exists for: a
 * THIRD device, restoring, taking whatever happened to be up there at that
 * second.
 *
 * So each device writes its own key and nothing overwrites anybody. Choosing
 * between them becomes a question with an answer instead of a coin toss — see
 * `pickBest`.
 *
 * The profile id still comes from the session and never from input. The device
 * id does come from input, so it is pattern-checked before it goes anywhere
 * near a key: it is a path segment, and a client that could put `../` in it
 * could write outside the prefix.
 */
const prefixFor = (profileId: string): string => `backups/${profileId}/`;
const keyFor = (profileId: string, device: string): string => `${prefixFor(profileId)}${device}.zip`;

/** Where single-key backups written before this change still live. Read, never
 *  written, and never deleted on somebody else's behalf: it may be the only
 *  copy a not-yet-updated device has. */
const legacyKeyFor = (profileId: string): string => `backups/${profileId}.zip`;


/**
 * Generous next to what a real library measures. The heaviest genuine export
 * seen is 194 KB compressed — these are CSVs, not images — so this is a guard
 * against something having gone wrong, not a budget anybody spends.
 */
export const MAX_BACKUP_BYTES = 25 * 1024 * 1024;

/** The counts the welcome screen greets somebody with, carried beside the ZIP
 *  rather than inside it so a phone can ask "what is up there" without
 *  downloading a library to find out. Base64 because a handle is not ASCII. */
type BackupInfo = {
  username?: string | null;
  shows?: number | null;
  episodes?: number | null;
  movies?: number | null;
};

/**
 * UTF-8 THROUGH BASE64, NOT `atob` ALONE. `atob` yields one character per
 * BYTE, so a handle written in Arabic — or any name outside Latin-1 — comes
 * back as mojibake if the result is parsed as a string. The phone encodes
 * UTF-8 before base64 (`stringToB64` in `backup.ts`), so this has to decode it
 * the same way round.
 */
function decodeUtf8B64(raw: string): string {
  const bin = atob(raw);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function readInfoHeader(raw: string | undefined): BackupInfo {
  if (!raw) return {};
  try {
    const json = JSON.parse(decodeUtf8B64(raw)) as unknown;
    if (!json || typeof json !== 'object') return {};
    const o = json as Record<string, unknown>;
    const num = (v: unknown): number | null => (typeof v === 'number' && isFinite(v) ? v : null);
    return {
      // Capped rather than validated: this is redisplayed to its own owner and
      // to nobody else, so the only thing worth defending against is size.
      username: typeof o.username === 'string' ? o.username.slice(0, 64) : null,
      shows: num(o.shows),
      episodes: num(o.episodes),
      movies: num(o.movies),
    };
  } catch {
    // A malformed header must not fail an upload that is otherwise fine. The
    // ZIP is the backup; this is a label on it.
    return {};
  }
}

/** R2 custom metadata is a string map, so the counts go out and come back as
 *  strings. Kept in one place so the two directions cannot drift. */
const toMetadata = (i: BackupInfo): Record<string, string> => {
  const out: Record<string, string> = {};
  if (i.username) out.username = i.username;
  if (i.shows != null) out.shows = String(i.shows);
  if (i.episodes != null) out.episodes = String(i.episodes);
  if (i.movies != null) out.movies = String(i.movies);
  return out;
};

const fromMetadata = (m: Record<string, string> | undefined): BackupInfo => {
  const n = (v: string | undefined): number | null => (v == null || v === '' ? null : Number(v));
  return {
    username: m?.username ?? null,
    shows: n(m?.shows),
    episodes: n(m?.episodes),
    movies: n(m?.movies),
  };
};

/** One stored backup, as the phone sees it. `device` is null for the single
 *  pre-per-device object. */
type StoredBackup = BackupInfo & { device: string | null; size: number; updatedAt: string | null };

/**
 * Every backup this profile has, newest first.
 *
 * One page is deliberate. This lists a reader's own devices — two, sometimes
 * three — and a profile with more than a thousand of them has a problem that
 * paginating here would hide rather than solve.
 */
async function listBackups(bucket: R2Bucket, profileId: string): Promise<StoredBackup[]> {
  const out: StoredBackup[] = [];
  const prefix = prefixFor(profileId);
  const listed = await bucket.list({ prefix, include: ['customMetadata'] });
  for (const o of listed.objects ?? []) {
    if (!o.key.endsWith('.zip')) continue;
    out.push({
      device: o.key.slice(prefix.length, -'.zip'.length),
      size: o.size,
      updatedAt: o.uploaded?.toISOString?.() ?? null,
      ...fromMetadata(o.customMetadata),
    });
  }
  const legacy = await bucket.head(legacyKeyFor(profileId));
  if (legacy) {
    out.push({
      device: null,
      size: legacy.size,
      updatedAt: legacy.uploaded?.toISOString?.() ?? null,
      ...fromMetadata(legacy.customMetadata),
    });
  }
  return out.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
}

/**
 * Which one a restore gets when the caller does not say.
 *
 * THE FULLEST, NOT THE NEWEST, and that is a deliberate answer to the bug this
 * route was changed for. Two devices at different sync states produce two
 * honest backups, and the later one is not the better one — on 21 Sep the
 * newer copy was the 1,042-episode one. Somebody restoring is trying not to
 * lose a decade; handing them the smaller library because it was uploaded four
 * minutes more recently is precisely the failure.
 *
 * Newest only breaks ties, and the import is a merge anyway: restoring the
 * fuller copy can never delete anything the other one had.
 */
function pickBest(all: StoredBackup[]): StoredBackup | null {
  if (all.length === 0) return null;
  return all.reduce((best, b) => {
    const be = b.episodes ?? -1;
    const bestEp = best.episodes ?? -1;
    if (be !== bestEp) return be > bestEp ? b : best;
    return (b.updatedAt ?? '') > (best.updatedAt ?? '') ? b : best;
  });
}

/** Plus, including the self-hosted case — see `hasPlus` in `middleware.ts`. */
const isPlus = hasPlus;

// ── write ────────────────────────────────────────────────────────────────────

backup.post('/backup', requireAuth, async (c) => {
  const bucket = c.env.BACKUPS;
  if (!bucket) return fail(c, 503, 'unavailable', 'Cloud backup is not configured.');
  if (!(await isPlus(c)))
    return fail(c, 402, 'plus_required', 'Cloud backup needs OpenTV Plus.');

  const body = await c.req.arrayBuffer();
  if (body.byteLength === 0) return fail(c, 400, 'invalid_body', 'Empty backup.');
  if (body.byteLength > MAX_BACKUP_BYTES)
    return fail(c, 413, 'too_large', 'That backup is larger than this server accepts.');

  const info = readInfoHeader(c.req.header('X-OpenTV-Backup-Info'));
  // A client that sends no device id keeps the old single key. That is not
  // politeness towards old builds — it is the only safe thing to do: writing
  // an unidentified upload under a made-up device id would put a second,
  // permanent, unattributable copy in the list every time it ran.
  const device = readDevice(c.req.header('X-OpenTV-Device'));
  const profileId = c.get('profileId');
  await bucket.put(device ? keyFor(profileId, device) : legacyKeyFor(profileId), body, {
    httpMetadata: { contentType: 'application/zip' },
    customMetadata: toMetadata(info),
  });

  const updatedAt = new Date().toISOString();
  // For the dashboard's Backup column: when, and how big. Never what.
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE profiles SET backup_at = ?, backup_bytes = ? WHERE id = ?').bind(updatedAt, body.byteLength, profileId),
    // the dashboard's daily count (migration 0060); kept 90 days like profile_days
    c.env.DB.prepare('INSERT OR IGNORE INTO backup_days (profile_id, day) VALUES (?, ?)').bind(profileId, updatedAt.slice(0, 10)),
    c.env.DB.prepare("DELETE FROM backup_days WHERE profile_id = ? AND day < date('now', '-90 days')").bind(profileId),
  ]);
  return c.json({ ok: true, size: body.byteLength, updatedAt, device });
});

// ── read ─────────────────────────────────────────────────────────────────────

/**
 * What is up there, without downloading it — the question the welcome screen
 * asks on a fresh install, where the answer decides whether a "restore your
 * library" button appears at all.
 */
backup.get('/backup/info', requireAuth, async (c) => {
  const bucket = c.env.BACKUPS;
  if (!bucket) return c.json({ exists: false });

  const all = await listBackups(bucket, c.get('profileId'));
  const best = pickBest(all);
  if (!best) return c.json({ exists: false });

  // THE TOP LEVEL DESCRIBES WHAT `GET /backup` WITHOUT A DEVICE WOULD RETURN,
  // and it has to keep doing so: a build that predates `devices` reads these
  // fields and then downloads, and the two must be the same object or the
  // welcome screen promises a library it does not hand over.
  return c.json({
    exists: true,
    size: best.size,
    updatedAt: best.updatedAt,
    username: best.username ?? null,
    shows: best.shows ?? null,
    episodes: best.episodes ?? null,
    movies: best.movies ?? null,
    device: best.device,
    // Everything, so a phone can offer the choice rather than be handed one.
    devices: all,
  });
});

/** The ZIP itself. Not Plus-gated — see the header. */
backup.get('/backup', requireAuth, async (c) => {
  const bucket = c.env.BACKUPS;
  if (!bucket) return fail(c, 503, 'unavailable', 'Cloud backup is not configured.');

  const profileId = c.get('profileId');
  // `?device=` when the reader has chosen one; otherwise the fullest, which is
  // the same object `/backup/info` just described.
  const asked = readDevice(c.req.query('device') ?? undefined);
  let key: string | null = null;
  if (asked) {
    key = keyFor(profileId, asked);
  } else if (c.req.query('device') === 'legacy') {
    key = legacyKeyFor(profileId);
  } else {
    const best = pickBest(await listBackups(bucket, profileId));
    if (best) key = best.device ? keyFor(profileId, best.device) : legacyKeyFor(profileId);
  }

  const object = key ? await bucket.get(key) : null;
  if (!object) return fail(c, 404, 'not_found', 'There is no backup for this account.');

  return new Response(object.body, {
    headers: {
      'Content-Type': 'application/zip',
      // Never cached: a backup that answers with last week's copy is worse
      // than one that answers with nothing.
      'Cache-Control': 'no-store',
    },
  });
});

// ── delete ───────────────────────────────────────────────────────────────────

/**
 * Take it back off the server. Deliberately ungated and deliberately
 * unconfirmed here — the phone asks; this obeys. Idempotent, so a second press
 * after a dropped connection is not an error.
 */
backup.delete('/backup', requireAuth, async (c) => {
  const bucket = c.env.BACKUPS;
  if (!bucket) return c.json({ ok: true });
  const profileId = c.get('profileId');

  // ALL OF THEM, unless one is named. "Take my library off your server" is the
  // request being made, and leaving the other phone's copy up there would be
  // answering a different one. `?device=` exists for a reader who wants to
  // drop a phone they no longer own without touching the rest.
  const asked = readDevice(c.req.query('device') ?? undefined);
  if (asked) {
    await bucket.delete(keyFor(profileId, asked));
    return c.json({ ok: true });
  }
  for (const b of await listBackups(bucket, profileId)) {
    await bucket.delete(b.device ? keyFor(profileId, b.device) : legacyKeyFor(profileId));
  }
  return c.json({ ok: true });
});
