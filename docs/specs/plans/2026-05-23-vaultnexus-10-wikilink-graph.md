# VaultNexus 10 — Wikilink Graph → Communities → Community-Aware Bridges

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Extract Obsidian wikilinks → build a note-link graph → detect link communities (Louvain) → upgrade `bridges()` to flag pairs that are semantically similar but live in **different link-communities and are not directly linked** = "notes that secretly agree across your link silos." This is the convergence half of the hero, Obsidian-native.

**Architecture:** Pure `extractWikilinks(body)` (regex; OFM `[[t]]`/`[[t|alias]]`/`[[t#h]]`/`![[embed]]`). `note-graph.ts` builds a `graphology` undirected graph (nodes=note paths, edges=resolved links) + Louvain → `Map<notePath, communityId>`. `VaultIndex` stores per-note links, lazily builds graph+communities, and enriches each `Bridge` with `crossCommunity` + `linked`. MCP `vaultnexus_bridges` gains a `crossCommunityOnly` filter and returns the new fields.

**Tech Stack:** TS/ESM/NodeNext, vitest, `graphology` + `graphology-communities-louvain` (new deps). FakeEmbedder for deterministic tests.

**Validation note:** bridges have no labeled gold set, so correctness is shown by construction + controlled-fixture tests (known links → known communities → known cross-community pair), not an eval metric.

---

## File Structure
- Create `src/core/wikilinks.ts` — `extractWikilinks(body): string[]`.
- Create `src/daemon/note-graph.ts` — `buildNoteGraph(notes)`, `detectCommunities(graph)`, `resolveLink(target, paths)`.
- Modify `src/daemon/vault-index.ts` — store `links` per note; lazy `communityOf` map; enrich `Bridge`.
- Modify `src/daemon/mcp-server.ts` — `crossCommunityOnly` param; richer output.
- Tests: `test/core/wikilinks.test.ts`, `test/daemon/note-graph.test.ts`, `test/daemon/bridges-community.test.ts`.
- Modify `package.json` — add the two graphology deps.

---

## Task 1: Wikilink extraction

**Files:** Create `src/core/wikilinks.ts`; Test `test/core/wikilinks.test.ts`

- [ ] **Step 1: Failing test**
```typescript
// test/core/wikilinks.test.ts
import { describe, it, expect } from 'vitest';
import { extractWikilinks } from '../../src/core/wikilinks.js';

describe('extractWikilinks', () => {
  it('plain, alias, heading, and embed forms → bare target', () => {
    expect(extractWikilinks('see [[Habits]] and [[Systems|my systems]]')).toEqual(['Habits', 'Systems']);
    expect(extractWikilinks('[[Note#Section]] and ![[Embedded]]')).toEqual(['Note', 'Embedded']);
  });
  it('dedupes, preserves first-seen order, ignores empties', () => {
    expect(extractWikilinks('[[A]] x [[A]] y [[B]]')).toEqual(['A', 'B']);
    expect(extractWikilinks('no links here')).toEqual([]);
    expect(extractWikilinks('[[ ]] [[]]')).toEqual([]);
  });
  it('trims whitespace inside brackets', () => {
    expect(extractWikilinks('[[  Spaced Note  ]]')).toEqual(['Spaced Note']);
  });
});
```

- [ ] **Step 2: Run → FAIL.** `pnpm vitest run test/core/wikilinks.test.ts`

- [ ] **Step 3: Implement**
```typescript
// src/core/wikilinks.ts
/** Obsidian wikilink targets from body text. [[t]] [[t|alias]] [[t#h]] ![[t]] → bare t, deduped, first-seen order. */
export function extractWikilinks(body: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(/!?\[\[([^\]]+?)\]\]/g)) {
    const target = m[1].split('|')[0].split('#')[0].trim(); // strip alias + heading
    if (target && !seen.has(target)) { seen.add(target); out.push(target); }
  }
  return out;
}
```

