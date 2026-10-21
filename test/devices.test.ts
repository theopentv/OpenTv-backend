import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '@/env';
import { readDeviceName, readPlatform } from '@/pure';
import { DEVICE_LIMIT } from '@/routes/sync';
import { call, freshDatabase, insertProfile, makeEnv, tokenFor } from './harness';

/**
 * The devices that sync with one account (0054).
 *
 * What can be wrong here in a way that costs real money or a real library:
 *
 *  1. WRITING ON EVERY SYNC. A phone polls once a minute; a row written each
 *     time is the whole D1 budget gone to one open app.
 *  2. A REMOVED PHONE QUIETLY REJOINING. The list exists to drop a lost phone;
 *     a removal that lasts until its next poll is no removal.
 *  3. THE CAP COUNTING THE WRONG ROWS — tombstones, or another profile's.
 *  4. THE CAP TURNING AWAY A PHONE ALREADY ON THE LIST, which would stop a
 *     real person's own fifth device the day a sixth was ever tried.
 */

let raw: Database.Database;
let env: Env;
let token: string;

const op = (id: string) => ({ id, ts: 1000, kind: 'watch', payload: '{"show":1,"s":2,"e":3}' });

const sync = (device: string, extra: Record<string, unknown> = {}, tok = token) =>
  call(env, 'POST', '/v1/sync', { token: tok, body: { device, cursor: 0, ops: [], ...extra } });

const rowFor = (device: string) =>
  raw.prepare('SELECT * FROM devices WHERE profile_id = ? AND device = ?').get('p1', device) as
    | { name: string | null; platform: string | null; first_seen: string; last_seen: string; removed_at: string | null }
    | undefined;

beforeEach(async () => {
  const fresh = freshDatabase();
  raw = fresh.raw;
  env = makeEnv(fresh.db);
  insertProfile(raw, 'p1', 'mahmood');
  insertProfile(raw, 'p2', 'sara');
  raw.prepare('UPDATE profiles SET is_plus = 1').run();
  token = await tokenFor(env, 'p1');
});

describe('registering', () => {
  it('writes a row on the first sync, with what the phone says about itself', async () => {
    const res = await sync('phone', { name: "Mahmood's iPhone", platform: 'ios' });
    expect(res.status).toBe(200);
    const row = rowFor('phone');
    expect(row?.name).toBe("Mahmood's iPhone");
    expect(row?.platform).toBe('ios');
    expect(row?.first_seen).toBe(row?.last_seen);
  });

  it('registers on a pull with no ops and no Plus — the list is not a paid feature', async () => {
    raw.prepare('UPDATE profiles SET is_plus = 0 WHERE id = ?').run('p1');
    expect((await sync('tablet')).status).toBe(200);
    expect(rowFor('tablet')).toBeDefined();
  });

  it('writes last_seen at most once an hour, however often the phone polls', async () => {
    await sync('phone');
    const first = rowFor('phone')!.last_seen;
    await sync('phone');
    await sync('phone', { name: 'renamed' });
    expect(rowFor('phone')!.last_seen).toBe(first);
    // And the rename waits for the hourly write with it.
    expect(rowFor('phone')!.name).toBeNull();

    raw.prepare("UPDATE devices SET last_seen = '2026-10-09T23:59:59.000Z' WHERE device = 'phone'").run();
    await sync('phone', { name: 'renamed', platform: 'ios' });
    const row = rowFor('phone')!;
    expect(row.last_seen > '2026-10-10').toBe(true);
    expect(row.name).toBe('renamed');
    expect(row.platform).toBe('ios');
  });

  it('moves last_seen later the SAME day, once the stamp is an hour old', async () => {
    // The bug: compared against today's date, a stamp from this morning never
    // sorted below it, so last_seen stood at first_seen until midnight.
    await sync('phone');
    const earlier = new Date(Date.now() - 61 * 60 * 1000).toISOString();
    raw.prepare('UPDATE devices SET last_seen = ? WHERE device = ?').run(earlier, 'phone');
    await sync('phone');
    expect(rowFor('phone')!.last_seen > earlier).toBe(true);
    expect(rowFor('phone')!.last_seen > rowFor('phone')!.first_seen).toBe(true);
  });

  it('keeps a name the hourly write did not bring', async () => {
    await sync('phone', { name: 'Pixel 8', platform: 'android' });
    raw.prepare("UPDATE devices SET last_seen = '2026-01-01T00:00:00.000Z' WHERE device = 'phone'").run();
    await sync('phone');
    expect(rowFor('phone')!.name).toBe('Pixel 8');
    expect(rowFor('phone')!.platform).toBe('android');
  });

  it('refuses a device id that could not be a path segment', async () => {
    const res = await sync('../phone');
    expect(res.status).toBe(400);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM devices').get()).toEqual({ n: 0 });
  });
});

