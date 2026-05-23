# VaultNexus Plan 02 — Markdown Parsing & Offset-Faithful Hierarchical Chunking

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Turn a Markdown note into offset-faithful chunks (a whole-note tier + block tiers) where every chunk's recorded `[byteStart, byteEnd)` slices the original source to exactly the chunk's raw text — the indexing substrate the retrieval engine (Plan 03+) embeds and cites.

**Architecture:** Pure, I/O-free `core/` functions. Parse with `unified`/`remark-parse` (+`remark-gfm` for tables) and `gray-matter` (frontmatter). Chunk at **mdast block-node boundaries** using remark's source `position.*.offset` — so offsets are exact by construction, never a hand-rolled sliding window, and code/tables/blockquotes/callouts are never split. Adjacent small blocks merge up to a token budget (`gpt-tokenizer`) without crossing a heading boundary or a non-mergeable block. Every chunk carries its heading path for `path#heading` addressing.

**Tech Stack:** TypeScript ESM/NodeNext, Node 22, vitest. New deps: `unified`, `remark-parse`, `remark-gfm`, `gray-matter`, `gpt-tokenizer`, `mdast-util-to-string`; dev `@types/mdast`.

**Scope note:** Plan 02 of the sequence (concept `docs/specs/2026-05-23-vaultnexus-concept.md` §3). Delivers ONLY parsing + chunking + the byte-offset contract. No embeddings, no vector store, no FTS5, no graph, no sentence/Claim-Index tier (deferred to the epistemic layer). Builds on Plan 01's `core/` + toolchain (already on master).

**TOOLCHAIN:** default `node` is v20.18 (broken); every command runs under `export PATH=/opt/homebrew/opt/node@22/bin:$PATH`. Authoritative type-check: `pnpm typecheck`. Commits: Roger French, no AI attribution. Branch: `feat/chunking` off master.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/core/types.ts` | `Granularity`, `Chunk` shared types |
| `src/core/markdown.ts` | `parseMarkdown(source)` → frontmatter + body byte-offset + mdast tree (positions on) |
| `src/core/chunk.ts` | `chunkDocument(source, opts?)` → `Chunk[]` (note tier + merged block tiers, offset-faithful, heading paths) |
| `test/core/*` | unit + the byte-offset contract test |

---

## Task 1: Dependencies + shared types

**Files:** Modify `package.json`; Create `src/core/types.ts`; Test `test/core/types.test.ts`

- [ ] **Step 1: Add dependencies**

Run (Node 22 PATH first):
```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
pnpm add unified remark-parse remark-gfm gray-matter gpt-tokenizer mdast-util-to-string
pnpm add -D @types/mdast
```
Expected: installs succeed; `package.json` dependencies updated.

- [ ] **Step 2: Write the failing test**

```typescript
// test/core/types.test.ts
import { describe, it, expect } from 'vitest';
import type { Chunk, Granularity } from '../../src/core/types.js';

describe('types', () => {
  it('Chunk shape is constructable', () => {
    const g: Granularity = 'block';
    const c: Chunk = {
      granularity: g,
      text: 'hello',
      byteStart: 0,
      byteEnd: 5,
      headingPath: ['Intro'],
    };
    expect(c.granularity).toBe('block');
    expect(c.byteEnd - c.byteStart).toBe(5);
  });
});
```

- [ ] **Step 3: Run to verify fail.** `pnpm vitest run test/core/types.test.ts` → FAIL (cannot resolve types.js).

- [ ] **Step 4: Write implementation**

```typescript
// src/core/types.ts

/** Chunk tier: whole note, or a block-level span within it. */
export type Granularity = 'note' | 'block';

