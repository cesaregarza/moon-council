# Running and inspecting experiments

## Providers and local setup

Use Node 24 on the native Linux filesystem:

```bash
cd moon-council
npm ci
cp .env.example .env
npm run dev
```

Open [http://127.0.0.1:4311](http://127.0.0.1:4311). The setup template selects the OpenAI API and
GPT-6 Luna. Set `OPENAI_API_KEY` before running real players, or set `LLM_PROVIDER=fake` for
interface checks and deterministic offline tests.

To run real players, edit `.env`:

```dotenv
LLM_PROVIDER=openai
OPENAI_API_KEY=your_key
OPENAI_MODEL=gpt-6-luna
OPENAI_REASONING_EFFORT=xhigh
OPENAI_MODERATOR_MODEL=optional_separate_model_id
```

Default live games have no total-token ceiling; they are still bounded by 500 model calls, 30
minutes of active runtime, and 8 day/night cycles.

The API key remains in the API/runner environment and is never sent to the browser or stored in
SQLite. OpenAI requests use the Responses API with `store: false` and strict JSON-schema output. The
application reconstructs every turn from its own filtered state.

Alternatively, use the ChatGPT account already signed in to Codex. The project-local CLI comes from
the official Codex SDK, so login and status checks use the same compatible runtime as the game
provider:

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

`CODEX_MODEL` falls back to `OPENAI_MODEL`, which can be convenient when both providers use the same
model id. The Codex adapter never reads or copies the login cache itself: the SDK launches its
bundled CLI, which reuses the saved account session. Every game decision starts a fresh, independent
Codex thread from the engine-filtered player view. The child receives a minimal environment without
`OPENAI_API_KEY`, runs in an empty temporary directory with a read-only sandbox, and has shell, web,
apps, hooks, memories, plugins, MCP servers, and subagents disabled. Only the schema-validated final
JSON and token usage enter the event store.

OpenAI player requests remain independent (`store: false`). Four explicit cache boundaries separate
immutable behavior, frozen rules, durable public outcomes, and the current public view. A common
strict API response format preserves reuse across notebooks and speeches. Private notebooks and
task/repair instructions follow the cached section. New games allow 8,192 output tokens including
reasoning, with concise final responses still enforced by schema. Exact wire bodies, cache
reads/writes, and diagnostic miss reasons are available in moderator audits. See
[API configuration, cache layout, and the bounded live probe](OPENAI_CACHING.md).

If `codex:status` reports that you are signed out, run `npm run codex:login` and complete the
browser flow. A live Codex game consumes the Codex allowance associated with that ChatGPT account;
API-key mode continues to use OpenAI Platform billing.

### Claude (Anthropic)

Claude seats use the Anthropic API key on the machine that runs the game. Every seat in a game uses
the same provider.

```dotenv
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=your_key
ANTHROPIC_MODEL=claude-haiku-5-5
ANTHROPIC_MODERATOR_MODEL=optional_separate_model_id
# Optional: output cap used when a request sets none (default 16000).
ANTHROPIC_MAX_OUTPUT_TOKENS=16000
```

The key is read only from the environment. It is never logged, stored in a game database or included
in the recorded request body. Requests use adaptive thinking with an explicit effort, structured
JSON output, and no sampling parameters or assistant prefill. Requests are text only: an image,
document or other non-text block is refused before any spend is reserved, because its bytes cannot
bound its cost. A refusal is recorded as a failed attempt with its category; no other model is
tried.

**Spend guard (fail closed).**

- Only models in the price table (`packages/llm/src/anthropic-pricing.ts`) can be called. That table
  covers Opus 5.5, Sonnet 5.5 and Haiku 5.5, including Haiku 5.5's higher rate for prompts above
  100,000 tokens.
- **Per game:** `maxSpendUsd` is required for any game with Claude seats; for a pilot, pass
  `--max-spend-usd`. Each call is admitted only if settled spend, plus unsettled calls at the worst
  case admitted when they began, plus this call's worst case, fits. The worst case bounds the prompt
  by its UTF-8 byte length (a token is never shorter than a byte), prices it as 1-hour cache writes
  at the long-context rate whenever that bound could cross the threshold, and adds the output cap.
  Settled calls count the provider's actual cost. Reaching the limit ends the game as
  `budget_exhausted`.
- **Per month:** a ledger outside the repository and game databases (default
  `~/.moon-council/claude-spend.json`, or `MOON_COUNCIL_SPEND_LEDGER`) holds UTC calendar-month
  spend. The default limit is $200 (`MOON_COUNCIL_CLAUDE_MONTHLY_LIMIT_USD`). Each call reserves its
  worst case before sending and settles to the actual cost afterwards, in the month it was reserved,
  even when a stale reservation was already swept at its worst case. A corrupt or unreadable ledger,
  or a held lock, refuses calls; it is never reset to zero.

Check the month's spend at any time, with no API call:

```bash
npm run claude:spend
```

A live smoke test (one tiny call, counted in the ledger) runs only when asked:
`npm run test:live:anthropic`.

#### Claude session protocol

`--protocol agent_claude_session_v1` runs each Claude seat as one cached conversation per game day.
It requires every seat on `anthropic` and the `journal_v4` Jev workflow, and refuses any other
pairing. The game protocol is unchanged: the same call kinds, a reflection after every speech, and
the same auction.

- Two system blocks are shared by every seat: the instructions with the frozen reference and the
  response envelope, then the public record before today. A seat with a personality has its
  personality block between them (see Personalities). The seat's first message holds its journal,
  brief and private evidence at day start. Each later call appends one turn: the records the seat is
  authorized to see since its last turn, then NOW and the request.
- History is append-only. Earlier turns and replies, thinking blocks included, are replayed
  byte-for-byte; thinking, effort and the response schema stay the same for the whole session.
- A new session starts at each day, after a journal compaction, or before the prompt would pass
  90,000 tokens on Haiku 5.5, whose price rises above 100,000.
- At game start and day start, the first seat's request goes alone and the others wait for its first
  streamed token, so they read the shared blocks instead of each writing them.
- Turns are stored in the game database (moderator-only), so a resumed game rebuilds every session
  byte-identically. A stored session is replayed only for its own game and seat; anything else opens
  a fresh session and is recorded as an anomaly. `npm run cache:audit` lists session reads, writes
  and misses by call kind.
- Each turn's NOW section carries the current public game state from the same renderer as the other
  protocols (every player, alive or not), so a session never shows less public information.

```bash
npm run pilot -- --provider anthropic --model claude-haiku-5-5 --decision-engine jev \
  --protocol agent_claude_session_v1 --max-spend-usd 2
```

#### Personalities

A V2 seat's `personality` is a frozen profile (CES-1585), not free text. A profile has eight traits
(0 to 1: deception, independence, conflict, risk, infoSeeking, selfPreservation, revisability,
engagement), four motivation weights summing to 1 (team, survival, attention, chaos), the text the
model reads (40 to 200 words), its source, and `textSha256`. A seat without one has no personality.
Personalities run only on the journal_v4 Jev decision engine: the config and the create-game request
refuse `seats.N.personality` on any other engine or workflow, and the lab keeps a chosen profile but
won't create the game until Jev is selected.

- **Presets:** `PERSONALITY_PRESETS` holds The Liar, The Maverick, The Sacrificial Lamb, The
  Disruptor, The Careful Reasoner, Evidence-focused and Persistent rambler. They are not sanitized.
- **Assignment:** `personalities.assignment` is `{ kind: "explicit" }` (each seat names its profile)
  or `{ kind: "seeded", seed, pool }`: each seat draws independently, with replacement, from the
  pool by seed and seat ID, and the config's seats must equal that draw. Either way the config holds
  every seat's exact profile, so resume and replay use the stored one.
- **Delivery:** a Claude session sends block 1 (shared by every seat), then the seat's personality
  block, then block 2 (the public record), then the day's messages. Its breakpoints are the end of
  each system block and the automatic one at the end of the request: four at most. Other request
  paths carry the text in the seat's private state, with the same instruction to play the character
  even where its motives differ from the faction objective. Jev's actor state gets a fixed digest,
  the label and all twelve values, and every Jev question tells the seat to weigh the motivations as
  given. The session identity includes the personality hash.
- **Semantic review:** the verified-last-wolf ballot rule still asks a personality seat once to
  reconsider, naming its motivations. A ballot it keeps then commits, and the
  `decision.semantic_assessed` event records `personalityException: "applied"` with the excepted
  issue. That records the exception, not that the ballot fits the character. No other rule has an
  exception, and a seat without a personality is still paused for an operator acknowledgement.
- **Generation**, offline only:
  `scripts/personality-generate.ts --seed-prefix S --count N --out FILE` writes a pool. A seed gives
  the values; a generator writes the text from the numbers alone. The default generator is a
  deterministic mock. `--generator anthropic --model M` is live and paid: it needs `--max-profiles`
  and `--max-spend-usd` and refuses before any call unless the count and its worst-case cost fit
  both. `scripts/fixtures/personality-samples.json` holds the five presets and three mock profiles.

## Pilot and recovery

`npm run pilot -- --help` prints the supported pilot and resume forms. A fresh pilot requires a
native Linux database/output path when those options are supplied. For an exact Luna/xhigh pilot
using a live provider, select the provider and model explicitly:

```bash
npm run pilot -- --provider openai --model gpt-6-luna --effort xhigh --seed standard-v3-pilot
```

New games have no total-token ceiling. Use `--max-tokens NUMBER` to opt into one or
`--max-tokens unlimited` explicitly; usage remains recorded.

The pilot prints a game ID and database path. Resume the same game by supplying both values and
`--resume`; the existing game must be V2:

```bash
npm run pilot -- --provider openai --model gpt-6-luna --effort xhigh \
  --db /native/path/game.db --game GAME_ID --resume
```

Use `--audit` with the same database and game ID to emit the moderator audit artifacts without
advancing the game. Pilot artifacts contain explicit application decisions and audit data, not
provider-hidden reasoning traces. Do not publish the local database or moderator artifacts as
multi-user data.

Add `--snapshot --out /native/path/private-archive` to save a consistent SQLite backup beside the
research JSON/JSONL and audit files. Snapshot creation refuses to overwrite an existing backup.
Audit mode does not make model calls, and terminal budget outcomes cannot be resumed. Keep these
spoiler archives private.

For read-only latency/usage summaries and targeted transcript/journal searches, use
`npm run pilot -- --inspect-bundle /native/path/research.json --match PLAYER_NAME --match PLAYER_ID --day 2`.
Matches are literal and case-insensitive; `--limit` and `--offset` page through source-identified
records. Without `--match`, only timing/usage metadata is printed. This mode opens no database,
changes no game, and makes no model calls.

For a live or completed game,
`npm run game:audit -- --db /native/path/game.db --game GAME_ID --compact` reads SQLite without
changing the game. Add `--status` for a concise live progress snapshot without private notebooks.
Alongside outcomes and provider timings, `journal` reports reflection counts, listening-note
updates, and whether every living player reviewed each speech before the next Jev call. An
unfinished reflection batch is pending, not a failure; legacy games without reflection events are
marked unobserved.

### Post-game surprise analysis

```bash
npm run game:analyze -- --db /native/path/game.db --game GAME_ID --out RUN_DIRECTORY \
  --review-provider anthropic --review-model claude-haiku-5-5 --max-spend-usd 20
```

The analyzer opens the database read-only. For every committed ballot with a recorded Jev
distribution, it asks Jev what the public record alone predicts, then scores the moment against the
player's recorded choice. Each night's wolf kill is one moment for the pack: Jev predicts who is
found dead at dawn, and the dawn outcome is scored against the mean of every living wolf's recorded
probability in the pack's final round. A save, a block, a split pack or a missing wolf distribution
makes that night "no signal", as do inconsistent pack records (for example a missing or duplicated
freeze, or a decision that is not the pointing wolf's own); a no-signal moment makes no Jev or
review call. Other night roles and non-kill pack points produce no moment. The moments are private
knowledge, herd over knowledge, noise or error, routine, or no signal. The top 12 (`--cap`) go to
the review model, plus 2 random routine moments as a recall check (`--recall`).

- The review provider and model have no defaults. Numeric options must be positive integers in
  range, or the run refuses to start.
- The review is capped by `--review-token-budget` (default 200,000 tokens). A review is admitted
  only if the budget covers its prompt (bounded by its bytes) plus `--review-max-output`, and it
  settles to the reported usage. Codex providers do not enforce an output cap, so they are refused
  as review providers. OpenAI is refused as unpriced: there is no OpenAI price table, so its spend
  cannot be bounded (see the spend cap below). The usable review providers are Claude (`anthropic`)
  with a priced model, and `fake`.
- Each review gets the player's decision-time briefing exactly as Jev received it (for a kill, each
  wolf's). Every cited event must be one the player could see before deciding, or the review is
  rejected and marked. For a kill, each knowledge claim names its wolf and is checked against that
  wolf's own view; a claim with no subject must hold for every wolf. Facts the player could not see
  belong only in its uncited `groundTruth`.
- `analysis.json` and `analysis.md` are written to `--out`, next to `research.json`, each through a
  temporary file and a rename. The analyzer refuses to run if a report path is the database, its WAL
  or SHM file, a link, or any file that is not one of its own previous reports. The reports hold
  moderator data, so never commit them. They record the models, Jev's tokens per call, and the
  review's tokens and reported cost.
- `npm run pilot -- ... --analyze --review-provider KIND --review-model MODEL --analysis-max-spend-usd USD`
  runs the analyzer automatically after a completed game. It is off by default, and a failure never
  changes the game record. The pilot's `--max-spend-usd` is the game's own Claude cap; the analysis
  has its own.

#### Analysis spend cap

Jev costs are not counted toward the cap, by Cesar's decision on 2026-10-23. The per-run limit is
enforced by the Claude review cap. Each run's Jev calls and tokens are still reported, as
information only.

- A paid review (`anthropic`) requires `--max-spend-usd` (in the pilot, `--analysis-max-spend-usd`).
  Without it, the run is refused by name (`MissingAnalysisSpendCapError`) before Jev or any review
  provider is built. A free review (`fake`) needs no cap. Cesar's policy is at most $20 per run;
  that is a policy for choosing the flag's value, not a limit in the code.
- `--review-token-budget` must be a positive integer, or the run is refused by name
  (`InvalidReviewTokenBudgetError`) before anything is built.
- Before any call, the review's worst case must fit under the cap, or the run is refused by name
  (`AnalysisSpendCapError`). The worst case is `--review-token-budget` × the model's highest
  per-token price (input, cache or output, at the long-context tier where one exists) × 3. The 3 is
  `CLAUDE_MAX_ATTEMPTS`: the Claude provider turns the SDK's own retries off on every request,
  including through an injected client, and retries a 429, 529 or other 5xx itself, up to three
  attempts per call. A retry waits what `Retry-After` asks, clamped to 60 seconds
  (`MAX_RETRY_WAIT_MS`). Every attempt is admitted against a game's cap through `admitSpend` and
  passes the warm gate, so a game's cap counts every attempt too. Prices come from
  `packages/llm/src/anthropic-pricing.ts`; for `claude-haiku-5-5`, the default 200,000-token budget
  comes to $1.50.
- A review model without a price (any OpenAI model, or an unlisted Claude model) is refused
  (`UnpricedReviewModelError`), because its spend cannot be bounded.
- Each Claude attempt reserves its own worst case, priced by the provider from its request bytes and
  output cap, against the cap and the monthly spend ledger. It settles to its actual cost; a failed
  attempt or unknown usage keeps the reservation. An attempt that would not fit is not sent; its
  review and every later one are marked `skipped_spend_cap` (`ReviewSpendLimitError`).
- A review's cost is known only when every attempt settled at its actual cost. Otherwise it is
  unknown, and the provider reports `heldUsd`, the total the ledger recorded for the call.
- The report's `spend` block, also summarized in `analysis.md`, holds the cap, the review's worst
  case, its reported cost (`reviewActualUsd`, unknown once any review's cost is unknown), and what
  the ledger recorded (`reviewHeldUsd`). `analysis.md` shows an unknown cost as "unknown (held $X)".

## Reusable Day 1 bases

For journal experiments, run Day 1 once with
`--provider openai --model gpt-6-luna --effort xhigh --decision-engine jev --pause-at-first-night`.
Keep the database and output in a private directory under `data/`. At the pause, capture a base with
the exact gameplay source revision:

```bash
mkdir -p data/checkpoints
python3 scripts/checkpoint.py capture \
  --db data/pilots/day1/game.db --game GAME_ID \
  --out data/checkpoints/day1 --source-revision "$(git rev-parse HEAD)"
python3 scripts/checkpoint.py inspect --base data/checkpoints/day1
python3 scripts/checkpoint.py fork \
  --base data/checkpoints/day1 --out data/pilots/experiment-01
npm run pilot -- --provider openai --model gpt-6-luna --effort xhigh \
  --decision-engine jev --db data/pilots/experiment-01/game.db \
  --game GAME_ID --resume --snapshot --out data/pilots/experiment-01
```

The helper requires Python 3 and an existing output parent. Capture and fork destinations must be
new directories. It accepts only a paused, day-first `journal_v4` game before any Night 1 work, with
no unresolved decisions or provider calls. Archived workflows cannot be relabeled as current ones.

The base is a consistent SQLite backup with read-only permissions and a SHA-256 manifest. Forks have
separate writable databases and preserve all roles, journals, decisions, usage, and frozen
configuration. They retain the same game ID, so distinguish experiments by directory and do not
combine their databases. Never resume the base itself. Each `fork.json` records the base hash,
source revision, event boundary, and inherited usage; subtract that usage when comparing
continuation costs. Resuming does not reset safety budgets or change the game's model settings.
These files contain private game evidence and remain excluded from publication.

## Verification and production-style local run

See [Contributing](../CONTRIBUTING.md) for the enforced formatting, lint, complexity, typing, and
test commands. The offline suite covers deterministic rules, private information boundaries,
auctions, reflection, recovery, API contracts, replay, complete fake-provider games, and browser
workflows.

For a production-style local run:

```bash
npm run build
npm run start:api
# In another terminal:
npm run start:runner
```

The built UI is served by the API at [http://127.0.0.1:4310](http://127.0.0.1:4310). This is
trusted-local tooling, not multi-user security: moderator views, player/team secrets, journals, and
applicable exports contain sensitive game data, and SQLite stores it in plaintext. Provider requests
are exact application prompts and schemas; they do not expose or represent hidden provider
chain-of-thought. Usage may be unknown, and Codex reports `outputLimitEnforced: false`; V2/V3
admission conservatively reserves unknown usage and cost estimates are lower bounds when usage or
pricing is incomplete.