- [ ] **Step 4: Run → PASS.** Then `pnpm typecheck` (0).
- [ ] **Step 5: Commit** `git add src/core/wikilinks.ts test/core/wikilinks.test.ts && git commit -m "feat(core): Obsidian wikilink extraction"`

---

## Task 2: Note graph + Louvain communities

**Files:** Create `src/daemon/note-graph.ts`; Test `test/daemon/note-graph.test.ts`; Modify `package.json`

- [ ] **Step 1: Add deps**
```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
pnpm add graphology graphology-communities-louvain
```
If pnpm gates a build script, approve only these. Confirm `pnpm typecheck` resolves the modules (graphology ships its own types; if `graphology-communities-louvain` lacks types, add `// @ts-expect-error` only as a last resort and report it).

- [ ] **Step 2: Failing test** (controlled graph: two triangles joined by nothing → 2 communities)
```typescript
// test/daemon/note-graph.test.ts
import { describe, it, expect } from 'vitest';
import { buildNoteGraph, detectCommunities, resolveLink } from '../../src/daemon/note-graph.js';

describe('resolveLink', () => {
  it('resolves a bare target to a note path by basename, case-insensitive', () => {
    const paths = ['Habits.md', 'sub/Systems.md'];
    expect(resolveLink('Habits', paths)).toBe('Habits.md');
    expect(resolveLink('systems', paths)).toBe('sub/Systems.md');
    expect(resolveLink('Missing', paths)).toBeUndefined();
  });
});

describe('communities', () => {
  it('separates two disconnected link clusters', () => {
    const notes = [
      { path: 'a.md', links: ['b', 'c'] }, { path: 'b.md', links: ['a', 'c'] }, { path: 'c.md', links: ['a', 'b'] },
      { path: 'x.md', links: ['y'] }, { path: 'y.md', links: ['x'] },
    ];
    const g = buildNoteGraph(notes);
    const comm = detectCommunities(g);
    // a,b,c share a community distinct from x,y
    expect(comm.get('a.md')).toBe(comm.get('b.md'));
    expect(comm.get('a.md')).toBe(comm.get('c.md'));
    expect(comm.get('x.md')).toBe(comm.get('y.md'));
    expect(comm.get('a.md')).not.toBe(comm.get('x.md'));
  });
  it('an unlinked note is its own community', () => {
    const g = buildNoteGraph([{ path: 'lone.md', links: [] }, { path: 'a.md', links: ['b'] }, { path: 'b.md', links: ['a'] }]);
    const comm = detectCommunities(g);
    expect(comm.get('lone.md')).not.toBe(comm.get('a.md'));
  });
});
```

- [ ] **Step 3: Implement** (verify exact louvain API against installed types; the function form returns node→community map)
```typescript
// src/daemon/note-graph.ts
import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';

/** Resolve a bare wikilink target to a note path by basename match (case-insensitive). */
export function resolveLink(target: string, paths: string[]): string | undefined {
  const t = target.toLowerCase();
  return paths.find((p) => {
    const base = p.slice(p.lastIndexOf('/') + 1).replace(/\.md$/i, '');
    return base.toLowerCase() === t;
  });
}

/** Undirected note-link graph: nodes = note paths, edges = resolved wikilinks. */
export function buildNoteGraph(notes: Array<{ path: string; links: string[] }>): Graph {
  const g = new Graph({ type: 'undirected' });
  const paths = notes.map((n) => n.path);
  for (const n of notes) g.mergeNode(n.path);
  for (const n of notes) {
    for (const l of n.links) {
      const target = resolveLink(l, paths);
      if (target && target !== n.path) g.mergeEdge(n.path, target); // mergeEdge is idempotent in undirected
    }
  }
  return g;
}

/** Louvain communities → notePath → communityId. Edgeless graph → each node its own id (louvain may throw on no edges). */
export function detectCommunities(graph: Graph): Map<string, number> {
  if (graph.size === 0) {
    let i = 0;
    const m = new Map<string, number>();
    graph.forEachNode((n) => m.set(n, i++));
    return m;
  }
  const mapping = louvain(graph) as Record<string, number>; // node → community number
  return new Map(Object.entries(mapping));
}
```

