# Actor-perspective Jev decisions (`journal_v4`)

Jev decides as the acting player using that player's private facts, beliefs, role and win condition.
Public proof is not a prerequisite for using private knowledge. The player LLM owns reflection and
freely chooses speech content; its proposed preferences inform Jev without becoming forced actions.
This applies to every seat and role.

Each mandatory journal update also returns a current `decisionBrief`:

- `action`: current evidence, private certainty versus unverified claims, alternatives, intentions
  and deception; maximum 4,000 characters.
- `attention`: whom the player wants to hear and why, unanswered accusations, novelty, repetition
  and speaking urgency; maximum 3,000 characters.

Both are free text and refresh even when the long journal is unchanged. The application stamps the
owner and a SHA-256 revision of all authorized meaningful evidence IDs, before context demotion.
Another player's brief, a missing brief, or a stale revision cannot be used. New speech, own
inspection results, resolved votes (including no elimination), deaths, role reveals and
announcements trigger reflection. Phase changes and pack points alone do not: current legal state
and latest authorized pack points are delivered directly. New v4 reflection events store a
high-water event sequence; archived v2/v3 source-ID lists remain readable.

Votes and night choices receive only the action brief; auctions receive only the attention brief.
Own inspections and published ballots are distinct from the brief's inferences. Choices describe
actions, retain stable handle-to-target mappings, and include neutral “Abstain from voting.” No vote
question carries listening instructions. Pack pointing retains simultaneous openings and sequential
followups. Sealed ballots remain private until resolution.

The aggregate journal budget includes prose and the current brief. Jev/v4 requires 16,000 estimated
tokens: this accommodates maximum briefs even with worst-case JSON escaping and leaves prose
headroom. Smaller budgets fail configuration validation before a game starts. LLM-only and archived
workflows keep their existing budget rules. Compaction changes prose only, preserving the brief,
owner and revision exactly. Speech carries null memory fields.

Reflection and speech share the versioned API envelope. The journal revision belongs only to a
Jev/v4 private decision context: it is stripped from the frozen public reference and cache key.
Changes to speech or private evidence do not invalidate the behavior/rules cache prefix. Public
evidence and the player's private input still change when appropriate.

## Bounded semantic handling and operator recovery

Transport/schema validity and semantic assessment are separate. The narrow guard
`verified_last_wolf_ballot_v1` applies when the player's terminal objective is eliminating all
wolves, public counts and revealed deaths establish one remaining wolf, and their own verified
inspection identifies that legal target. An abstention or another target triggers one Jev
reconsideration containing the contradiction and original distribution. Ambiguous role names across
alignments disable this proof; same-named versions are counted once per public role count.

A persistent contradiction pauses before committing. The assessment and checkpoint are saved
atomically. With a one-call episode budget, the pause explicitly says reconsideration is pending;
resume completes that one review. A completed, rejected review cannot be retried indefinitely by
resuming.

After inspecting the exact final receipt, an operator can acknowledge the anomaly. This commits
**Jev's final recorded ballot**, including abstention, with a private operator event and note. It
makes no model call and does not substitute a target. The game remains paused until separately
resumed. Changed evidence, epoch, journal version, legal state or a missing validated receipt
prevents acknowledgment. Repeating a successful acknowledgment is idempotent.

```bash
npm run pilot -- --db /native/game.db --game GAME_ID \
  --acknowledge-semantic DECISION_ID \
  --operator-note 'Reviewed the final Jev receipt; retain this anomaly'

# Resume separately after acknowledgment.
npm run pilot -- --db /native/game.db --game GAME_ID --resume
```

The same control is available with `POST /api/v1/games/GAME_ID/control`:

```json
{
  "action": "acknowledge_semantic_anomaly",
  "decisionId": "DECISION_ID",
  "note": "Reviewed the final Jev receipt; retain this anomaly"
}
```

Low confidence alone does not establish bad strategy. This guard does not block uncertain village
abstention, wolf deception, or general protection/inspection choices. It also **does not catch every
conflict between a brief and a fact**: the evaluation below retains one such failure outside the
terminal-wolf case. No broad accuracy guarantee is claimed.

