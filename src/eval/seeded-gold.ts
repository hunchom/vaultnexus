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
    query: 'a wager I am putting in writing today about the trajectory of general-purpose research assistants over the next few years',
    targets: ['notes/decisions/ai-capabilities-2027.md'],
  },
  {
    query: 'when fast pattern recognition by an expert beats writing out a structured argument',
    targets: ['notes/decisions/intuition-vs-analysis.md'],
  },
  {
    query: 'why quick iteration through perception, framing, choice, and execution outperforms careful planning under time pressure',
    targets: ['notes/decisions/ooda-loop-fast.md'],
  },
  {
    query: 'commitment that consistent publishing cadence will grow my readership to a specific audience size by a target date',
    targets: ['notes/decisions/personal-blog-growth.md'],
  },
  {
    query: 'imagining catastrophic project failure ahead of time to surface tripwires and assumptions before launch',
    targets: ['notes/decisions/premortem-checklist.md'],
  },
  {
    query: 'looking back from older age and weighing the things I did against the things I declined',
    targets: ['notes/decisions/regret-minimization-frame.md'],
  },
  {
    query: 'expecting in-person attendance requirements at large employers to harden rather than soften over the next eighteen months',
    targets: ['notes/decisions/remote-work-future.md'],
  },
  {
    query: 'how many hours of focused effort per week translate into working fluency in a new systems language within roughly a year and a half',
    targets: ['notes/decisions/skill-acquisition-rate.md'],
  },
  {
    query: 'why money already spent should not influence whether to continue an investment, and the auction reframe that helps me stop honoring it',
    targets: ['notes/decisions/sunk-cost-trap.md'],
  },

  // ── productivity cluster (9) ───────────────────────────────────────────────
  {
    query: 'treating my schedule as something I declare rather than read, and defending named appointments against incoming requests',
    targets: ['notes/productivity/calendar-blocking.md'],
  },
  {
    query: 'how unexpectedly costly it is to jump between unrelated kinds of work and the bug rate that follows the resumption',
    targets: ['notes/productivity/context-switching-cost.md'],
  },
  {
    query: 'a ninety- to one-hundred-twenty-minute uninterrupted stretch on a single hard problem with messaging closed',
    targets: ['notes/productivity/deep-work-blocks.md'],
  },
  {
    query: 'why a periodic backwards-looking ritual is the load-bearing habit that keeps the rest of my system functioning',
    targets: ['notes/productivity/gtd-effectiveness.md'],
  },
  {
    query: 'the five-step loop of grab everything, decide what it is, sort, look back, then do — most failures come from skipping the middle steps',
    targets: ['notes/productivity/gtd-overview.md'],
  },
  {
    query: 'protecting against background dread from week-old unread messages by emptying the queue twice weekly without ritual perfectionism',
    targets: ['notes/productivity/inbox-zero-strategy.md'],
  },
  {
    query: 'why a half-hour interruption dropped into the afternoon of someone doing deep creative work destroys the whole afternoon',
    targets: ['notes/productivity/maker-vs-manager.md'],
  },
  {
    query: 'a Sunday-afternoon forty-five-minute ritual with a coffee where I process captures, walk the project list, and look ahead at the coming days',
    targets: ['notes/productivity/weekly-review-protocol.md'],
  },
  {
    query: 'why twenty-five-minute slices with five-minute pauses ultimately disrupted my hardest thinking even after fixing a starting-friction problem',
    targets: ['notes/productivity/why-i-quit-pomodoro.md'],
  },

  // ── tools cluster (8) ──────────────────────────────────────────────────────
  {
    query: 'each entry should encode one self-contained claim small enough to be linked to but big enough to stand on its own',
    targets: ['notes/tools/atomic-notes-principle.md'],
  },
  {
    query: 'the bet that storing thoughts in plain text and a human-readable convention will outlive any single application that reads them',
    targets: ['notes/tools/markdown-portability.md'],
  },
  {
    query: 'how aggressively to chop a developing thought into separate entries — too granular fragments the graph, too coarse hides connections inside paragraphs',
    targets: ['notes/tools/note-density-tradeoff.md'],
  },
  {
    query: 'choosing between typing a query to retrieve versus walking the structure to explore, and when each fits the task',
    targets: ['notes/tools/search-vs-browse.md'],
  },
  {
    query: 'why flashcard drilling is oversold for general knowledge work and only earns its keep on discrete recall like vocabulary or syntax I touch rarely',
    targets: ['notes/tools/spaced-repetition-utility.md'],
  },
  {
    query: 'starting a thin computational layer on top of my plain-text knowledge store to surface unseen connections and narrate how my positions have moved',
    targets: ['notes/tools/this-vaultnexus-experiment.md'],
  },
  {
    query: 'the single feature that pinned my long-term editor choice: writing flat files I can grep, version-control, and outlive the vendor',
    targets: ['notes/tools/why-obsidian.md'],
  },
  {
    query: 'a directed reference inside prose carries reasoning, while a category label only buckets — they are not interchangeable connection types',
    targets: ['notes/tools/wikilinks-vs-tags.md'],
  },
];
