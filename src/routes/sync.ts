import { Hono, type Context } from 'hono';
import type { App } from '@/env';
import { fail } from '@/http';
import { hasPlus, requireAuth } from '@/middleware';
import { plusOn, readDevice, readDeviceName, readPlatform } from '@/pure';

/**
 * One person's own devices, kept level.
 *
 * WHAT THIS IS NOT. It is not a watch-history table, and `backend/README.md`'s
 * promise is unchanged: this server still cannot answer "what did they watch".
 * These rows are a RELAY. A phone says what it just did in the user's own
 * words — "watched S2E3", "took that rating back" — the tablet collects it and
 * does the same thing locally, and the row is dead weight the moment every
 * device has seen it. The library is still SQLite on each phone. Drop this
 * table whole and every device keeps its complete history, losing only the
 * changes in flight.
 *
 * WHY OPS AND NOT THE BACKUP ZIP, which already exists and already crosses
 * devices. Because the ZIP is a TV Time-format export and a TV Time export is
 * a list of what you HAVE. Un-marking an episode, taking back a rating and
 * deleting a film are absences, and an absence cannot be written into a format
 * whose every row is a presence — so a ZIP-based sync silently resurrects
 * everything the user deleted on the other device, for ever. Intent travels;
 * state does not.
 *
 * WHY INTENT AND NOT ROWS. "Watched S2E3" replayed through the app's own
 * `markWatched` keeps every derived thing — the episode counter, the streak,
 * the widget — correct by construction. Shipping the ROW would mean shipping
 * `episodesSeen` too, and two devices that disagree about a derived number
 * have no way to settle it.
 *
 * ONE ROUND TRIP. Push and pull are the same request because they are the same
 * moment: a device that has something to say almost always wants to hear what
 * it missed, and two calls would double the wake-up cost for nothing.
 *
 * PLUS GATES PUSHING, NEVER PULLING — the rule `backup.ts` already keeps. When
 * a subscription lapses the other devices stop receiving this one's changes,
 * and this one still receives theirs and still holds its own complete library.
 * Nothing a user did becomes unreachable because a card expired.
 */

export const sync = new Hono<App>();

/** A push is a person's phone catching up, not a bulk import. Anything past
 *  this is either a bug or an attempt to fill the table. */
export const MAX_OPS_PER_PUSH = 500;

/** Generous for an op that is at most an id, a season and an episode; small
 *  enough that this table cannot be used as storage. */
export const MAX_PAYLOAD_BYTES = 4096;

/**
 * HOW LONG A MESSAGE IN FLIGHT IS WORTH KEEPING.
 *
 * A device offline longer than this cannot be caught up from here, and is told
 * so — see `reset` below. Ninety days is well past "I left my tablet in a
 * drawer over the summer" and nowhere near "this is where my library lives".
 */
export const RETAIN_DAYS = 90;

export type IncomingOp = { id: string; ts: number; kind: string; payload: string };

/**
 * What a push may contain.
 *
 * REJECTS THE WHOLE BATCH rather than dropping bad entries. A partial apply
 * would move the client's cursor past ops that were never stored, and the
 * user would never learn which of their changes evaporated.
 */
export function validateOps(raw: unknown): IncomingOp[] | string {
  if (!Array.isArray(raw)) return 'ops must be an array';
  if (raw.length > MAX_OPS_PER_PUSH) return 'too many ops';
  const out: IncomingOp[] = [];
  const seen = new Set<string>();
  for (const o of raw) {
    if (!o || typeof o !== 'object') return 'bad op';
    const r = o as Record<string, unknown>;
    if (typeof r.id !== 'string' || !r.id || r.id.length > 80) return 'bad op id';
    if (seen.has(r.id)) return 'duplicate op id';
    seen.add(r.id);
    if (typeof r.kind !== 'string' || !r.kind || r.kind.length > 32) return 'bad op kind';
    if (typeof r.payload !== 'string' || r.payload.length > MAX_PAYLOAD_BYTES) return 'bad op payload';
    // A device clock can be wrong; it cannot be absent. Order is all it is for.
    if (typeof r.ts !== 'number' || !isFinite(r.ts)) return 'bad op ts';
    out.push({ id: r.id, ts: r.ts, kind: r.kind, payload: r.payload });
  }
  return out;
}

