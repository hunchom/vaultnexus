import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IndexSnapshot, type SnapshotChunk } from '../../src/daemon/index-snapshot.js';

const tmpDb = (): string => join(mkdtempSync(join(tmpdir(), 'vn-snap-')), 's.db');

const mkChunk = (i: number): SnapshotChunk => ({
  headingPath: [`H${i}`],
  text: `chunk text ${i}`,
  byteStart: i * 10,
  byteEnd: i * 10 + 9,
  vec: new Float32Array([i * 1.0, i * 2.0, i * 3.0]),
});

describe('IndexSnapshot', () => {
  it('roundtrips note metadata', () => {
    const s = new IndexSnapshot(tmpDb());
    expect(s.getNote('a.md')).toBeUndefined();
    s.setNote('a.md', 'sha-a', 1000);
    expect(s.getNote('a.md')).toEqual({ contentSha: 'sha-a', mtimeMs: 1000 });
    // upsert overwrites
    s.setNote('a.md', 'sha-a2', 2000);
    expect(s.getNote('a.md')).toEqual({ contentSha: 'sha-a2', mtimeMs: 2000 });
    s.close();
  });

  it('roundtrips chunks with Float32Array via BLOB', () => {
    const s = new IndexSnapshot(tmpDb());
    s.setNote('a.md', 'sha-a', 1);
    s.putChunks('a.md', [mkChunk(1), mkChunk(2)]);
    const got = s.getChunks('a.md');
    expect(got).toHaveLength(2);
    expect(got[0].headingPath).toEqual(['H1']);
    expect(got[0].text).toBe('chunk text 1');
    expect(got[0].byteStart).toBe(10);
    expect(got[0].byteEnd).toBe(19);
    expect(Array.from(got[0].vec)).toEqual([1, 2, 3]);
    expect(Array.from(got[1].vec)).toEqual([2, 4, 6]);
    s.close();
  });

  it('putChunks replaces prior chunks atomically', () => {
    const s = new IndexSnapshot(tmpDb());
    s.setNote('a.md', 'sha-a', 1);
    s.putChunks('a.md', [mkChunk(1), mkChunk(2), mkChunk(3)]);
    expect(s.getChunks('a.md')).toHaveLength(3);
    s.putChunks('a.md', [mkChunk(9)]);
    const got = s.getChunks('a.md');
    expect(got).toHaveLength(1);
    expect(got[0].text).toBe('chunk text 9');
    s.close();
  });

  it('deleteNote cascades to chunks', () => {
    const s = new IndexSnapshot(tmpDb());
    s.setNote('a.md', 'sha-a', 1);
    s.setNote('b.md', 'sha-b', 2);
    s.putChunks('a.md', [mkChunk(1)]);
    s.putChunks('b.md', [mkChunk(2)]);
    s.deleteNote('a.md');
    expect(s.getNote('a.md')).toBeUndefined();
    expect(s.getChunks('a.md')).toEqual([]);
    expect(s.getNote('b.md')).toBeDefined();
    expect(s.getChunks('b.md')).toHaveLength(1);
    s.close();
  });

  it('listNotes returns sorted note paths', () => {
    const s = new IndexSnapshot(tmpDb());
    s.setNote('z.md', 'sha-z', 1);
    s.setNote('a.md', 'sha-a', 2);
    s.setNote('m.md', 'sha-m', 3);
    expect(s.listNotes()).toEqual(['a.md', 'm.md', 'z.md']);
    s.close();
  });

  it('persists across reopen', () => {
    const path = tmpDb();
    const a = new IndexSnapshot(path);
    a.setNote('a.md', 'sha-a', 1);
    a.putChunks('a.md', [mkChunk(7)]);
    a.close();
    const b = new IndexSnapshot(path);
    expect(b.getNote('a.md')).toEqual({ contentSha: 'sha-a', mtimeMs: 1 });
    const chunks = b.getChunks('a.md');
    expect(chunks).toHaveLength(1);
    expect(Array.from(chunks[0].vec)).toEqual([7, 14, 21]);
    b.close();
  });

  it('close is idempotent', () => {
    const s = new IndexSnapshot(tmpDb());
    s.close();
    expect(() => s.close()).not.toThrow();
  });
});
