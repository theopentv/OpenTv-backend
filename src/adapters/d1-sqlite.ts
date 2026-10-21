/**
 * D1, spoken by SQLite.
 *
 * WHY THIS IS NOT TEST CODE ANY MORE. It began in `test/harness.ts` so the
 * Worker could be driven end to end without workerd, and 558 tests have been
 * shaping it since -- including the bound-parameter ceiling and the `batch()`
 * behaviour a first version got wrong. That makes it the most exercised
 * adapter in this repository, so the self-hosted container runs THIS rather
 * than a second implementation nobody would test and which would drift the
 * first time either was fixed.
 *
 * The harness imports it from here for exactly the same reason.
 */
import type Database from 'better-sqlite3';

import { D1_MAX_BOUND_PARAMS } from '@/pure';

/**
 * The smallest honest D1 shim: `prepare().bind().run()/all()/first()` with
 * `meta.changes`. Synchronous underneath, async on the outside, exactly as D1
 * presents itself.
 *
 * `batch()` executes in order and does not roll back — the ordering is the half
 * the import endpoints actually depend on (the rollup statement's
 * `WHERE NOT EXISTS` guard must run before that item's insert), and atomicity
 * is D1's to provide.
 *
 * It also returns `results` for a SELECT, which D1 does and an earlier version
 * of this shim did not: it called `run()` on every statement and threw the rows
 * away. A batch of SELECTs would have come back as a row of empty envelopes,
 * and the first route to read a list through `batch()` would have been tested
 * against a lie.
 */
export function d1(db: Database.Database): D1Database {
  const prepare = (sql: string, binds: unknown[] = []): D1PreparedStatement => {
    // THE LIMIT SQLITE DOES NOT HAVE AND D1 DOES.
    //
    // better-sqlite3 will happily bind a thousand parameters, so a shim without
    // this line reports green for a statement production answers with a 500.
    // That is exactly how the aggregate list form shipped: its tests only ever
    // asked for one or two targets, and would have passed at a hundred.
    if (binds.length > D1_MAX_BOUND_PARAMS) {
      throw new Error(
        `D1 binds at most ${D1_MAX_BOUND_PARAMS} parameters per query; this one has ${binds.length}.`,
      );
    }
    const stmt = () => db.prepare(sql);
    const api = {
      bind: (...values: unknown[]) => prepare(sql, values),
      async run() {
        const info = stmt().run(...(binds as never[]));
        return { success: true, meta: { changes: info.changes } };
      },
      async all() {
        return { success: true, results: stmt().all(...(binds as never[])), meta: {} };
      },
      async first(col?: string) {
        const row = stmt().get(...(binds as never[])) as Record<string, unknown> | undefined;
        if (!row) return null;
        return col === undefined ? row : (row[col] ?? null);
      },
      async raw() {
        return [];
      },
      /**
       * What one member of a `batch()` returns: rows when it reads, `changes`
       * when it writes. better-sqlite3 refuses `all()` on a non-reader and
       * `run()` discards rows, so the two are told apart by `stmt.reader`.
       */
      async batchRun() {
        const st = stmt();
        if (st.reader) {
          return { success: true, results: st.all(...(binds as never[])), meta: { changes: 0 } };
        }
        const info = st.run(...(binds as never[]));
        return { success: true, results: [], meta: { changes: info.changes } };
      },
    };
    return api as unknown as D1PreparedStatement;
  };

  const api = {
    prepare: (sql: string) => prepare(sql),
    async batch(stmts: D1PreparedStatement[]) {
      // AS D1 DOES. Real D1 throws on an empty batch; a shim that shrugged hid
      // a 500 on `PUT /v1/me/published` with no rows (21 Oct).
      if (stmts.length === 0) throw new Error('D1_ERROR: No SQL statements detected.');
      const out: unknown[] = [];
      for (const s of stmts) out.push(await (s as unknown as { batchRun(): Promise<unknown> }).batchRun());
      return out;
    },
  };
  return api as unknown as D1Database;
}
