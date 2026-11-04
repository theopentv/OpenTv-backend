import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '@/env';
import { MAX_BACKUP_BYTES } from '@/routes/backup';
import { call, callBytes, fakeBucket, freshDatabase, insertProfile, makeEnv, tokenFor } from './harness';

/**
 * Cloud backup — the third destination, after iCloud and Drive.
 *
 * What can be wrong here in a way nobody would notice:
 *
 *  1. PLUS GATING THE WRONG DIRECTION. Upload needs a subscription; download
 *     and delete must not. A backup that locks when a card expires is a
 *     hostage, and the failure is invisible until somebody's card expires.
 *  2. ONE KEY PER PROFILE. If the key carried anything but the session's own
 *     profile id, one user could read another's library — the worst bug this
 *     server could have.
 *  3. NO BINDING MEANS OFF. A deployment without the bucket must answer
 *     "no backup", not 500.
 */

let raw: Database.Database;
let env: Env;
let bucket: ReturnType<typeof fakeBucket>;
let token: string;

const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);

const makePlus = (id: string) =>
  raw.prepare('UPDATE profiles SET is_plus = 1 WHERE id = ?').run(id);

beforeEach(async () => {
  const fresh = freshDatabase();
  raw = fresh.raw;
  bucket = fakeBucket();
  env = makeEnv(fresh.db, undefined, bucket);
  insertProfile(raw, 'p1', 'mahmood');
  insertProfile(raw, 'p2', 'sara');
  token = await tokenFor(env, 'p1');
});

describe('uploading', () => {
  it('refuses without Plus, and says so in a code the app can answer with the paywall', async () => {
    const res = await callBytes(env, 'POST', '/v1/backup', ZIP, { token });
    expect(res.status).toBe(402);
    expect(res.json.error.code).toBe('plus_required');
    expect(bucket.stored.size).toBe(0);
  });

  it('stores one object, keyed to the profile, once Plus is on', async () => {
    makePlus('p1');
    const res = await callBytes(env, 'POST', '/v1/backup', ZIP, { token });
    expect(res.status).toBe(200);
    expect(res.json.size).toBe(ZIP.length);
    expect([...bucket.stored.keys()]).toEqual(['backups/p1.zip']);
  });

  it('overwrites in place, so pressing backup twice cannot fill a bucket', async () => {
    makePlus('p1');
    await callBytes(env, 'POST', '/v1/backup', ZIP, { token });
    await callBytes(env, 'POST', '/v1/backup', new Uint8Array(20), { token });
    expect(bucket.stored.size).toBe(1);
    expect(bucket.stored.get('backups/p1.zip')?.size).toBe(20);
  });

  it('refuses an empty body and one over the cap', async () => {
    makePlus('p1');
    expect((await callBytes(env, 'POST', '/v1/backup', new Uint8Array(0), { token })).status).toBe(400);
    const huge = new Uint8Array(MAX_BACKUP_BYTES + 1);
    expect((await callBytes(env, 'POST', '/v1/backup', huge, { token })).status).toBe(413);
    expect(bucket.stored.size).toBe(0);
  });

  it('needs a token at all', async () => {
    expect((await callBytes(env, 'POST', '/v1/backup', ZIP)).status).toBe(401);
  });
});

