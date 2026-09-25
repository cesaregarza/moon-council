# Contributing to Moon Council

Start with the [architecture map](docs/ARCHITECTURE.md) and the tests beside the module you are
changing. The aim is understandable experiments: a reader should be able to trace a player's
information, submitted choice, validation, and committed event.

## Local setup and checks

Use the Node version in `.nvmrc`. Python 3.10+ runs the checkpoint and publication utilities; CI
uses Python 3.10. Install the development tools in a virtual environment:

```bash
npm ci
python3 -m venv .venv
. .venv/bin/activate
python3 -m pip install -r requirements-dev.txt

npm run format
npm run format:python
npm run check
npm run lint:python
npm test -- --maxWorkers=2
python3 scripts/test_checkpoint.py
python3 scripts/test_public_snapshot.py
npm run build
npx playwright install chromium
LLM_PROVIDER=fake npm run test:e2e
```

Run these from the repository root. `npm run check` checks formatting, lint, complexity, and types;
it does not rewrite files. `npm run lint:fix` applies the linter's safe fixes, which still need
review. The Python tools are separate so TypeScript-only work does not need a Python environment. CI
enforces both toolchains along with tests, production build, browser checks, and publication-history
checks. Use `LLM_PROVIDER=fake` and a disposable `DATABASE_URL` for integration work. Live provider
tests are opt-in; ordinary verification must not consume provider usage.

## Style and typing

[Prettier](https://prettier.io/docs/options) formats TypeScript, TSX, CSS, JSON, Markdown, HTML, and
YAML with a **100-column target**. [Ruff](https://docs.astral.sh/ruff/configuration/) formats and
lints the Python scripts at the same target width. `.editorconfig` defines UTF-8, LF, spaces, and
final newlines. Configure your editor to use the committed settings rather than a personal style.

Print width is a readability target, not a hard character limit. URLs and indivisible strings can
exceed it. Prompt literals and evidence text must retain their bytes; embedded-language formatting
is disabled so a formatter does not rewrite a model's input. Break up surrounding code instead of
inserting newlines into protocol text. Evaluation JSON is retained as a recorded artifact.

TypeScript already uses `strict` and `noUncheckedIndexedAccess`.
[Oxlint's type-aware checks](https://oxc.rs/docs/guide/usage/linter/type-aware) add correctness,
unused code, explicit `any`, promise handling, and hook-dependency checks. Use inferred schema types
for contracts and `unknown` plus validation at external boundaries. An unchecked cast does not
validate JSON. Do not replace `any` with `as never` to satisfy a rule.

Handle rejected promises. UI callbacks may use `void` only when the asynchronous function handles
its failures. The React `set-state-in-effect` heuristic is disabled because observer effects fetch
and synchronize external state; hook dependencies and other correctness rules remain enabled. Any
new suppression needs a local explanation. The existing codepoint-spread exception preserves
archived evidence truncation semantics.

## Keep complexity visible

Prefer named steps, explicit inputs, small functions with one responsibility, and early returns over
nested conditions or compressed expressions. Reuse a concept when it has a stable meaning; avoid a
generic abstraction that merely hides two unrelated branches. Fewer characters are not necessarily
less complexity. Kolmogorov complexity is not a computable code-quality score.

`npm run complexity` uses Oxlint's cyclomatic-complexity rule, with **20 as the ceiling for new
functions**. The checked-in [baseline](scripts/complexity-baseline.json) lists existing exceptions.
CI rejects a new exception or an increase beyond its allowance. It is a migration guard, not a claim
that the existing architecture is simple. Anonymous functions with the same description are compared
as a sorted group within their file; this cannot distinguish individual anonymous callbacks.

The largest remaining hotspots include decision-episode execution, submission validation, and the
observer room component. Separate those by stable responsibilities in focused changes with
regression coverage. Avoid rewriting the decision state machine as part of a mechanical formatting
change. After deliberately reducing debt, update the baseline with:

```bash
npm run complexity -- --write-baseline
npm run format
```

Review that diff. Do not regenerate it merely to make a failing check green. Tests and fixtures are
excluded from the complexity budget but remain formatted, linted, and typechecked. Cyclomatic
complexity does not measure architectural coupling, duplication, or domain clarity; review those
too.

## Preserve experiment contracts

- Keep the moderator authoritative. Validate choices before committing events.
- Project player information before constructing prompts; keep journals and sealed ballots private.
- Preserve archived protocol behavior. A journal change must not relabel old checkpoints.
- Treat prompt text, schemas, citation handles, and cache-prefix bytes as observable behavior.
- Keep formatting-only edits separate from semantic edits when practical. Explain behavior changes
  and test the affected boundary, rather than adding tests that merely repeat the implementation.

Provider keys, databases, journals, captured model requests, personal hostnames, and deployment
configuration stay out of Git. New public docs or root configuration files must be explicitly added
to `scripts/public-snapshot.py`'s allowlist. Run its source scan before committing and its history
verification before publishing. The scanner supplements review; it is not proof that a file is safe.

```bash
python3 scripts/public-snapshot.py --source . --output /tmp/moon-council-export --scan-only
python3 scripts/public-snapshot.py --source . --verify-history
```
