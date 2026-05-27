---
date: 2024-12-20
---

# This VaultNexus Experiment

I am starting a project to build a second-brain layer on top of my Obsidian vault. The hypothesis is that the existing tooling — search, the graph view, manual link traversal — is necessary but insufficient to extract the value the vault is supposed to be storing, and that a thin computational layer on top can produce meaningful uplift without compromising the plain-text properties I care about (see [[markdown-portability]]).

## What I am building

A daemon that watches the vault, indexes it semantically as well as lexically, and exposes a small set of operations that the existing tooling cannot do well:

- Cross-note convergence: "which notes are saying similar things without being explicitly linked?" The link graph encodes what I have already noticed; the convergence signal is supposed to surface what I have not yet noticed.
- Cited reasoning: given a question, walk the link graph and produce a chain of supporting notes with citations back to the source. This is the [[atomic-notes-principle]] payoff — atomic notes are useful as citation units in a way that essay-shaped notes are not.
- Belief-drift narration: when a note has been edited multiple times, surface how the claim has shifted. The canonical fixture for this is my own [[gtd-effectiveness]] note, where my position has measurably hardened over three commits. The system should be able to narrate that shift back to me when I revisit.

## Design constraints

The plain-text vault is the source of truth. The index is derived data and can be regenerated. No proprietary database, no cloud dependency, no lock-in.

The system is single-player. I am not designing for collaboration or sharing. This simplifies a lot of decisions; if those constraints loosen later, they will be a separate project.

## Why I am writing this note now

I want to mark, in the vault itself, that the system is starting and what I am hoping to learn from it. The vault is the substrate for the experiment, and the experiment is going to be partly about the vault. Some recursion is fine and probably appropriate.

## What I will know in a year

By December 2025, I will know whether the convergence signal surfaces things I would not have found on my own, and whether the cited-reasoning output actually changes how I make decisions. Both are testable; both are honest tests.