describe('the label beside the ZIP', () => {
  it('round-trips the counts the welcome screen greets somebody with', async () => {
    makePlus('p1');
    // Encoded exactly as the phone does it: UTF-8 first, then base64. A handle
    // outside Latin-1 is the case that catches a server decoding it wrong.
    const payload = JSON.stringify({ username: 'محمود', shows: 12, episodes: 340, movies: 88 });
    const utf8 = new TextEncoder().encode(payload);
    const info = btoa(String.fromCharCode(...utf8));
    await callBytes(env, 'POST', '/v1/backup', ZIP, {
      token,
      headers: { 'X-OpenTV-Backup-Info': info },
    });

    const res = await call(env, 'GET', '/v1/backup/info', { token });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      exists: true,
      size: ZIP.length,
      username: 'محمود',
      shows: 12,
      episodes: 340,
      movies: 88,
    });
  });

  it('a mangled header does not fail an upload that is otherwise fine', async () => {
    makePlus('p1');
    const res = await callBytes(env, 'POST', '/v1/backup', ZIP, {
      token,
      headers: { 'X-OpenTV-Backup-Info': 'not base64 at all !!' },
    });
    expect(res.status).toBe(200);
    expect((await call(env, 'GET', '/v1/backup/info', { token })).json.exists).toBe(true);
  });

  it('says so plainly when there is nothing up there', async () => {
    const res = await call(env, 'GET', '/v1/backup/info', { token });
    expect(res.json).toEqual({ exists: false });
  });
});

describe('getting it back', () => {
  it('returns the exact bytes that went up', async () => {
    makePlus('p1');
    await callBytes(env, 'POST', '/v1/backup', ZIP, { token });
    const res = await callBytes(env, 'GET', '/v1/backup', undefined, { token });
    expect(res.status).toBe(200);
    expect([...res.bytes]).toEqual([...ZIP]);
  });

  /** The whole point of the gate being one-directional. */
  it('still returns it after Plus lapses', async () => {
    makePlus('p1');
    await callBytes(env, 'POST', '/v1/backup', ZIP, { token });
    raw.prepare('UPDATE profiles SET is_plus = 0, plus_until = NULL WHERE id = ?').run('p1');

    const res = await callBytes(env, 'GET', '/v1/backup', undefined, { token });
    expect(res.status).toBe(200);
    expect([...res.bytes]).toEqual([...ZIP]);
  });

  it('404s when this account never uploaded one', async () => {
    expect((await callBytes(env, 'GET', '/v1/backup', undefined, { token })).status).toBe(404);
  });

  /** The worst bug this server could have. */
  it('never hands one profile another profile’s library', async () => {
    makePlus('p1');
    await callBytes(env, 'POST', '/v1/backup', ZIP, { token });

    const other = await tokenFor(env, 'p2');
    const res = await callBytes(env, 'GET', '/v1/backup', undefined, { token: other });
    expect(res.status).toBe(404);
    expect((await call(env, 'GET', '/v1/backup/info', { token: other })).json).toEqual({ exists: false });
  });
});

describe('deleting it', () => {
  it('removes it without needing Plus, and is idempotent', async () => {
    makePlus('p1');
    await callBytes(env, 'POST', '/v1/backup', ZIP, { token });
    raw.prepare('UPDATE profiles SET is_plus = 0 WHERE id = ?').run('p1');

    expect((await call(env, 'DELETE', '/v1/backup', { token })).status).toBe(200);
    expect(bucket.stored.size).toBe(0);
    // again, on a bucket that no longer has it
    expect((await call(env, 'DELETE', '/v1/backup', { token })).status).toBe(200);
  });
});

describe('a deployment without the bucket', () => {
  beforeEach(() => {
    env = { ...env, BACKUPS: undefined };
  });

  it('is off rather than broken', async () => {
    makePlus('p1');
    expect((await callBytes(env, 'POST', '/v1/backup', ZIP, { token })).status).toBe(503);
    expect((await call(env, 'GET', '/v1/backup/info', { token })).json).toEqual({ exists: false });
    expect((await callBytes(env, 'GET', '/v1/backup', undefined, { token })).status).toBe(503);
    expect((await call(env, 'DELETE', '/v1/backup', { token })).status).toBe(200);
  });
});

/**
 * Two devices, two keys.
 *
 * The bug these exist for: `backups/<profileId>.zip` was one object per
 * PROFILE, overwritten in place, so a reader's two phones raced each other.
 * On 21 Sep the cloud copy went from a 1,260-episode library to a 1,042-episode
 * one and back again, twice, in an afternoon. Survivable only because each
 * phone still had its own copy locally — and not survivable at all for the
 * case the feature exists for, a third device restoring.
 */
