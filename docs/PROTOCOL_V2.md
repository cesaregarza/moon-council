# Werewolf Lab V2 protocol

This document describes behavior implemented by the V2 contracts, API, engine, simulator, and pilot. It is a protocol reference, not a balance proposal or a security specification.

## Version boundary

V2 game configurations use `schemaVersion: "game_config_v2"` and an immutable resolved role deck. New games created by the API and pilot freeze `protocolVersion: "agent_v2_1"`; stored `agent_v2` games retain their original night-first/event-queue semantics for exact replay and resumption. Stored V1 games remain readable for replay and export, but are legacy replay-only: control attempts return `409` and they cannot be resumed by the V2 runner. Clone a legacy configuration into a new V2 setup when a new run is needed.

## Standard setup and rules

The `standard-8-v2` preset has exactly eight seats and this role multiset:

| Count | Role | Alignment |
| ---: | --- | --- |
| 2 | Werewolf | werewolf |
| 1 | Seer | village |
| 1 | Doctor v2 | village |
| 4 | Villager | village |

Doctor v2 is the immutable version whose protection action rejects the same target on consecutive nights. Roleblocker and Mayor are available from the seeded role catalog for `custom-v2` experiments; they are not part of the standard-eight preset. The role engine validates actions, targets, charges, effects, and win predicates; model output does not directly mutate state.

Self-protection is legal. An accepted protection attempt counts even if blocked; an intervening night without that selection breaks the repeat restriction. Pack agreement freezes before blocking: an agreed attack executes if at least one living pack member is unblocked, subject to protection. Named private channels maintain separate pointing rounds and agreement records.

Werewolf coordination is point-only. A living wolf emits a `team.point` containing only the pointing actor and target. The team sees points through its named channel; private reports and rationale are not team messages. V2 resolves a pack kill only after the expected living wolves point unanimously, or records no agreement after the bounded pointing allowance (three point turns per living wolf).

V2 ballots are sealed: `vote.cast` is player/moderator-visible while voting is in progress. Resolution emits the public `vote.resolved` record, including the resolved tally/ballots. Public speech and role/reveal payloads are projected separately from moderator state.

The V2.1 lifecycle begins with a normal Day 1: every living player receives an opening opportunity, discussion closes, all ballots are sealed against the completed discussion snapshot, and the public tally/elimination resolves. Only then does Night 1 begin. Later cycles resolve night actions, announce dawn on the following numbered day, discuss, and vote normally.

## Deliberation episodes

Each V2 opportunity is a persisted `DecisionOpportunityV1` with a player, phase/day epoch, view ID, starting journal version, exact `player_context_v2` packet, status, recovery number, and optional best report. The packet contains only the player’s authorized self/role, living-player projection, known allies, rules, cited context sources, legal actions/targets, journal, response docket, and closing flag.

The policy is explicit in the game configuration:

- `mode: "single"` makes one bounded report episode; `mode: "gated"` allows a report to request a justified comparison before a later commit-only call.
- `maxCalls` caps calls in a gated episode. `optionalDayCalls` and `optionalNightCalls` bound optional follow-up calls.
- `requestTimeoutMs` and `episodeTimeoutMs` bound one provider request and the active episode.
- `maxContextTokens` covers the application prompt plus schema estimate. `maxJournalTokens` bounds the journal result.
- `safety.maxModelCalls`, `safety.maxWallClockMs`, and `maxTotalTokens` are admission/runtime ceilings. Unknown usage is reserved conservatively; an in-flight request can overshoot the total-token ceiling before its receipt is known.

Defaults are eight cycles, 500 attempts, two million admitted tokens, 30 minutes of active runtime, 120 seconds per request, and five minutes per episode. Operator pause time is excluded from active runtime. Provider transport retries are disabled so retries remain application-owned and accounted for; the Codex adapter uses an isolated, retry-free OpenAI service configuration with the existing saved login.

