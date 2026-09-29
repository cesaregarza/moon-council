# Testing the speaker auction

Test three separate questions: whether the ranking rule behaves as specified, whether model bids
reflect the participant's information and intentions, and whether feedback produces useful
conversations. A correct final puzzle answer cannot answer all three. A frozen replay cannot predict
how listeners would react to a changed speech history.

## 1. Mechanical tests: implemented, with no provider calls

`auction:replay` calls the production ranking function on recorded study auctions. It first checks
that both recorded effective and original winners, every score, peer-rating matrix, and candidate
exclusion can be reproduced. It rejects corrupted inputs and strips private records, journals,
speeches, and provider requests from the output. The four-player study format is the supported
input.

For every actor in every saved auction it independently applies:

| Intervention         | Actor's urgency | Actor's willingness | Actor's ratings of peers |
| -------------------- | --------------- | ------------------- | ------------------------ |
| `urge_only`          | 1               | Unchanged           | Unchanged                |
| `max_urgency`        | 1               | True                | Unchanged                |
| `zero_rival_ratings` | Unchanged       | Unchanged           | All zero                 |
| `max_and_zero`       | 1               | True                | All zero                 |

Other players' bids, incoming ratings of the actor, eligibility, and tie order stay fixed. All four
players' results appear in JSON; the Markdown table highlights the designated target and any
saboteur. Original bids form the baseline even when the recorded run included an urgency override.

```sh
npm run auction:replay -- --study data/one-study --out data/one-replay

# Separate studies retain separate rows and their own recorded histories.
npm run auction:replay -- \
  --study data/rambling-study \
  --study data/obstruction-study \
  --out data/paired-replay
```

The output directory must be new. Without `--out`, the command prints JSON. Inputs remain unchanged;
output includes manifest/checkpoint hashes, the frozen experiment source commit, and hashes of the
replay implementation and production ranking function. Incomplete runs retain their status and only
their observed prefixes. Zero-auction failures have missing intervention outcomes, not zero wins.

**The unit is an eligible recorded auction state, not a future conversation turn.** Counterfactual
winners do not change later eligibility, speeches, or journals. Adjacent independent replays can
select the same actor even though a real conversation would prohibit that sequence. Do not sum these
wins into a predicted floor share or treat the auctions as independent experimental replications.

### What the arithmetic permits

For nonzero total listener interest, normalization is common to all candidates, so the winning
comparison is simply `(bias + urgency) × mean peer interest`. With bias 0.25, a max-urgency actor
can beat an actor at urgency 0.5 when its incoming interest is greater than 60% of that
competitor's. Maximum urgency therefore helps without being an unconditional entitlement to speak.

A player's own outgoing ratings do not raise its own raw interest, but lowering them can reduce its
competitors' raw interest. The rule is not strategy-proof. A low rating may also be a sincere
preference; a replay measures the opportunity for manipulation, not dishonest intent.

The deterministic fixtures establish three boundaries:

- An actor with urgency 1 and interest 0.05 loses to urgency 0.2 and interest 0.9. Strong listener
  rejection can outweigh maximum urgency.
- If every listener rating is zero, the equal-weight fallback makes urgency decide. The system does
  not interpret unanimous disinterest as a requirement to stop speaking.
- With constant preferences favoring two players, those two can alternate for all twelve turns while
  the other two never speak. Previous-speaker exclusion prevents consecutive turns by one actor; it
  does not guarantee service to every participant.

Those fixtures deliberately contain no language model, speech interpretation, or reputation update.
The regular tests also cover willingness versus urgency, eligibility, tie order, ignored self
ratings, monotonic interventions, source preservation, and rejection of inconsistent saved scores.

### First replay of the chained-evidence pilot

All 48 recorded auctions from the four completed discussions reproduced exactly at source
`5aae3655b81e29c9f8a1fbb809b043f33ca8280c`. The two failed forced-urgency discussions contained no
auctions and remain missing. This replay made no model calls.

| Saved discussion                         | Actor | Eligible states | Original wins | Max urgency | Zero outgoing ratings | Both |
| ---------------------------------------- | ----- | --------------: | ------------: | ----------: | --------------------: | ---: |
| Rambling study: focused control          | Ben   |               9 |             3 |           6 |                     6 |    8 |
| Rambling study: rambler                  | Ben   |               9 |             3 |           5 |                     4 |    7 |
| Obstruction study: fresh focused control | Ben   |               9 |             3 |           7 |                     7 |    8 |
| Obstruction study: saboteur              | Ada   |               8 |             4 |           5 |                     5 |    5 |

These are separate one-turn interventions on each actor. The differences between the two fresh
controls illustrate why one conversation is insufficient to estimate a stable effect. The replay
shows that both urgency inflation and strategic outgoing ratings can alter selection; it does not
establish that either behavior would maintain these gains once peers observe changed speeches. The
failed max-urgency live conditions are still unanswered by this replay.

