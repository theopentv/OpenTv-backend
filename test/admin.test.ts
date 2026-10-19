import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '@/env';
import { call, freshDatabase, insertProfile, makeEnv, tokenFor } from './harness';

/**
 * The dashboard's door. The cases here are the ones where being wrong is
 * invisible from the outside: a missing secret that opens rather than closes,
 * a cookie accepted without its signature, and an expiry nobody checks.
 */
describe('the admin dashboard', () => {
  let env: Env;
  /** The same database the env holds, for arranging rows a route cannot make. */
  let raw: ReturnType<typeof freshDatabase>['raw'];

  beforeEach(() => {
    const fresh = freshDatabase();
    raw = fresh.raw;
    env = { ...makeEnv(fresh.db), ADMIN_EMAIL: 'me@example.com', ADMIN_PASSWORD: 'a-long-one' };
  });

  const login = (over: Record<string, string> = {}) =>
    call(env, 'POST', '/v1/admin/login', {
      body: { email: 'me@example.com', password: 'a-long-one', ...over },
    });

  it('refuses everything when no administrator is configured', async () => {
    const bare = makeEnv(freshDatabase().db);
    const res = await call(bare, 'POST', '/v1/admin/login', {
      body: { email: '', password: '' },
    });
    // The dangerous failure is comparing against undefined and letting an
    // empty password through.
    expect(res.status).toBe(503);
  });

  it('refuses a wrong password, and says nothing about which half was wrong', async () => {
    const wrongPass = await login({ password: 'not-it-at-all' });
    const wrongUser = await login({ email: 'someone@example.com' });
    expect(wrongPass.status).toBe(401);
    expect(wrongUser.status).toBe(401);
    expect(wrongPass.json).toEqual(wrongUser.json);
  });

  it('lets the right pair in and hands back an HttpOnly cookie', async () => {
    const res = await login();
    expect(res.status).toBe(200);
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('otv_admin=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
  });

  it('refuses stats without a cookie, and with a forged one', async () => {
    expect((await call(env, 'GET', '/v1/admin/stats')).status).toBe(401);

    const forged = await call(env, 'GET', '/v1/admin/stats', {
      headers: { Cookie: 'otv_admin=eyJleHAiOjk5OTk5OTk5OTl9.not-a-real-signature' },
    });
    expect(forged.status).toBe(401);
  });

  it('answers stats with the cookie it just issued', async () => {
    const cookie = (await login()).headers.get('set-cookie')!.split(';')[0]!;
    const res = await call(env, 'GET', '/v1/admin/stats', { headers: { Cookie: cookie } });

    expect(res.status).toBe(200);
    expect(res.json.totals.accounts).toBe(0);
    expect(Array.isArray(res.json.joins)).toBe(true);
  });

  it('answers the activity windows, and they are numbers rather than absent', async () => {
    const cookie = (await login()).headers.get('set-cookie')!.split(';')[0]!;
    const res = await call(env, 'GET', '/v1/admin/stats', { headers: { Cookie: cookie } });
    const t = res.json.totals;
    // A window that silently vanished from the query would render as an empty
    // card rather than an error, so the shape is what is worth asserting.
    for (const k of [
      'comments_today', 'comments_7d', 'comments_30d',
      'ratings_today', 'ratings_7d', 'ratings_30d',
      'characters_today', 'characters_7d', 'characters_30d',
      // People, which is the half a single bulk import cannot inflate.
      'raters_today', 'raters_7d', 'raters_30d',
      'commenters_today', 'commenters_7d', 'commenters_30d',
      'voters_today', 'voters_7d', 'voters_30d',
    ]) {
      expect(typeof t[k]).toBe('number');
    }
    // Windows nest: a day is inside a week is inside a month.
    expect(t.comments_today).toBeLessThanOrEqual(t.comments_7d);
    expect(t.comments_7d).toBeLessThanOrEqual(t.comments_30d);
  });

  it('counts what was written here, never what arrived in bulk', async () => {
    const cookie = (await login()).headers.get('set-cookie')!.split(';')[0]!;
    const now = new Date().toISOString();
    // One rating written tonight, one seeded from an archive an hour ago. Both
    // are real rows with today's created_at; only the first is activity.
    raw
      .prepare(`INSERT INTO profiles (id, handle, handle_lower, created_at) VALUES ('p1', 'someone', 'someone', ?)`)
      .run(now);
    raw
      .prepare(
        `INSERT INTO ratings (id, author_id, target_source, target_key, score, created_at, imported_at)
         VALUES ('r1', 'p1', 'tvdb', 'tvdb:1', 5, ?, NULL), ('r2', 'p1', 'tvdb', 'tvdb:2', 4, ?, ?)`,
      )
      .run(now, now, now);

    const res = await call(env, 'GET', '/v1/admin/stats', { headers: { Cookie: cookie } });
    expect(res.json.totals.ratings).toBe(2);
    expect(res.json.totals.ratings_today).toBe(1);
    expect(res.json.totals.raters_today).toBe(1);
  });

  /*
   * THE DAY BUTTONS. "Opened yesterday" needs the day log, because
   * last_seen_at only remembers the latest open; and yesterday's ratings must
   * not show up as today's or vice versa.
   */
  it('answers for a past day from the day log, not for today', async () => {
    const cookie = (await login()).headers.get('set-cookie')!.split(';')[0]!;
    const today = new Date().toISOString().slice(0, 10);
    const yday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    raw.prepare(`INSERT INTO profiles (id, handle, handle_lower, created_at, last_seen_at) VALUES ('p1', 'someone', 'someone', ?, ?)`)
      .run(`${yday}T08:00:00.000Z`, `${today}T09:00:00.000Z`);
    raw.prepare(`INSERT INTO profile_days (profile_id, day) VALUES ('p1', ?)`).run(yday);
    raw.prepare(`INSERT INTO ratings (id, author_id, target_source, target_key, season, episode, score, created_at)
                 VALUES ('r1', 'p1', 'tvdb', '1', 1, 1, 5, ?)`).run(`${yday}T10:00:00.000Z`);

    const past = await call(env, 'GET', `/v1/admin/users?day=${yday}`, { headers: { Cookie: cookie } });
    expect(past.json.day).toBe(yday);
    expect(past.json.items[0].opened_today).toBe(true);
    expect(past.json.items[0].today).toHaveLength(1);

    const now = await call(env, 'GET', '/v1/admin/users', { headers: { Cookie: cookie } });
    expect(now.json.day).toBe(today);
    expect(now.json.items[0].today).toHaveLength(0); // yesterday's rating stays yesterday's

    const future = await call(env, 'GET', '/v1/admin/users?day=2999-01-01', { headers: { Cookie: cookie } });
    expect(future.json.day).toBe(today);
  });

  /*
   * THE DASHBOARD WAS THE DATABASE'S BIGGEST READER (29 Sep): ~400k rows every
   * open. A second open inside ten minutes must not touch the database, and a
   * change made from the dashboard must show at once.
   */
  it('serves a repeat read from the cache, and a write makes it fresh', async () => {
    const cookie = (await login()).headers.get('set-cookie')!.split(';')[0]!;
    const now = new Date().toISOString();
    raw.prepare(`INSERT INTO profiles (id, handle, handle_lower, created_at) VALUES ('p1', 'someone', 'someone', ?)`).run(now);
    const first = await call(env, 'GET', '/v1/admin/users', { headers: { Cookie: cookie } });
    await new Promise((r) => setTimeout(r, 5)); // the cache write is waitUntil'd
    // Changed underneath without going through the dashboard: a cached read
    // must not see it...
    raw.prepare(`INSERT INTO profiles (id, handle, handle_lower, created_at) VALUES ('p2', 'another', 'another', ?)`).run(now);
    const second = await call(env, 'GET', '/v1/admin/users', { headers: { Cookie: cookie } });
    expect(second.json.items).toHaveLength(first.json.items.length);
    // ...and a change made FROM the dashboard makes the next read fresh.
    await call(env, 'POST', '/v1/admin/users/someone/plus', { body: { months: 1 }, headers: { Cookie: cookie } });
    const third = await call(env, 'GET', '/v1/admin/users', { headers: { Cookie: cookie } });
    expect(third.json.items).toHaveLength(2);
    // The Hard refresh button does the same without changing anything.
    raw.prepare(`INSERT INTO profiles (id, handle, handle_lower, created_at) VALUES ('p3', 'third', 'third', ?)`).run(now);
    expect((await call(env, 'GET', '/v1/admin/users', { headers: { Cookie: cookie } })).json.items).toHaveLength(2);
    expect((await call(env, 'POST', '/v1/admin/cache/clear', { headers: { Cookie: cookie } })).status).toBe(200);
    expect((await call(env, 'GET', '/v1/admin/users', { headers: { Cookie: cookie } })).json.items).toHaveLength(3);
    expect((await call(env, 'POST', '/v1/admin/cache/clear')).status).toBe(401);
    // Never served to somebody without the cookie.
    expect((await call(env, 'GET', '/v1/admin/users')).status).toBe(401);
  });

  it("tags Google's test robots and leaves them out of the counts", async () => {
    const cookie = (await login()).headers.get('set-cookie')!.split(';')[0]!;
    const now = new Date().toISOString();
    for (const [id, h, mail] of [
      ['r1', 'user_p_robot', 'roycobb.00486@gmail.com'],
      // Same shape of address, but a real member: has rated something.
      ['h1', 'human', 'jane.12345@gmail.com'],
    ]) {
      raw.prepare(`INSERT INTO profiles (id, handle, handle_lower, created_at) VALUES (?, ?, ?, ?)`).run(id, h, h, now);
      raw.prepare(`INSERT INTO identities (provider, external_id, profile_id, email, created_at) VALUES ('google', ?, ?, ?, ?)`).run(id, id, mail, now);
    }
    raw.prepare(`INSERT INTO ratings (id, author_id, target_source, target_key, season, episode, score, created_at)
                 VALUES ('x1', 'h1', 'tvdb', '1', 1, 1, 5, ?)`).run(now);

    const stats = await call(env, 'GET', '/v1/admin/stats', { headers: { Cookie: cookie } });
    expect(stats.json.totals.robots).toBe(1);
    expect(stats.json.totals.accounts).toBe(1);
    const users = await call(env, 'GET', '/v1/admin/users', { headers: { Cookie: cookie } });
    const by = Object.fromEntries(users.json.items.map((u: { handle: string; robot: number }) => [u.handle, u.robot]));
    expect(by).toEqual({ user_p_robot: 1, human: 0 });
  });

  it('lists people without listing anything they wrote', async () => {
    const cookie = (await login()).headers.get('set-cookie')!.split(';')[0]!;
    const res = await call(env, 'GET', '/v1/admin/users', { headers: { Cookie: cookie } });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.json.items)).toBe(true);
    // The line this route sits on: who, and how much, never what. A body field
    // appearing here would be the thing to catch.
    expect(res.text).not.toContain('body');
  });

  /*
   * "319947 S1E1" was what the dashboard printed for a show nobody had put on
   * their profile. The server holds no catalogue and never will, so the only
   * names it has are the ones phones sent alongside a key -- and it was asking
   * one of the three tables that hold them.
   */
  it('names a title from a list when no shelf has it', async () => {
    const cookie = (await login()).headers.get('set-cookie')!.split(';')[0]!;
    const now = new Date().toISOString();
    raw
      .prepare(`INSERT INTO profiles (id, handle, handle_lower, created_at) VALUES ('p1', 'someone', 'someone', ?)`)
      .run(now);
    raw
      .prepare(
        `INSERT INTO ratings (id, author_id, target_source, target_key, season, episode, score, created_at)
         VALUES ('r1', 'p1', 'tvdb', '319947', 1, 1, 5, ?)`,
      )
      .run(now);
    // Not on anybody's shelf — only in a list, which is where the name was
    // sitting unread.
    raw.prepare(`INSERT INTO lists (id, owner_id, name, created_at) VALUES ('l1', 'p1', 'Later', ?)`).run(now);
    raw
      .prepare(
        `INSERT INTO list_items (list_id, position, target_source, target_key, title)
         VALUES ('l1', 0, 'tvdb', '319947', 'Poker Face')`,
      )
      .run();

    const res = await call(env, 'GET', '/v1/admin/users', { headers: { Cookie: cookie } });
    const me = (res.json.items as { id: string; today: { title: string; where: string }[] }[]).find(
      (u) => u.id === 'p1',
    );
    expect(me?.today?.[0]?.title).toBe('Poker Face');
    expect(me?.today?.[0]?.where).toBe('S1E1');
  });

  /*
   * THE OTHER 27%. A shelf is truncated and a rating is not, so a member with
   * a large library rates plenty of shows that never reach `profile_titles`.
   * The name has to ride along with the write or it does not exist.
   */
  it('names a title from the rating that carried it', async () => {
    const cookie = (await login()).headers.get('set-cookie')!.split(';')[0]!;
    insertProfile(raw, 'p9', 'marley');
    const token = await tokenFor(env, 'p9');

    await call(env, 'POST', '/v1/ratings', {
      token,
      body: { target_source: 'tvdb', target_key: '319947', season: 1, episode: 1, score: 10, title: 'Killision Course' },
    });
    // Nowhere else on the server knows this show.
    expect(raw.prepare(`SELECT COUNT(*) AS n FROM profile_titles WHERE target_key='319947'`).get()).toEqual({ n: 0 });

    const res = await call(env, 'GET', '/v1/admin/users', { headers: { Cookie: cookie } });
    const them = (res.json.items as { id: string; today: { title: string }[] }[]).find((u) => u.id === 'p9');
    expect(them?.today?.[0]?.title).toBe('Killision Course');
  });

  /* First writer wins: one doctored request must not rename a title for
     everybody who comes after it. */
  it('keeps the first name it was given', async () => {
    insertProfile(raw, 'p9', 'marley');
    const token = await tokenFor(env, 'p9');
    const rate = (title: string) =>
      call(env, 'POST', '/v1/ratings', {
        token,
        body: { target_source: 'tvdb', target_key: '42', score: 8, title },
      });
    await rate('The Real One');
    await rate('Something Else');
    expect(raw.prepare(`SELECT name FROM title_names WHERE target_key='42'`).get()).toEqual({
      name: 'The Real One',
    });
  });

  it('refuses the people list without a cookie', async () => {
    expect((await call(env, 'GET', '/v1/admin/users')).status).toBe(401);
  });

  it('serves the page itself, unindexed', async () => {
    const res = await call(env, 'GET', '/admin/dashboard');
    expect(res.status).toBe(200);
    expect(res.text).toContain('OpenTV');
    expect(res.headers.get('x-robots-tag')).toContain('noindex');
  });

  /**
   * One decision, every copy of that GIF.
   *
   * The inheriting half (in images.test.ts) covers everybody who picks a GIF
   * AFTER a moderator rules on it. This is the people who picked it BEFORE and
   * are sitting in the queue behind the row just decided — without which
   * approving a popular reaction GIF clears one comment and leaves forty
   * identical ones to click through, which is exactly the per-person
   * moderation this is meant to end.
   */
  describe('deciding about an asset', () => {
    const cookie = async () => (await login()).headers.get('set-cookie')!.split(';')[0]!;

    const seed = (commentId: string, assetId: string | null, status = 'pending') => {
      raw
        .prepare(
          `INSERT INTO comments (id, author_id, target_source, target_key, body, created_at)
           VALUES (?, 'p1', 'tvdb', 'show:1', 'x', '2026-01-01T00:00:00.000Z')`,
        )
        .run(commentId);
      raw
        .prepare(
          `INSERT INTO comment_images (comment_id, r2_key, is_gif, scan_status, asset_id, created_at)
           VALUES (?, ?, 1, ?, ?, '2026-01-01T00:00:00.000Z')`,
        )
        .run(commentId, `comments/${commentId}.gif`, status, assetId);
    };

    const statusOf = (id: string) =>
      (raw.prepare('SELECT scan_status FROM comment_images WHERE comment_id = ?').get(id) as { scan_status: string })
        .scan_status;

    beforeEach(() => {
      raw.prepare("INSERT INTO profiles (id, handle, handle_lower, created_at) VALUES ('p1','m','m','2026-01-01')").run();
    });

    it('clears everybody else waiting behind the same GIF', async () => {
      seed('c1', 'popular');
      seed('c2', 'popular');
      seed('c3', 'popular');
      const res = await call(env, 'POST', '/v1/admin/images/c1', {
        headers: { Cookie: await cookie() },
        body: { status: 'clean' },
      });
      expect(res.status).toBe(200);
      expect(res.json.also_decided).toBe(2);
      expect(statusOf('c2')).toBe('clean');
      expect(statusOf('c3')).toBe('clean');
    });

    it('blocks them all just as widely', async () => {
      seed('c1', 'nasty');
      seed('c2', 'nasty');
      await call(env, 'POST', '/v1/admin/images/c1', {
        headers: { Cookie: await cookie() },
        body: { status: 'blocked' },
      });
      expect(statusOf('c2')).toBe('blocked');
    });

    it('leaves a row somebody already ruled on individually alone', async () => {
      // A considered decision about one comment is not overwritten by a later
      // general ruling about the asset.
      seed('c1', 'popular');
      seed('c2', 'popular', 'blocked');
      await call(env, 'POST', '/v1/admin/images/c1', {
        headers: { Cookie: await cookie() },
        body: { status: 'clean' },
      });
      expect(statusOf('c2')).toBe('blocked');
    });

    it('does not touch anything when the picture has no asset', async () => {
      // Somebody's own photograph is nobody else's, so a decision about it
      // must not reach past the comment it belongs to.
      seed('c1', null);
      seed('c2', null);
      const res = await call(env, 'POST', '/v1/admin/images/c1', {
        headers: { Cookie: await cookie() },
        body: { status: 'clean' },
      });
      expect(res.json.also_decided).toBe(0);
      expect(statusOf('c2')).toBe('pending');
    });

    it('"Show all" really shows them: bulk is not taken for a comment id', async () => {
      // Until 20 Oct `/admin/images/:id` was registered first and swallowed
      // "bulk", answering ok while changing nothing.
      seed('c1', null);
      seed('c2', null);
      seed('c3', null);
      const res = await call(env, 'POST', '/v1/admin/images/bulk', {
        headers: { Cookie: await cookie() },
        body: { ids: ['c1', 'c2'], status: 'clean' },
      });
      expect(res.status).toBe(200);
      expect(res.json.changed).toBe(2);
      expect(statusOf('c1')).toBe('clean');
      expect(statusOf('c2')).toBe('clean');
      expect(statusOf('c3')).toBe('pending');
    });

    it('lists one member\'s waiting photos when asked by handle', async () => {
      seed('c1', null);
      raw.prepare("INSERT INTO profiles (id, handle, handle_lower, created_at) VALUES ('p2','Other','other','2026-01-01')").run();
      raw.prepare(`INSERT INTO comments (id, author_id, target_source, target_key, body, created_at)
                   VALUES ('c9', 'p2', 'tvdb', 'show:1', 'x', '2026-01-01T00:00:00.000Z')`).run();
      raw.prepare(`INSERT INTO comment_images (comment_id, r2_key, is_gif, scan_status, created_at)
                   VALUES ('c9', 'comments/c9.gif', 1, 'pending', '2026-01-01T00:00:00.000Z')`).run();
      const res = await call(env, 'GET', '/v1/admin/images?status=pending&handle=@Other', { headers: { Cookie: await cookie() } });
      expect(res.json.items.map((i: { comment_id: string }) => i.comment_id)).toEqual(['c9']);
    });
  });
});