Private `decision.semantic_assessed` events retain the rule, issues, attempt ID and transport
validity only where the guard applies. Scheduling decisions do not generate inapplicable assessment
events. Raw requests, responses, model versions, usage and latency remain in attempt records; public
views and other seats cannot read them. Jev returns distributions, not a prose explanation.

## Evaluation and limits

The [initial eight-case receipts](ACTOR_EVALUATION.json) are retained as historical evidence, **not
a validated accuracy benchmark**. Most authored briefs explicitly gave the intended action, so
copying the preference could score 8/8. The wolf and inspection fixtures also contained
inconsistencies; the current generator corrects those. Those corrections do not retroactively repair
the original receipts. Their `retries: 0` and `addedLlmCalls: 0` fields were fixed by harness
construction, not independently measured.

The original 68% input reduction (23,425 to 7,463 tokens) depended on roughly 8 KB of repetitive
padded journal text per fixture. It is not a production-wide saving. Shorter journals reduce the
benefit; near the 16k journal ceiling it can grow. The original 3,057 versus 2,959 ms comparison
does not establish a latency improvement. Additional output for two 150–300-word summaries on each
reflection was not measured by that experiment.

Four new cases were authored after the original prompt freeze and both arms were run once,
preserving all outcomes. These are post-review validation cases, not an independent population
benchmark. Both used Jev 1.13.0; prompts were not retuned after the results.

| Case                                                           | Archived v3        | Revised v4                     |
| -------------------------------------------------------------- | ------------------ | ------------------------------ |
| Own result identifies last wolf; brief leans abstain           | Abstained: failed  | Voted wolf: passed             |
| Outside endgame; brief prefers an actor-cleared villager       | Abstained: passed  | Voted cleared villager: failed |
| No stated preference; own result identifies last wolf          | Abstained: failed  | Voted wolf: passed             |
| Repeated public doubt; private wolf fact appears once in brief | Voted wolf: passed | Voted wolf: passed             |

That is 2/4 versus 3/4 on these cases. The three v4 endgame ballots passed the live guard on the
first attempt; no reconsideration was needed in this sample. Regression tests separately exercise
initial contradiction, corrected reconsideration, persistent rejection, interruption and explicit
acknowledgment. Four calls per arm used 3,845 versus 3,426 input tokens (about 11% less) and 1,491
versus 1,489 ms. These short-journal cases demonstrate why the earlier 68% should not be
generalized.

One actual `gpt-6-luna`/`xhigh` reflection used the production request builder, API provider,
response validation and journal application on the doubt-heavy synthetic state, then passed its
generated brief to the real Jev decision executor. It used 2,596 input tokens, 1,222 output tokens
(including 425 reasoning tokens), 0 cached input tokens and 2,203 cache-write input tokens in 14,153
ms. The action/attention briefs were 1,117/1,098 characters, and Jev committed the ballot. This is
total reflection usage, **not incremental brief cost**; there is no matched v3 reflection or
full-game cost estimate.

[Complete new synthetic inputs, exact distributions, usage, checkpoints and Luna receipt](ACTOR_HOLDOUT_EVALUATION.json).
No original game data was loaded or changed.

```bash
npm test -- packages/simulator/src/actor-regressions.test.ts
npm run jev:actor-eval                         # Original fixture family, offline
npx tsx scripts/jev-actor-holdout.ts            # New cases, offline
npx tsx scripts/jev-actor-holdout.ts --live \
  --out /native/new-evaluation-directory       # Both arms once
npx tsx scripts/jev-actor-holdout.ts --live --luna-only \
  --out /native/new-reflection-directory       # One paid reflection + Jev vote
```

Live runs require configured credentials. All outcomes are saved, including rubric failures.
`scripts/jev-actor-report.ts --holdouts REPORT.json --reflection REPORT.json --out NEW_REPORT.json`
combines the receipts without model calls. Harness repetitions are labeled “by construction”;
production attempt and reconsideration counts come from the stored records.