Single mode permits one substantive call and one schema repair. Gated mode permits at most three attempts, including at most one repair; additional allowances are four calls per player per day and two per night. Optional reconsideration must compare at least two named alternatives using already-delivered evidence. Requests to wait for future information do not qualify. Routine speech/pass and informationless choices are commit-only; the final permitted call is also commit-only. A failed continuation retains the latest still-current legal proposal instead of fabricating a replacement.

The context fitter measures the exact application prompt, packet, and stage-specific schema together using a conservative approximate token estimator. It retains essential authorized facts, cited sources, own commitments, and the current journal ahead of optional older speech. If essential material cannot fit, the decision pauses explicitly. Each persisted request records precisely what was delivered. Presentation permutations are private to each player and opportunity and remain fixed during reconsideration.

Discussion has deterministic opening, follow-up, and closing stages. In V2.1, every living player privately submits a complete discussion report against the same frozen public revision. The report includes whether they want to speak, an urge from zero to one, and a willingness-to-listen value for every other living player. For each eligible candidate, the scheduler averages the other players’ listening values, normalizes those candidate averages to sum to one, calculates `(speakerBias + urge) × normalized listening`, and grants the maximum score. A seeded order breaks exact ties; response rights restrict the candidate set before scoring, so popularity cannot suppress an owed reply. Non-selected reports are retained as explicitly superseded audit artifacts, and only the selected report and journal patch commit.

A public accusation/challenge or a name mention can create a response docket. A player’s report may request a response; the scheduler consumes addressed docket entries and does not invent response rights. Closing receives a frozen docket and cannot introduce new accusations.

Every living player receives an opening opportunity. Ordinary follow-ups are capped at `ceil(living players / 2)` overall and two per player, with a one-message cooldown. Passes consume opportunities. The two-thirds readiness threshold is tied to the public revision and cannot erase an outstanding response right. Closing responses share one frozen view, are published together, and precede sealed ballots against the completed discussion. Accused silence must explicitly consider a feasible speech alternative; weak strategy is not grounds to force a different action.

V2.1 runs mutually independent decisions concurrently up to `discussion.maxParallelDecisions` (default four for newly created games). One frozen auction ballot, pack-pointing round, night-action wave, closing window, or sealed-ballot wave shares a fixed event boundary. Provider response latency cannot change speaker priority or action order. Valid reports persist first, then accepted effects and journal patches commit in deterministic seeded order. A wolf’s private report does not consume an extra point: each of at most three simultaneous rounds contributes one committed point per living wolf, and failure to reach unanimity skips the kill.

The report is an explicit application artifact containing observations, inferences, one to three alternatives, a selected alternative, an action proposal, confidence, a concise summary, journal operations, and a `commit` or `continue` control. It is not hidden chain-of-thought. Journal operations apply relative to the opportunity’s starting journal version and are validated before commit. Stale epochs, stale journal versions, illegal proposals, and context-limit failures do not resolve an action.

## Durable recovery and outcomes

Attempts, usage receipts, report events, journal updates, and commitments are stored in SQLite agent records/events. A validated pending report can commit after an operator pause without another provider call. An uncertain started/received attempt pauses the opportunity; resuming an active paused episode records a new recovery number. Exhausted repair/retry paths pause unresolved work and fabricate no safe action. A runner lease expiry pauses the game and requires explicit recovery.

V2 budget exhaustion is terminal and records `game.budget_exhausted`. Other unresolved decision failures record a public pause plus moderator-visible detail. `decision.reported` records the report and continuation verdict; `decision.committed` is the authority boundary for applying its proposal and journal.

Optional moderator narration receives only a disclosure packet, not canonical state or a player context. Its requests, attempts, usage, and pending result are durable. Narration cannot mutate mechanics; when optional compute is unavailable the engine supplies the announcement directly.

## Observer projections and replay

All observer routes are local, unauthenticated API routes. Use the narrowest view:

```text
GET /api/v1/games/:id?view=public|moderator|player|team&playerId=...&teamId=...&at=...
GET /api/v1/games/:id/events?view=...&playerId=...&teamId=...&at=...
```