/** Offset-faithful unit of a parsed note. `text` === source UTF-8 bytes [byteStart, byteEnd). */
export interface Chunk {
  granularity: Granularity;
  text: string;
  byteStart: number;
  byteEnd: number;
  headingPath: string[]; // enclosing headings, outer→inner; [] at note root
}
```

- [ ] **Step 5: Run to verify pass.** `pnpm vitest run test/core/types.test.ts` → PASS. Then `pnpm typecheck` → exit 0.

- [ ] **Step 6: Commit**
```bash
git add package.json pnpm-lock.yaml src/core/types.ts test/core/types.test.ts
git commit -m "feat(core): chunk types + parsing/chunking deps"
```

---

## Task 2: `parseMarkdown` — frontmatter split + positioned mdast

**Files:** Create `src/core/markdown.ts`; Test `test/core/markdown.test.ts`

`gray-matter` strips frontmatter and reports the body; the body's byte offset within the original source is needed so downstream offsets map back to the ORIGINAL file. remark-parse keeps `position.start.offset` / `position.end.offset` as CHARACTER offsets into the BODY (the string it parsed). Downstream converts char→byte and adds the body offset.

- [ ] **Step 1: Write the failing test**

```typescript
// test/core/markdown.test.ts
import { describe, it, expect } from 'vitest';
import { parseMarkdown } from '../../src/core/markdown.js';

