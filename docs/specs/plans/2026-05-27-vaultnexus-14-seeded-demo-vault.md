# VaultNexus 14 — Seeded Demo Vault

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Concept §6 cold-start: ship a small but realistic seeded vault with pre-existing dated git history so a fresh install can demonstrate convergence (Plan 07/10), cited reasoning (Plan 12), belief-drift narration (Plan 13), and — later — confirmation-drift analytics and forecast-resolution **immediately**, without waiting for the user's own vault to mature. This is the **canonical day-one demo target** and the **substrate for every spike** in concept §10 (value, drift, contradiction).

**Why now:** Both reasoning backbones (Plan 12, Plan 13) are deterministic and need a corpus with intentional structure to demonstrate value beyond toy tests. The existing `demo-vault/` (Plan 07, 5 notes) is a wiring fixture, not a value fixture. Without a richer seeded vault, the next plan (drift-signal computer) tests on toy fixtures; the §10 spikes have no canonical baseline; and a fresh install shows nothing on Tier-A MVP wave-1a features.

**Architecture:**
- `demo-vault-seeded/notes/` holds ~30 hand-authored markdown files organized into 3 wikilink-coherent topic communities. Content is synthetic but realistic — coherent within a topic, sparse cross-topic links (one or two each, for bridges/convergence to surface against).
- One designated "stance-shift" note is committed three times with deliberate **conviction-lexicon creep** (hedge words → assertion words → strong-assertion words) and **flat supporting-evidence** (no new wikilinks added in revisions 2 + 3) — this is the canonical test case for the future drift signal.
- Five forecast-marked notes carry frontmatter `forecast: { claim: string, by: ISO-date, marked_at: ISO-date }` so the future ledger has resolvable predictions on day one.
- A few notes carry frontmatter `date:` so `extractFrontmatterDate` (Plan 13) returns something on real fixtures.
- `scripts/seed-demo-vault.ts` is a Node script that:
  1. Takes an output directory.
  2. Copies `demo-vault-seeded/notes/` into it.
  3. `git init --initial-branch=main` in the output dir.
  4. Replays a baked **commit timeline** (`docs/seed/commit-timeline.json` — a list of `{ files: string[], date: ISO, message: string }` records) using `git -c user.email=demo@vaultnexus -c user.name=Demo commit --date=<ISO>` plus `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` env so historic dates stick.
  5. Reports the output path.
- Determinism: same `commit-timeline.json` → same git history. Content files do not contain timestamps that drift; all dates live in the timeline.
- The seeded vault is **clearly labeled sample data** (a top-level `README.md` says so) and is **never** auto-indexed alongside the user's real vault.

**Tech stack:** TS/ESM/NodeNext, vitest, `node:child_process`, `node:fs`. No new deps.

**Non-goals (later plans):**
- Stochastic / parametric vault generator (Plan 14 ships a static-content + baked-timeline approach; a future plan can layer a generator on top if scale requires).
- Forecast-resolution UX (the marked predictions exist; resolution + Brier scoring is a separate Milestone-2 plan).
- Drift-signal computer itself (Plan 15 will consume this vault as its primary fixture).

---

## File Structure

- Create `demo-vault-seeded/notes/` — ~30 hand-authored `.md` files across 3 topic dirs.
- Create `demo-vault-seeded/README.md` — "Sample data; do not edit or index alongside real vaults."
- Create `docs/seed/commit-timeline.json` — baked commit sequence (dates + file groups + messages).
- Create `scripts/seed-demo-vault.ts` — the replay script.
- Create `test/scripts/seed-demo-vault.test.ts` — asserts the seeded vault matches contract.
- Modify `package.json` — add `"seed:demo": "tsx scripts/seed-demo-vault.ts"` to scripts.

---

## Content brief (load-bearing — the test asserts this structure)

### Topic community A: "Productivity Systems" (~10 notes)

Theme: pros/cons of GTD vs deep work vs maker schedule. A is the **wikilink hub** — most cross-community links live here.

Notes (file names):
- `productivity/index.md` — hub; wikilinks to all other A notes + 2 cross-community.
- `productivity/gtd-overview.md`
- `productivity/gtd-effectiveness.md` — **the stance-shift note** (3 commits, see "Commit timeline" below)
- `productivity/deep-work-blocks.md`
- `productivity/maker-vs-manager.md`
- `productivity/weekly-review-protocol.md`
- `productivity/inbox-zero-strategy.md`
- `productivity/context-switching-cost.md`
- `productivity/calendar-blocking.md` — frontmatter `date: 2024-08-14`
- `productivity/why-i-quit-pomodoro.md` — frontmatter `date: 2024-09-02`

### Topic community B: "Decision Making" (~10 notes)