describe('POST /v1/admin/users/:handle/message', () => {
  it('puts one message in one person\'s bell, and only with the admin cookie', async () => {
    const fresh = freshDatabase();
    const env = { ...makeEnv(fresh.db), ADMIN_EMAIL: 'me@example.com', ADMIN_PASSWORD: 'a-long-one' };
    fresh.raw.prepare(`INSERT INTO profiles (id, handle, handle_lower, created_at) VALUES ('p1', 'Someone', 'someone', '2026-09-29')`).run();
    const cookie = (await call(env, 'POST', '/v1/admin/login', { body: { email: 'me@example.com', password: 'a-long-one' } }))
      .headers.get('set-cookie')!.split(';')[0]!;

    expect((await call(env, 'POST', '/v1/admin/users/someone/message', { body: { text: 'hi' } })).status).toBe(401);
    expect((await call(env, 'POST', '/v1/admin/users/someone/message', { body: { text: '' }, headers: { Cookie: cookie } })).status).toBe(400);
    const ok = await call(env, 'POST', '/v1/admin/users/someone/message', {
      body: { text: 'Thanks for the review — the import is fixed in 1.6.4. — Noddy' },
      headers: { Cookie: cookie },
    });
    expect(ok.status).toBe(200);

    const bell = await call(env, 'GET', '/v1/notifications', { token: await tokenFor(env, 'p1') });
    expect(bell.json.items[0]).toMatchObject({ kind: 'message', actor: null, body: 'Thanks for the review — the import is fixed in 1.6.4. — Noddy' });
  });

});

