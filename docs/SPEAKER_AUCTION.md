# The speaker auction

The auction allocates attention using two perspectives: the candidate's desire to speak and other
players' desire to hear that candidate. It is a scheduling mechanism, not a correctness vote on what
the speaker will say.

## From evidence to a speaking slot

1. Living players reflect on new authorized evidence. Their LLM updates the private journal and
   current attention brief, including unanswered accusations and whom they want to hear from.
2. The scheduler freezes eligible candidates, listeners, response dockets, and the public revision.
3. Jev scores each submitted player's urgency and listening preferences using that player's context.
   A candidate can decline to speak. Listening ratings do not reveal another player's private notes.
4. The scheduler ranks willing candidates. Only the winner's LLM generates a full speech, freely
   choosing its content. The resulting public speech triggers another reflection cycle.

The last remaining opening candidate is a shortcut: only that candidate submits a bid. With no other
submitted listener ratings, the equal-weight fallback applies. Concurrency changes execution
latency, not the frozen inputs or deterministic ranking.

## Scoring

For each willing, eligible candidate `s`:

```text
interest(s) = mean of submitted ratings for s, excluding s's own rating
weight(s)   = interest(s) / sum of interest across willing candidates
priority(s) = (speakerBias + urge(s)) × weight(s)
```

Missing ratings are omitted from the mean. No ratings means zero raw interest. If the sum of raw
interest is zero, each willing candidate receives weight `1 / candidateCount`. Highest priority
wins. Equal priorities are resolved by seeded tie order, then player ID.

Urgency and listening ratings lie between 0 and 1. With the default bias `0.25` and two willing
candidates:

| Candidate | Urge | Mean listener interest | Normalized interest | Priority |
| --------- | ---: | ---------------------: | ------------------: | -------: |
| A         |  1.0 |                   0.25 |                0.25 |   0.3125 |
| B         |  0.5 |                   0.75 |                0.75 |   0.5625 |

B speaks despite lower urgency because the listeners want to hear B more. Ratings are model
judgments, not calibrated probabilities. There is no explicit account of accumulated social capital:
repetition can affect later attention briefs and ratings, which in turn affect later auctions.

## Eligibility and response opportunities

Opening rounds cover living players who have not yet completed an opening opportunity. Declining
also completes that opportunity; the system does not force everyone to deliver an opening speech.

Follow-up rounds exclude the most recent speaker and players at their individual follow-up limit. If
response dockets are outstanding, candidates are restricted to eligible players who owe a response.
Dockets are built from formal accusations/challenges and name mentions in non-closing speeches; this
is a practical response mechanism, not a perfect semantic accusation detector.

Discussion can end when enough living players report readiness at the current public revision and no
response is owed. A total follow-up cap or exhaustion of candidates also ends the auction stage.
Outstanding dockets then receive a closing-response stage before voting. Closing responses have
restricted scope, including no new accusations. These limits bound discussion; they do not guarantee
that every accusation receives a persuasive answer.

## What to inspect

Moderator audit events include the submitted intents, raw and normalized listening scores, priority,
selected player, and declined candidates. The selected speaker is public; private bids and journals
are not public evidence. To evaluate the mechanism, inspect whose testimony was sought, whether new
accusations produced response opportunities, and whether repetitive speakers lost listener interest.
A win or loss alone does not establish scheduling quality.

Implementation: [`scheduler-v2.ts`](../packages/simulator/src/scheduler-v2.ts) contains the pure
ranking and eligibility functions.
[`orchestrator-v2.ts`](../packages/simulator/src/orchestrator-v2.ts) freezes rounds, collects bids,
and commits the selected speech. The [protocol guide](PROTOCOL_V3.md) describes compatibility with
earlier auction workflows.
