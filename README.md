# Moon Council — LLM Werewolf Lab

A local-first research console for running AI-only classic Werewolf games. The application separates social behavior from game authority: models decide what to say and which legal intent to submit, while a deterministic moderator kernel owns every role, secret, phase transition, effect, vote, and win condition.

New games use the cache- and citation-safe [V3.1 agent protocol](docs/PROTOCOL_V3.md) on top of the deterministic V2 rules engine. Original V3 and [V2](docs/PROTOCOL_V2.md) games keep their recorded behavior.

## What works

- Seeded 5–16 player games with immutable role snapshots
- V2 standard-eight preset: 2 Werewolves, Seer, Doctor, and 4 Villagers
- V2 Doctor rule forbids protecting the same target on consecutive nights; Roleblocker and Mayor remain available as experimental custom roles
- Restricted declarative role definitions; no arbitrary role code
- Point-only werewolf coordination: private journals remain private, teammates see only `team.point` gestures
- V2 unanimous pack kills with a hard limit of three pointing turns per living werewolf; no agreement means no kill
- V2 sealed ballots: `vote.cast` remains player/moderator-visible until public vote resolution
- V2.1 starts with a complete Day 1 discussion and sealed elimination vote, followed by Night 1
- Isolated player projections and explicit private journals
- V3.1 reactive listener auctions: small bids, deterministic `(bias + urge) × normalized listening`, and full speech generation only for the selected player
- Setup-selectable decision concurrency from sequential cache-first execution to all-seat latency-first execution; commits remain deterministic
- Durable cross-player public `E#` citations, owner-only private `R#` citations, and application mapping back to canonical event IDs
- Four-layer prompts with byte-stable public prefixes, explicit cache boundaries for compatible Responses models, and recorded layer/schema hashes
- Small task-specific V3 outputs for bids, selected speech, votes, night actions, and pack points; the application constructs the detailed research record
- Sparse private memory updates can commit while listening, independently of winning a speaking slot
- Single or gated deliberation episodes with durable decision recovery; exhausted retries pause unresolved work without fabricating a safe action
- Play, pause, V2 phase-step, decision-step, speed, and abort controls; legacy V1 games are replay-only
- Public, moderator, individual-player, and named-team replay perspectives
- JSON and JSONL perspective-scoped research exports
- One-to-fifty-game experiment batches with completed/interrupted/failed/budget-truncated counts and a valid-outcome denominator
- OpenAI Responses API, signed-in Codex SDK, and credential-free deterministic fake providers
- Optional disclosure-only moderator narration with durable usage and recovery records

The private journal is a compact, explicit game artifact containing beliefs, goals, strategy, and unresolved questions. It is not a request for or representation of hidden model chain-of-thought.

## Quick start

Use Node 24 on the native Linux filesystem:

```bash
cd moon-council
npm install
cp .env.example .env
npm run dev
```