Add a test for the edgeless case in Step 2:
```typescript
  it('edgeless graph → every node its own community (no throw)', () => {
    const comm = detectCommunities(buildNoteGraph([{ path: 'p.md', links: [] }, { path: 'q.md', links: [] }]));
    expect(comm.get('p.md')).not.toBe(comm.get('q.md'));
    expect(comm.size).toBe(2);
  });
```

- [ ] **Step 4: Run → PASS.** Louvain is deterministic on these disjoint inputs; if a seed is needed for determinism, pass `louvain(graph, { rng: () => 0.5 })` or the library's seed option — confirm tests are stable across 3 runs. `pnpm typecheck` (0).
- [ ] **Step 5: Commit** `git add src/daemon/note-graph.ts test/daemon/note-graph.test.ts package.json pnpm-lock.yaml pnpm-workspace.yaml && git commit -m "feat(daemon): note-link graph + Louvain communities"`

---

## Task 3: VaultIndex stores per-note wikilinks

**Files:** Modify `src/daemon/vault-index.ts`

- [ ] **Step 1:** Add import `import { extractWikilinks } from '../core/wikilinks.js';` and a field `private readonly noteLinks = new Map<string, string[]>();`.
- [ ] **Step 2:** In `addNote(notePath, source)`, after the early-return guard, record links once per note:
```typescript
this.noteLinks.set(notePath, extractWikilinks(source));
```
(Place it before/after the blocks loop — once per note, not per chunk.)
- [ ] **Step 3:** Add an accessor used by Task 4:
```typescript
/** notePath → its outgoing wikilink targets (unresolved bare names). */
private noteList(): Array<{ path: string; links: string[] }> {
  return [...this.noteLinks.entries()].map(([path, links]) => ({ path, links }));
}
```
- [ ] **Step 4:** `pnpm test` (all green — no behavior change yet), `pnpm typecheck` (0).
- [ ] **Step 5: Commit** `git add src/daemon/vault-index.ts && git commit -m "feat(daemon): VaultIndex records per-note wikilinks"`

---

## Task 4: Community-aware bridges

**Files:** Modify `src/daemon/vault-index.ts`; Test `test/daemon/bridges-community.test.ts`