Theme: intuitive vs analytical, OODA loop, premortems, forecast-marked predictions.

- `decisions/index.md` — hub; wikilinks to all B notes + 1 cross-community.
- `decisions/intuition-vs-analysis.md`
- `decisions/premortem-checklist.md`
- `decisions/ooda-loop-fast.md`
- `decisions/sunk-cost-trap.md`
- `decisions/ai-capabilities-2027.md` — **forecast note 1**, frontmatter `forecast: { claim: "...", by: 2027-12-31, marked_at: 2024-11-01 }`
- `decisions/remote-work-future.md` — **forecast note 2**, frontmatter forecast on `2026-06-30`
- `decisions/personal-blog-growth.md` — **forecast note 3**
- `decisions/skill-acquisition-rate.md` — **forecast note 4**
- `decisions/regret-minimization-frame.md` — **forecast note 5**

### Topic community C: "Knowledge Tools" (~10 notes)

Theme: note-taking, second-brain, atomic notes, this very vault.

- `tools/index.md` — hub; wikilinks to all C notes + 1 cross-community.
- `tools/atomic-notes-principle.md`
- `tools/zettelkasten-vs-folders.md`
- `tools/why-obsidian.md`
- `tools/markdown-portability.md`
- `tools/wikilinks-vs-tags.md`
- `tools/spaced-repetition-utility.md`
- `tools/note-density-tradeoff.md`
- `tools/search-vs-browse.md`
- `tools/this-vaultnexus-experiment.md` — frontmatter `date: 2024-12-20`

### Cross-community wikilinks (the convergence-bait)

- `productivity/maker-vs-manager.md` wikilinks `[[ooda-loop-fast]]` (A → B).
- `decisions/premortem-checklist.md` wikilinks `[[weekly-review-protocol]]` (B → A).
- `tools/this-vaultnexus-experiment.md` wikilinks `[[gtd-effectiveness]]` (C → A).
- `productivity/context-switching-cost.md` mentions `[[atomic-notes-principle]]` (A → C).

That is **four** cross-community wikilinks total. Louvain (Plan 10) should still produce three communities (A/B/C) under this sparse cross-link load.

### Stance-shift commit sequence (the drift-signal fixture)

`productivity/gtd-effectiveness.md` is committed **three times** at three dated commits. The text body is rewritten each time; **no new wikilinks are added between revision 1 and revision 3**.

- Revision 1 (2024-03-15): hedge-heavy. Phrases like "I'm not sure yet, but…", "early trials suggest…", "this could be useful in certain contexts…". 200–300 words.
- Revision 2 (2024-06-10): mixed conviction. "GTD's daily review *appears* essential", "I've come to rely on the weekly review", removes most hedges. Same wikilinks as r1.
- Revision 3 (2024-10-22): strong assertion. "GTD is the only viable knowledge-work system for me", "without the weekly review I'm useless", no hedges. Same wikilinks as r1 + r2.

This is the canonical drift fixture — Plan 15's lexicon-based conviction score is expected to monotonically increase across these three revisions, with supporting-claim-count (≈ wikilink fan-out + linked-note count) staying flat.

### Forecast-marked notes (the ledger fixture)

Each of the five forecast notes carries frontmatter:

```yaml
---
forecast:
  claim: "<a falsifiable claim>"
  by: 2027-12-31         # or whatever
  marked_at: 2024-11-01  # the date the user marked it
---
```

Plus a body that argues the claim. Plan 15+ will resolve these against outcomes.

---

## Commit timeline (`docs/seed/commit-timeline.json`)

A JSON array, oldest-first. Each entry: `{ files: string[], date: string (ISO), message: string }`.

Approximate sequence (the builder may inflate the body count to keep commits ~5 files each — but the dated milestones below are load-bearing):

