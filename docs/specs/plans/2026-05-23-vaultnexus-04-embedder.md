# VaultNexus Plan 04 — Embedder / Provider Layer

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** A model-agnostic `Embedder` abstraction: a deterministic **fake** embedder (so the whole indexing/retrieval pipeline tests offline, no keys/network) and a real **OpenAI-compatible** embedder over `undici` with a capability probe (embed one string → its length is the true dimension). This is the bridge from chunk text (Plan 02) to vectors (Plan 03).

**Architecture:** `core/embedder.ts` defines the `Embedder` interface + `FakeEmbedder` (pure, deterministic hash→unit-vector). Request/response shaping is pure (`buildEmbedBody`/`parseEmbedResponse`) and unit-tested in isolation. `OpenAIEmbedder` wraps those with one `undici` POST and a `probe()`; it is tested **network-free** via undici's `MockAgent`. Vectors are returned as `Float32Array`; callers L2-normalize + quantize (Plan 03).

**Tech Stack:** TypeScript ESM/NodeNext, Node 22, vitest. New dep: `undici`.

**Scope note:** Plan 04 of the sequence (concept §5, embed role only). Delivers the embed abstraction + fake + one real provider + probe. NOT: reranker/judge roles, the vault-grounded micro-benchmark router, the full registry selection UX (a thin factory only), persistence. Builds on master (Plans 01–03; reuses `core/vectors.ts` `l2normalize`).

**TOOLCHAIN:** every command under `export PATH=/opt/homebrew/opt/node@22/bin:$PATH`. Authoritative `pnpm typecheck`. Commits Roger French, no AI attribution. Branch `feat/embedder` off master.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/core/embedder.ts` | `Embedder` interface + `FakeEmbedder` (deterministic, offline) |
| `src/core/embed-protocol.ts` | pure `buildEmbedBody` / `parseEmbedResponse` (OpenAI-compatible shape) |
| `src/daemon/openai-embedder.ts` | `OpenAIEmbedder` (undici POST + `probe()`) |
| `test/**` | fake determinism, protocol shaping, MockAgent integration |

---

## Task 1: `Embedder` interface + deterministic `FakeEmbedder`

**Files:** Modify `package.json` (add `undici`); Create `src/core/embedder.ts`; Test `test/core/embedder.test.ts`

- [ ] **Step 1: Add undici**
```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
pnpm add undici
```

- [ ] **Step 2: Write the failing test**
```typescript
// test/core/embedder.test.ts
import { describe, it, expect } from 'vitest';
import { FakeEmbedder, type Embedder } from '../../src/core/embedder.js';

describe('FakeEmbedder', () => {
  it('is an Embedder with a fixed dimension', async () => {
    const e: Embedder = new FakeEmbedder(64);
    expect(e.dimensions).toBe(64);
    const [v] = await e.embed(['hello']);
    expect(v).toBeInstanceOf(Float32Array);
    expect(v.length).toBe(64);
  });
  it('is deterministic: same text → identical vector', async () => {
    const e = new FakeEmbedder(32);
    const [a] = await e.embed(['same']);
    const [b] = await e.embed(['same']);
    expect(Array.from(a)).toEqual(Array.from(b));
  });
  it('different text → different vector', async () => {
    const e = new FakeEmbedder(32);
    const [a] = await e.embed(['alpha']);
    const [b] = await e.embed(['beta']);
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });
  it('returns unit-norm vectors (ready for cosine)', async () => {
    const e = new FakeEmbedder(48);
    const [v] = await e.embed(['norm me']);
    let s = 0; for (const x of v) s += x * x;
    expect(Math.sqrt(s)).toBeCloseTo(1, 5);
  });
  it('embeds a batch in order', async () => {
    const e = new FakeEmbedder(16);
    const vs = await e.embed(['a', 'b', 'c']);
    expect(vs.length).toBe(3);
    const [a2] = await e.embed(['a']);
    expect(Array.from(vs[0])).toEqual(Array.from(a2));
  });
});
```

- [ ] **Step 3: Implement**
```typescript
// src/core/embedder.ts
import { l2normalize } from './vectors.js';

/** Model-agnostic embedding provider. Returns one unit-norm Float32Array per input. */
export interface Embedder {
  readonly dimensions: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

// FNV-1a 32-bit
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic offline embedder: hash(text,dim) → unit vector. For tests + offline pipeline. */
export class FakeEmbedder implements Embedder {
  constructor(public readonly dimensions: number = 64) {}

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => this.one(t));
  }

  private one(text: string): Float32Array {
    const v = new Float32Array(this.dimensions);
    for (let d = 0; d < this.dimensions; d++) {
      v[d] = (fnv1a(`${text}:${d}`) / 0xffffffff) * 2 - 1; // [-1,1]
    }
    return l2normalize(v);
  }
}
```

- [ ] **Step 4: Run → PASS** (5). `pnpm typecheck` → 0.

- [ ] **Step 5: Commit**
```bash
git add package.json pnpm-lock.yaml src/core/embedder.ts test/core/embedder.test.ts
git commit -m "feat(core): Embedder interface + deterministic FakeEmbedder"
```

---

## Task 2: pure OpenAI-compatible request/response shaping

**Files:** Create `src/core/embed-protocol.ts`; Test `test/core/embed-protocol.test.ts`

- [ ] **Step 1: Write the failing test**
```typescript
// test/core/embed-protocol.test.ts
import { describe, it, expect } from 'vitest';
import { buildEmbedBody, parseEmbedResponse } from '../../src/core/embed-protocol.js';

