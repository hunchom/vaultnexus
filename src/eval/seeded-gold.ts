/** Plan 22 — paraphrase gold queries over the Plan 14 seeded demo vault.
 *
 * 26 queries across 3 wikilink-coherent communities (decisions / productivity / tools).
 * Each query paraphrases its target note's core claim WITHOUT sharing distinctive
 * vocabulary with the note — the vector half of the retriever must do the lift;
 * FTS5 keyword overlap alone should not retrieve the target. Plan 09 reviewer rule:
 * max shared content-word per query ≤ 1, OR target-intersection / query-length < 0.2.
 *
 * Schema: { query, targets } where targets are notePaths relative to the seeded
 * vault root (e.g. "notes/productivity/gtd-effectiveness.md"). Multi-target queries
 * use any-of semantics: any one target in top-K counts as a hit.
 */

export interface GoldQuery {
  query: string;
  targets: string[];
}

export const SEEDED_GOLD_QUERIES: GoldQuery[] = [
  // ── decisions cluster (9) ──────────────────────────────────────────────────
  {
    query: 'a bookmark I want my future self to grade about how capable autonomous task-doing software might become for knowledge jobs by late this decade',
    targets: ['notes/decisions/ai-capabilities-2027.md'],
  },
  {
    query: 'when accumulated tacit experience should override the impulse to lay every step out explicitly before acting',
    targets: ['notes/decisions/intuition-vs-analysis.md'],
  },
  {
    query: 'why rapidly cycling between noticing, sense-making, choosing, and moving wins over deliberate plan-refinement when adversaries are also adapting',
    targets: ['notes/decisions/ooda-loop-fast.md'],
  },
  {
    query: 'a written-down bet linking how often I post longform pieces over a two-year horizon to crossing a specific traffic threshold on my own writing site',
    targets: ['notes/decisions/personal-blog-growth.md'],
  },
  {
    query: 'rehearsing the headline of a disaster post-mortem before the work even begins so warning signs and stop-conditions get named upfront',
    targets: ['notes/decisions/premortem-checklist.md'],
  },
  {
    query: 'the Bezos heuristic of imagining oneself elderly looking backward, biasing toward attempt rather than abstain when the call is genuinely close',
    targets: ['notes/decisions/regret-minimization-frame.md'],
  },
  {
    query: 'why I expect the post-pandemic flexible-location norm to keep tightening into hybrid mandates by the middle of next year',
    targets: ['notes/decisions/remote-work-future.md'],
  },
  {
    query: 'estimating the calendar time and weekly investment needed to reach intermediate competence in Rust starting from zero',
    targets: ['notes/decisions/skill-acquisition-rate.md'],
  },
  {
    query: 'the pitfall of letting irretrievable prior outlay shape ongoing allocation; cured by mentally re-tendering the same hours or dollars among today\'s competing uses as if no history existed',
    targets: ['notes/decisions/sunk-cost-trap.md'],
  },

  // ── productivity cluster (9) ───────────────────────────────────────────────
  {
    query: 'using a schedule as an active authoring surface; intentions go on the grid in advance so any inbound interruption has to evict an existing commitment to land',
    targets: ['notes/productivity/calendar-blocking.md'],
  },
  {
    query: 'the hidden tax of swapping between dissimilar tasks: extra minutes to refill working memory and elevated mistakes in the code touched right after',
    targets: ['notes/productivity/context-switching-cost.md'],
  },
  {
    query: 'protected window roughly two hours long for one demanding cognitive task with notifications silenced and a clear exit goal',
    targets: ['notes/productivity/deep-work-blocks.md'],
  },
  {
    query: 'arguing that my whole personal operating system hinges on the recurring retrospective and falls apart whenever I omit it',
    targets: ['notes/productivity/gtd-effectiveness.md'],
  },
  {
    query: 'David Allen\'s canonical method for managing knowledge tasks — common dismissals usually trace to executing only a couple of phases while blaming the methodology, when the dropped stages are exactly what would have caught the breakage',
    targets: ['notes/productivity/gtd-overview.md'],
  },
  {
    query: 'a relaxed posture toward digital-message-pile-management — biweekly drain sessions, no obsession over a clean state, just stopping any item from lingering past a couple of sunsets and morphing into low-grade anxiety',
    targets: ['notes/productivity/inbox-zero-strategy.md'],
  },
  {
    query: 'two operating modes for a working week — one that absorbs short conversations cheaply and one that needs uninterrupted afternoons or its output collapses far beyond the conversation length',
    targets: ['notes/productivity/maker-vs-manager.md'],
  },
  {
    query: 'my standing weekend appointment with myself where I clear pending captures, audit each active commitment, and preview the upcoming seven days',
    targets: ['notes/productivity/weekly-review-protocol.md'],
  },
  {
    query: 'abandoning the tomato-shaped countdown gadget after half a year — the enforced cadence kept severing whichever delicate thread of reasoning I was chasing',
    targets: ['notes/productivity/why-i-quit-pomodoro.md'],
  },

  // ── tools cluster (8) ──────────────────────────────────────────────────────
  {
    query: 'each Zettel should hold exactly one indecomposable thesis — concise enough to cite, fat enough to argue with as an independent unit',
    targets: ['notes/tools/atomic-notes-principle.md'],
  },
  {
    query: 'betting that storing my writing as a tiny conventional pseudo-code legible by any unix tool will outlive whatever shiny editor is currently fashionable',
    targets: ['notes/tools/markdown-portability.md'],
  },
  {
    query: 'calibrating how coarsely or finely to slice an evolving train of reasoning into separate files — over-shred and the resulting web is useless rubble, under-shred and the cross-concept seams get buried in running prose',
    targets: ['notes/tools/note-density-tradeoff.md'],
  },
  {
    query: 'two retrieval strategies inside a knowledge store — typing exact remembered fragments to pull a passage versus surfing outward from a familiar anchor when the destination is hazy',
    targets: ['notes/tools/search-vs-browse.md'],
  },
  {
    query: 'the cult around timed-flashcard apps oversells their payoff for deep conceptual work; they really shine only for niche lookup-style recall I rarely encounter',
    targets: ['notes/tools/spaced-repetition-utility.md'],
  },
  {
    query: 'kicking off the experimental tool that augments my flat-file repository: hidden semantic overlaps among entries, traceable reasoning chains for questions, and a retelling of how my expressed opinions have evolved over revisions',
    targets: ['notes/tools/this-vaultnexus-experiment.md'],
  },
  {
    query: 'after trying every other note-taking app on the market the one trait that settled my choice for a decade-scale commitment was that my data on disk stays accessible to every commandline utility I already know',
    targets: ['notes/tools/why-obsidian.md'],
  },
  {
    query: 'an inline cross-reference embedded mid-sentence is doing different cognitive work than a hashtag classifier; swapping one for the other surrenders the why',
    targets: ['notes/tools/wikilinks-vs-tags.md'],
  },
];