describe('parseMarkdown', () => {
  it('splits frontmatter and reports body byte offset', () => {
    const src = '---\ntitle: T\n---\n# Head\n\nBody text.\n';
    const r = parseMarkdown(src);
    expect(r.frontmatter).toEqual({ title: 'T' });
    // body starts right after the closing '---\n'
    expect(Buffer.from(src).subarray(r.bodyByteOffset).toString()).toContain('# Head');
    expect(r.tree.type).toBe('root');
    expect(r.tree.children.length).toBeGreaterThan(0);
    // positions are tracked
    expect(r.tree.children[0].position?.start.offset).toBeDefined();
  });

  it('handles no frontmatter (body offset 0)', () => {
    const src = '# Just a heading\n\ntext\n';
    const r = parseMarkdown(src);
    expect(r.frontmatter).toEqual({});
    expect(r.bodyByteOffset).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify fail.** `pnpm vitest run test/core/markdown.test.ts` → FAIL.

- [ ] **Step 3: Write implementation**

```typescript
// src/core/markdown.ts
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import matter from 'gray-matter';
import type { Root } from 'mdast';

export interface ParsedMarkdown {
  frontmatter: Record<string, unknown>;
  body: string; // source minus frontmatter
  bodyByteOffset: number; // UTF-8 byte offset of body within the original source
  tree: Root; // mdast over `body`, positions on
}

const processor = unified().use(remarkParse).use(remarkGfm);

/** Parse a note: strip frontmatter, parse body to positioned mdast. */
export function parseMarkdown(source: string): ParsedMarkdown {
  const parsed = matter(source);
  const body = parsed.content;
  // gray-matter preserves body verbatim after frontmatter → locate it for the byte offset
  const idx = source.indexOf(body);
  const bodyByteOffset = idx <= 0 ? (idx === 0 ? 0 : 0) : Buffer.from(source.slice(0, idx)).length;
  const tree = processor.parse(body) as Root;
  return {
    frontmatter: parsed.data ?? {},
    body,
    bodyByteOffset,
    tree,
  };
}
```

Note for implementer: the `indexOf(body)` approach can be fragile if the body string also appears in frontmatter; if a test exposes that, switch to computing the offset from `matter`'s reported frontmatter length (`source.length - body.length` after normalizing the trailing-newline handling, or parse the `---` fences directly). Make the two tests above pass and the byte-offset contract test in Task 4 pass — that is the real bar. Adapt as needed.

- [ ] **Step 4: Run to verify pass.** `pnpm vitest run test/core/markdown.test.ts` → PASS. `pnpm typecheck` → 0.

- [ ] **Step 5: Commit**
```bash
git add src/core/markdown.ts test/core/markdown.test.ts
git commit -m "feat(core): markdown parse (frontmatter split + positioned mdast)"
```

---

## Task 3: `chunkDocument` — note tier + offset-faithful block tiers

**Files:** Create `src/core/chunk.ts`; Test `test/core/chunk.test.ts`

Algorithm:
1. `parseMarkdown(source)`.
2. **Note tier:** one `Chunk{granularity:'note'}` spanning the body — `byteStart = bodyByteOffset`, `byteEnd = bodyByteOffset + byteLen(body)`, `text = body`, `headingPath: []`.
3. Walk top-level `tree.children` in order, tracking the current heading path (a `heading` node updates the path by its `depth`; it is NOT itself emitted as a block).
4. For each non-heading top-level block node, compute its byte span from its char `position` (`charToByte(body, position.start.offset) + bodyByteOffset` … same for end) and its `text = bodyBytes.slice(byteStart-bodyByteOffset, byteEnd-bodyByteOffset)`.
5. **Merge** consecutive *mergeable* blocks (paragraph, list, blockquote text) into one `Chunk{granularity:'block'}` until adding the next would exceed `opts.tokenBudget` (default 512, via `gpt-tokenizer` `encode().length`) OR the heading path changes OR the next block is **non-mergeable** (code, table, thematicBreak, html). Non-mergeable blocks are always emitted as their own single chunk (never split, never merged). The merged chunk's `byteStart` = first block's start, `byteEnd` = last block's end, `text` = `bodyBytes.slice(...)` over that span (so any whitespace between merged blocks is included verbatim → offset-faithful).
6. Return `[noteChunk, ...blockChunks]`.

`charToByte(s, charOffset)` = `Buffer.from(s.slice(0, charOffset)).length` (UTF-8). Keep all slicing in a single `Buffer.from(body)` to map byte spans.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/core/chunk.test.ts
import { describe, it, expect } from 'vitest';
import { chunkDocument } from '../../src/core/chunk.js';

const blocks = (cs: ReturnType<typeof chunkDocument>) => cs.filter((c) => c.granularity === 'block');

describe('chunkDocument', () => {
  it('emits a note tier spanning the whole body', () => {
    const src = '# H\n\npara one\n';
    const cs = chunkDocument(src);
    const note = cs.find((c) => c.granularity === 'note')!;
    expect(note).toBeDefined();
    expect(Buffer.from(src).subarray(note.byteStart, note.byteEnd).toString()).toBe(note.text);
  });

  it('tracks heading paths', () => {
    const src = '# A\n\nunder a\n\n## B\n\nunder b\n';
    const cs = blocks(chunkDocument(src));
    const underB = cs.find((c) => c.text.includes('under b'))!;
    expect(underB.headingPath).toEqual(['A', 'B']);
    const underA = cs.find((c) => c.text.includes('under a'))!;
    expect(underA.headingPath).toEqual(['A']);
  });

  it('never merges a code block with prose', () => {
    const src = 'para before\n\n```js\nconst x = 1;\n```\n\npara after\n';
    const cs = blocks(chunkDocument(src));
    const code = cs.find((c) => c.text.includes('const x'))!;
    expect(code.text).toContain('```js');
    expect(code.text).not.toContain('para before');
    expect(code.text).not.toContain('para after');
  });

  it('merges small adjacent paragraphs under the token budget', () => {
    const src = 'p1\n\np2\n\np3\n';
    const cs = blocks(chunkDocument(src, { tokenBudget: 1000 }));
    expect(cs.length).toBe(1); // all three merged
    expect(cs[0].text).toContain('p1');
    expect(cs[0].text).toContain('p3');
  });

  it('splits when the token budget is exceeded', () => {
    const src = 'p1\n\np2\n\np3\n';
    const cs = blocks(chunkDocument(src, { tokenBudget: 1 }));
    expect(cs.length).toBe(3); // budget forces one block each
  });
});
```

- [ ] **Step 2: Run to verify fail.** `pnpm vitest run test/core/chunk.test.ts` → FAIL.

- [ ] **Step 3: Write implementation**

```typescript
// src/core/chunk.ts
import { encode } from 'gpt-tokenizer';
import type { RootContent, Heading } from 'mdast';
import { parseMarkdown } from './markdown.js';
import type { Chunk } from './types.js';

export interface ChunkOptions {
  tokenBudget?: number; // merge cap for adjacent mergeable blocks
}

const NON_MERGEABLE = new Set(['code', 'table', 'thematicBreak', 'html']);

function tokens(s: string): number {
  return encode(s).length;
}

function headingText(node: Heading): string {
  return node.children.map((c) => ('value' in c ? c.value : '')).join('').trim();
}

/** Parse + chunk a note into a note tier plus offset-faithful block tiers. */
export function chunkDocument(source: string, opts: ChunkOptions = {}): Chunk[] {
  const budget = opts.tokenBudget ?? 512;
  const { body, bodyByteOffset, tree } = parseMarkdown(source);
  const bodyBytes = Buffer.from(body);

  const byteLen = (charOffset: number): number => Buffer.byteLength(body.slice(0, charOffset));
  const spanText = (bStart: number, bEnd: number): string =>
    bodyBytes.subarray(bStart, bEnd).toString();

  const out: Chunk[] = [];

  // note tier
  out.push({
    granularity: 'note',
    text: body,
    byteStart: bodyByteOffset,
    byteEnd: bodyByteOffset + bodyBytes.length,
    headingPath: [],
  });

  const path: string[] = [];
  type Pending = { startByte: number; endByte: number; toks: number; path: string[] };
  let pending: Pending | null = null;

  const flush = (): void => {
    if (!pending) return;
    out.push({
      granularity: 'block',
      text: spanText(pending.startByte, pending.endByte),
      byteStart: pending.startByte + bodyByteOffset,
      byteEnd: pending.endByte + bodyByteOffset,
      headingPath: [...pending.path],
    });
    pending = null;
  };

  for (const node of tree.children as RootContent[]) {
    if (!node.position) continue;
    const bStart = byteLen(node.position.start.offset!);
    const bEnd = byteLen(node.position.end.offset!);

    if (node.type === 'heading') {
      flush();
      const depth = (node as Heading).depth;
      path.length = Math.max(0, depth - 1);
      path[depth - 1] = headingText(node as Heading);
      continue;
    }

    const text = spanText(bStart, bEnd);
    const tk = tokens(text);
    const mergeable = !NON_MERGEABLE.has(node.type);
    const pathChanged = pending && pending.path.join(' ') !== path.join(' ');

    if (!mergeable || !pending || pathChanged || pending.toks + tk > budget) {
      flush();
      pending = { startByte: bStart, endByte: bEnd, toks: tk, path: [...path] };
      if (!mergeable) flush(); // non-mergeable stands alone
    } else {
      pending.endByte = bEnd; // extend span (includes inter-block whitespace verbatim)
      pending.toks += tk;
    }
  }
  flush();

  return out;
}
```

- [ ] **Step 4: Run to verify pass.** `pnpm vitest run test/core/chunk.test.ts` → PASS (5 tests). `pnpm typecheck` → 0.

- [ ] **Step 5: Commit**
```bash
git add src/core/chunk.ts test/core/chunk.test.ts
git commit -m "feat(core): offset-faithful hierarchical chunking"
```

---

## Task 4: The byte-offset contract test (the load-bearing guarantee)

**Files:** Test `test/core/offset-contract.test.ts`

The whole point of the chunker: for EVERY chunk, slicing the original source's UTF-8 bytes by `[byteStart, byteEnd)` reproduces `chunk.text` exactly. This must hold across frontmatter, unicode, code, tables, and nested headings. This test is the spec; if it fails, the chunker is wrong regardless of the unit tests.

- [ ] **Step 1: Write the contract test**

```typescript
// test/core/offset-contract.test.ts
import { describe, it, expect } from 'vitest';
import { chunkDocument } from '../../src/core/chunk.js';

const SAMPLES: Array<[string, string]> = [
  ['plain', '# Title\n\nHello world.\n\nSecond para.\n'],
  ['frontmatter', '---\ntitle: X\ntags: [a,b]\n---\n# H\n\nbody after fm\n'],
  ['unicode', '# Café ☕ 日本語\n\nnaïve façade — emoji 🚀 and 漢字.\n\nmore.\n'],
  ['code', 'before\n\n```python\ndef f(x):\n    return x  # 日本語 comment\n```\n\nafter\n'],
  ['table', '# T\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\ntail\n'],
  ['nested', '# A\n\na text\n\n## B\n\nb text\n\n### C\n\nc text\n'],
  ['mixed-unicode-code', '# 🎯\n\npara ☕\n\n```\nliteral ☕ block\n```\n\nend ☕\n'],
];

describe('byte-offset contract', () => {
  for (const [name, src] of SAMPLES) {
    it(`every chunk slices the source exactly: ${name}`, () => {
      const buf = Buffer.from(src);
      const chunks = chunkDocument(src);
      expect(chunks.length).toBeGreaterThan(0);
      for (const c of chunks) {
        expect(c.byteStart).toBeGreaterThanOrEqual(0);
        expect(c.byteEnd).toBeLessThanOrEqual(buf.length);
        expect(c.byteStart).toBeLessThan(c.byteEnd);
        // THE contract:
        expect(buf.subarray(c.byteStart, c.byteEnd).toString('utf8')).toBe(c.text);
      }
    });
  }

  it('note tier covers the body for every sample', () => {
    for (const [, src] of SAMPLES) {
      const note = chunkDocument(src).find((c) => c.granularity === 'note')!;
      expect(note).toBeDefined();
      expect(Buffer.from(src).subarray(note.byteStart, note.byteEnd).toString()).toBe(note.text);
    }
  });
});
```

- [ ] **Step 2: Run.** `pnpm vitest run test/core/offset-contract.test.ts`.
  - Expected: PASS. If any sample fails, the chunker's char→byte mapping or the `parseMarkdown` body offset is wrong — FIX `chunk.ts`/`markdown.ts` until every sample passes. Do NOT weaken the contract assertion. The unicode + frontmatter + code samples are the ones that catch char-vs-byte and body-offset bugs.

- [ ] **Step 3: Run the full suite + typecheck.** `pnpm test` (all green, no regressions to Plan 01's 19) and `pnpm typecheck` (0).

- [ ] **Step 4: Commit**
```bash
git add test/core/offset-contract.test.ts
git commit -m "test(core): byte-offset contract across unicode/code/frontmatter"
```

---

## Self-Review (completed during authoring)

**Spec coverage (concept §3 chunking):** hierarchical chunking (note + block tiers) ✓ Task 3; offset-faithful (`path#heading` via `headingPath`; byte spans) ✓ Tasks 3–4; never split code/tables/callouts ✓ Task 3 (`NON_MERGEABLE`) + Task 4 (code/table samples); frontmatter handling ✓ Task 2; remark+gfm+gray-matter stack ✓. Deferred (later plans, noted): sentence/Claim-Index tier, wikilink/OFM block-ref extraction, embeddings.

**Placeholder scan:** none — all code/tests complete. Two implementer-adaptation notes (Task 2 body-offset robustness; Task 3/4 fix-until-contract-passes) are guidance, not placeholders; the contract test is the hard spec.

**Type consistency:** `Chunk`/`Granularity` defined Task 1, used identically in Tasks 3–4; `chunkDocument(source, opts?)` signature consistent; `parseMarkdown` return shape consistent Tasks 2–3.

**Known risk:** mdast `position.*.offset` is non-null when remark tracks positions (default on); the impl asserts with `!`. If a node lacks a position it is skipped (`if (!node.position) continue`) — acceptable (only synthetic nodes lack positions; remark-parse sets them on all parsed nodes).