Public and team payloads omit unrevealed private roles, journals, usage, and decision records. A player receives that player’s own role/journal and authorized player/team events. A team view requires a named team channel (the standard wolf channel is `werewolves`) and receives only authorized team points. Moderator view is the spoiler projection and includes full state, journals, attempts, and usage. Do not fetch moderator view as a default for a non-spoiler observer.

`at` is a historical cursor. For moderator view it is a global event sequence. For public/player/team views it is the zero-based index in that perspective’s visible event list; the returned visible events have contiguous perspective-local sequence numbers. The server reconstructs state, journals, decision records, and usage at the cursor. A historical decision report can therefore be visible as pending before a later commitment/final journal update.

The control route accepts phase `step` and V2 `step_decision` in addition to pause/abort/speed and run-compatible wire actions. The UI exposes phase step and decision step for V2; legacy controls remain replay-only. Decision routes are moderator/player-only:

```text
GET /api/v1/games/:id/decisions?view=moderator|player&playerId=...&at=...
GET /api/v1/games/:id/decisions/:decisionId?view=moderator|player&playerId=...&at=...
```

The detail response contains `opportunity`, `attempts`, `turns`, and decision-linked events. Public/team decision lists are empty. Export uses the same view and cursor boundary:

```text
GET /api/v1/games/:id/export?view=public|moderator|player|team&playerId=...&teamId=...&format=json|jsonl&at=...
```

Public/team exports omit seeds, role decks, opponent journals, and private reports. Moderator exports are spoiler artifacts and should remain local.

## Experiment batches

V2 batches use `experiment_v2` with a V2 base configuration. The summary retains legacy aggregate metrics and adds `completed`, `interrupted`, `failed`, `budgetTruncated`, and `validOutcomeDenominator`. The valid outcome denominator is the number of completed runs; interrupted, failed, and budget-truncated runs are reported separately rather than silently treated as wins/losses. Usage totals include attempts from incomplete runs.

Usage fields can be null. The audit reports `unknownUsageAttempts`; V2 admission reserves unknown usage. OpenAI reports its output limit as enforced, while the Codex adapter reports `outputLimitEnforced: false`. Costs are lower bounds when usage or model pricing is incomplete. Cached-input and reasoning counters are subsets of provider usage and are not added twice to input/output totals.

Each player decision is an independent provider request rather than a shared conversation. OpenAI uses `store: false`; compatible GPT-5.6-and-later requests put an explicit 30-minute cache breakpoint after the shared stable developer instructions and before the dynamic private packet. This permits prefix reuse without cross-player conversational state. Codex-login decisions likewise use fresh threads and a stable prefix, but the installed SDK does not expose explicit cache controls. The ledger records provider-reported cached/cache-write tokens and never treats a cache hit as guaranteed.

## Pilot operation

`npm run pilot --help` prints the supported arguments. Fake mode is credential-free. For the requested exact live verification model and effort:

```bash
npm run pilot -- --provider codex --model gpt-5.6-luna --effort xhigh --seed standard-v2-pilot
```

The pilot prints its game ID and database/output directory. Resume the same V2 game with the same database and ID:

```bash
npm run pilot -- --provider codex --model gpt-5.6-luna --effort xhigh \
  --db /native/path/game.db --game GAME_ID --resume
```

Use `--audit` with `--db` and `--game` to inspect the existing game without advancing it. Live providers require an explicit model; the pilot does not substitute another live model.

Use `--snapshot --out /native/path/private-archive` with audit mode to preserve an online SQLite backup and research/audit artifacts. Existing backup files are not overwritten. Budget-terminal games are audit/replay-only.

## Trust and data boundary

This is trusted-local tooling, not multi-user security. API routes are unauthenticated, moderator/player/team projections are sensitive, and SQLite stores secrets and journals in plaintext. Keep databases and moderator artifacts on a controlled native filesystem. Application requests sent to providers are the exact prompts and schemas assembled by the simulator; the protocol stores validated outputs and provider usage, not provider-hidden reasoning traces.
