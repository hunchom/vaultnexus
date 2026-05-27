# Markdown Portability

Markdown's biggest single feature is that it is not a feature — it is a convention. The files are plain text, the syntax is human-readable, and any tool that can read text can read the notes. The bet I am making by keeping my vault in markdown is that this property will be more valuable than any individual feature a richer format could offer.

## The portability test

The test I run on any notes tool I consider seriously: if the tool disappeared tomorrow, what would I have left? With markdown the answer is: every note, intact, in a directory I can open with anything. With a database-backed proprietary format, the answer ranges from "an export I have to coax out" to "nothing." That gap is the whole argument.

## What markdown gives up

Markdown does give things up. Rich tables are awkward. Embedded media is by-reference rather than inline. Complex layouts are not possible without escaping into HTML. For my use case — primarily prose with occasional code and lightweight structure — none of these are dealbreakers, but they are real costs that other people's use cases might amplify.

## What markdown gains, beyond portability

Markdown's plain-text nature unlocks the entire Unix toolchain. I can grep across thousands of notes in milliseconds. I can write a script to rename all references to a moved note. I can put the vault in git and get a history backbone that any future tool can read.

This last property is what makes the vault a substrate for a system like [[this-vaultnexus-experiment]]. A proprietary database would need a custom indexer; the markdown vault accepts indexers, search engines, vector stores, link analysers, and any future tool I have not yet imagined, with zero coordination.

## The standardisation worry

The honest critique of "markdown" is that there are many slightly-incompatible dialects. Obsidian's wikilink syntax, frontmatter conventions, embed syntax — these are not in CommonMark. The escape hatch is that the non-portable extras degrade gracefully: read in a non-Obsidian tool, the wikilinks appear as plain-text double-bracket spans rather than rendered links. The information is preserved even when the rendering is not.
