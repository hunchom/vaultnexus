# VaultNexus 13 — `recall_history` Git-History Backbone

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Build the pure-logic backbone for belief-drift narration (spec §4 Tier A MVP). Given a vault note path, return a deterministic revision timeline pulled from `git log` plus dated frontmatter — every entry citing a real SHA the user can `git show`. **No LLM narration step** — the natural-language "how the stance shifted" layer is a separate, deferred plan that consumes this output.

**Why this shape:** The spec's FP-safe guarantee for `recall_history` is "every claimed change points at a dated diff the user can open" (concept §4). That guarantee lives in the data backbone — once the walker returns `{sha, commitDate, message, frontmatterDate?}` tuples that are by construction real git refs, the natural-language layer on top can be wrong about *characterization* but never about *provenance*. Same partition as Plan 12 (`reason_over_vault` — citation chain is the contract; LLM compose is separate).

**Architecture:**
- `src/daemon/git-history.ts` is the only place the daemon shells out to `git`. Three pure async functions over a `repoPath: string`:
  - `isGitRepo(repoPath)` — boolean probe (`git -C <repo> rev-parse --is-inside-work-tree`, exit 0 ⇒ true).
  - `noteRevisions(repoPath, notePath, opts?)` — walks `git log --follow --pretty=format:%H%x00%aI%x00%s%x00%aE -- <notePath>`. Returns `Revision[]` chronological newest-first. `--follow` tracks renames.
  - `noteContentAt(repoPath, sha, notePath)` — `git show <sha>:<notePath>`. Returns content string. On binary or missing → throws a typed error the caller can catch.
- Frontmatter date extraction reuses `gray-matter` (already a dep). `extractFrontmatterDate(content): string | undefined` reads `frontmatter.date` if present and valid ISO; returns `undefined` otherwise. Lives in `src/core/markdown.ts` alongside the existing parser.
- `VaultIndex` gains an optional `vaultPath: string | undefined` field set at construction. When unset (e.g. unit tests that build an index without a backing dir), `history()` returns `[]`. When set, `history(notePath, opts)` calls the git-history module.
- `main.ts` passes `process.env.VAULTNEXUS_VAULT` to the `VaultIndex` constructor as `vaultPath`.
- MCP surface: `vaultnexus_history` returns `{ revisions: Revision[] }` where each `Revision` is `{ sha, commitDate, message, authorEmail, frontmatterDate?, content? }`. `withContent: true` includes the content snapshot at each revision (otherwise just metadata).

**Tech stack:** TS/ESM/NodeNext, vitest, `node:child_process` (`spawn`/`execFile`), gray-matter (already a dep). **No new deps.**

**Non-goals (later plans):**
- LLM narration (`recall_history` natural-language stance-shift story) — separate plan, separate gate.
- Confirmation-drift slope (Milestone-2 instrument: hedge-lexicon-derived conviction-score vs supporting-claim-count over git-time) — gated on §10.9 precision spike, ships separately.
- Per-block diff highlighting / heat-map visualization (downstream consumer of this backbone).
- Multi-repo / submodule walking (the vault is a single repo).

---

## File Structure

- Create `src/daemon/git-history.ts` — pure async wrappers around `git` CLI; `Revision` type.
- Modify `src/core/markdown.ts` — add `extractFrontmatterDate(content)`.
- Modify `src/daemon/vault-index.ts` — add `vaultPath?: string` ctor param; add `history(notePath, opts)` method.
- Modify `src/daemon/main.ts` — pass `process.env.VAULTNEXUS_VAULT` as `vaultPath`.
- Modify `src/daemon/mcp-server.ts` — register `vaultnexus_history` tool.
- Tests: `test/daemon/git-history.test.ts`, `test/daemon/mcp-history.test.ts`.

---

## Task 1 — `isGitRepo()` + `noteRevisions()` walker

**Files:** Create `src/daemon/git-history.ts`; Create `test/daemon/git-history.test.ts`

- [ ] **Step 1:** Define types + module shape:

```typescript
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export interface Revision {
  sha: string;
  commitDate: string;    // ISO 8601 from git %aI
  message: string;
  authorEmail: string;
  frontmatterDate?: string;   // user-declared frontmatter `date:` if valid ISO
  content?: string;            // populated only when withContent: true
}

export interface HistoryOptions {
  since?: string;     // ISO date; git --since
  until?: string;     // ISO date; git --until
  withContent?: boolean;
  maxRevisions?: number;   // default 50; honored client-side after git output
}

export async function isGitRepo(repoPath: string): Promise<boolean> {
  try {
    await exec('git', ['-C', repoPath, 'rev-parse', '--is-inside-work-tree']);
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 2: Failing test** in `test/daemon/git-history.test.ts`:
  - Use `node:fs.mkdtempSync` for a tmp repo dir.
  - `execSync('git init && git -c user.email=t@t -c user.name=T commit ...')` to seed 3 commits on `notes/a.md` with different content + ISO dates 2024-01-01, 2024-02-01, 2024-03-01.
  - Call `noteRevisions(repoPath, 'notes/a.md')`. Assert: length === 3, descending by commitDate, every revision has non-empty `sha` (40 hex chars) + ISO `commitDate`.

- [ ] **Step 3: Implement `noteRevisions`:**

```typescript
const NUL = '\0';

