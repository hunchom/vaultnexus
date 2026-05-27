# Spaced Repetition Utility

Spaced repetition systems — Anki, SuperMemo, and the rest — are oversold for general note-taking and underused for the specific cases where they actually shine. I have been on both sides of this and want to write down the version I now believe.

## Where SRS is the right tool

SRS is the right tool when the information is genuinely retrieval-shaped: there is a question, there is a discrete correct answer, and the value of being able to answer the question without consulting a reference is high. Vocabulary in a new language is the canonical example. Medical school facts. Chess opening lines. Programming-language syntax for a language you write occasionally but not daily.

In these cases the cost of forgetting is real (you cannot fluently produce the language, you cannot recognise the chess line) and the SRS amortises the rehearsal cost so the retention curve stays flat instead of decaying.

## Where SRS is the wrong tool

SRS is the wrong tool for *understanding*. If the value of the knowledge is in connecting it to other knowledge, in synthesising arguments from it, in being able to reason about it — none of that is the rehearsal of a discrete answer. Trying to SRS your way to understanding produces flash-card-shaped knowledge: brittle, decontextualised, and incapable of being recombined.

The clearest test: would I be content to be able to recite the answer in the abstract, without being able to use the underlying concept fluently in argument? If yes, SRS-shaped. If no, the knowledge belongs in [[atomic-notes-principle]]-style notes that get reactivated by being linked into ongoing writing, not by being drilled.

## What I actually use SRS for

A small Anki deck for the specific technical syntax I touch infrequently — Rust borrow-checker patterns that I forget between Rust projects, regex syntax for languages I drop in and out of. The deck is maybe two hundred cards. I would not extend it much further; the maintenance cost rises faster than linearly with deck size.

## The opportunity cost critique

Time spent reviewing flashcards is time not spent reading new material or doing project work. For most knowledge workers, the marginal returns from new exposure dominate the marginal returns from rehearsal, and the SRS evangelists tend to underweight that trade-off.
