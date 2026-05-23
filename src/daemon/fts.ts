import Database from 'better-sqlite3';

export interface FtsHit { id: number; score: number; } // higher = better

/** In-memory FTS5 keyword index over chunk text, keyed by integer id (chunk array index). */
export class FtsIndex {
  private readonly db: Database.Database;
  private readonly insert: Database.Statement;

  constructor() {
    this.db = new Database(':memory:');
    this.db.exec("CREATE VIRTUAL TABLE chunks USING fts5(text, tokenize='unicode61');");
    this.insert = this.db.prepare('INSERT INTO chunks(rowid, text) VALUES (?, ?)');
  }

  /** Add chunk text under its integer id. */
  add(id: number, text: string): void {
    this.insert.run(id, text);
  }

  /** Free text → FTS5 MATCH of quoted terms; avoids syntax errors from user punctuation. */
  private toMatch(query: string): string {
    const terms = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    return terms.map((t) => `"${t}"`).join(' OR ');
  }

  /** bm25-ranked hits; higher score = better (negated from SQLite bm25 lower=better). */
  search(query: string, k: number): FtsHit[] {
    const match = this.toMatch(query);
    if (!match) return [];
    return this.db
      .prepare('SELECT rowid AS id, -bm25(chunks) AS score FROM chunks WHERE chunks MATCH ? ORDER BY bm25(chunks) LIMIT ?')
      .all(match, Math.trunc(k)) as FtsHit[]; // LIMIT needs int → float k throws "datatype mismatch"
  }

  /** Release the in-memory db (native handle). */
  close(): void {
    this.db.close();
  }
}
