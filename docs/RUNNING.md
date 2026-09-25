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