1. `2024-01-15` — `productivity/index.md`, `productivity/gtd-overview.md`, `productivity/deep-work-blocks.md`. "seed: initial productivity notes"
2. `2024-02-04` — `decisions/index.md`, `decisions/intuition-vs-analysis.md`, `decisions/ooda-loop-fast.md`. "seed: initial decision-making notes"
3. `2024-03-15` — `productivity/gtd-effectiveness.md` (revision 1, hedge-heavy). "first impressions of GTD"
4. `2024-04-22` — `tools/index.md`, `tools/atomic-notes-principle.md`, `tools/zettelkasten-vs-folders.md`. "seed: initial knowledge-tools notes"
5. `2024-05-10` — `productivity/weekly-review-protocol.md`, `productivity/inbox-zero-strategy.md`. "productivity: review protocols"
6. `2024-06-10` — `productivity/gtd-effectiveness.md` (revision 2, mixed conviction). "GTD: weekly review pays off"
7. `2024-07-03` — `decisions/premortem-checklist.md`, `decisions/sunk-cost-trap.md`. "decision-making: bias countermeasures"
8. `2024-08-14` — `productivity/maker-vs-manager.md`, `productivity/calendar-blocking.md`, `productivity/context-switching-cost.md`. "productivity: schedule structure"
9. `2024-09-02` — `productivity/why-i-quit-pomodoro.md`. "productivity: quitting pomodoro"
10. `2024-09-25` — `tools/why-obsidian.md`, `tools/markdown-portability.md`, `tools/wikilinks-vs-tags.md`. "tools: choosing obsidian"
11. `2024-10-22` — `productivity/gtd-effectiveness.md` (revision 3, strong assertion). "GTD: the only viable system"
12. `2024-11-01` — all 5 forecast-marked notes. "decisions: marking 2027 forecasts"
13. `2024-11-18` — `tools/spaced-repetition-utility.md`, `tools/note-density-tradeoff.md`, `tools/search-vs-browse.md`. "tools: density + retrieval"
14. `2024-12-20` — `tools/this-vaultnexus-experiment.md`. "tools: starting the vaultnexus experiment"

The builder hand-authors all notes + the timeline JSON. Date values must be valid ISO 8601 dates parseable by `Date.parse`.

---

## Task 1 — Hand-author the 30-note corpus + commit timeline

**Files:** Create `demo-vault-seeded/notes/**/*.md` (~30 files), `demo-vault-seeded/README.md`, `docs/seed/commit-timeline.json`.

- [ ] **Step 1:** Create the directory tree:
  ```
  demo-vault-seeded/
    README.md
    notes/
      productivity/...  (10 .md files)
      decisions/...     (10 .md files)
      tools/...         (10 .md files)
  ```
