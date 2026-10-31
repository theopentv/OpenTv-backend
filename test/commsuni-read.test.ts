/**
 * Reading the CommsUni board — phase one of the integration (1.6.5).
 * The key stays on the Worker, only members can read, deleted comments are
 * hidden whole, "never archived" is an empty thread and not an error, and a
 * 429 stops us asking for a minute.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '@/env';
import { commsuniPath, kvKey, refreshCommsuniProfile, trimComment } from '@/routes/commsuni';
import { call, freshDatabase, makeEnv, tokenFor } from './harness';

describe('commsuniPath', () => {
  it('addresses an episode by show id, season and episode', () => {
    expect(commsuniPath({ type: 'episode', id: '289590', season: '1', episode: '2' })).toBe(
      '/entities/episode/tvdb-289590-s1e2/comments?limit=20&sort=most_liked&include=language_counts%2Csource_counts',
    );
  });
  it('filters by source and language on their side, and offers "top"', () => {
    expect(commsuniPath({ type: 'show', id: '1', source: 'tvtime,opentv', language: 'ar', sort: 'most_relevant' })).toBe(
      '/entities/show/tvdb-1/comments?limit=20&sort=most_relevant&source=tvtime%2Copentv&language=ar&include=language_counts%2Csource_counts',
    );
  });
  it('drops a source or language that is not a slug or a tag', () => {
    expect(commsuniPath({ type: 'show', id: '1', source: 'tv time;drop', language: 'english!' })).toBe(
      '/entities/show/tvdb-1/comments?limit=20&sort=most_liked&include=language_counts%2Csource_counts',
    );
  });
  it('addresses shows and films by their own id, and passes sort and cursor', () => {
    expect(commsuniPath({ type: 'movie', id: '1234', sort: 'most_recent', cursor: 'abc' })).toBe(
      '/entities/movie/tvdb-1234/comments?limit=20&sort=most_recent&cursor=abc',
    );
  });
  it('refuses anything that is not a number where one belongs', () => {
    expect(commsuniPath({ type: 'show', id: '12a' })).toBeNull();
    expect(commsuniPath({ type: 'episode', id: '1', season: 'x', episode: '1' })).toBeNull();
    expect(commsuniPath({ type: 'user', id: '1' })).toBeNull();
  });
});

describe('kvKey', () => {
  it('keeps an episode page-two key inside KV’s 512 bytes (Show more, 4 Oct)', async () => {
    const path = commsuniPath({ type: 'episode', id: '360388', season: '1', episode: '1', cursor: 'x'.repeat(433) })!;
    const key = await kvKey(`commsuni:c:${path}`);
    expect(new TextEncoder().encode(key).length).toBeLessThanOrEqual(512);
    expect(await kvKey(`commsuni:c:${path}`)).toBe(key);
    expect(await kvKey('commsuni:c:short')).toBe('commsuni:c:short');
  });
});

describe('trimComment', () => {
  it('carries the picture a GIF-only comment is made of, https only', () => {
    expect(trimComment({ id: 'g', text: '', attachments: [{ url: 'https://static.klipy.com/x.webp' }] } as never)?.image).toBe('https://static.klipy.com/x.webp');
    expect(trimComment({ id: 'h', text: 'hi', imageUrl: 'http://insecure.example/x.png' } as never)?.image).toBeNull();
  });
  it('hides a tombstone completely', () => {
    expect(trimComment({ id: 'a', text: null as unknown as string, deleted: true })).toBeNull();
  });
  it('keeps what the app draws and nothing about the viewer', () => {
    const t = trimComment({
      id: 'a', text: 'hi', userName: 'TV Time user', origin: { kind: 'tvtime', slug: 'tvtime', displayName: 'TV Time' },
      likeCount: 4, replyCount: 1, isSpoiler: true, viewerLiked: true,
    } as never);
    expect(t).toMatchObject({ id: 'a', text: 'hi', likes: 4, replyCount: 1, isSpoiler: true, origin: { kind: 'tvtime' } });
    expect(JSON.stringify(t)).not.toContain('viewer');
  });
});

describe('GET /v1/commsuni/comments', () => {
  let env: Env;
  let calls: { url: string; headers: Headers }[];
  let reply: { status: number; body: unknown };

  beforeEach(() => {
    const fresh = freshDatabase();
    fresh.raw.prepare(`INSERT INTO profiles (id, handle, handle_lower, created_at) VALUES ('p1', 'a', 'a', '2026-09-29')`).run();
    env = { ...makeEnv(fresh.db), COMMSUNI_API_KEY: 'tvta_live_test' };
    calls = [];
    reply = { status: 200, body: { data: { comments: [{ id: 'c1', text: 'great', origin: { kind: 'tvtime', slug: 'tvtime' } }], nextCursor: null } } };
    vi.stubGlobal('fetch', async (url: string, init: { headers: Record<string, string> }) => {
      calls.push({ url, headers: new Headers(init.headers) });
      return new Response(JSON.stringify(reply.body), { status: reply.status });
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const get = async (q = 'type=episode&id=289590&season=1&episode=2') =>
    call(env, 'GET', `/v1/commsuni/comments?${q}`, { token: await tokenFor(env, 'p1') });

  it('the dashboard switch stops every read, cached or not, without asking CommsUni', async () => {
    await get();
    await env.CACHE.put('commsuni:off', '1');
    expect((await get()).status).toBe(503);
    expect(calls).toHaveLength(1);
    await env.CACHE.delete('commsuni:off');
    expect((await get()).status).toBe(200);
  });

  it('counts a read that reached CommsUni, and not one the cache answered', async () => {
    await get();
    await get();
    expect(calls).toHaveLength(1);
    const row = await env.DB.prepare(`SELECT kind, calls FROM commsuni_usage`).first();
    expect(row).toEqual({ kind: 'read', calls: 1 });
  });

  it('passes the language counts through, first page only', async () => {
    reply = { status: 200, body: { data: { comments: [], nextCursor: null, languageCounts: [{ language: 'en', count: 812 }, { language: 'ar', count: 'x' }], sourceCounts: [{ source: 'tvtime', count: 800 }, { source: 'opentv', count: 0 }, { source: 7, count: 1 }] } } };
    const res = await get('type=show&id=7');
    expect(res.json.languageCounts).toEqual([{ language: 'en', count: 812 }]);
    expect(res.json.sourceCounts).toEqual([{ source: 'tvtime', count: 800 }, { source: 'opentv', count: 0 }]);
  });

  it('reports a comment, and refuses "mine" on anything but the archive', async () => {
    const tk = await tokenFor(env, 'p1');
    const id = '461e74b7-a099-4d5b-8da1-bba42393d5a5';
    reply = { status: 202, body: {} };
    const ok = await call(env, 'POST', '/v1/commsuni/report', { token: tk, body: { id, reason: 'spam', client_id: 'abcdefgh1' } });
    expect(ok.status).toBe(200);
    expect(calls.at(-1)!.url).toBe(`https://api.commsuni.tv/v1/comments/${id}/reports`);
    expect(calls.at(-1)!.headers.get('idempotency-key')).toBe('abcdefgh1');
    const mine = await call(env, 'POST', '/v1/commsuni/report', { token: tk, body: { id, reason: 'mine_hide', client_id: 'abcdefgh2' } });
    expect(mine.status).toBe(400);
    const mineArchived = await call(env, 'POST', '/v1/commsuni/report', { token: tk, body: { id, reason: 'mine_hide', archived: true, client_id: 'abcdefgh3' } });
    expect(mineArchived.status).toBe(200);
    expect((await call(env, 'POST', '/v1/commsuni/report', { token: tk, body: { id, reason: 'boring', client_id: 'abcdefgh4' } })).status).toBe(400);
  });

  it('asks for a reply\'s own replies with parent=', async () => {
    const root = '461e74b7-a099-4d5b-8da1-bba42393d5a5';
    const branch = '561e74b7-a099-4d5b-8da1-bba42393d5a6';
    reply = { status: 200, body: { data: { replies: [], nextCursor: null } } };
    await call(env, 'GET', `/v1/commsuni/replies?id=${root}&parent=${branch}`, { token: await tokenFor(env, 'p1') });
    expect(calls.at(-1)!.url).toContain(`/comments/${root}/replies?`);
    expect(calls.at(-1)!.url).toContain(`parent=${branch}`);
  });

  it('sends a new name to CommsUni at once, only for somebody sharing', async () => {
    await refreshCommsuniProfile(env, 'p1', 'https://api.example');
    expect(calls).toHaveLength(0);
    await env.DB.prepare(
      `INSERT INTO commsuni_consent (id, profile_id, decision, identity, prompt_version, covers_existing, decided_at)
       VALUES ('k1', 'p1', 'share', 'profile', 1, 0, '2026-10-05T00:00:00Z')`,
    ).run();
    await refreshCommsuniProfile(env, 'p1', 'https://api.example');
    expect(calls.at(-1)!.url).toBe('https://api.commsuni.tv/v1/authors/me/profile');
  });

  it('sends a reply\'s spoiler flag and GIPHY GIF, and falls back to the words if the GIF is refused', async () => {
    await env.DB.prepare(
      `INSERT INTO commsuni_consent (id, profile_id, decision, identity, prompt_version, covers_existing, decided_at)
       VALUES ('k2', 'p1', 'share', 'persona', 1, 0, '2026-10-05T00:00:00Z')`,
    ).run();
    const tk = await tokenFor(env, 'p1');
    const parent = '461e74b7-a099-4d5b-8da1-bba42393d5a5';
    const gif = 'https://media2.giphy.com/media/abc/giphy.gif';
    const bodies: unknown[] = [];
    let status = 201;
    vi.stubGlobal('fetch', async (url: string, init: { body?: string }) => {
      if (url.includes('/replies')) bodies.push(JSON.parse(init.body ?? '{}'));
      return new Response(JSON.stringify(url.includes('/replies') && status === 400 ? { error: { code: 'invalid_parameter' } } : { data: { comment: { id: 'r1' } } }), {
        status: url.includes('/replies') ? status : 200,
      });
    });
    // A GIF is Plus.
    const free = await call(env, 'POST', '/v1/commsuni/reply', { token: tk, body: { parent, text: 'ha', gif, client_id: 'abcdefgh6' } });
    expect(free.status).toBe(403);
    await env.DB.prepare("UPDATE profiles SET is_plus = 1 WHERE id = 'p1'").run();
    const ok = await call(env, 'POST', '/v1/commsuni/reply', { token: tk, body: { parent, text: 'ha', spoiler: true, gif, client_id: 'abcdefgh9' } });
    expect(ok.status).toBe(200);
    expect(bodies.at(-1)).toEqual({ text: 'ha', isSpoiler: true, attachments: [{ url: gif, contentType: 'image/gif', provider: 'giphy' }] });

    status = 400;
    bodies.length = 0;
    await call(env, 'POST', '/v1/commsuni/reply', { token: tk, body: { parent, text: 'ha', gif, client_id: 'abcdefgh8' } });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual({ text: 'ha', isSpoiler: false });

    const gifOnly = await call(env, 'POST', '/v1/commsuni/reply', { token: tk, body: { parent, text: '', gif, client_id: 'abcdefgh7' } });
    expect(gifOnly.status).toBe(422);
  });

  it('needs a signed-in member', async () => {
    expect((await call(env, 'GET', '/v1/commsuni/comments?type=show&id=1')).status).toBe(401);
  });

  it('sends the key and an opaque actor id, and never a device header', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.json.comments[0].text).toBe('great');
    expect(calls[0]!.url).toBe('https://api.commsuni.tv/v1/entities/episode/tvdb-289590-s1e2/comments?limit=20&sort=most_liked&include=language_counts%2Csource_counts');
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer tvta_live_test');
    expect(calls[0]!.headers.get('x-tvta-actor-id')).toMatch(/^[0-9a-f]{64}$/);
    expect(calls[0]!.headers.get('origin')).toBeNull();
  });

  it('answers a repeat read from the cache', async () => {
    await get();
    await new Promise((r) => setTimeout(r, 5));
    await get();
    expect(calls).toHaveLength(1);
  });

  it('turns "never archived" into an empty thread', async () => {
    reply = { status: 404, body: { error: { code: 'not_archived' } } };
    const res = await get('type=show&id=99');
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ comments: [], nextCursor: null, archived: false });
  });

  it('stops asking for a minute after a 429', async () => {
    reply = { status: 429, body: { error: { code: 'rate_limited' } } };
    expect((await get('type=show&id=1')).status).toBe(503);
    expect((await get('type=show&id=2')).status).toBe(503);
    expect(calls).toHaveLength(1);
  });

  it('is off, quietly, when no key is configured', async () => {
    env = { ...env, COMMSUNI_API_KEY: undefined };
    expect((await get()).status).toBe(503);
    expect(calls).toHaveLength(0);
  });
});

describe('GET /v1/commsuni/replies', () => {
  let env: Env;
  let urls: string[];
  beforeEach(() => {
    const fresh = freshDatabase();
    fresh.raw.prepare(`INSERT INTO profiles (id, handle, handle_lower, created_at) VALUES ('p1', 'a', 'a', '2026-09-29')`).run();
    env = { ...makeEnv(fresh.db), COMMSUNI_API_KEY: 'tvta_live_test' };
    urls = [];
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ data: { replies: [{ id: 'r1', text: 'agreed', origin: { kind: 'partner', slug: 'seenfy' } }, { id: 'r2', text: null, deleted: true }], nextCursor: null } }), { status: 200 });
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("opens one thread's replies, tombstones hidden", async () => {
    const res = await call(env, 'GET', '/v1/commsuni/replies?id=4f1c2a9e-1111-2222-3333-444455556666', { token: await tokenFor(env, 'p1') });
    expect(res.status).toBe(200);
    expect(res.json.replies.map((r: { id: string }) => r.id)).toEqual(['r1']);
    expect(urls[0]).toBe('https://api.commsuni.tv/v1/comments/4f1c2a9e-1111-2222-3333-444455556666/replies?limit=50&sort=most_recent');
  });
  it('refuses an id that is not one, and needs a member', async () => {
    expect((await call(env, 'GET', '/v1/commsuni/replies?id=../../x', { token: await tokenFor(env, 'p1') })).status).toBe(400);
    expect((await call(env, 'GET', '/v1/commsuni/replies?id=4f1c2a9e-1111')).status).toBe(401);
  });
});

describe('POST /v1/commsuni/share', () => {
  let env: Env;
  let raw: import('better-sqlite3').Database;
  let sent: { url: string; method: string; headers: Headers; body: unknown }[];
  beforeEach(() => {
    const fresh = freshDatabase();
    raw = fresh.raw;
    raw.prepare(`INSERT INTO profiles (id, handle, handle_lower, created_at) VALUES ('p1', 'a', 'a', '2026-09-29'), ('p2', 'b', 'b', '2026-09-29')`).run();
    const say = raw.prepare(
      `INSERT INTO comments (id, author_id, target_source, target_key, season, episode, body, is_spoiler, lang, parent_id, imported_at, created_at, like_count)
       VALUES (?, ?, 'tvdb', '289590', 1, 2, ?, 0, 'en', ?, NULL, '2026-10-02T10:00:00Z', 0)`,
    );
    say.run('mine', 'p1', 'great episode', null);
    say.run('theirs', 'p2', 'not yours', null);
    say.run('reply', 'p1', 'a reply', 'theirs');
    env = { ...makeEnv(fresh.db), COMMSUNI_API_KEY: 'tvta_live_test' };
    sent = [];
    vi.stubGlobal('fetch', async (url: string, init: { method?: string; headers: Record<string, string>; body?: string }) => {
      sent.push({ url, method: init.method ?? 'GET', headers: new Headers(init.headers), body: init.body ? JSON.parse(init.body) : null });
      if (url.endsWith('/comments') || url.endsWith('/replies')) return new Response(JSON.stringify({ data: { comment: { id: 'cu1' } } }), { status: 201 });
      return new Response(null, { status: 204 });
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const consent = (decision: string, identity: string | null) =>
    raw.prepare(`INSERT INTO commsuni_consent (id, profile_id, decision, identity, prompt_version, covers_existing, decided_at) VALUES (?, 'p1', ?, ?, 1, 0, ?)`).run(crypto.randomUUID(), decision, identity, new Date().toISOString());
  const share = async (comment_id: string) => call(env, 'POST', '/v1/commsuni/share', { token: await tokenFor(env, 'p1'), body: { comment_id } });

  it('refuses without consent to share', async () => {
    expect((await share('mine')).status).toBe(403);
    consent('keep_private', null);
    expect((await share('mine')).status).toBe(403);
    expect(sent).toHaveLength(0);
  });

  it('shares a comment already saved here, by id, with an idempotency key and the actor', async () => {
    consent('share', 'persona');
    const res = await share('mine');
    expect(res.status).toBe(200);
    const post = sent.find((s) => s.method === 'POST')!;
    expect(post.url).toBe('https://api.commsuni.tv/v1/entities/episode/tvdb-289590-s1e2/comments');
    expect(post.headers.get('idempotency-key')).toBe('mine');
    expect(post.headers.get('x-tvta-actor-id')).toMatch(/^[0-9a-f]{64}$/);
    expect(post.body).toEqual({ text: 'great episode', language: 'en', isSpoiler: false });
    // persona: the profile overlay is cleared, not set
    expect(sent.find((s) => s.url.endsWith('/authors/me/profile'))!.method).toBe('DELETE');
  });

  it("never shares somebody else's comment or a reply", async () => {
    consent('share', 'profile');
    expect((await share('theirs')).status).toBe(404);
    expect((await share('reply')).status).toBe(404);
    expect(sent.filter((s) => s.method === 'POST')).toHaveLength(0);
  });

  const PARENT = '4f1c2a9e-1111-2222-3333-444455556666';
  const reply = async (body: Record<string, unknown>) => call(env, 'POST', '/v1/commsuni/reply', { token: await tokenFor(env, 'p1'), body });

  it('replies only with consent, and only with words', async () => {
    expect((await reply({ parent: PARENT, text: 'agreed', client_id: 'client-1234' })).status).toBe(403);
    consent('share', 'profile');
    expect((await reply({ parent: PARENT, text: '   ', client_id: 'client-1234' })).status).toBe(400);
    expect((await reply({ parent: 'not-a-uuid', text: 'agreed', client_id: 'client-1234' })).status).toBe(400);
    expect(sent.filter((s) => s.method === 'POST')).toHaveLength(0);
  });

  it('posts a reply under the parent, keyed by the client id', async () => {
    consent('share', 'profile');
    const res = await reply({ parent: PARENT, text: ' agreed ', client_id: 'client-1234' });
    expect(res.status).toBe(200);
    const post = sent.find((s) => s.method === 'POST')!;
    expect(post.url).toBe(`https://api.commsuni.tv/v1/comments/${PARENT}/replies`);
    expect(post.headers.get('idempotency-key')).toBe('client-1234');
    expect(post.body).toEqual({ text: 'agreed', isSpoiler: false });
    // profile identity: their name goes first
    expect(sent.find((s) => s.url.endsWith('/authors/me/profile'))!.method).toBe('PUT');
  });
});

describe('GET /v1/commsuni/media/:id', () => {
  let env: Env;
  let calls: { url: string; auth: string | null }[];
  let grant: { status: string; url?: string };
  const store = new Map<string, Response>();
  const ID = '4f1c2a9e-1111-2222-3333-444455556666';
  beforeEach(() => {
    const fresh = freshDatabase();
    fresh.raw.prepare(`INSERT INTO profiles (id, handle, handle_lower, created_at) VALUES ('p1', 'a', 'a', '2026-09-29')`).run();
    env = { ...makeEnv(fresh.db), COMMSUNI_API_KEY: 'tvta_live_test' };
    calls = [];
    store.clear();
    grant = { status: 'granted', url: 'https://media.commsuni.tv/signed/abc' };
    vi.stubGlobal('caches', {
      default: {
        match: async (r: Request) => store.get(r.url)?.clone(),
        put: async (r: Request, res: Response) => void store.set(r.url, res),
      },
    });
    vi.stubGlobal('fetch', async (url: string, init?: { headers?: Record<string, string> }) => {
      calls.push({ url, auth: init?.headers?.Authorization ?? null });
      if (url.endsWith('/media-grants')) return new Response(JSON.stringify({ data: { grants: [{ commentId: ID, ...grant, contentType: 'image/jpeg' }] } }), { status: 200 });
      return new Response('JPEGBYTES', { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
    });
  });
  afterEach(() => vi.unstubAllGlobals());
  const get = async () => call(env, 'GET', `/v1/commsuni/media/${ID}`, { token: await tokenFor(env, 'p1') });

  it('fetches the signed picture without our key, and serves the bytes', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const delivery = calls.find((c) => c.url.startsWith('https://media.commsuni.tv'))!;
    expect(delivery.auth).toBeNull();
  });

  it('remembers a missing picture instead of asking again', async () => {
    grant = { status: 'missing' };
    expect((await get()).status).toBe(404);
    expect((await get()).status).toBe(404);
    expect(calls.filter((c) => c.url.endsWith('/media-grants'))).toHaveLength(1);
  });

  it('refuses an id that is not a comment id', async () => {
    expect((await call(env, 'GET', '/v1/commsuni/media/abc', { token: await tokenFor(env, 'p1') })).status).toBe(400);
  });
});
