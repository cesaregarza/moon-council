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

This phase has not been run by `auction:replay`. It needs its own frozen fixture set and call
budget.

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
