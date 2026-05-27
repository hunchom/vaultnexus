# Search vs Browse

Two strategies for finding things in a notes vault: search (type query, get hits) and browse (walk the structure, find by navigation). Most tooling discussions treat these as alternatives. They are complements with different failure modes, and the question is which one to default to.

## When search wins

Search wins when I know what I am looking for and can name it. If I can summon the rough phrase a note contains, full-text search is faster than any browse path I could construct. The keystroke-to-result latency is short, and the search index does not care about my filing decisions from three years ago.

This is the case most often. The default failure mode of browse — getting lost in folder taxonomy I no longer remember — is more painful than the default failure mode of search.

## When browse wins

Browse wins when I do not know what I am looking for. The classic case: I want to refresh my memory on what I have written about a topic, without a specific note in mind. Browse lets me discover notes I had forgotten existed; search would have required me to remember enough to type a query.

Browse also wins for "what is adjacent to this note" exploration. Following [[wikilinks-vs-tags]]-style links from a known starting note is browsing, and the link graph is the substrate that makes it productive.

## What I default to

I default to search for retrieval, browse for exploration. Practically this means I start with a search box for ~80% of lookups, and switch to walking the link graph for the ~20% that are open-ended.

A meta-pattern that has worked: the index notes in each topic cluster are explicitly browse-shaped. They exist so I can land on them, then radiate outward through links rather than diving into the file tree. The index notes are a deliberate compromise between the folder pole and the pure-graph pole discussed in [[zettelkasten-vs-folders]].

## The tool implication

A notes tool that is bad at search is a notes tool I cannot trust for long-term scale. Search performance over thousands of notes is a hard requirement. A notes tool that is bad at link-graph traversal is one I will outgrow as soon as the vault crosses a threshold where I can no longer hold the structure in working memory.