export async function noteRevisions(repoPath: string, notePath: string, opts: HistoryOptions = {}): Promise<Revision[]> {
  if (!await isGitRepo(repoPath)) return [];
  const args = ['-C', repoPath, 'log', '--follow', `--pretty=format:%H${NUL}%aI${NUL}%s${NUL}%aE`];
  if (opts.since) args.push(`--since=${opts.since}`);
  if (opts.until) args.push(`--until=${opts.until}`);
  args.push('--', notePath);
  const { stdout } = await exec('git', args, { maxBuffer: 32 * 1024 * 1024 });
  if (!stdout.trim()) return [];
  const all = stdout.split('\n').map((line) => {
    const [sha, commitDate, message, authorEmail] = line.split(NUL);
    return { sha, commitDate, message, authorEmail } as Revision;
  });
  return all.slice(0, opts.maxRevisions ?? 50);
}
```

- [ ] **Step 4:** Run `pnpm test -- git-history`. Confirm green.

---

## Task 2 — `noteContentAt()` + frontmatter date extraction

**Files:** Modify `src/daemon/git-history.ts`; Modify `src/core/markdown.ts`; Extend `test/daemon/git-history.test.ts`

- [ ] **Step 1: Failing test** — load content from the second commit of the fixture from Task 1. Assert it matches the seed content for that revision exactly.

- [ ] **Step 2: Implement `noteContentAt`:**

```typescript
export async function noteContentAt(repoPath: string, sha: string, notePath: string): Promise<string> {
  const { stdout } = await exec('git', ['-C', repoPath, 'show', `${sha}:${notePath}`], { maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}
```

- [ ] **Step 3: Failing test** for frontmatter date — seed a note with `---\ndate: 2024-02-15\n---\n# Hello`. Call `extractFrontmatterDate(content)`. Assert returns `'2024-02-15'` (or whatever string form gray-matter returns — coerce to ISO string in the impl). Add a second case with no frontmatter at all → returns `undefined`. Add a third with frontmatter but no `date:` field → `undefined`. Add a fourth with `date: not-a-date` → `undefined` (validity check).

- [ ] **Step 4: Implement** in `src/core/markdown.ts`:

```typescript
/** User-declared frontmatter `date:` as ISO string, undefined if missing/invalid. */
export function extractFrontmatterDate(content: string): string | undefined {
  const fm = parseMarkdown(content).frontmatter;
  const raw = fm?.date;
  if (raw === undefined || raw === null) return undefined;
  const iso = raw instanceof Date ? raw.toISOString() : String(raw);
  return Number.isNaN(Date.parse(iso)) ? undefined : iso;
}
```

(Adapt to the actual return shape of `parseMarkdown`; the existing module is in `src/core/markdown.ts`. Read it before writing the test.)

- [ ] **Step 5:** Run `pnpm test -- git-history` + `pnpm test -- markdown`. Confirm green.

---

## Task 3 — `withContent` + frontmatter date enrichment

**Files:** Modify `src/daemon/git-history.ts`; Extend `test/daemon/git-history.test.ts`

- [ ] **Step 1: Failing test** — call `noteRevisions(repo, 'notes/a.md', { withContent: true })`. For at least one revision whose seeded content includes a frontmatter `date:` field, assert the returned revision has both `content: <expected string>` and `frontmatterDate: <expected ISO>`.

- [ ] **Step 2: Implement.** Inside `noteRevisions`, when `opts.withContent` is true: for each revision (post-slice), `await noteContentAt(repoPath, sha, notePath)` and set `r.content`. Then `r.frontmatterDate = extractFrontmatterDate(r.content)`. Use `Promise.all` to parallelize the per-revision git-show calls.

- [ ] **Step 3:** Confirm green.

---

## Task 4 — `VaultIndex.history()` wrapper

**Files:** Modify `src/daemon/vault-index.ts`; Modify `src/daemon/main.ts`; Extend `test/daemon/git-history.test.ts`

- [ ] **Step 1: Failing integration test** — construct `VaultIndex(fakeEmbedder, { vaultPath: tmpRepoDir })`, index a note via `addNote`, call `index.history('notes/a.md')`. Assert revisions are returned.

- [ ] **Step 2: Implement.** Add to `VaultIndex` constructor:

```typescript
constructor(
  private readonly embedder: Embedder,
  private readonly vaultPath?: string,
) {}

async history(notePath: string, opts: HistoryOptions = {}): Promise<Revision[]> {
  if (!this.vaultPath) return [];
  return noteRevisions(this.vaultPath, notePath, opts);
}
```

The `vaultPath` must come from the daemon, not from the index's notion of paths (the index doesn't store the vault root anywhere today — addNote receives absolute or relative paths transparently). `main.ts` change:

```typescript
const index = new VaultIndex(embedder, process.env.VAULTNEXUS_VAULT);
```

`history()` receives the **same `notePath` that was passed to `addNote`**. If the caller used relative paths (as `indexVault` does), `notePath` is already relative to `vaultPath` and `git log -- <relpath>` works directly. If absolute paths were used, the caller must convert before calling `history()`. Document this contract in the docstring.

- [ ] **Step 3:** Confirm green. Existing 130 tests must remain green (constructor signature change is additive — `vaultPath` is optional).

---

## Task 5 — `vaultnexus_history` MCP tool

**Files:** Modify `src/daemon/mcp-server.ts`; Create `test/daemon/mcp-history.test.ts`

- [ ] **Step 1: Failing smoke test** — start in-memory MCP server with an indexed `VaultIndex` over a tmp git repo. Call `vaultnexus_history` with `{ notePath: 'notes/a.md' }`. Assert JSON response has `revisions: [...]` with at least one entry shaped like a `Revision`.

- [ ] **Step 2: Implement:**

```typescript
server.registerTool(
  'vaultnexus_history',
  {
    description:
      'Walk git history for a note. Returns chronological (newest first) revisions w/ sha + commitDate + message + authorEmail; optional content snapshot + user-declared frontmatter date. Backbone for belief-drift narration; no LLM compose — every revision cites a real git SHA the user can `git show`.',
    inputSchema: {
      notePath: z.string(),
      since: z.string().optional(),
      until: z.string().optional(),
      withContent: z.boolean().optional(),
      maxRevisions: z.number().int().positive().optional(),
    },
  },
  async ({ notePath, since, until, withContent, maxRevisions }) => {
    const revisions = await index.history(notePath, { since, until, withContent, maxRevisions });
    return { content: [{ type: 'text', text: JSON.stringify({ revisions }) }] };
  },
);
```

- [ ] **Step 3:** Confirm green.

---

## Task 6 — Edge cases + final verification

**Files:** Extend `test/daemon/git-history.test.ts`

- [ ] **Step 1:** Non-git vault → `noteRevisions` returns `[]`. `VaultIndex.history()` returns `[]` when `vaultPath` is undefined.
- [ ] **Step 2:** Note never committed (file exists in working tree, no log entry) → returns `[]`.
- [ ] **Step 3:** `maxRevisions: 2` honored when 3 revisions exist.
- [ ] **Step 4:** `since`/`until` filter honored — set `since: '2024-02-15'`, expect only the third commit (date 2024-03-01) returned.
- [ ] **Step 5:** Rename preserved via `--follow` — commit `notes/a.md`, rename it to `notes/b.md` in a second commit, call `noteRevisions(repo, 'notes/b.md')`, assert length === 2.
- [ ] **Step 6:** `pnpm typecheck && pnpm test && pnpm build` all green. Expected test count: 130 + ~8 new = ~138.

---

## Verification before completion

- [ ] `pnpm test` — all green incl. new tests (~138 total).
- [ ] `pnpm typecheck` — zero errors.
- [ ] `pnpm build` — emits dist/ cleanly with shebang'd bins.
- [ ] **No new deps added.** `child_process.execFile` is stdlib.
- [ ] Caveman-ULTRA on all source comments/docstrings written. No "Fix N:" prefaces, no essay blocks. ONE-line comments. Quoted strings + symbol names verbatim.
- [ ] No `Claude` / `Anthropic` / `Co-Authored-By` / `noreply@anthropic` strings in any new or modified file.
- [ ] Each task committed atomically on `feat/recall-history` w/ author `dev <dev@localhost>`.

---

## Decision log (validated-first hooks)

- **Why shell out to `git` rather than `isomorphic-git`:** zero new dep; the daemon's controlled environment will always have git (it's the precondition for a "Markdown/Obsidian vault"); JS-pure git would add a multi-MB dep for a feature that runs once per user-initiated history call — wrong cost/value ratio. `execFile` over `exec` to skip shell parsing (no injection surface — args are array-form).
- **Why no narration here:** mirrors Plan 12. The backbone returns mechanically-verifiable provenance; the LLM characterization layer rides on top and gets its own gate. Decouples shipping the deterministic substrate from any model-choice decision.
- **Why frontmatter `date` *in addition to* commit `date`:** they answer different questions. Commit date is "when this state was recorded"; frontmatter date is "what date the user *says* this is about" (e.g., a journal entry edited months later). The narration layer will want both.
- **Why `--follow`:** Obsidian users routinely rename notes; without `--follow`, half of vaults would show empty history on renamed files. Tradeoff: `--follow` is implicit-rename-detection (heuristic). Acceptable — the failure mode is "miss a revision," never "fabricate one."
- **Security:** `execFile` with arg-array passes `notePath` directly to git without shell interpretation. The only injection-relevant inputs are `since`/`until` (also passed via arg-array). No new attack surface.
