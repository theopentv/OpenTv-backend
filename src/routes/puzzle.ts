import { Hono } from 'hono';
import type { App } from '@/env';
import { fail } from '@/http';
import { requireAuth } from '@/middleware';

/**
 * THE DAILY PUZZLE, AS A COUNT. The game itself lives on the phone; this is
 * what the dashboard reads to say how many people played and how long their
 * streaks are. Shape, never content: no title and no id ever arrive here.
 *
 * First write of a day wins, so a retry or a second phone changes nothing. The
 * day is the phone's own, because a puzzle day is a local day; a day more than
 * one away from the server's is refused rather than trusted.
 */
export const puzzle = new Hono<App>();

const MAX_TRIES = 6;

puzzle.post('/puzzle/played', requireAuth, async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const day = typeof body?.day === 'string' ? body.day : '';
  const { won, tries, streak } = body ?? {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return fail(c, 400, 'invalid_body', 'Bad day.');
  if (typeof won !== 'boolean' || !Number.isInteger(tries) || !Number.isInteger(streak)) {
    return fail(c, 400, 'invalid_body', 'Bad result.');
  }
  const me = c.get('profileId');
  const db = c.env.DB;
  /*
   * A far day only as a MAKE-UP (2.2.2): a day granted with tries -2 because
   * our crash cost it (L8X, Nov 2026) is played later from the archive, and
   * its result replaces the grant. Any other far day is still refused.
   */
  const distance = Math.abs(Date.parse(`${day}T12:00:00Z`) - Date.now());
  if (!(distance < 2 * 864e5)) {
    const grant = await db
      .prepare('SELECT 1 FROM puzzle_days WHERE profile_id = ? AND day = ? AND tries = -2')
      .bind(me, day)
      .first();
    if (!grant) return fail(c, 400, 'invalid_body', 'Bad day.');
  }
  // KEPT, NOT TRIMMED (2.2.2). These rows are what gives a wiped phone its
  // streak back, so a 90-day trim would cap every restored streak at 90. About
  // 100 bytes a day played; deleted with the account.
  // First write of a day wins, except over a make-up grant, which a real
  // result replaces.
  await db
    .prepare(
      `INSERT INTO puzzle_days (profile_id, day, won, tries, streak) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (profile_id, day) DO UPDATE SET won = excluded.won, tries = excluded.tries, streak = excluded.streak
       WHERE puzzle_days.tries < 0`,
    )
    .bind(me, day, won ? 1 : 0, Math.min(Math.max(tries as number, 0), MAX_TRIES), Math.min(Math.max(streak as number, 0), 100000))
    .run();
  return c.json({ ok: true });
});

/*
 * THE DAYS BACK (2.2.2). A phone that was wiped or replaced starts with no
 * history and so no streak; it asks for the days this server already holds
 * and fills its own gaps. Only what the phone itself sent.
 */
puzzle.get('/puzzle/played', requireAuth, async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT day, won, tries FROM puzzle_days WHERE profile_id = ? ORDER BY day',
  )
    .bind(c.get('profileId'))
    .all<{ day: string; won: number; tries: number }>();
  return c.json({ days: results.map((r) => ({ day: r.day, won: r.won === 1, tries: r.tries })) });
});
