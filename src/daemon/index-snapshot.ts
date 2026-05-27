import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface NoteMeta { contentSha: string; mtimeMs: number; }

export interface SnapshotChunk {
  headingPath: string[];
  text: string;
  byteStart: number;
  byteEnd: number;
  vec: Float32Array;
}

/** On-disk note→chunks store. Mirrors Plan 11 embedding-cache: better-sqlite3 + BLOB + WAL. */
export class IndexSnapshot {
  private readonly db: Database.Database;
  private readonly getNoteStmt: Database.Statement;
  private readonly upsertNoteStmt: Database.Statement;
  private readonly deleteNoteStmt: Database.Statement;
  private readonly listNotesStmt: Database.Statement;
  private readonly getChunksStmt: Database.Statement;
  private readonly deleteChunksStmt: Database.Statement;
  private readonly insertChunkStmt: Database.Statement;
  private readonly putChunksTxn: (notePath: string, chunks: SnapshotChunk[]) => void;
  // FK ON DELETE CASCADE needs pragma + table-creation FK clause → setNote() upsert clears stale rows
  private closed = false;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        notePath TEXT PRIMARY KEY,
        contentSha TEXT NOT NULL,
        mtimeMs INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        notePath TEXT NOT NULL REFERENCES notes(notePath) ON DELETE CASCADE,
        headingPath TEXT NOT NULL,
        text TEXT NOT NULL,
        byteStart INTEGER NOT NULL,
        byteEnd INTEGER NOT NULL,
        vec BLOB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_notePath ON chunks(notePath);
    `);
    this.getNoteStmt = this.db.prepare('SELECT contentSha, mtimeMs FROM notes WHERE notePath = ?');
    this.upsertNoteStmt = this.db.prepare(
      'INSERT INTO notes (notePath, contentSha, mtimeMs) VALUES (?, ?, ?) ' +
      'ON CONFLICT(notePath) DO UPDATE SET contentSha = excluded.contentSha, mtimeMs = excluded.mtimeMs',
    );
    this.deleteNoteStmt = this.db.prepare('DELETE FROM notes WHERE notePath = ?');
    this.listNotesStmt = this.db.prepare('SELECT notePath FROM notes ORDER BY notePath');
    this.getChunksStmt = this.db.prepare(
      'SELECT headingPath, text, byteStart, byteEnd, vec FROM chunks WHERE notePath = ? ORDER BY id',
    );
    this.deleteChunksStmt = this.db.prepare('DELETE FROM chunks WHERE notePath = ?');
    this.insertChunkStmt = this.db.prepare(
      'INSERT INTO chunks (notePath, headingPath, text, byteStart, byteEnd, vec) VALUES (?, ?, ?, ?, ?, ?)',
    );
    this.putChunksTxn = this.db.transaction((notePath: string, chunks: SnapshotChunk[]) => {
      this.deleteChunksStmt.run(notePath);
      for (const c of chunks) {
        const buf = Buffer.from(c.vec.buffer, c.vec.byteOffset, c.vec.byteLength);
        this.insertChunkStmt.run(notePath, JSON.stringify(c.headingPath), c.text, c.byteStart, c.byteEnd, buf);
      }
    });
  }

  getNote(notePath: string): NoteMeta | undefined {
    return this.getNoteStmt.get(notePath) as NoteMeta | undefined;
  }

  setNote(notePath: string, contentSha: string, mtimeMs: number): void {
    this.upsertNoteStmt.run(notePath, contentSha, mtimeMs);
  }

  deleteNote(notePath: string): void {
    // explicit chunks-delete first → keep contract even if FK pragma is off
    this.deleteChunksStmt.run(notePath);
    this.deleteNoteStmt.run(notePath);
  }

  listNotes(): string[] {
    return (this.listNotesStmt.all() as Array<{ notePath: string }>).map((r) => r.notePath);
  }

  getChunks(notePath: string): SnapshotChunk[] {
    const rows = this.getChunksStmt.all(notePath) as Array<{
      headingPath: string; text: string; byteStart: number; byteEnd: number; vec: Buffer;
    }>;
    return rows.map((r) => {
      const b = r.vec; // fresh 0-offset copy → avoids pooled-buffer offset hazards
      const vec = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
      return {
        headingPath: JSON.parse(r.headingPath) as string[],
        text: r.text,
        byteStart: r.byteStart,
        byteEnd: r.byteEnd,
        vec,
      };
    });
  }

  /** Atomic replace: delete prior chunks for notePath → insert new set. */
  putChunks(notePath: string, chunks: SnapshotChunk[]): void {
    this.putChunksTxn(notePath, chunks);
  }

  close(): void {
    if (this.closed) return; // idempotent
    this.closed = true;
    this.db.close();
  }
}