describe('the cap', () => {
  const fill = async () => {
    for (let i = 0; i < DEVICE_LIMIT; i++) await sync(`d${i}`);
  };

  it('turns a new device away once the account has its full set, and only a new one', async () => {
    await fill();
    const extra = await sync('d99', {}, token);
    expect(extra.status).toBe(403);
    expect(extra.json.error.code).toBe('device_limit');
    expect(rowFor('d99')).toBeUndefined();
    // The five already on the list are untouched, ops and all.
    const known = await sync('d0', { ops: [op('d0:1')] });
    expect(known.status).toBe(200);
  });

  it('counts one profile, not the whole table', async () => {
    await fill();
    const tokenP2 = await tokenFor(env, 'p2');
    expect((await sync('sara-phone', {}, tokenP2)).status).toBe(200);
  });

  it('does not count a removed device, so remove-then-add works', async () => {
    await fill();
    expect((await call(env, 'DELETE', '/v1/me/devices/d0', { token })).status).toBe(200);
    expect((await sync('d99')).status).toBe(200);
  });
});

describe('removing', () => {
  it('refuses the removed device in both directions from its next sync', async () => {
    await sync('phone');
    await sync('tablet', { ops: [op('tablet:1')] });
    const res = await call(env, 'DELETE', '/v1/me/devices/phone', { token });
    expect(res.status).toBe(200);

    const pull = await sync('phone');
    expect(pull.status).toBe(403);
    expect(pull.json.error.code).toBe('device_removed');
    const push = await sync('phone', { ops: [op('phone:1')] });
    expect(push.status).toBe(403);
    // Nothing it brought was stored.
    expect(raw.prepare("SELECT COUNT(*) AS n FROM sync_ops WHERE device_id = 'phone'").get()).toEqual({ n: 0 });
  });

  it('is already-gone the second time, and never somebody else’s', async () => {
    await sync('phone');
    await call(env, 'DELETE', '/v1/me/devices/phone', { token });
    expect((await call(env, 'DELETE', '/v1/me/devices/phone', { token })).status).toBe(404);

    const tokenP2 = await tokenFor(env, 'p2');
    await sync('sara-phone', {}, tokenP2);
    expect((await call(env, 'DELETE', '/v1/me/devices/sara-phone', { token })).status).toBe(404);
    expect((await sync('sara-phone', {}, tokenP2)).status).toBe(200);
  });

  it('needs no Plus — you can always stop a device of your own', async () => {
    await sync('phone');
    raw.prepare('UPDATE profiles SET is_plus = 0 WHERE id = ?').run('p1');
    expect((await call(env, 'DELETE', '/v1/me/devices/phone', { token })).status).toBe(200);
  });
});

describe('the list', () => {
  it('shows the live devices of this profile, most recently used first, with the limit', async () => {
    await sync('old', { name: 'Old phone', platform: 'android' });
    raw.prepare("UPDATE devices SET last_seen = '2026-09-01T00:00:00.000Z' WHERE device = 'old'").run();
    await sync('phone', { name: "Mahmood's iPhone", platform: 'ios' });
    await sync('gone');
    await call(env, 'DELETE', '/v1/me/devices/gone', { token });
    await sync('sara-phone', {}, await tokenFor(env, 'p2'));

    const res = await call(env, 'GET', '/v1/me/devices', { token });
    expect(res.status).toBe(200);
    expect(res.json.limit).toBe(DEVICE_LIMIT);
    expect(res.json.devices.map((d: { device: string }) => d.device)).toEqual(['phone', 'old']);
    expect(res.json.devices[0]).toMatchObject({ name: "Mahmood's iPhone", platform: 'ios' });
    expect(res.json.devices[0].last_seen).toBeTruthy();
  });

  it('goes with the account', async () => {
    await sync('phone');
    expect((await call(env, 'DELETE', '/v1/me', { token })).status).toBe(204);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM devices').get()).toEqual({ n: 0 });
  });
});

describe('what a phone may say about itself', () => {
  it('keeps a name as a label and nothing more', () => {
    expect(readDeviceName("  Mahmood's iPhone\n")).toBe("Mahmood's iPhone");
    expect(readDeviceName('x'.repeat(100))).toHaveLength(64);
    expect(readDeviceName('')).toBeNull();
    expect(readDeviceName(42)).toBeNull();
  });

  it('takes a platform word or nothing', () => {
    expect(readPlatform('ios')).toBe('ios');
    expect(readPlatform('android')).toBe('android');
    expect(readPlatform('iOS 18')).toBeNull();
    expect(readPlatform(null)).toBeNull();
  });
});
