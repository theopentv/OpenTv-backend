import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '@/env';
import { MAX_OPS_PER_PUSH, validateOps } from '@/routes/sync';
import { call, freshDatabase, insertProfile, makeEnv, tokenFor } from './harness';

/**
 * Sync between one person's own devices.
 *
 * What can be wrong here in a way nobody would notice until their library is:
 *
 *  1. A DEVICE RECEIVING ITS OWN OPS. Most are idempotent; "+1 rewatch" is
 *     not, so an echo silently inflates counts on the device that did the
 *     work — and only there, so the two devices disagree for ever.
 *  2. THE CURSOR STANDING STILL. A device that does all the talking gets no
 *     rows back, and a cursor taken from "the last row returned" never moves,
 *     so every sync re-asks the same window until one arrives.
 *  3. PLUS GATING THE WRONG DIRECTION — the rule `backup.ts` keeps. Pushing
 *     needs a subscription; receiving must not, or a lapsed card silently
 *     freezes a second device holding a real library.
 *  4. CROSSING PROFILES. The worst bug this server could have.
 */

let raw: Database.Database;
let env: Env;
let tokenP1: string;

const makePlus = (id: string) => raw.prepare('UPDATE profiles SET is_plus = 1 WHERE id = ?').run(id);

const op = (id: string, kind = 'watch', payload = '{"show":1,"s":2,"e":3}', ts = 1000) => ({ id, ts, kind, payload });

const push = (token: string, device: string, ops: unknown[] = [], cursor = 0) =>
  call(env, 'POST', '/v1/sync', { token, body: { device, cursor, ops } });

beforeEach(async () => {
  const fresh = freshDatabase();
  raw = fresh.raw;
  env = makeEnv(fresh.db);
  insertProfile(raw, 'p1', 'mahmood');
  insertProfile(raw, 'p2', 'sara');
  makePlus('p1');
  makePlus('p2');
  tokenP1 = await tokenFor(env, 'p1');
});

describe('the relay', () => {
  it('carries an op from the phone to the tablet', async () => {
    await push(tokenP1, 'phone', [op('phone:1')]);
    const res = await push(tokenP1, 'tablet');
    expect(res.status).toBe(200);
    expect(res.json.ops).toHaveLength(1);
    expect(res.json.ops[0].kind).toBe('watch');
    expect(res.json.ops[0].payload).toBe('{"show":1,"s":2,"e":3}');
  });

  /**
   * A RELAY THAT STARTED AGAIN — a self-hosted instance reset, a database
   * restored from a backup, a profile deleted and remade.
   *
   * `seq` counts within one relay, so a cursor higher than anything this one
   * has reached came from a different one. Treating it as an ordinary request
   * hands the device nothing, moves its cursor to the top, and loses that whole
   * window silently: seen once as a phone skipping a film being un-watched and
   * twenty-three episodes being ticked, with nothing failing anywhere.
   */
  it('serves a device whose cursor is ahead of the relay from the start', async () => {
    await push(tokenP1, 'phone', [op('phone:1'), op('phone:2')]);
    // 24 is where this device got to on the relay that no longer exists.
    const res = await push(tokenP1, 'tablet', [], 24);
    expect(res.status).toBe(200);
    expect(res.json.ops).toHaveLength(2);
  });

  it('leaves a cursor that is merely up to date alone', async () => {
    await push(tokenP1, 'phone', [op('phone:1')]);
    const caught = await push(tokenP1, 'tablet');
    // Caught up means cursor === top, which must not be mistaken for ahead.
    const again = await push(tokenP1, 'tablet', [], caught.json.cursor);
    expect(again.json.ops).toHaveLength(0);
  });

  it('never hands a device back its own ops', async () => {
    await push(tokenP1, 'phone', [op('phone:1'), op('phone:2')]);
    const res = await push(tokenP1, 'phone');
    expect(res.json.ops).toHaveLength(0);
  });

  it('moves the cursor even when nothing comes back, so a talking device stops re-asking', async () => {
    const first = await push(tokenP1, 'phone', [op('phone:1')]);
    expect(first.json.ops).toHaveLength(0); // its own op, withheld
    expect(first.json.cursor).toBeGreaterThan(0); // but the cursor advanced past it
    const again = await push(tokenP1, 'phone', [], first.json.cursor);
    expect(again.json.cursor).toBe(first.json.cursor);
  });

  it('delivers each op once, and only what came after the cursor', async () => {
    await push(tokenP1, 'phone', [op('phone:1')]);
    const a = await push(tokenP1, 'tablet');
    await push(tokenP1, 'phone', [op('phone:2')], a.json.cursor);
    const b = await push(tokenP1, 'tablet', [], a.json.cursor);
    expect(b.json.ops).toHaveLength(1);
    expect(b.json.ops[0].seq).toBeGreaterThan(a.json.ops[0].seq);
  });

  it('applies a retried push once — the same op ids are free the second time', async () => {
    await push(tokenP1, 'phone', [op('phone:1')]);
    await push(tokenP1, 'phone', [op('phone:1')]);
    const res = await push(tokenP1, 'tablet');
    expect(res.json.ops).toHaveLength(1);
  });

  it('keeps two profiles apart', async () => {
    await push(tokenP1, 'phone', [op('phone:1')]);
    const tokenP2 = await tokenFor(env, 'p2');
    const res = await push(tokenP2, 'phone2');
    expect(res.json.ops).toHaveLength(0);
  });

  it('says reset only when a row the device never saw has been pruned away', async () => {
    await push(tokenP1, 'phone', [op('phone:1'), op('phone:2')]);
    expect((await push(tokenP1, 'tablet', [], 0)).json.reset).toBe(false); // a first sync has nothing to miss

    // Caught up to seq 1, and seq 2 is still there: the next row is the very
    // one it is waiting for, so there is no gap and no reset.
    expect((await push(tokenP1, 'tablet', [], 1)).json.reset).toBe(false);

    // Now seq 2 — which this device never saw — ages out, and seq 3 arrives.
    // AUTOINCREMENT never reissues 2, so the hole is permanent and visible.
    raw.prepare('DELETE FROM sync_ops WHERE seq <= 2').run();
    await push(tokenP1, 'phone', [op('phone:9')]);
    expect((await push(tokenP1, 'tablet', [], 1)).json.reset).toBe(true);
  });
});

