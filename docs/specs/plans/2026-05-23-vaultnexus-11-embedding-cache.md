# VaultNexus 11 — Persistent Embedding Cache

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Stop re-embedding the whole vault on every daemon restart. Cache `embedding(text)` by content hash (model-scoped) in an on-disk SQLite store; a `CachingEmbedder` wraps the real embedder and only calls it for cache misses. Restart cost drops from "re-embed every note (paid Voyage calls)" to "hash lookups + embed only new/changed blocks."

**Architecture:** `EmbeddingCache` (better-sqlite3, already a dep) = `key → vec BLOB`, `key = sha256(namespace \0 text)` where namespace is the model id (switching models can't return stale vectors). `CachingEmbedder implements Embedder` decorates a base `Embedder`: batch-lookup, embed only misses, persist, return in input order. `selectEmbedder` wraps the real OpenAI/Voyage embedder; FakeEmbedder stays uncached (free + deterministic). Writes are per-batch transactions → durable without explicit close; `close()` exists for clean shutdown + tests.

**Tech Stack:** TS/ESM/NodeNext, vitest, better-sqlite3, node:crypto. No new deps.

**Non-goals (later plans):** full index serialization (skip re-chunk/re-FTS), cache eviction/TTL, content-change invalidation beyond hashing (a changed block = new hash = natural miss; the old entry is harmless orphan).

---

## File Structure
- Modify `src/core/paths.ts` — add `defaultCachePath()` (home dir, persistent).
- Create `src/daemon/embedding-cache.ts` — `EmbeddingCache`.
- Create `src/daemon/caching-embedder.ts` — `CachingEmbedder`.
- Modify `src/daemon/select-embedder.ts` — wrap real embedder.
- Modify `src/daemon/main.ts` — close cache on shutdown.
- Tests: `test/daemon/embedding-cache.test.ts`, `test/daemon/caching-embedder.test.ts`.

---

## Task 1: Cache path + EmbeddingCache store

**Files:** Modify `src/core/paths.ts`; Create `src/daemon/embedding-cache.ts`; Test `test/daemon/embedding-cache.test.ts`

- [ ] **Step 1:** Add to `src/core/paths.ts`:
```typescript
import { homedir, tmpdir } from 'node:os';
// (keep existing tmpdir import usage; merge the import line)

/** Persistent embedding cache DB (survives reboot, unlike tmpdir). 'off' disables. */
export function defaultCachePath(): string {
  return process.env.VAULTNEXUS_CACHE ?? join(homedir(), '.vaultnexus', 'embeddings.db');
}
```

- [ ] **Step 2: Failing test**
```typescript
// test/daemon/embedding-cache.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EmbeddingCache } from '../../src/daemon/embedding-cache.js';

const tmpDb = () => join(mkdtempSync(join(tmpdir(), 'vn-cache-')), 'e.db');

describe('EmbeddingCache', () => {
  it('round-trips vectors by key, miss → undefined', () => {
    const c = new EmbeddingCache(tmpDb());
    expect(c.getMany(['k1'])).toEqual([undefined]);
    c.setMany([{ key: 'k1', vec: new Float32Array([0.5, -0.25, 1]) }]);
    const [got] = c.getMany(['k1']);
    expect(Array.from(got!)).toEqual([0.5, -0.25, 1]);
    c.close();
  });
  it('persists across reopen of the same file', () => {
    const path = tmpDb();
    const a = new EmbeddingCache(path);
    a.setMany([{ key: 'x', vec: new Float32Array([1, 2, 3, 4]) }]);
    a.close();
    const b = new EmbeddingCache(path);
    expect(Array.from(b.getMany(['x'])[0]!)).toEqual([1, 2, 3, 4]);
    b.close();
  });
  it('getMany preserves order with mixed hit/miss', () => {
    const c = new EmbeddingCache(tmpDb());
    c.setMany([{ key: 'a', vec: new Float32Array([1]) }, { key: 'c', vec: new Float32Array([3]) }]);
    const got = c.getMany(['a', 'b', 'c']);
    expect(got.map((v) => (v ? v[0] : null))).toEqual([1, null, 3]);
    c.close();
  });
});
```

- [ ] **Step 3: Run → FAIL.** `pnpm vitest run test/daemon/embedding-cache.test.ts`

- [ ] **Step 4: Implement**
```typescript
// src/daemon/embedding-cache.ts
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
      const b = row.vec; // copy to a fresh 0-offset ArrayBuffer (avoids pooled-buffer offset hazards)
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
```

- [ ] **Step 5: Run → PASS.** `pnpm test 2>&1 | tail -3`, `pnpm typecheck` (0).
- [ ] **Step 6: Commit** `git add src/core/paths.ts src/daemon/embedding-cache.ts test/daemon/embedding-cache.test.ts && git commit -m "feat(daemon): persistent embedding cache store (better-sqlite3 BLOB)"`

---

## Task 2: CachingEmbedder

**Files:** Create `src/daemon/caching-embedder.ts`; Test `test/daemon/caching-embedder.test.ts`

- [ ] **Step 1: Failing test** (spy base to prove misses-only)
```typescript
// test/daemon/caching-embedder.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CachingEmbedder } from '../../src/daemon/caching-embedder.js';
import { EmbeddingCache } from '../../src/daemon/embedding-cache.js';
import { FakeEmbedder } from '../../src/core/embedder.js';

const tmpDb = () => join(mkdtempSync(join(tmpdir(), 'vn-ce-')), 'e.db');

class CountingEmbedder extends FakeEmbedder {
  public embedded: string[] = [];
  async embed(texts: string[]): Promise<Float32Array[]> { this.embedded.push(...texts); return super.embed(texts); }
}

describe('CachingEmbedder', () => {
  it('embeds only cache misses, returns input order', async () => {
    const base = new CountingEmbedder(32);
    const ce = new CachingEmbedder(base, new EmbeddingCache(tmpDb()), 'm1');
    const first = await ce.embed(['alpha', 'beta']);
    expect(base.embedded).toEqual(['alpha', 'beta']); // both miss first time
    const second = await ce.embed(['beta', 'gamma']); // beta cached, gamma new
    expect(base.embedded).toEqual(['alpha', 'beta', 'gamma']); // only gamma added
    expect(Array.from(second[0])).toEqual(Array.from(first[1])); // beta vec stable from cache
  });
  it('namespace (model) scopes the cache — different model re-embeds', async () => {
    const cache = new EmbeddingCache(tmpDb());
    const b1 = new CountingEmbedder(16);
    await new CachingEmbedder(b1, cache, 'modelA').embed(['x']);
    const b2 = new CountingEmbedder(16);
    await new CachingEmbedder(b2, cache, 'modelB').embed(['x']);
    expect(b2.embedded).toEqual(['x']); // modelB miss despite same text
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement**
```typescript
// src/daemon/caching-embedder.ts
import { createHash } from 'node:crypto';
import type { Embedder } from '../core/embedder.js';
import type { EmbeddingCache } from './embedding-cache.js';

/** Decorates an Embedder with a persistent cache. Key = sha256(namespace \0 text); namespace = model id. */
export class CachingEmbedder implements Embedder {
  constructor(private readonly base: Embedder, private readonly cache: EmbeddingCache, private readonly namespace: string) {}

  get dimensions(): number { return this.base.dimensions; }

  private key(text: string): string {
    return createHash('sha256').update(this.namespace).update('\0').update(text).digest('hex');
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const keys = texts.map((t) => this.key(t));
    const out = this.cache.getMany(keys);
    const missIdx: number[] = [];
    out.forEach((v, i) => { if (!v) missIdx.push(i); });
    if (missIdx.length) {
      const fresh = await this.base.embed(missIdx.map((i) => texts[i]));
      const writes = fresh.map((vec, k) => { out[missIdx[k]] = vec; return { key: keys[missIdx[k]], vec }; });
      this.cache.setMany(writes);
    }
    return out as Float32Array[];
  }

  close(): void { this.cache.close(); }
}
```

- [ ] **Step 4: Run → PASS.** `pnpm test 2>&1 | tail -3`, `pnpm typecheck` (0).
- [ ] **Step 5: Commit** `git add src/daemon/caching-embedder.ts test/daemon/caching-embedder.test.ts && git commit -m "feat(daemon): CachingEmbedder — embed only cache misses, model-scoped"`

---

## Task 3: Wire cache into embedder selection + shutdown

**Files:** Modify `src/daemon/select-embedder.ts`, `src/daemon/main.ts`

- [ ] **Step 1:** In `select-embedder.ts`, wrap the real embedder. Imports: `import { CachingEmbedder } from './caching-embedder.js'; import { EmbeddingCache } from './embedding-cache.js'; import { defaultCachePath } from '../core/paths.js';`. Replace the real-embedder branch:
```typescript
  if (baseURL && apiKey && model) {
    const e = new OpenAIEmbedder({ baseURL, apiKey, model });
    await e.probe();
    const cachePath = env.VAULTNEXUS_CACHE ?? defaultCachePath();
    if (cachePath === 'off') return e; // escape hatch (no persistence)
    return new CachingEmbedder(e, new EmbeddingCache(cachePath), model); // model = cache namespace
  }
```
(FakeEmbedder branch unchanged — free + deterministic, no cache.)

- [ ] **Step 2:** In `main.ts`, close the embedder cache on shutdown if it has a `close`. After the embedder is created (`const embedder = await selectEmbedder();`), and inside the `shutdown` handler, add a guarded close:
```typescript
  // in shutdown, before/after the server closes:
  if (typeof (embedder as { close?: () => void }).close === 'function') (embedder as { close: () => void }).close();
```
Place it so it runs once during shutdown (alongside socket/http close). Keep it defensive (FakeEmbedder has no close).

- [ ] **Step 3:** Verify nothing regresses: `pnpm test 2>&1 | tail -3` (all green — tests use FakeEmbedder, no cache path hit), `pnpm typecheck` (0), `pnpm build` (0).
- [ ] **Step 4:** Manual smoke (real embedder, proves cache file is created + reused) — OPTIONAL, needs env; do it if env present, else skip and note:
```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
export VAULTNEXUS_EMBED_URL="$GITNEXUS_EMBEDDING_URL" VAULTNEXUS_EMBED_KEY="$GITNEXUS_EMBEDDING_API_KEY" VAULTNEXUS_EMBED_MODEL="voyage-3-large"
export VAULTNEXUS_CACHE="$(mktemp -d)/e.db"
pnpm eval 2>&1 | grep queries=    # 1st run: embeds (Voyage calls)
time pnpm eval 2>&1 | grep queries= # 2nd run: cache hits → faster, identical metrics
```
- [ ] **Step 5: Commit** `git add src/daemon/select-embedder.ts src/daemon/main.ts && git commit -m "feat(daemon): cache real embeddings, close cache on shutdown"`

---

## Task 4: Finish

- [ ] **Step 1:** Full suite green + typecheck 0 + build 0.
- [ ] **Step 2:** Final review (whole plan diff), address nits, merge to master per superpowers:finishing-a-development-branch.

---

## Self-Review
- **Spec coverage:** cache store (T1) ✓, CachingEmbedder (T2) ✓, wiring+shutdown (T3) ✓, finish (T4) ✓.
- **Placeholders:** none — real code/tests; only the real-embedder smoke (T3 S4) is env-gated/optional.
- **Type consistency:** `CacheWrite{key,vec}` (T1) consumed by `CachingEmbedder` (T2) + `getMany→(Float32Array|undefined)[]` matches CachingEmbedder miss-scan. `CachingEmbedder implements Embedder` (dimensions getter + embed). `defaultCachePath` (T1) used in T3. `close()` on cache + CachingEmbedder, called in main shutdown (T3).
- **Durability:** setMany is a transaction → committed immediately; no data loss without close. WAL mode for concurrent read safety.
- **Correctness hazards:** BLOB read copies via `slice` (no pooled-buffer offset bug); namespace in hash key prevents cross-model staleness; changed block text → new hash → natural miss (stale entry orphaned, harmless).
- **No regression:** tests use FakeEmbedder (uncached path); cache only wraps the real embedder.