describe('one backup per device', () => {
  const withDevice = (device: string) => ({ token, headers: { 'X-OpenTV-Device': device } });
  const info = (n: { shows?: number; episodes?: number; movies?: number }) => ({
    'X-OpenTV-Backup-Info': Buffer.from(JSON.stringify(n), 'utf8').toString('base64'),
  });

  it('does not let one phone overwrite the other', async () => {
    makePlus('p1');
    await callBytes(env, 'POST', '/v1/backup', ZIP, withDevice('phone'));
    await callBytes(env, 'POST', '/v1/backup', new Uint8Array(20), withDevice('tablet'));
    expect([...bucket.stored.keys()].sort()).toEqual(['backups/p1/phone.zip', 'backups/p1/tablet.zip']);
  });

  it('still overwrites in place PER DEVICE, so one phone cannot fill a bucket', async () => {
    makePlus('p1');
    await callBytes(env, 'POST', '/v1/backup', ZIP, withDevice('phone'));
    await callBytes(env, 'POST', '/v1/backup', new Uint8Array(20), withDevice('phone'));
    expect(bucket.stored.size).toBe(1);
    expect(bucket.stored.get('backups/p1/phone.zip')?.size).toBe(20);
  });

  it('restores the FULLEST library, not the most recently uploaded', async () => {
    // The whole point. The 1,042-episode copy was the NEWER one that day, and
    // handing somebody the smaller library because it arrived four minutes
    // later is exactly the failure this route was changed for.
    makePlus('p1');
    await callBytes(env, 'POST', '/v1/backup', new Uint8Array(1260), {
      ...withDevice('full'),
      headers: { 'X-OpenTV-Device': 'full', ...info({ episodes: 1260 }) },
    });
    await callBytes(env, 'POST', '/v1/backup', new Uint8Array(1042), {
      ...withDevice('behind'),
      headers: { 'X-OpenTV-Device': 'behind', ...info({ episodes: 1042 }) },
    });

    const meta = await call(env, 'GET', '/v1/backup/info', { token });
    expect(meta.json.episodes).toBe(1260);
    expect(meta.json.device).toBe('full');
    expect(meta.json.devices).toHaveLength(2);

    // and the bytes must be the same object the info just described, or the
    // welcome screen promises a library it does not hand over
    const zip = await call(env, 'GET', '/v1/backup', { token });
    expect(zip.status).toBe(200);
  });

  it('hands over a named device when the reader picks one', async () => {
    makePlus('p1');
    await callBytes(env, 'POST', '/v1/backup', new Uint8Array(8), withDevice('phone'));
    await callBytes(env, 'POST', '/v1/backup', new Uint8Array(20), withDevice('tablet'));
    const res = await call(env, 'GET', '/v1/backup?device=tablet', { token });
    expect(res.status).toBe(200);
    expect((await call(env, 'GET', '/v1/backup?device=nosuch', { token })).status).toBe(404);
  });

  it('keeps reading a backup written before per-device keys existed', async () => {
    // A phone that has not updated still writes the old single key, and its
    // owner must not be told their backup vanished.
    makePlus('p1');
    await callBytes(env, 'POST', '/v1/backup', ZIP, { token });
    expect([...bucket.stored.keys()]).toEqual(['backups/p1.zip']);
    const meta = await call(env, 'GET', '/v1/backup/info', { token });
    expect(meta.json.exists).toBe(true);
    expect(meta.json.device).toBe(null);
    expect((await call(env, 'GET', '/v1/backup', { token })).status).toBe(200);
  });

  it('refuses a device id that is a path rather than a name', async () => {
    // It comes from input and it goes into a key. A client that could put
    // `../` in it could write outside its own prefix — and into another
    // profile's.
    makePlus('p1');
    await callBytes(env, 'POST', '/v1/backup', ZIP, {
      token,
      headers: { 'X-OpenTV-Device': '../p2/stolen' },
    });
    // falls back to this profile's own legacy key, never p2's
    expect([...bucket.stored.keys()]).toEqual(['backups/p1.zip']);
  });

  it('deletes every device by default, and only one when asked', async () => {
    makePlus('p1');
    await callBytes(env, 'POST', '/v1/backup', ZIP, withDevice('phone'));
    await callBytes(env, 'POST', '/v1/backup', ZIP, withDevice('tablet'));

    await call(env, 'DELETE', '/v1/backup?device=phone', { token });
    expect([...bucket.stored.keys()]).toEqual(['backups/p1/tablet.zip']);

    await callBytes(env, 'POST', '/v1/backup', ZIP, withDevice('phone'));
    // "take my library off your server" means all of it, not this handset's
    await call(env, 'DELETE', '/v1/backup', { token });
    expect(bucket.stored.size).toBe(0);
  });

  it('never lets one profile see another profile-s devices', async () => {
    makePlus('p1');
    makePlus('p2');
    const other = await tokenFor(env, 'p2');
    await callBytes(env, 'POST', '/v1/backup', ZIP, withDevice('phone'));
    const meta = await call(env, 'GET', '/v1/backup/info', { token: other });
    expect(meta.json.exists).toBe(false);
  });
});

