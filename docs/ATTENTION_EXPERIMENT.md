# Personality and attention experiment

This experiment asks whether a player who repeatedly contributes little useful information loses
listener interest, even when their desire to speak stays at its maximum. It measures peer responses;
it does not prescribe how anyone should react.

## Personalities

Each seat already has a private, free-text `personality` (up to 1,000 characters). The setup form
now has two editable presets: **Evidence-focused** and **Persistent rambler**. The first emphasizes
updating on evidence and contributing useful information. The second emphasizes repetitive,
digressive public speech while retaining the player's faction objective and honest private notes.

Only the owner receives that personality in their private context. Other players learn about the
behavior through public speech. They are not told who is the experimental subject, what personality
that seat has, or which urgency is overridden. A personality is a model instruction, so inspect the
actual speeches to check whether the intended behavior happened.

## Explicit urgency intervention

A new optional V2 game configuration field is available through the create-game API and runner:

```json
{
  "experiment": {
    "forcedUrgency": { "p3": 1.0 }
  }
}
```

Keys must identify configured seats and values must be between zero and one. The intervention is
supported for Jev's `journal_v4` listener auction. Omit the entire field for normal games.

After a successful Jev scoring call, the application replaces an **eligible** seat's urgency and
participation flag. Zero declines; positive values participate. It leaves every listening rating,
readiness response, eligibility rule, response docket, and speaking cap intact. It does not make a
seat eligible or force that seat to win.

`discussion.bid_submitted.payload.submission` and the provider attempt retain Jev's original answer.
`payload.intent` is the effective input to ranking. An accompanying `urgencyOverride` records the
original urgency/participation and forced urgency. The moderator configuration panel, research
export, and full game audit show the intervention. Public/player views do not disclose its config.
Archived configurations and games without the optional field retain their original behavior.

## Reproducible paired run

Preview configurations without calls or writes:

```sh
npm run attention:experiment -- --seed attention-rambler-1
```

Exercise mechanics with fake providers, or explicitly run OpenAI plus Jev:

```sh
npm run attention:experiment -- --fake --out data/attention-offline
npm run attention:experiment -- --live --model gpt-6-luna --effort xhigh \
  --seed attention-rambler-1 --out data/attention-live
```

The output directory must be new. The runner executes two fresh eight-player discussions, using
identical seeds, role assignments, models, and auction rules. The control gives everyone the
evidence-focused personality. The treatment gives the first seeded plain villager the rambler
personality and forces their urgency to 1.0. Choosing a plain villager avoids tying this particular
intervention to a special power; it is not disclosed to agents.

Both arms pause after Day 1 discussion, before any vote. Each has a default limit of 500 provider
attempts and 30 active minutes, configurable with `--max-calls` and `--max-minutes`. There is no
total token ceiling. Normal opening opportunities, consecutive-speaker exclusion, readiness quorum,
and two-follow-up-per-player limits remain unchanged. A missing or failed arm exits nonzero and
saves its available diagnostics. Do not treat the fake run as evidence of social behavior.

Artifacts include the manifest, separate SQLite databases, moderator research exports, invariant
audits, full audits, and a comparison containing attention series and provider usage. These contain
private fictional game evidence and belong outside public source. Existing provider configuration is
loaded only for `--live`; credentials are never written to these artifacts.

Monitor both arms without changing their databases or showing private notes:

```sh
npm run attention:status -- --out data/attention-live
```

## Reading the audit

`npm run game:audit -- --db PATH --game ID` adds `discussion.attention`:

- Each auction records eligibility, selected/declined status, urgency and overrides, raw/normalized
  interest, priority, and each listener's individual ratings and current attention note. A separate
  journal-update timeline includes reactions after the final auction.
- Floor share counts **committed non-closing public speeches**, not bids, selections, words, or
  closing responses. Prior share uses only speeches before an auction. Share after the auction
  counts speeches up to the next auction; an undelivered selection adds nothing.
- Day summaries split floor share by player, faction, and role. For at least three scored eligible
  auctions, they report Spearman correlation between prior floor share and raw listener interest.
  Tied ranks are averaged; insufficient or constant series return `null`. Missing/ineligible ratings
  are also `null`, never invented zeroes.

The full audit is for moderator analysis and includes private attention notes and roles. `--status`
remains a small monitoring view without these notes. The audit opens SQLite read-only.

A credible positive result needs the actual rambler speeches, listeners identifying repetition or
low information in their own notes, lower subsequent interest, and a distinction between auction
losses and mechanical ineligibility. Attention can also increase because others want a suspect to
answer a question. Correlation alone does not establish a cause.

This is one paired stochastic trial. A seed fixes the game assignment and tie order, not model
outputs. Personality and forced urgency change together, so the pair does not isolate their
individual effects. More seeds and a rational-but-forced-urgency arm would be follow-up experiments.
