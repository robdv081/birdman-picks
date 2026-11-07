// A tiny stand-in for Cloudflare D1 backed by Node's built-in SQLite, for tests.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

export function makeDB(schemaPath) {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(schemaPath, 'utf8'));
  const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v);
  const stmt = (sql, params = []) => ({
    bind: (...vals) => stmt(sql, vals.map(norm)),
    async first() {
      const r = db.prepare(sql).get(...params);
      return r ? { ...r } : null;
    },
    async all() {
      return { results: db.prepare(sql).all(...params).map((r) => ({ ...r })) };
    },
    async run() {
      const r = db.prepare(sql).run(...params);
      return { results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
    _exec() {
      return db.prepare(sql).run(...params);
    },
  });
  return {
    raw: db,
    prepare: (sql) => stmt(sql),
    async batch(stmts) {
      db.exec('BEGIN');
      try {
        const out = stmts.map((s) => s._exec());
        db.exec('COMMIT');
        return out.map(() => ({ results: [] }));
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
}