## 2. Bid judgment: the next isolated model test

Give Jev paired, fictional actor contexts where one relevant fact changes. Use the current
actor-perspective prompt and score rubric; preserve the rest of the wording and ordering. Record
model version, exact inputs, raw outputs, and failures. Do not retry until a desired answer appears.

| Paired contrast                                                                                           | Expected directional behavior for a cooperative actor                         |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| A private verified clue is needed now / that same clue is already public and accepted                     | Greater speaking urgency before disclosure                                    |
| Someone asks the actor a necessary question / that question has already been answered                     | Greater urgency while the answer is still needed                              |
| A peer has the missing clue / the peer has repeatedly supplied no relevant information                    | Greater desire to hear the clue holder                                        |
| A false claim is contradicted by a newly received authenticated record / no new evidence has arrived      | Greater urgency to correct with new evidence                                  |
| A contradiction needs the speaker's explanation / the same contradiction has received multiple nonanswers | Test whether repeated nonanswers reduce demand for another explanation        |
| A useful claim is concise / the same claim is surrounded by unrelated repetition                          | Preserve belief in the claim while testing the value of another speaking turn |

These are prespecified ordinal expectations, not claims that a particular numeric score is correct.
Wanting an answer must remain distinct from trusting its source. For a malicious actor, evaluate
bids against that actor's objective separately; helping the group is not the universal rubric.

Use the paired fixtures first with directly authored journals to isolate Jev. Then feed the same
underlying events through Luna's journal updater and repeat the assessment on those journals. That
separates interpretation errors from scoring errors. Include an explicit received-evidence list and
an explicitly pending event so a scheduled backup cannot be mistaken for delivered information.

`auction:bid-probe` implements a separate, bounded judgment study. Its eight pairs cover undisclosed
versus established clues, unanswered versus resolved questions, useful versus exhausted peers, a
first explanation request versus a standing refusal, received versus pending backups, concise versus
padded claims, unresolved versus independently resolved claims from a distrusted source, and
cooperative versus obstructive objectives. The concise/padded and objective contrasts are
exploratory: verbosity does not prove low next-turn value, and a malicious objective admits several
tactics. Listening is not a trust score.

Each of the sixteen fictional contexts receives one Jev bid from an authored factual journal, one
fresh Luna journal update from an independent prior journal and the actual events, and one Jev bid
from that update. Both lanes reuse `jevPrompt` from the clue-chain study, including its private
objective rubric. Luna receives the same objective-neutral concise personality in every cell. The
scored actor and peer are eligible after the fourth speech; all pairs have matching floor counts.
Only the actor's private records are present. The pending backup contains no future record values.

```sh
# First commit a clean source tree. Preparation freezes inputs and makes no calls.
npm run auction:bid-probe -- --out data/bid-probe --mode prepare

# Review manifest.json, then run the fixed batch with configured provider credentials.
npm run auction:bid-probe -- --out data/bid-probe --mode run --live

# Rebuild descriptive tables using the same fixture version; no provider calls.
npm run auction:bid-probe -- --out data/bid-probe --mode report
```

The ceiling is **48 calls: 16 Luna and 32 Jev**, two concurrent contexts, twenty minutes for the
whole batch, no application output-token ceiling. Fixed shuffled order is saved before any call. The
default models match the previous pilot: GPT-6 Luna at `xhigh` and `jev-latest`; actual returned
versions and usage are logged. A Luna failure leaves its dependent Jev observation missing while
other contexts proceed. There are no retries, replacements, or resume after uncertain interruption.
An exclusive start marker rejects a second execution in the same directory.

Preparation requires a new native-filesystem output directory and a clean committed tree. Live
execution verifies that commit, relevant source hashes, and fixture inputs. The private directory
contains the frozen manifest and prompt previews, durable attempt ledger, generated journals, raw
successful responses, partial results, and report. The normal ask-jev log retains request/error
records even when its response validator rejects an answer.

Primary comparisons use the same probability-weighted score as the study runner, normalized to 0–1.
Six pairs have a prespecified direction; two are exploratory. Differences within 0.02 are labeled
near ties for readability, not statistical equivalence. Each cell is a single observation; these are
diagnostic cases, not independent replications or a performance estimate. Journal provenance must
also be inspected directly: a sensible urgency score can coexist with a false note. This explicit
turn-four pending-status test does not recreate the previous pilot's ambiguous post-turn-six
delivery boundary.

### First paired-judgment results

The first batch completed all 48 calls in 95.49 seconds with no failures or retries, using frozen
source `f381939eaf95e72cb38e259194357c769a905bf5`. Returned models were `gpt-6-luna` and
`jev-1.13.0`. This was sixteen decision contexts, not sixteen discussions.

