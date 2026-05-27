# Premortem Checklist

A premortem is the inverse of a postmortem. Before launching, you imagine the project has failed catastrophically a year from now and you write the story of how. It is one of the most reliably useful structured thinking tools I have used, and it costs about ninety minutes.

## The protocol

I run it solo or with a small group, depending on the project. The script is roughly:

1. State the project and the success criterion in one sentence.
2. Fast-forward to one year from launch. The project has failed visibly. What does the failure look like? Write the headline.
3. Walk backwards through the most plausible failure cause. Not the most likely — the most plausible. Likelihood is the next step.
4. For each plausible failure mode, ask: is there a leading indicator I could watch for, and what would I do if I saw it?
5. Rank the failure modes by a rough "cost × probability" estimate.
6. For the top three, define a tripwire — a metric or observation that triggers a response — and write the response down before launch.

## Why it works

It exploits an asymmetry in human reasoning: predicting future failure is easier than predicting future success, because failure is concrete (we have many vivid examples of failed projects) while success is vague. The premortem gives the planning brain a more reliable target to aim at than "what could go wrong" does in the abstract.

It also sidesteps the social cost of voicing doubt. In a regular planning meeting, "what could go wrong" attracts the label of being negative. In a premortem, voicing doubt is the assignment, so the doubt comes out.

## What I have learned from running it

The failure modes I generate in a premortem are almost never the ones that actually kill the project, but the *act of generating them* shifts how I notice anomalies during execution. It is closer to a vaccination than a forecast.

The next checkpoint after the premortem ties into my regular [[weekly-review-protocol]] — I revisit the premortem tripwires during the project-review step, so the prediction stays live.