describe('the people list on a busy day', () => {
  it('still lists people with many new shelf titles (D1 caps a statement at 100 parameters)', async () => {
    const fresh = freshDatabase();
    const env = { ...makeEnv(fresh.db), ADMIN_EMAIL: 'me@example.com', ADMIN_PASSWORD: 'a-long-one' };
    insertProfile(fresh.raw, 'p1', 'mahmood');
    const now = new Date().toISOString();
    const add = fresh.raw.prepare("INSERT INTO shelf_seen (profile_id, kind, target_key, first_seen_at) VALUES ('p1', 'show', ?, ?)");
    for (let i = 0; i < 40; i++) add.run(`key-${i}`, now);
    const login = await call(env, 'POST', '/v1/admin/login', { body: { email: 'me@example.com', password: 'a-long-one' } });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
    const res = await call(env, 'GET', '/v1/admin/users', { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    expect(res.json.items.length).toBe(1);
  });
});

describe('the dashboard trends and the seasonal calendar', () => {
  let env: Env;
  let raw: ReturnType<typeof freshDatabase>['raw'];
  beforeEach(() => {
    const fresh = freshDatabase();
    raw = fresh.raw;
    env = { ...makeEnv(fresh.db), ADMIN_EMAIL: 'me@example.com', ADMIN_PASSWORD: 'a-long-one' };
  });
  const cookieOf = async () =>
    (await call(env, 'POST', '/v1/admin/login', { body: { email: 'me@example.com', password: 'a-long-one' } }))
      .headers.get('set-cookie')!.split(';')[0]!;

  it('counts each line per day, and keeps imports out of comments and ratings', async () => {
    const cookie = await cookieOf();
    const today = new Date().toISOString().slice(0, 10);
    const now = new Date().toISOString();
    insertProfile(raw, 'p1', 'one');
    insertProfile(raw, 'p2', 'two');
    raw.prepare('UPDATE profiles SET created_at = ?').run(now);
    raw.prepare('INSERT INTO profile_days (profile_id, day) VALUES (?, ?), (?, ?)').run('p1', today, 'p2', today);
    raw
      .prepare(
        `INSERT INTO ratings (id, author_id, target_source, target_key, score, created_at, imported_at)
         VALUES ('r1', 'p1', 'tvdb', 'tvdb:1', 5, ?, NULL), ('r2', 'p1', 'tvdb', 'tvdb:2', 4, ?, ?)`,
      )
      .run(now, now, now);

    expect((await call(env, 'GET', '/v1/admin/trends?days=14')).status).toBe(401);
    const res = await call(env, 'GET', '/v1/admin/trends?days=14', { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    expect(res.json.days).toBe(14);
    expect(res.json.series.joins).toEqual([{ day: today, n: 2, apple: 0, google: 0 }]);
    expect(res.json.series.opened).toEqual([{ day: today, n: 2 }]);
    expect(res.json.series.ratings).toEqual([{ day: today, n: 1, p: 1 }]);
    // An unknown range falls back to thirty days rather than reading a year.
    expect((await call(env, 'GET', '/v1/admin/trends?days=365', { headers: { Cookie: cookie } })).json.days).toBe(30);
  });

  it('keeps off as off, follows the calendar in auto, and keeps a hand-picked event', async () => {
    const cookie = await cookieOf();
    const set = (event: unknown) => call(env, 'POST', '/v1/admin/event', { headers: { Cookie: cookie }, body: { event } });
    const shown = async () => (await call(env, 'GET', '/v1/links')).json.event;

    expect(await shown()).toBeNull();
    const auto = await set('auto');
    expect(auto.json.mode).toBe('auto');
    const { scheduledEvent } = await import('@/pure');
    expect(await shown()).toBe(scheduledEvent(new Date().toISOString().slice(0, 10)));
    expect((await set('christmas')).json).toMatchObject({ mode: 'manual', event: 'christmas', next: null });
    expect(await shown()).toBe('christmas');
    expect((await set(null)).json.mode).toBe('off');
    expect((await set('easter')).status).toBe(400);
  });
});