/** Plus, including the self-hosted case — see `hasPlus` in `middleware.ts`. */
const isPlus = hasPlus;

/**
 * HOW MANY DEVICES ONE ACCOUNT SYNCS. A phone, a tablet, an old phone not yet
 * wiped, a work phone — five is past any one person and short of a group chat
 * sharing one Plus, which is the only thing this number exists to stop.
 */
export const DEVICE_LIMIT = 5;

/** How stale `devices.last_seen` may get before a sync rewrites it. */
export const LAST_SEEN_EVERY_MS = 60 * 60 * 1000;

/**
 * THE REGISTRY (0054): who this device is, and whether it may still sync.
 *
 * Called on every push and pull, because both are a device being in use, and
 * the list of devices is read from `last_seen`. Three answers:
 *   - `removed`: the owner dropped this device from the list. It is told so
 *     rather than silently re-registered — a lost phone that comes back must
 *     not quietly rejoin.
 *   - `limit`: a device never seen before, and the account already has its
 *     full set. The existing five carry on; this one is turned away.
 *   - null: carry on.
 *
 * AT MOST ONE WRITE AN HOUR PER DEVICE: a phone polls every minute, and sixty
 * writes an hour per open app is the whole D1 budget. A new device costs one
 * INSERT; a known one costs nothing until its stamp is an hour old. The name
 * and platform ride on that same write.
 *
 * ponytail: the cap is a read-then-insert, so two NEW devices racing on the
 * same second can both land as the fifth. Harmless; a transaction if it ever
 * matters.
 */