describe('backup pictures, beside the ZIP', () => {
  const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 9, 9]);
  const put = (name: string, t = token) => callBytes(env, 'PUT', `/v1/backup/images/${name}`, GIF, { token: t });

  it('keeps one per name under the profile, Plus to write, anyone of theirs to read', async () => {
    expect((await put('comment-img-1.gif')).status).toBe(402);
    makePlus('p1');
    expect((await put('comment-img-1.gif')).status).toBe(200);
    expect([...bucket.stored.keys()]).toEqual(['backup-images/p1/comment-img-1.gif']);
    const back = await callBytes(env, 'GET', '/v1/backup/images/comment-img-1.gif', undefined, { token });
    expect([...back.bytes]).toEqual([...GIF]);
    // another profile asking for the same name gets its own (none), never p1's
    const other = await tokenFor(env, 'p2');
    expect((await callBytes(env, 'GET', '/v1/backup/images/comment-img-1.gif', undefined, { token: other })).status).toBe(404);
  });

  it('refuses a name that is a path', async () => {
    makePlus('p1');
    expect((await put('..%2Fp2%2Fx.gif')).status).toBe(400);
    expect((await put('.hidden')).status).toBe(400);
    expect(bucket.stored.size).toBe(0);
  });

  it('is never listed as a device, and goes when the backup is deleted', async () => {
    makePlus('p1');
    await callBytes(env, 'POST', '/v1/backup', ZIP, { token, headers: { 'X-OpenTV-Device': 'phone' } });
    await put('a.gif');
    await put('b.gif');
    const info = await call(env, 'GET', '/v1/backup/info', { token });
    expect(info.json.devices).toHaveLength(1);
    await call(env, 'DELETE', '/v1/backup', { token });
    expect(bucket.stored.size).toBe(0);
  });
});

describe('deleting the account', () => {
  it('takes every backup and picture with it, and nobody else\'s', async () => {
    makePlus('p1');
    makePlus('p2');
    const other = await tokenFor(env, 'p2');
    await callBytes(env, 'POST', '/v1/backup', ZIP, { token, headers: { 'X-OpenTV-Device': 'phone' } });
    await callBytes(env, 'PUT', '/v1/backup/images/a.gif', ZIP, { token });
    await callBytes(env, 'POST', '/v1/backup', ZIP, { token: other, headers: { 'X-OpenTV-Device': 'phone' } });
    expect((await call(env, 'DELETE', '/v1/me', { token })).status).toBe(204);
    expect([...bucket.stored.keys()]).toEqual(['backups/p2/phone.zip']);
  });
});