- [ ] **Step 1: Failing test** (controlled fixture: 2 link-clusters, a cross-cluster semantic twin)
```typescript
// test/daemon/bridges-community.test.ts
import { describe, it, expect } from 'vitest';
import { VaultIndex } from '../../src/daemon/vault-index.js';
import { FakeEmbedder } from '../../src/core/embedder.js';

// cluster1: a<->b linked. cluster2: x<->y linked. a and x share an identical line (twin) but are unlinked + different clusters.
async function seeded(): Promise<VaultIndex> {
  const idx = new VaultIndex(new FakeEmbedder(64));
  await idx.addNote('a.md', '# A\n\n[[b]]\n\nidentical bridging line\n');
  await idx.addNote('b.md', '# B\n\n[[a]]\n\nb unique filler\n');
  await idx.addNote('x.md', '# X\n\n[[y]]\n\nidentical bridging line\n');
  await idx.addNote('y.md', '# Y\n\n[[x]]\n\ny unique filler\n');
  return idx;
}

describe('community-aware bridges', () => {
  it('flags the a↔x twin as crossCommunity and not linked', async () => {
    const idx = await seeded();
    const top = idx.bridges(20, 0.9).find((br) => br.similarity > 0.9)!;
    expect([top.a.notePath, top.b.notePath].sort()).toEqual(['a.md', 'x.md']);
    expect(top.crossCommunity).toBe(true);
    expect(top.linked).toBe(false);
  });
  it('crossCommunityOnly filter drops same-community pairs', async () => {
    const idx = await seeded();
    const all = idx.bridges(50, -1);
    const cross = idx.bridges(50, -1, true);
    expect(cross.every((b) => b.crossCommunity)).toBe(true);
    expect(cross.length).toBeLessThanOrEqual(all.length);
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement.** Extend `Bridge` and `bridges()`:
  - Add to the `Bridge` interface: `crossCommunity: boolean; linked: boolean;`.
  - Add lazy community state + a directly-linked lookup. Inside `bridges(topN, minSimilarity, crossCommunityOnly = false)`:
    - Build communities once: `const comm = detectCommunities(buildNoteGraph(this.noteList()));`
    - Build a resolved adjacency set for `linked`: for each note, resolve its links to paths → `Set<"pathA pathB">` (sorted pair key).
    - When pushing a bridge, compute `crossCommunity = comm.get(aPath) !== comm.get(bPath)` and `linked = adjacency.has(key(aPath,bPath))`.
    - If `crossCommunityOnly && !crossCommunity` → skip.
  - Keep the existing similarity-floor, same-note exclusion, descending sort, topN slice.
  - Imports: `import { buildNoteGraph, detectCommunities, resolveLink } from './note-graph.js';`

- [ ] **Step 4: Run → PASS.** Update the existing `test/daemon/bridges.test.ts` only if the added fields break a deep-equal (they assert on `.similarity`/`.notePath`/`.text`, so they should still pass — confirm). `pnpm test` all green, `pnpm typecheck` 0.
- [ ] **Step 5: Commit** `git add src/daemon/vault-index.ts test/daemon/bridges-community.test.ts && git commit -m "feat(daemon): community-aware bridges (crossCommunity + linked flags)"`

---

## Task 5: MCP surface + finish

**Files:** Modify `src/daemon/mcp-server.ts`

- [ ] **Step 1:** Add `crossCommunityOnly` to the `vaultnexus_bridges` inputSchema and pass it through:
```typescript
inputSchema: { topN: z.number().int().positive().optional(), minSimilarity: z.number().optional(), crossCommunityOnly: z.boolean().optional() },
```
```typescript
async ({ topN, minSimilarity, crossCommunityOnly }) => {
  const bridges = index.bridges(topN ?? 20, minSimilarity ?? 0.5, crossCommunityOnly ?? false);
  return { content: [{ type: 'text', text: JSON.stringify(bridges) }] };
},
```
Update the tool description to mention it surfaces hidden cross-cluster connections (`crossCommunity`/`linked` fields).
- [ ] **Step 2:** `pnpm test` (all green incl demo-vault e2e), `pnpm typecheck` 0, `pnpm build` 0.
- [ ] **Step 3: Commit** `git add src/daemon/mcp-server.ts && git commit -m "feat(daemon): vaultnexus_bridges crossCommunityOnly filter + community fields"`

---

## Self-Review
- **Spec coverage:** extraction (T1) ✓, graph+communities (T2) ✓, link storage (T3) ✓, community-aware bridges (T4) ✓, MCP surface (T5) ✓.
- **Placeholders:** none — real code/tests throughout; only the louvain seed option is "verify against installed types" (legitimately library-version-dependent — flagged for the implementer).
- **Type consistency:** `extractWikilinks(body):string[]` used in T3. `buildNoteGraph(Array<{path,links}>)` fed by `noteList()` (T3) shape. `detectCommunities→Map<string,number>` consumed in T4. `Bridge` gains `crossCommunity`/`linked` (T4), serialized unchanged by the tool (T5). `bridges(topN,minSimilarity,crossCommunityOnly?)` signature consistent T4↔T5.
- **Fragility guard:** new tests use isolated fixtures; demo-vault deterministic bridge tests must stay green (T4/T5 confirm) — do NOT edit demo-vault notes.
- **Determinism:** Louvain stability checked over 3 runs (T2 Step 4); disjoint clusters are robust regardless of seed.