async function registerDevice(
  c: Context<App>,
  profileId: string,
  device: string,
  name: string | null,
  platform: string | null,
): Promise<'removed' | 'limit' | null> {
  const row = await c.env.DB.prepare('SELECT last_seen, removed_at FROM devices WHERE profile_id = ? AND device = ?')
    .bind(profileId, device)
    .first<{ last_seen: string; removed_at: string | null }>();
  if (row?.removed_at) return 'removed';

  const now = new Date().toISOString();
  if (!row) {
    const n = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM devices WHERE profile_id = ? AND removed_at IS NULL')
      .bind(profileId)
      .first<{ n: number }>();
    if ((n?.n ?? 0) >= DEVICE_LIMIT) return 'limit';
    // OR IGNORE: the same new device pushing twice at once is one row.
    await c.env.DB.prepare(
      'INSERT OR IGNORE INTO devices (profile_id, device, name, platform, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind(profileId, device, name, platform, now, now)
      .run();
    return null;
  }

  // ISO strings order as dates do, so "over an hour ago" is a string compare.
  // HOURLY, not daily (21 Oct): compared against today's DATE, a full ISO
  // stamp from this morning never sorts below it, so "Your devices" showed
  // every phone last seen when it was first seen, all day.
  if (row.last_seen < new Date(Date.now() - LAST_SEEN_EVERY_MS).toISOString()) {
    await c.env.DB.prepare(
      'UPDATE devices SET last_seen = ?, name = COALESCE(?, name), platform = COALESCE(?, platform) WHERE profile_id = ? AND device = ?',
    )
      .bind(now, name, platform, profileId, device)
      .run();
  }
  return null;
}

sync.post('/sync', requireAuth, async (c) => {
  const profileId = c.get('profileId');
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return fail(c, 400, 'invalid_body', 'body must be JSON');
  }

  // Pattern-checked now that it is also a URL segment (`DELETE /me/devices/:device`).
  // Every id a phone has ever made is base-36, so nothing real is refused.
  const device = readDevice(typeof body.device === 'string' ? body.device : undefined);
  if (!device) return fail(c, 400, 'invalid_body', 'device is required');
  const cursor = typeof body.cursor === 'number' && isFinite(body.cursor) && body.cursor >= 0 ? Math.floor(body.cursor) : 0;

  const ops = validateOps(body.ops ?? []);
  if (typeof ops === 'string') return fail(c, 400, 'invalid_body', ops);

  // BEFORE the Plus gate and before anything is stored: a device that may not
  // sync may not sync in either direction, whatever it brought.
  const standing = await registerDevice(c, profileId, device, readDeviceName(body.name), readPlatform(body.platform));
  if (standing === 'removed') return fail(c, 403, 'device_removed', 'This device was removed from the account.');
  if (standing === 'limit') return fail(c, 403, 'device_limit', `This account already syncs on ${DEVICE_LIMIT} devices.`);

  if (ops.length > 0) {
    if (!(await isPlus(c))) return fail(c, 402, 'plus_required', 'pushing changes needs OpenTV Plus');
    // OR IGNORE, so the retry of a push that already landed is free and silent.
    const stmt = c.env.DB.prepare(
      'INSERT OR IGNORE INTO sync_ops (profile_id, op_id, device_id, ts, kind, payload) VALUES (?, ?, ?, ?, ?, ?)',
    );
    await c.env.DB.batch(ops.map((o) => stmt.bind(profileId, o.id, device, o.ts, o.kind, o.payload)));
    // For the dashboard's Sync column: when this account last pushed a change.
    await c.env.DB.prepare('UPDATE profiles SET sync_at = ? WHERE id = ?').bind(new Date().toISOString(), profileId).run();
  }

  const top = await c.env.DB.prepare('SELECT MAX(seq) AS m FROM sync_ops WHERE profile_id = ?')
    .bind(profileId)
    .first<{ m: number | null }>();

  /*
   * A CURSOR AHEAD OF THE RELAY BELONGS TO A DIFFERENT ONE.
   *
   * `seq` is this relay's own counter, and a device that is fully caught up
   * holds exactly the highest one. Holding a HIGHER number is impossible unless
   * the relay it came from is gone: a self-hosted instance reset, a database
   * restored from a backup, a profile deleted and remade.
   *
   * The old code compared only the other way — a cursor too OLD to catch up —
   * so this case slipped through as an ordinary request and the device asked
   * for everything after a number the new relay had not reached yet. It was
   * handed nothing, moved its cursor to the top, and lost that window for good.
   *
   * Seen exactly once and only because two devices were being watched at the
   * time: a phone skipped the first 24 ops of a fresh relay, which were a film
   * being un-watched and twenty-three episodes being ticked. Nothing failed.
   * The two libraries simply disagreed, quietly, for ever.
   *
   * Starting again from nothing is right rather than generous: the relay is the
   * whole of what this generation holds, so there is nothing older to miss.
   */
  const ahead = cursor > 0 && (top?.m == null || cursor > top.m);
  const from = ahead ? 0 : cursor;

  /*
   * EVERY DEVICE BUT THIS ONE. A phone applying its own ops back would double
   * every rewatch it recorded — those are the ops that are NOT idempotent,
   * because "+1 rewatch" said twice means two.
   */
  const rows = await c.env.DB.prepare(
    `SELECT seq, device_id, ts, kind, payload FROM sync_ops
       WHERE profile_id = ? AND seq > ? AND device_id != ?
       ORDER BY seq LIMIT 1000`,
  )
    .bind(profileId, from, device)
    .all<{ seq: number; device_id: string; ts: number; kind: string; payload: string }>();

  const got = rows.results ?? [];

  /*
   * THE CURSOR MOVES PAST ROWS THIS DEVICE WROTE ITSELF, which the query above
   * excludes. Reading the profile's own high-water mark rather than the last
   * row returned is what stops a device that does all the talking from asking
   * for the same empty window for ever.
   */
  const head = got.length > 0 ? got[got.length - 1]!.seq : (top?.m ?? from);

  /*
   * "I CANNOT CATCH YOU UP." A device whose cursor predates the oldest row we
   * still hold has a gap it can never see, and carrying on would leave it
   * quietly wrong for ever. Saying so lets the phone fall back to the full
   * backup, which is the one thing that is always complete.
   *
   * Only ever for a cursor that was actually set: a first sync starts at 0 and
   * has nothing to miss.
   */
  const oldest = await c.env.DB.prepare('SELECT MIN(seq) AS m FROM sync_ops WHERE profile_id = ?')
    .bind(profileId)
    .first<{ m: number | null }>();
  const reset = from > 0 && oldest?.m != null && from < oldest.m - 1;

  // Pruning rides on writes rather than a cron: it is cheap, and a profile
  // that never syncs has nothing to prune.
  if (ops.length > 0) {
    await c.env.DB.prepare(`DELETE FROM sync_ops WHERE created_at < datetime('now', ?)`)
      .bind(`-${RETAIN_DAYS} days`)
      .run();
  }

  return c.json({
    cursor: head,
    reset,
    ops: got.map((r) => ({ seq: r.seq, ts: r.ts, kind: r.kind, payload: r.payload })),
  });
});

