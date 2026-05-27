# Internal design specs

This directory holds the design notes + per-plan implementation notes that drove the build. They're public because the project is — not because they're polished docs.

If you're reading the code and want to know *why* a piece exists the way it does, the relevant plan in `plans/` usually has the answer. If you're just trying to use VaultNexus, read [the main README](../../README.md) and [the getting-started guide](../GETTING_STARTED.md) instead.

## Layout

- `2026-05-23-vaultnexus-concept.md` — earliest framing: the problem, the wedge, the hypothesis.
- `2026-05-23-vaultnexus-design.md` — system-level design that the plans implement.
- `pipeline.md` — the retrieval pipeline in detail.
- `diagrams/` — DOT sources for architecture diagrams.
- `implementation-notes.md` — running notes from build.
- `drift-lexicon.md` — drift detection vocabulary.
- `plans/` — one file per build plan (Plans 01–N). Each plan has its own scope, acceptance criteria, and rule-compliance checklist.

## Format

Plans follow a rough template:
- **Goal** — one sentence.
- **Scope** — what's in, what's out.
- **Approach** — the design choice and why.
- **Acceptance** — observable conditions that say "done".
- **Checklist** — rule + hygiene + testing items.

Some plans cite earlier plans by number. The order is roughly chronological but not strictly linear — drift / fixer plans land between feature plans.