In each row, A is the first condition and B the second. Values are normalized probability-weighted
scores. The concise/padded and objective comparisons were exploratory; the other six expected A > B.

| Comparison (A / B)                    | Authored A | Authored B | Luna A | Luna B |
| ------------------------------------- | ---------: | ---------: | -----: | -----: |
| New clue / already public clue        |      0.782 |      0.160 |  0.758 |  0.713 |
| Unanswered / resolved question        |      0.858 |      0.315 |  0.747 |  0.620 |
| Useful / exhausted peer               |      0.915 |      0.060 |  0.943 |  0.465 |
| First request / standing refusal      |      0.797 |      0.417 |  0.723 |  0.268 |
| Delivered / pending record            |      0.863 |      0.613 |  0.752 |  0.640 |
| Concise / padded claim (exploratory)  |      0.715 |      0.590 |  0.877 |  0.755 |
| Unresolved / reported resolution      |      0.902 |      0.080 |  0.757 |  0.800 |
| Cooperative / malicious (exploratory) |      0.948 |      0.275 |  0.925 |  0.455 |

All six prespecified directions appeared with authored journals, and five with Luna journals. These
are different diagnostic cases, not independent replicates or an accuracy estimate. Reading all
sixteen generated journals identified three useful follow-up targets:

- After a clue was already public, Luna still proposed confirming it and verifying other links. The
  new-versus-public urgency gap narrowed from 0.623 to 0.045. The notes did not invent a record;
  they retained more unfinished corroboration than the authored notes.
- When Ben explicitly said he had no C record and no additional information, Luna retained his B
  ownership but omitted the exhaustion. Jev cannot recover that missing statement from the
  transcript, which is absent from its bid input. This is a plausible explanation for the higher
  listening score, requiring a separate controlled repair probe to establish causality.
- After another peer reported a resolving record, Luna accepted a provisional answer but still
  prioritized explaining Ben's conflicting account. Listening slightly increased, from 0.758 to
  0.800. The authored notes express distrust more strongly than the generic prior/event packet; this
  comparison measures continued demand, not an isolated trust effect.

The pending-backup journal correctly said no record had arrived. The delivered variant correctly
used its new private C row. Both speech-length variants retained the same relevant clue, and the
standing refusal reduced listening in both lanes. The malicious journal combined a desire to hear
the useful row with a plan to avoid helping the group; changed scores do not prove a coherent or
successful suppression strategy.

This is a snapshot journal-construction test: one update from a prior journal and four speeches, not
four successive updates. Human-authored notes and generated notes can reasonably differ in
uncertainty. The next small tests should isolate retention of explicit negative facts and the
marginal value of another confirmation before attributing these patterns to the auction arithmetic.
No live forced-urgency or alternative-scheduler comparison was added by this batch.

## Journal improvements and an allocation control

A personality assignment is a treatment instruction, not proof of the behavior produced by a
language model. To distinguish memory quality from scheduling, use two separate experiments.

### Versioned free-prose journals

`memory-v2` preserves evidence provenance, already-public versus genuinely new information, explicit
statements that a peer lacks further information, and answered/declined/superseded questions. It
asks what another turn could add to the actor's objective. An independent confirmation or
clarification can still be useful; the instruction does not require lower scores, force agreement,
or prescribe speech topics. Public claims remain claims, and pending deliveries remain pending.
Statements of exhaustion expire when new information becomes available.

The long journal remains free text. No new JSON memory schema or output-token cap is introduced.
This is an explicit study policy, separate from the full game's versioned attention brief; it does
not silently rewrite archived studies or switch the full game to an untested prompt.

```sh
# Compare two freshly generated journals on each identical actor context.
npm run auction:bid-probe -- --out data/journal-comparison --journal-comparison --mode prepare
npm run auction:bid-probe -- --out data/journal-comparison --mode run --live

# Choose this policy explicitly for a new discussion batch.
npm run auction:study -- --protocol clue-chain-v1 --journal-policy memory-v2
```

The new comparison freezes `auction-journal-comparison-v1`: sixteen contexts, two journal policies,
one Luna update followed by one Jev bid per policy, **64 calls maximum** (32 Luna, 32 Jev). Two
contexts run concurrently, policy order is balanced across A/B variants, and both start from the
same original prior notes. Twenty-minute batch deadline, no retries, no replacement calls. A failed
journal leaves its dependent score missing. `--journal-comparison` is preparation-only; execution
reads the frozen manifest. Historical manifests without `journalPolicy` retain `legacy` behavior.

Primary assessment is fidelity: retaining information limits and question status while preserving
uncertainty, provenance, and the actor's objective. Jev scores are secondary. A lower score alone is
not improvement. These are reused development cases, not a held-out benchmark or accumulated
multi-turn memory study. The manifest records the assessment rubric before any calls.