- [ ] **Step 2:** Hand-author every note per the content brief above. Each note is ~150–400 words, plain markdown, with at least one `## Heading` (so chunking exercises heading paths), at least one `[[wikilink]]` (except the stance-shift note's revision 1 which can have just one), and — where called for in the brief — frontmatter (`date:` and/or `forecast:`). **Caveman discipline applies to plan/code/commit comments, NOT to the demo content** — the demo notes must be *readable, realistic English prose* (a fresh user reads them on day one).
- [ ] **Step 3:** Hand-author the three revisions of `productivity/gtd-effectiveness.md` as **three separate text fragments** stored alongside the live file. The simplest pattern: keep revision 3 as the final committed state in `demo-vault-seeded/notes/productivity/gtd-effectiveness.md` (because that's what `git checkout main` shows), and stash revisions 1 + 2 in `demo-vault-seeded/.history/gtd-effectiveness/{r1.md,r2.md}` for the seeder script to pull at the appropriate commits.
- [ ] **Step 4:** Author `docs/seed/commit-timeline.json` per the schema above.
- [ ] **Step 5:** Author `demo-vault-seeded/README.md` — one paragraph, says "Sample data shipped with VaultNexus for demo + tests. Do not index alongside your real vault. The git history here is synthetic — commit dates are baked, not lived."
- [ ] **Step 6:** Commit. `git add demo-vault-seeded docs/seed`. NEVER `git add -A`. Message: `feat: seeded demo vault content (~30 notes, 3 communities)`.

---

## Task 2 — Seeder script `scripts/seed-demo-vault.ts`

**Files:** Create `scripts/seed-demo-vault.ts`; Modify `package.json` (add `seed:demo` script).

- [ ] **Step 1:** Failing test (Task 3 below covers this, but the script's contract is here):
  - Input: a target directory path (CLI arg).
  - Output: copies `demo-vault-seeded/notes/**` to the target, runs `git init --initial-branch=main`, replays the commit timeline (substituting revision 1 / 2 content for the stance-shift note at the correct commits via the `.history/` stash files), and prints the absolute target path on stdout.
  - On each commit, set `GIT_AUTHOR_DATE` + `GIT_COMMITTER_DATE` env to the commit's ISO date, and pass `--date=<ISO>` to `git commit`. Use `git -c user.email=demo@vaultnexus -c user.name=Demo` to avoid touching the host's git config.
- [ ] **Step 2:** Implement. Use `node:fs` for copy + `child_process.execFileSync` for git ops. Keep the script under ~120 LOC. **Use `execFile` (not `exec`)** — same security stance as Plan 13.
- [ ] **Step 3:** Add to `package.json` scripts:
  ```json
  "seed:demo": "tsx scripts/seed-demo-vault.ts"
  ```
- [ ] **Step 4:** Sanity-check: run `pnpm seed:demo /tmp/vn-demo-$$` manually; cd into the output; `git log --oneline | wc -l` ≥ 14; `git log -- productivity/gtd-effectiveness.md` shows 3 entries; `head` of the file matches revision 3 content. Optional — the formal test in Task 3 is authoritative.

---

## Task 3 — Test the seeder + E2E against existing tools

**Files:** Create `test/scripts/seed-demo-vault.test.ts`.

- [ ] **Step 1: Failing test** — call the seeder against a `mkdtempSync` target. Then assert:
  - The target dir exists + contains `notes/productivity/index.md` + ~29 other `.md` files (use a glob + count).
  - `git -C <target> rev-parse HEAD` returns a valid SHA.
  - `git -C <target> log --oneline | wc -l` ≥ 14.
  - `noteRevisions(target, 'notes/productivity/gtd-effectiveness.md')` (from `src/daemon/git-history.ts`) returns **exactly 3** revisions in descending commit-date order; the oldest is dated `2024-03-15T*`, newest `2024-10-22T*`.
  - For each of the 3 revisions, `noteContentAt(target, sha, 'notes/productivity/gtd-effectiveness.md')` returns content whose **conviction-lexicon density** (count of strong-assertion words like "only", "always", "never", "essential", "useless", "must" — pick a 6-word lexicon) is **strictly increasing** r1 < r2 < r3. This bakes the canonical drift fixture for Plan 15.
  - At least one note (e.g. `decisions/ai-capabilities-2027.md`) has frontmatter `forecast` parseable via gray-matter.
- [ ] **Step 2:** Run all the test assertions. If any fails, fix the content authoring OR the seeder until green.
- [ ] **Step 3: E2E roundtrip** — same test file, separate `describe`: build a `VaultIndex` (FakeEmbedder is fine — wiring test only), index every `.md` under `<target>/notes/`, call `index.history('notes/productivity/gtd-effectiveness.md')`, assert it returns the 3 revisions. Confirms the seeded vault is indexable + history-walkable end-to-end through the MCP-facing surface.

---

## Task 4 — Verification + final commit

- [ ] **Step 1:** Run `pnpm typecheck` — 0 errors.
- [ ] **Step 2:** Run `pnpm test` — all green; total test count ≥ 150 + ~5 new = ~155.
- [ ] **Step 3:** Run `pnpm build` — clean.
- [ ] **Step 4:** Confirm `demo-vault-seeded/` is committed (`git ls-files demo-vault-seeded | wc -l` ≈ 30) and `scripts/seed-demo-vault.ts` is committed.
- [ ] **Step 5:** Confirm `git log master..HEAD --pretty='%h %an <%ae>'` shows every commit authored as `Roger French <merihmengisteab@gmail.com>`. No `hunchom`, no `Claude`, no other identities.
- [ ] **Step 6:** Confirm `git log master..HEAD --stat | grep '.claude/'` is empty.

---

## Verification before completion

- [ ] `pnpm test` — all green, ~155 tests.
- [ ] `pnpm typecheck` — zero errors.
- [ ] `pnpm build` — clean.
- [ ] **No new deps added.** `child_process` is stdlib.
- [ ] Caveman-ULTRA on code comments. Demo-vault content is **realistic English prose**, not caveman.
- [ ] No `Claude` / `Anthropic` / `Co-Authored-By` / `noreply@anthropic` strings in any new or modified file (the spec doc itself has its rule-checklist line — that's fine).
- [ ] Each task committed atomically on `feat/seeded-demo-vault` w/ author `Roger French <merihmengisteab@gmail.com>`.
- [ ] **Do NOT rewrite history (no rebase / amend / reset-author).** **Do NOT `git add -A`** — use `git add <specific-paths>` for every commit.

---

## Decision log (validated-first hooks)

- **Why hand-authored vs. generator:** a stochastic generator would itself be a content-design problem (parameter choice = preference encoding); a static + readable + intentional corpus is testable on its merits, demoable to humans, and small enough to ship without scope creep. A generator can layer on top later if vault-scale tests need it.
- **Why three communities, not two or five:** Louvain on this density (sparse cross-links) should produce ≈3 communities cleanly — exercising Plan 10's `crossCommunity` flag against a known partition. Two would be too easy (one bridge); five would split tiny clusters.
- **Why the stance-shift note has a frozen wikilink set across revisions:** the future drift signal is `conviction_lexicon_slope` against `supporting_claim_count_slope`. Holding the latter flat across the three commits **isolates the conviction signal**, which is the Plan 15 fixture's purpose.
- **Why baked dates, not lived history:** reproducibility. The same `commit-timeline.json` produces the same SHAs on every machine, so tests are deterministic.
- **Why label "sample data" in the README:** concept §6 explicitly says "clearly labeled sample data and is never mixed into or indexed alongside the user's real vault." This is the labeling.
