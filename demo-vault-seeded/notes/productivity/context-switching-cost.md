# Context Switching Cost

The folk wisdom is that context switching is expensive. The folk wisdom is correct, and the cost is roughly an order of magnitude larger than people self-report. Here is the version of the receipts I have collected for myself, with the caveat that this is one person's experience, not a meta-analysis.

## The bare numbers

A reset between two unrelated working contexts — say, writing a design document and then triaging a bug report — costs me somewhere between fifteen and twenty-five minutes. That number is not the time to "get back to where I was" in the sense of remembering what I was doing. It is the time to be back at the cognitive depth I was at before the switch. The first ten minutes of resumed work are reliably worse than the work I was doing before the interruption.

This is consistent with what people report in studies, but more importantly, it is consistent with my own honest measurement. I started tracking it after I noticed that "I'll just answer this one email" mid-block would somehow eat the next forty minutes.

## What the cost actually buys

The cost is not just the resumption time. It also buys:
- A small but real degradation in the quality of the resumed work. Bugs introduced after an interruption are over-represented in my git blame.
- A measurable increase in subjective fatigue at the end of the day. Days with three or more unplanned interruptions feel disproportionately worse than days with one or two.
- An undermining of the morning's deep-work block, which is the most productive ninety minutes of my day. See [[deep-work-blocks]].

## What I do about it

I batch. I treat shallow work as a thing that happens between deep blocks, not during them. Notifications are off during blocks; the calendar block itself is treated as a meeting with myself. When I capture interruptions properly — see the [[gtd-overview]] capture habit — the urge to context-switch reliably weakens, because the captured item stops nagging.

The wikilink-style capture I borrowed from [[atomic-notes-principle]] helps here too: writing a one-line idea down is cheap enough that the interruption-to-capture loop closes in under thirty seconds and I am back in the block.
