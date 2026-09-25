# Werewolf Lab V3.1 agent protocol

V3.1 keeps V3's bid-select-speak scheduler and small task outputs while repairing citation safety
and prompt-cache layout. The deterministic V2 game engine, frozen role rules, visibility boundary,
recovery model, and event-sourced replay remain authoritative. New games use
`schemaVersion: "game_config_v2"` with `protocolVersion: "agent_v3_1"`; historical V1, V2, V2.1, and
V3 games keep their recorded behavior.

## Design boundary

The player model chooses one small task result. The application supplies identity, legal choices,
evidence handles, scheduling metadata, and the canonical research record. A model never authors a
complete `DecisionReportV2`, game event, journal snapshot, actor ID, phase, or rule result.

The V3 task contracts are:

| Task                | Model output                                                                                                    | Application responsibility                                 |
| ------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `discussion_bid`    | urge, readiness, one contribution plan or decline, listening values, sparse memory suggestions, brief rationale | eligibility, auction score, response rights, persistence   |
| `discussion_listen` | readiness, listening values, sparse memory suggestions, brief rationale                                         | prevents an ineligible player from drafting a speech       |
| `discussion_speech` | selected speech, structured public acts, reply handles, sparse memory suggestions, brief rationale              | binds output to the frozen winning plan and publishes it   |
| `closing_response`  | reply or explicit decline against the frozen docket                                                             | prevents recursive new accusations and batches publication |
| `vote_choice`       | direct target, intentional uniform set, or abstention; brief rationale and sparse memory                        | sealed ballot storage, seeded draw, tally, elimination     |
| `night_choice`      | direct target or intentional uniform set; brief rationale and sparse memory                                     | legality, action resolution, private result delivery       |
| `team_point_choice` | direct target or intentional uniform set; brief private rationale and sparse memory                             | publishes only the committed point to the pack             |

These are strict stage-specific Structured Output schemas. V3.1 uses durable `E1`, `E2`, … handles
for public records and an owner-only `R1`, `R2`, … namespace for private records. Public numbering
never counts hidden activity, so the same public event has the same handle for every player. The
model never copies canonical UUIDs. The application validates handle membership in the current
delivered set and maps it back to canonical IDs. Invalid optional journal material is recorded and
omitted without discarding an otherwise valid action. An invalid essential target or reply pauses
after one field-specific repair rather than becoming a fabricated pass.

## Bid, select, then speak

Every living player gets an opening response opportunity, but V3 does not pre-generate every
possible speech. Each auction first collects private scheduling bids concurrently against one frozen
public revision. Eligible players may propose a short contribution plan; other living players submit
listener-only ratings. The deterministic scheduler computes:

```text
(speakerBias + urge) × normalized aggregate willingness to listen
```

Only the selected player receives a second call to turn the frozen plan into public speech. The
selected response must retain its planned act kind, target, and reply references. Losing bids are
not marked `decision.superseded`, because their listening/readiness and sparse belief updates are
useful committed private decisions rather than discarded draft speeches.

Opening candidates shrink as players complete their opening opportunity. Follow-ups retain the
ordinary `ceil(living / 2)` limit, two-per-player limit, cooldown, readiness quorum, and
response-right priority. When only one eligible candidate remains, only that player is polled.
Closing response rights use one frozen view and are published together before sealed voting.

## Memory and inspectability

The application maintains authorized facts and executed public commitments. The model may suggest
only changed beliefs, one changed hypothesis, strategy/goals, unresolved questions, or a separate
deception plan. The application converts those suggestions into bounded keyed `PrivateJournalV2`
operations and applies them atomically with the committed task result.

A player can therefore learn while listening even if another speaker wins. Conversely, a drafted
plan is not recorded as an action the player took. V3 stores a concise contemporaneous `rationale`;
it is an inspectable game artifact, not hidden chain-of-thought and not a claim that every internal
causal step was captured.

Every `decision.reported` record contains both the small validated `submission` and the
application-constructed compatibility report. The decision inspector shows the task type, submitted
result, resulting journal patch, continuation verdict, attempts, and committed event.
Provider-hidden reasoning is neither requested nor persisted.