describe('Plus', () => {
  it('gates pushing', async () => {
    raw.prepare('UPDATE profiles SET is_plus = 0 WHERE id = ?').run('p1');
    const res = await push(tokenP1, 'phone', [op('phone:1')]);
    expect(res.status).toBe(402);
    expect(res.json.error.code).toBe('plus_required');
  });

  it('never gates receiving — a lapsed card must not freeze a second device', async () => {
    await push(tokenP1, 'phone', [op('phone:1')]);
    raw.prepare('UPDATE profiles SET is_plus = 0 WHERE id = ?').run('p1');
    const res = await push(tokenP1, 'tablet');
    expect(res.status).toBe(200);
    expect(res.json.ops).toHaveLength(1);
  });
});

describe('what a push may contain', () => {
  it('rejects the whole batch rather than dropping one bad op', () => {
    expect(validateOps([op('a'), { id: 'b', ts: 1, kind: 'watch' }])).toBe('bad op payload');
    expect(validateOps([op('a'), op('a')])).toBe('duplicate op id');
    expect(validateOps(Array.from({ length: MAX_OPS_PER_PUSH + 1 }, (_, i) => op(`x${i}`)))).toBe('too many ops');
    expect(validateOps([{ ...op('a'), ts: 'now' }])).toBe('bad op ts');
    expect(validateOps('nope')).toBe('ops must be an array');
  });

  it('accepts a clean batch', () => {
    expect(validateOps([op('a'), op('b')])).toHaveLength(2);
  });

  it('stores nothing when a batch is refused', async () => {
    const res = await push(tokenP1, 'phone', [{ id: 'a', ts: 1, kind: 'watch' }]);
    expect(res.status).toBe(400);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM sync_ops').get()).toEqual({ n: 0 });
  });
});

describe('turning it off', () => {
  const off = (headers: Record<string, string> = { 'X-OpenTV-Device': 'phone' }) =>
    call(env, 'DELETE', '/v1/sync', { token: tokenP1, headers });
  const left = () => raw.prepare('SELECT device_id FROM sync_ops ORDER BY seq').all().map((r: any) => r.device_id);

  it("drops this device's ops in flight, and needs no subscription to do it", async () => {
    await push(tokenP1, 'phone', [op('phone:1')]);
    raw.prepare('UPDATE profiles SET is_plus = 0 WHERE id = ?').run('p1');
    const res = await off();
    expect(res.status).toBe(200);
    expect(left()).toEqual([]);
  });

  it("never takes another device's changes with it", async () => {
    // The bug: the tablet switching off deleted the phone's unpulled ops too.
    await push(tokenP1, 'phone', [op('phone:1')]);
    await push(tokenP1, 'tablet', [op('tablet:1')]);
    await off({ 'X-OpenTV-Device': 'tablet' });
    expect(left()).toEqual(['phone']);
  });

  it('deletes nothing for a client that does not say which device it is', async () => {
    await push(tokenP1, 'phone', [op('phone:1')]);
    expect((await off({})).status).toBe(200);
    expect(left()).toEqual(['phone']);
  });
});
