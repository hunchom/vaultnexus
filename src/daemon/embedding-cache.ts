import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface CacheWrite { key: string; vec: Float32Array; }

/** On-disk key→Float32Array store (better-sqlite3 BLOB). Durable per setMany transaction. */
export class EmbeddingCache {
  private readonly db: Database.Database;
  private readonly getStmt: Database.Statement;
  private readonly setStmt: Database.Statement;
  private readonly setTxn: (writes: CacheWrite[]) => void;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec('CREATE TABLE IF NOT EXISTS emb (k TEXT PRIMARY KEY, vec BLOB NOT NULL)');
    this.getStmt = this.db.prepare('SELECT vec FROM emb WHERE k = ?');
    this.setStmt = this.db.prepare('INSERT OR REPLACE INTO emb (k, vec) VALUES (?, ?)');
    this.setTxn = this.db.transaction((writes: CacheWrite[]) => {
      for (const w of writes) this.setStmt.run(w.key, Buffer.from(w.vec.buffer, w.vec.byteOffset, w.vec.byteLength));
    });
  }

  /** Lookup in input order; miss → undefined. */
  getMany(keys: string[]): Array<Float32Array | undefined> {
    return keys.map((k) => {
      const row = this.getStmt.get(k) as { vec: Buffer } | undefined;
      if (!row) return undefined;
      const b = row.vec; // copy to fresh 0-offset ArrayBuffer (avoids pooled-buffer offset hazards)
      return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    });
  }

  setMany(writes: CacheWrite[]): void {
    if (writes.length) this.setTxn(writes);
  }

  close(): void {
    this.db.close();
  }
}