### Scripted scheduler comparison with observable memory

```sh
npm run auction:control -- --out data/auction-control
```

This command makes **zero provider calls**. It enumerates 864 deterministic cases: three conditions,
two arrival schedules, two listener signals, three schedulers, and all 24 seat/tie orders. Each
scheduler starts a fresh trajectory. Scripts disclose three necessary route links; completion means
all three are public. Facts can be delivered together at slot 1 or privately at slots 1/4/7. Agents
see their own delivered records and public speeches, never another actor's hidden record or future
arrival. Their observable-memory journals are constructed exactly, so summarization errors are
removed from this control.

- **Schedulers:** the production auction formula, urgency-only, and cyclic round-robin. All use
  twelve slots, the same willingness, the same previous-speaker exclusion, and matched tie order.
- **Conditions:** cooperative scripts; a fourth actor who always bids maximum urgency and rambles
  without task evidence; or a separate p2 actor who sets its outgoing ratings to zero while keeping
  truthful speech and ordinary urgency. The last is an injected rating tactic, not a lying model.
- **Listener signals:** a stated toy rule rates an unheard peer 0.7 and a peer who exhausted current
  information or offered no task information 0.05. Flat-interest holds every sincere rating at 0.7.
  No hidden personality or future private arrival influences that rule. A new private arrival can
  legitimately be unknown to listeners, even with perfect memory.

The primary measurements are completion slot and useless slots before completion. JSON also retains
exact bids, journals, speech, private arrival times, and eligible opportunities passed over before
each disclosure. Never-delivered facts are censored, with null service delay; they are not
zero-delay successes. Post-completion turn share can describe surplus talk rather than task harm.

The exact-memory control removes comprehension error, but its numerical preference rule is an
explicit assumption. It tests scheduler behavior conditional on that signal; it does not prove Jev
will generate it or that the auction should win. The flat-interest condition checks what listener
feedback adds, and should reproduce urgency-only trajectories when no outgoing-rating attack is
present. Cyclic service may beat the auction on some tasks. Enumerated seat orders are design cases,
not independent live experimental replicates.

## 3. Feedback: controlled conversations after the bid checks

Keep rambler, malicious-rating, and misinformation scenarios separate initially. Hold task, seed,
seating, information availability, turn budget, and models constant within a comparison. Give each
condition fresh journals; do not switch policies midway through an observed conversation.

Compare the existing auction with a seeded cyclic schedule and an urgency-only schedule, with the
same previous-speaker rule and budgets. A cyclic schedule provides a service guarantee at the cost
of ignoring relevance. Urgency-only selection measures what listener ratings add. Do not assume
either alternative is better before observing the tradeoff.

Start with one cooperative control and one disruptive actor per group. Cross natural versus forced
urgency separately from natural versus zeroed outgoing ratings. Do not simultaneously change the
participant's personality, bidding policy, and evidence distribution and attribute everything to one
cause. Use multiple matched seeds before estimating treatment effects.

Measure:

- **Service delay:** eligible auction opportunities from a useful private clue or correction
  arriving to its public disclosure. Report never-disclosed evidence as censored/missing, not
  instant service.
- **Useful information delivered:** grounded, newly disclosed links or corrections per fixed turn
  budget, with transcript coding against the records.
- **Suppression:** whether an eligible holder of essential evidence is repeatedly passed over, and
  whether the evidence was collectively available at the time.
- **Attention consumption:** speaking turns and character/token share separately. A rambler can use
  more of the text budget without receiving more turns.
- **Feedback:** listener-by-listener ratings and their journal explanations before and after useful,
  repetitive, or deceptive speeches. Retain honest and strategic raters separately.
- **Recovery:** adoption and persistence of a correction, with final answers as a secondary outcome.

A diagnostic belief probe should not prevent the discussion from starting. In a new protocol, record
probe failures as missing probe data; retain bid/speech failures as explicit run failures. Preserve
invalid provider output privately for diagnosis, and define its handling before starting. Do not
silently reinterpret failed calls from the existing frozen pilot.

A small study with scripted public contributions can isolate allocation from speech-generation
quality. Follow it with free-form Luna conversations to test whether the result survives adaptive
behavior. Label these as different protocols. Scripted speakers are a research control, not a change
to Moon Council's normal free choice of speech.

## Interpretation

The auction has no separate reputation account or direct knowledge of a speech's truth or
usefulness. Its social feedback is whatever listeners retain in journals and express in subsequent
ratings. Structural starvation is therefore possible; whether it occurs, self-corrects, or harms a
task is an empirical question. Replays identify where to stress the system, paired prompts locate
judgment failures, and live comparisons measure the feedback loop.
