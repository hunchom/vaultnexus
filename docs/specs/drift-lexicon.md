# Drift Lexicon v1 — Pre-Registered Artifact

This document is the **frozen v1 lexicon** for the confirmation-drift signal described in concept §10.9. It is the input to the precision-gate spike — the make-or-break experiment for the durability bet. Once §10.9a (lexicon-perturbation stability) runs against a labeled corpus, any change to the lists below counts as a **new signal version** (v2), gated by its own re-validation. Pre-registration is the safeguard against post-hoc tuning to the labeled set.

## Scoring rule

`conviction(text) = (assertion_count - hedge_count) / max(1, total_word_count)`

- Case-insensitive.
- Word-bounded (`\b…\b`).
- Counted in the note **body** (after frontmatter strip).
- Multi-word terms (e.g. `kind of`) are matched as phrases, **not** as their constituent words. A single occurrence of `kind of` adds one to the hedge count, not two; and the single-word `kind` is **not** in the lexicon, so phrase-membership does not double-count.
- Empty input → score `0`.
- Range in practice: roughly `[-0.05, +0.10]`.

## Hedge words (14)

```
maybe
perhaps
might
could
seems
appears
possibly
somewhat
tentatively
arguably
roughly
apparently
probably
kind of
```

## Strong-assertion words (12)

```
definitely
clearly
obviously
certainly
must
always
never
only
every
essential
useless
impossible
```

## Design notes

- **Why no `should` / `may` / `can`?** They are too polysemous in normative prose ("the system should handle X" vs "you should try X"). Including them would push the false-positive rate on technical notes too high to be useful.
- **Why no `never` / `always` as hedges?** They are intensifiers of negative/positive assertions, not hedges — the speaker is committing harder, not softer.
- **Why no domain stop-words?** The lexicon is domain-agnostic by design; the §10.9 spike measures whether it generalizes, and adding domain terms would defeat that measurement.
- **Why English-only?** The signal's first validation target is English-language knowledge-worker vaults (per the concept's assumption). Multilingual lexicons are gated on a separate plan.

## Versioning

This lexicon is **v1**. Edits to the lists above require:
1. A new spec document (`drift-lexicon-v2.md`, etc.).
2. A re-run of §10.9 (precision) and §10.9a (perturbation-stability) on the labeled corpus.
3. A separate plan documenting the change rationale.

Edits to the **scoring rule** (denominator, multi-word handling, frontmatter-strip behavior) similarly require a version bump, because they change the score's meaning even when the word lists are unchanged.