## Context, isolation, and caching

V3.1 requests are assembled in this order:

1. `L0`: stable player instructions and the frozen public game/rule reference.
2. `L1`: a deterministic public-state window that is byte-identical for every seat at the same
   public revision.
3. `L2`: that player's role, authorized private facts, bounded journal, personally required older
   public evidence, response docket, and legal choices.
4. `L3`: the small changing task suffix, including commit-only state, any previous valid proposal,
   and precise repair feedback.

Dynamic information stays at the end. Every attempt records hashes for L0–L3 and the output schema
so exports can prove which prefixes were actually identical. OpenAI Responses requests use
`store: false`, explicit 30-minute cache breakpoints after L0 and L1, and a stable frozen-reference
routing key when supported. Cache hits are an optimization, never an assumption; reported
cached/cache-write usage is recorded and shown in the moderator UI. Codex-login uses isolated
temporary working directories and threads, reusing a thread only inside one bounded
retry/reconsideration episode. No provider conversation is shared between players.

`discussion.maxParallelDecisions` is the setup-time cache/latency control. `1` admits the wave
sequentially, maximizing the chance that the first completed request warms a prefix before the next
begins. The seat count admits the whole wave concurrently, minimizing wall time but weakening
first-wave warm reuse. Intermediate values use a bounded worker pool. Parallel execution does not
guarantee zero caching, and sequential execution does not guarantee a hit; the provider's reported
cached-input usage is the measurement of record.

The exact application request, strict schema, requested model/effort, raw requested JSON response,
parsed submission, usage receipt, latency, and validation outcome are persisted per provider
attempt. The raw field is only the explicit structured output requested by the task; hidden provider
reasoning and unrelated provider response data are not stored.

Routine bids run at `deliberation.bidReasoningEffort` (default `medium`). Selected speeches, votes,
and night choices use the seat's configured effort (the verification target is Luna `xhigh`).
Independent bids, pack points, night powers, closing replies, and sealed ballots run concurrently up
to `discussion.maxParallelDecisions`, while commits occur through deterministic application
ordering.

## Deliberation, failure, and recovery

`single` mode permits one substantive task response plus one schema repair. `gated` mode permits the
existing bounded episode, but routine bid/speech work is commit-only. A consequential vote or night
choice may request one specific unresolved comparison when relevant evidence and compute remain. The
final permitted call is commit-only.

Usage is captured before parsing, so malformed output is not free. A repair receives the exact
validation error and never silently repeats an identical prompt. If a latest valid legal proposal
exists when reconsideration ends, it commits; otherwise the game pauses. Operator pause, abort,
stale epochs, context limits, and crash recovery retain the V2 atomic/idempotent behavior.

The context admission estimate covers the exact V3 prompt and schema. Essential private facts are
never silently removed to fit. A context-limit failure pauses unresolved work. Output ceilings are
enforced by providers that expose them; Codex-login records `outputLimitEnforced: false` and
admission stops using reported or conservatively reserved usage.

## Export and replay

V3.1 moderator/player JSON exports use `werewolf_research_bundle_v3_1`; original V3 exports retain
`werewolf_research_bundle_v3`. In JSONL, attempts occur exactly once as top-level `kind: "attempt"`
records; decision records carry `attemptIds` rather than copying whole attempts. Exports retain
exact layered request packets and hashes, small validated submissions, application-built records,
journal revisions, random draws, event history, usage, and frozen configuration.

Public and team perspectives receive no private decisions or attempts. A player perspective receives
only that player's records. Historical cursors reconstruct the report, V3 submission, journal, and
attempt response as they existed at that replay position; later outputs are not exposed beside
earlier state.

The standard rules remain unchanged: a complete Day 1 ends in a sealed elimination vote before Night
1; the standard roster is two Werewolves, one Seer, one Doctor, and four Villagers; Doctor cannot
protect the same target on consecutive nights; wolf communication is point-only and requires
unanimity within three rounds; ties eliminate nobody; deaths reveal roles; wolves win at parity and
village wins when all wolves are eliminated.
