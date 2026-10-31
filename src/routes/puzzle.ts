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
  const distance = Math.abs(Date.parse(`${day}T12:00:00Z`) - Date.now());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !(distance < 2 * 864e5)) return fail(c, 400, 'invalid_body', 'Bad day.');
  if (typeof won !== 'boolean' || !Number.isInteger(tries) || !Number.isInteger(streak)) {
    return fail(c, 400, 'invalid_body', 'Bad result.');
  }
  const me = c.get('profileId');
  const db = c.env.DB;
  await db.batch([
    db
      .prepare('INSERT OR IGNORE INTO puzzle_days (profile_id, day, won, tries, streak) VALUES (?, ?, ?, ?, ?)')
      .bind(me, day, won ? 1 : 0, Math.min(Math.max(tries as number, 0), MAX_TRIES), Math.min(Math.max(streak as number, 0), 100000)),
    db.prepare("DELETE FROM puzzle_days WHERE profile_id = ? AND day < date('now', '-90 days')").bind(me),
  ]);
  return c.json({ ok: true });
});
