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

Every analysis run calls Jev, so every run spends real credit and needs `--max-spend-usd` (in the
pilot, `--analysis-max-spend-usd`). Without it, the run is refused by name
(`MissingAnalysisSpendCapError`) before Jev or any review provider is built. Cesar's policy is at
most $20 per run. That is a policy for choosing the flag's value, not a limit in the code.

The cap enforces an estimate made under the assumptions below. It is not a guaranteed ceiling on the
bill. Before the first paid call, the analyzer builds every Jev request from the stored game and
sums a worst case over every paid call site:

| Call site                                                                                                      | Attempts                                                                                           | Worst case per call                                                                          |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Jev prediction, one per decision with a signal, before selection: `askJev` in `scripts/lib/analyze-moments.ts` | 1: ask-jev sends one request with no automatic retry (`~/.local/bin/ask-jev`, its `--help` epilog) | (request bytes + 512) × $0.042/M × 1.5                                                       |
| Review, one per selected moment, recall checks included: `reviewOne` in `scripts/lib/analyze-review.ts`        | 3: one plus the Anthropic SDK's default two retries                                                | the whole `--review-token-budget` × the model's highest per-token price × 3, for all reviews |

The recall check selects from moments Jev has already predicted, so it makes no Jev call of its own.
No other path in the analyzer spends.

- **Jev bound.** A Jev call's billed input token count is assumed never to exceed the UTF-8 byte
  count of the full request as the client sends it, plus 512 tokens for any provider-side framing.
  The request is measured as JSON with a one-space indent, which is never shorter than what ask-jev
  sends (it re-serializes with Python's `", "` and `": "` separators).
- **Evidence.** ask-jev's request logs record each request and its billed `input_tokens`: 2,421
  calls on the desktop (2026-09-23 to 2026-10-21, all `jev-1.13.0`) and 3 on the Pi. Across these
  2,424 calls, billed input tokens ranged from 0.216 to 0.567 of the request's bytes as sent, so the
  bound held in every call. The smallest request (884 bytes) billed 501 tokens. A fixed framing
  overhead is therefore at most 501 tokens, which the 512-token allowance covers even for a request
  smaller than any logged. These are logged calls, not a vendor guarantee.
- **Billing semantics.** Input-only billing is the disclosed model. TypeSafe's home page
  (https://typesafe.ai) prices only input, at $42 per billion input tokens. The jev skill
  (`~/.claude/skills/jev/SKILL.md`, lines 9 and 10) documents "input-only billing". Zuplo's gateway
  documentation (https://zuplo.com/docs/ai-gateway/jev) says output tokens are free. If TypeSafe
  ever billed output, this estimate would not cover it, and Jev has no output cap to bound it with.
- **Rate.** $0.042 per million input tokens, from the jev tooling
  (`~/.claude/skills/jev/scripts/jev.py:182`, `tokens * 0.042 / 1e6`). It is a local assumption,
  matched by the home page above, with a 1.5 margin over it.
- **Review prices.** Taken from `packages/llm/src/anthropic-pricing.ts` (Anthropic's pricing page,
  read 2026-10-22). For `claude-haiku-5-5` the highest rate is $2.50 per million, so the default
  200,000-token budget is $1.50 with every attempt counted.
- **Unpriced providers.** A review model without a price (any OpenAI model, an unlisted Claude
  model) is refused (`UnpricedReviewModelError`), because its spend cannot be bounded.

If the worst case exceeds the cap, the run is refused by name (`AnalysisSpendCapError`) with no Jev
or review call. Otherwise Claude reviews run under a per-call check:

- Each review reserves its own worst case, which the provider prices from its request bytes and
  output cap. The reservation counts against what the cap leaves after Jev's worst case, and against
  the monthly spend ledger.
- The reservation then settles to the reported cost. Unknown usage keeps the reservation.
- A call that would not fit is not sent. It and every later review are marked `skipped_spend_cap`
  (`ReviewSpendLimitError`).

Jev's spend is bounded only by the preflight, because Jev reports tokens but no cost.

The report's `spend` block, also summarized in `analysis.md`, holds the cap, the estimated worst
case (Jev, review, total) and the actual usage. The actual Jev cost is the reported input tokens at
the assumed rate, with no margin. The actual review cost is the reported cost. Either one is unknown
when any call's usage is unknown.

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