/**
 * ONE DEVICE turning sync off: what IT put in flight, dropped. Gated on
 * nothing — you can always stop.
 *
 * NEVER THE WHOLE ACCOUNT (21 Oct). It used to delete every row of the
 * profile, so the tablet switching off took with it the phone's changes the
 * laptop had not pulled yet — gone, and nothing said so. The device comes in
 * `X-OpenTV-Device`, the header the backup upload already sends. A client that
 * sends none (1.7 and older) deletes nothing: rows it cannot attribute are
 * other devices' as much as its own, and `RETAIN_DAYS` prunes them anyway.
 *
 * ponytail: this device's OWN ops that another device has not pulled yet go
 * too — no per-device cursor is kept to know. Store the pull cursor on the
 * hourly `devices` write if that ever matters.
 */
sync.delete('/sync', requireAuth, async (c) => {
  const device = readDevice(c.req.header('X-OpenTV-Device'));
  if (device) {
    await c.env.DB.prepare('DELETE FROM sync_ops WHERE profile_id = ? AND device_id = ?')
      .bind(c.get('profileId'), device)
      .run();
  }
  return c.json({ ok: true });
});

/**
 * "Your devices". The live ones only — a removed device is a tombstone, not a
 * row anybody needs to see again. Most recently used first, so the phone in
 * the hand is at the top and the one in the drawer at the bottom. The limit
 * rides along so the app never keeps its own copy of the number.
 */
sync.get('/me/devices', requireAuth, async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT device, name, platform, first_seen, last_seen FROM devices
       WHERE profile_id = ? AND removed_at IS NULL
       ORDER BY last_seen DESC, first_seen DESC`,
  )
    .bind(c.get('profileId'))
    .all<{ device: string; name: string | null; platform: string | null; first_seen: string; last_seen: string }>();
  return c.json({ devices: rows.results ?? [], limit: DEVICE_LIMIT });
});

/**
 * Drop a device. Its next sync, in either direction, is refused with
 * `device_removed`; its library stays on it, and nothing it already relayed is
 * taken back — those were real things the owner did before the phone was
 * lost. Gated on nothing but a session, like turning sync off: you can always
 * stop a device of your own. A 404 is "already gone", which the app treats as
 * done.
 */
sync.delete('/me/devices/:device', requireAuth, async (c) => {
  const device = readDevice(c.req.param('device'));
  if (!device) return fail(c, 400, 'invalid_body', 'bad device id');
  const r = await c.env.DB.prepare(
    'UPDATE devices SET removed_at = ? WHERE profile_id = ? AND device = ? AND removed_at IS NULL',
  )
    .bind(new Date().toISOString(), c.get('profileId'), device)
    .run();
  if (!r.meta.changes) return fail(c, 404, 'not_found', 'No such device.');
  return c.json({ ok: true });
});
