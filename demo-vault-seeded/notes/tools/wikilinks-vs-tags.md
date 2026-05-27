# Wikilinks vs Tags

Both wikilinks and tags exist to connect notes, but they connect them differently and the right intuition is that they are not substitutes — they answer different questions.

## What wikilinks do well

A wikilink is a *directed claim*: this note refers to that note for a specific reason. The link is one-to-one and explicit. When I link `[[atomic-notes-principle]]` from inside a paragraph, I am asserting that the paragraph is making a claim that the linked note supports, qualifies, or extends. The link carries information about *why*, encoded by where in the prose it appears.

This is the load-bearing kind of connection. It is what makes the link graph reason-able rather than just navigable.

## What tags do well

A tag is an *undirected category*: this note belongs to that bucket. Tags are good for slicing the vault by orthogonal axes — `#question`, `#in-progress`, `#review-due` — that the topic hierarchy does not capture. They function as cross-cutting metadata layered on top of the link graph.

The distinguishing test: would you want to navigate from the tag to the notes, but never from the notes to the tag in prose? If yes, it is genuinely tag-shaped. If you want to point at the concept from inside another note's argument, it should be a wikilink, even if it feels more abstract than usual.

## What I do operationally

I am wikilink-dominant. Most of my organisational weight rides on the link graph. Tags are reserved for workflow status (`#in-progress`, `#parked`, `#archive`) and for one or two cross-cutting concepts where I genuinely want category-style retrieval rather than reasoning-style traversal.

The mistake I made early on was using tags for what should have been wikilinks. Tagging a note `#productivity` when I should have linked `[[productivity/index]]` from inside the prose loses the *why* — the tag tells me the note belongs to a bucket, but not what the note is claiming about the bucket.

## The signal-to-noise problem

Tags rot faster than links. A vault with thirty tags is manageable; a vault with three hundred is unsearchable. Wikilinks scale better because each one carries its own contextual reason for existing, while tag systems require disciplined pruning that I never seem to actually do.