Open [http://127.0.0.1:4311](http://127.0.0.1:4311). The default `LLM_PROVIDER=fake` mode needs no credentials and is useful for interface checks, engine development, and deterministic test runs.

To run real players, edit `.env`:

```dotenv
LLM_PROVIDER=openai
OPENAI_API_KEY=your_key
OPENAI_MODEL=your_available_model_id
OPENAI_MODERATOR_MODEL=optional_separate_model_id
```

The API key remains in the API/runner environment and is never sent to the browser or stored in SQLite. OpenAI requests use the Responses API with `store: false` and strict JSON-schema output. The application reconstructs every turn from its own filtered state.

Alternatively, use the ChatGPT account already signed in to Codex. The project-local CLI comes from the official Codex SDK, so login and status checks use the same compatible runtime as the game provider:

```bash
npm run codex:login
npm run codex:status
```

Then select the Codex provider in `.env`:

```dotenv
LLM_PROVIDER=codex
CODEX_MODEL=your_available_codex_model_id
CODEX_MODERATOR_MODEL=optional_separate_model_id
CODEX_REASONING_EFFORT=medium
CODEX_TIMEOUT_MS=120000
```

`CODEX_MODEL` falls back to `OPENAI_MODEL`, which can be convenient when both providers use the same model id. The Codex adapter never reads or copies the login cache itself: the SDK launches its bundled CLI, which reuses the saved account session. Every game decision starts a fresh, independent Codex thread from the engine-filtered player view. The child receives a minimal environment without `OPENAI_API_KEY`, runs in an empty temporary directory with a read-only sandbox, and has shell, web, apps, hooks, memories, plugins, MCP servers, and subagents disabled. Only the schema-validated final JSON and token usage enter the event store.

OpenAI player requests remain independent (`store: false`). V3.1 puts stable instructions first, then a same-revision public layer, then the authorized private briefing, and finally the changing task suffix. Compatible models receive explicit cache breakpoints after the stable and public layers. Independent player sessions do not imply shared memory and do not prevent prefix cache reuse. Setup exposes a decision-concurrency factor: `1` favors warm-prefix reuse, the seat count favors latency, and intermediate pools trade between them. Cached and cache-write token counts are recorded when the provider reports them; a hit is never assumed.

If `codex:status` reports that you are signed out, run `npm run codex:login` and complete the browser flow. A live Codex game consumes the Codex allowance associated with that ChatGPT account; API-key mode continues to use OpenAI Platform billing.

## Architecture

```text
React observer console ── REST/SSE ── Fastify API ── SQLite event store
                                               │
Background runner ── player projection ── provider adapter
       │                                      ├─ OpenAI Responses
       │                                      ├─ Codex SDK + saved login
       └─ deterministic moderator kernel      └─ deterministic fake
```

- `packages/contracts` owns all versioned Zod wire contracts.
- `packages/engine` is a pure deterministic reducer, role engine, projection boundary, and discussion scheduler.
- `packages/db` owns Drizzle schemas, migrations, jobs, events, journals, usage, and repository interfaces.
- `packages/llm` owns provider-neutral decisions, prompts, schema repair, and provider implementations.
- `packages/simulator` orchestrates game phases and experiment batches without granting model output authority.
- `apps/api`, `apps/runner`, and `apps/web` are the deployable processes and browser surface.

SQLite uses WAL mode and defaults to `data/werewolf.db`. Role versions and each game's role deck are immutable, so later workshop edits cannot change a replay.

## Role definitions

The Role Workshop edits the restricted `role_v1` JSON schema. Saving creates a new immutable version. Mechanics are separate from model-facing descriptions:

```json
{
  "schemaVersion": "role_v1",
  "id": "seer",
  "version": 1,
  "name": "Seer",
  "alignment": "village",
  "description": "Inspect one player each night.",
  "knowledge": ["own_role"],
  "actions": [{
    "id": "divine_alignment",
    "name": "Divine alignment",
    "description": "Inspect one other living player's alignment.",
    "phase": "night",
    "effect": "inspect_alignment",
    "target": {
      "min": 1,
      "max": 1,
      "allowSelf": false,
      "aliveOnly": true
    },
    "teamAggregation": "none"
  }],
  "passives": { "voteWeight": 1 },
  "winCondition": {
    "terminal": true,
    "predicate": {
      "kind": "alignment_eliminated",
      "alignment": "werewolf"
    }
  }
}
```

Supported effects are `eliminate`, `protect`, `inspect_alignment`, `inspect_role`, `block`, and `reveal`. Win predicates support alignment elimination, alignment parity, self survival, and nested `all`, `any`, and `not` expressions. Action charges and target alignment constraints are enforced at admission.

## API

Endpoint paths retain `/api/v1`; the application remains trusted-local and unauthenticated, including V2 games.

- `GET/POST /api/v1/roles`
- `GET/POST /api/v1/games` (POST creates agent-protocol V3 games on the V2 rules schema; legacy snapshots remain readable)
- `GET /api/v1/games/:id?view=public|moderator|player|team&playerId=...&teamId=...&at=...`
- `POST /api/v1/games/:id/control`
- `GET /api/v1/games/:id/events`
- `GET /api/v1/games/:id/events/stream`
- `GET /api/v1/games/:id/decisions?view=moderator|player&playerId=...&at=...`
- `GET /api/v1/games/:id/decisions/:decisionId?view=moderator|player&playerId=...&at=...`
- `GET /api/v1/games/:id/export?view=public|moderator|player|team&playerId=...&teamId=...&format=json|jsonl&at=...`
- `GET/POST /api/v1/experiments`
- `GET /api/v1/experiments/:id`

Control actions are `start`, `pause`, `resume`, `step`, `step_decision`, `abort`, and `speed` at the wire level. V2 observer controls use phase `step` and decision `step_decision`; legacy V1 control attempts return `409` and the snapshot is replay-only. The background runner claims durable jobs from SQLite. V1 repair/fallback can record a safe pass; V2 retries are bounded, and exhausted or unresolved V2 work pauses without fabricating an action. Lease expiry also pauses the game and requires explicit recovery.

## V3 pilot

`npm run pilot --help` prints the supported pilot and resume forms. A fresh pilot requires a native Linux database/output path when those options are supplied. For an exact Luna/xhigh pilot using a live provider, select the provider and model explicitly:

```bash
npm run pilot -- --provider codex --model gpt-5.6-luna --effort xhigh --seed standard-v3-pilot
```

The pilot prints a game ID and database path. Resume the same game by supplying both values and `--resume`; the existing game must be V2:

```bash
npm run pilot -- --provider codex --model gpt-5.6-luna --effort xhigh \
  --db /native/path/game.db --game GAME_ID --resume
```

Use `--audit` with the same database and game ID to emit the moderator audit artifacts without advancing the game. Pilot artifacts contain explicit application decisions and audit data, not provider-hidden reasoning traces. Do not publish the local database or moderator artifacts as multi-user data.

Add `--snapshot --out /native/path/private-archive` to save a consistent SQLite backup beside the research JSON/JSONL and audit files. Snapshot creation refuses to overwrite an existing backup. Audit mode does not make model calls, and terminal budget outcomes cannot be resumed. Keep these spoiler archives private.

For read-only latency/usage summaries and targeted transcript/journal searches, use `npm run pilot -- --inspect-bundle /native/path/research.json --match PLAYER_NAME --match PLAYER_ID --day 2`. Matches are literal and case-insensitive; `--limit` and `--offset` page through source-identified records. Without `--match`, only timing/usage metadata is printed. This mode opens no database, changes no game, and makes no model calls.

## Verification


```bash
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
npm audit
```

The suite covers deterministic assignment and resolution, unanimous pack kills, bounded point-only wolf coordination, protection/blocking order, action charges, weighted votes and ties, win checks, prompt-shaped speech, cross-player secret filtering, follow-up fairness and termination, provider repair/fallback, provider-wide outage pausing, API contracts, exact event replay, an eight-seat full game, a ten-run experiment, and browser workflows.

For a production-style local run:

```bash
npm run build
npm run start:api
# In another terminal:
npm run start:runner
```

The built UI is served by the API at [http://127.0.0.1:4310](http://127.0.0.1:4310). This is trusted-local tooling, not multi-user security: moderator views, player/team secrets, journals, and applicable exports contain sensitive game data, and SQLite stores it in plaintext. Provider requests are exact application prompts and schemas; they do not expose or represent hidden provider chain-of-thought. Usage may be unknown, and Codex reports `outputLimitEnforced: false`; V2/V3 admission conservatively reserves unknown usage and cost estimates are lower bounds when usage or pricing is incomplete.