describe('embed protocol (OpenAI-compatible)', () => {
  it('builds the request body', () => {
    expect(buildEmbedBody('text-embedding-3-small', ['a', 'b'])).toEqual({
      model: 'text-embedding-3-small',
      input: ['a', 'b'],
    });
  });
  it('parses embeddings in API index order regardless of array order', () => {
    const resp = {
      data: [
        { index: 1, embedding: [0.1, 0.2] },
        { index: 0, embedding: [0.3, 0.4] },
      ],
    };
    const out = parseEmbedResponse(resp, 2);
    expect(out.length).toBe(2);
    expect(Array.from(out[0])).toEqual([0.3, 0.4]); // index 0 first
    expect(Array.from(out[1])).toEqual([0.1, 0.2]);
    expect(out[0]).toBeInstanceOf(Float32Array);
  });
  it('throws on a count mismatch', () => {
    expect(() => parseEmbedResponse({ data: [{ index: 0, embedding: [1] }] }, 2)).toThrow();
  });
  it('throws on a malformed response', () => {
    expect(() => parseEmbedResponse({}, 1)).toThrow();
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement**
```typescript
// src/core/embed-protocol.ts

export interface EmbedBody { model: string; input: string[]; }
interface EmbedDatum { index: number; embedding: number[]; }
interface EmbedResponse { data?: EmbedDatum[]; }

/** OpenAI-compatible /embeddings request body. */
export function buildEmbedBody(model: string, texts: string[]): EmbedBody {
  return { model, input: texts };
}

/** Parse /embeddings response → Float32Array[] in input order. `expected` = #inputs. */
export function parseEmbedResponse(resp: unknown, expected: number): Float32Array[] {
  const data = (resp as EmbedResponse)?.data;
  if (!Array.isArray(data)) throw new Error('embed response: missing data[]');
  if (data.length !== expected) {
    throw new Error(`embed response: expected ${expected} embeddings, got ${data.length}`);
  }
  const ordered = [...data].sort((a, b) => a.index - b.index);
  return ordered.map((d) => {
    if (!Array.isArray(d.embedding)) throw new Error('embed response: missing embedding[]');
    return Float32Array.from(d.embedding);
  });
}
```

- [ ] **Step 4: Run → PASS** (4). `pnpm typecheck` → 0.

- [ ] **Step 5: Commit**
```bash
git add src/core/embed-protocol.ts test/core/embed-protocol.test.ts
git commit -m "feat(core): OpenAI-compatible embed request/response shaping"
```

---

## Task 3: `OpenAIEmbedder` (undici) + capability probe — MockAgent test

**Files:** Create `src/daemon/openai-embedder.ts`; Test `test/daemon/openai-embedder.test.ts`

- [ ] **Step 1: Write the failing test (network-free via undici MockAgent)**
```typescript
// test/daemon/openai-embedder.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from 'undici';
import { OpenAIEmbedder } from '../../src/daemon/openai-embedder.js';

let prev: Dispatcher;
let mock: MockAgent;

beforeEach(() => {
  prev = getGlobalDispatcher();
  mock = new MockAgent();
  mock.disableNetConnect();
  setGlobalDispatcher(mock);
});
afterEach(() => { setGlobalDispatcher(prev); });

function stub(embeddings: number[][]) {
  const pool = mock.get('https://api.example.com');
  pool.intercept({ path: '/v1/embeddings', method: 'POST' }).reply(200, {
    data: embeddings.map((embedding, index) => ({ index, embedding })),
  });
}

describe('OpenAIEmbedder', () => {
  it('embeds texts via POST and returns Float32Array[]', async () => {
    stub([[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]]);
    const e = new OpenAIEmbedder({ baseURL: 'https://api.example.com/v1', apiKey: 'k', model: 'm' });
    const out = await e.embed(['a', 'b']);
    expect(out.length).toBe(2);
    expect(Array.from(out[0])).toEqual([0.1, 0.2, 0.3].map((x) => Math.fround(x)));
  });

  it('probe() sets dimensions from a one-string embed', async () => {
    stub([[0, 1, 2, 3, 4]]);
    const e = new OpenAIEmbedder({ baseURL: 'https://api.example.com/v1', apiKey: 'k', model: 'm' });
    const dims = await e.probe();
    expect(dims).toBe(5);
    expect(e.dimensions).toBe(5);
  });

  it('throws on a non-2xx response', async () => {
    mock.get('https://api.example.com').intercept({ path: '/v1/embeddings', method: 'POST' }).reply(401, { error: 'nope' });
    const e = new OpenAIEmbedder({ baseURL: 'https://api.example.com/v1', apiKey: 'bad', model: 'm' });
    await expect(e.embed(['x'])).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement**
```typescript
// src/daemon/openai-embedder.ts
import { request } from 'undici';
import type { Embedder } from '../core/embedder.js';
import { buildEmbedBody, parseEmbedResponse } from '../core/embed-protocol.js';

export interface OpenAIEmbedderConfig {
  baseURL: string; // e.g. https://api.openai.com/v1
  apiKey: string;
  model: string;
}

/** OpenAI-compatible embedder over undici. dimensions=0 until probe() or first embed(). */
export class OpenAIEmbedder implements Embedder {
  private _dims = 0;
  constructor(private readonly cfg: OpenAIEmbedderConfig) {}

  get dimensions(): number {
    return this._dims;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const res = await request(`${this.cfg.baseURL}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.apiKey}` },
      body: JSON.stringify(buildEmbedBody(this.cfg.model, texts)),
    });
    if (res.statusCode < 200 || res.statusCode >= 300) {
      const text = await res.body.text();
      throw new Error(`embed HTTP ${res.statusCode}: ${text.slice(0, 200)}`);
    }
    const json = await res.body.json();
    const out = parseEmbedResponse(json, texts.length);
    if (out.length > 0) this._dims = out[0].length;
    return out;
  }

  /** Probe true dimension by embedding one string (no endpoint advertises it). */
  async probe(): Promise<number> {
    const [v] = await this.embed(['probe']);
    this._dims = v.length;
    return this._dims;
  }
}
```

- [ ] **Step 4: Run → PASS** (3). `pnpm typecheck` → 0.
  - If undici's MockAgent API differs in the installed version (e.g. `mock.get(origin)` vs `mock.get(url)`, or `intercept` options), adapt the TEST to the installed undici's MockAgent API — keep it network-free (`disableNetConnect`) and keep the three behaviors (embed returns vectors, probe sets dims, non-2xx throws). The `OpenAIEmbedder` itself should not need changes.

- [ ] **Step 5: Full suite + typecheck.** `pnpm test` (all green incl Plans 01–03) and `pnpm typecheck` (0).

- [ ] **Step 6: Commit**
```bash
git add src/daemon/openai-embedder.ts test/daemon/openai-embedder.test.ts
git commit -m "feat(daemon): OpenAI-compatible undici embedder + capability probe"
```

---

## Self-Review (completed during authoring)

**Spec coverage (concept §5, embed role):** model-agnostic `Embedder` interface ✓ Task 1; offline/default-testable path ✓ FakeEmbedder; real API provider over own undici ✓ Task 3; capability probe (embed one string → length = dim) ✓ Task 3; OpenAI-compatible shape ✓ Task 2. Deferred (noted): reranker + judge roles, registry micro-benchmark router, local node-llama-cpp embedder, dim-floor/recall gate at registration (Plan 05/06).

**Placeholder scan:** none — code + tests complete. The undici MockAgent-API adaptation note (Task 3 Step 4) is guidance; the three behaviors are the contract.

**Type consistency:** `Embedder` defined Task 1, implemented by `FakeEmbedder` (Task 1) + `OpenAIEmbedder` (Task 3); `buildEmbedBody`/`parseEmbedResponse` defined Task 2, used Task 3; `Float32Array[]` return type consistent; reuses `l2normalize` from `core/vectors.ts` (Plan 03).

**Design note:** `OpenAIEmbedder` lives in `daemon/` (it does I/O — undici); `FakeEmbedder` + protocol helpers are pure `core/`. This keeps `core/` I/O-free per the architecture. `parseEmbedResponse` sorts by API `index` so batch order is never assumed.
