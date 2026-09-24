# Actor-perspective Jev decisions (`journal_v4`)

Jev decides **as the acting player** using that player's private facts, beliefs, role and win condition. Public proof is not a prerequisite for using private knowledge. The player LLM owns reflection and freely chooses speech content; its proposed preferences inform Jev without becoming forced actions. This applies to every seat and role, not a named character.

Each existing mandatory journal update also returns a current `decisionBrief`:

- `action`: current evidence, private certainty versus unverified claims, alternatives, intentions and deception; maximum 4,000 characters.
- `attention`: whom the player wants to hear and why, unanswered accusations, novelty, repetition and the player's urgency; maximum 3,000 characters.

Both are free text. A brief must refresh even when the long journal is unchanged. The application stamps the owner and a SHA-256 revision of the complete authorized meaningful evidence IDs, before context demotion. Another player's brief, a missing brief, or a stale revision cannot be used. The orchestrator refreshes it before decisions. A stale frozen opportunity pauses instead of silently substituting the full journal. Phase changes and pack points alone do not add reflection calls; current legal state and latest authorized pack points are delivered directly.

Votes and night choices receive only the action brief; auctions receive only the attention brief. Own inspections and published ballots are distinct from the brief's inferences. Choices describe actions (“Vote to eliminate …”, “Use Protect on …”), retain their stable handle-to-target mapping, and include neutral “Abstain from voting.” No vote question carries listening instructions. Pack pointing retains simultaneous openings and sequential followups.

The long freeform journal retains its 16,000 estimated-token default ceiling. This aggregate also charges the current brief. Compaction edits long-form prose only and preserves the brief, owner and revision exactly. Speech carries null memory fields. Reflection and speech share the versioned strict API envelope and stable caching prefix; v2/v3 workflows and saved games keep their original contracts.

## Bounded semantic handling

Transport/schema validity and semantic assessment are recorded separately. The first guard (`verified_last_wolf_ballot_v1`) applies only when the acting player's own terminal objective is elimination of all wolves, public role counts and revealed deaths prove one wolf remains, and their own verified inspection identifies that legal target. An abstention or another target triggers one Jev reconsideration containing the contradiction and original evaluation. The application never replaces it with a preferred move or an LLM's recommendation.

A persistent contradiction pauses before committing. The recorded checkpoint survives interruption; resuming cannot create unlimited retries. A terminal semantic rejection requires explicit inspection and supersession of that opportunity, not ordinary resume. Call/time/token admission still applies; insufficient budget pauses. A split distribution or low confidence alone does not establish wrong strategy. Uncertain village abstention, wolf deception, and ordinary protection/inspection decisions are not blocked by this narrow guard.

Private `decision.semantic_assessed` events retain rule version, applicability, issues, attempt ID and transport validity. Research review exposes them separately from returned distributions. Raw request/response, model version, usage and latency remain in the existing attempt records; other players and public views cannot read them. Jev provides no prose explanation.

## Verification

```bash
npm test -- packages/simulator/src/jev-actor.test.ts
npm run jev:actor-eval                 # offline case/prompt size report
npm run jev:actor-eval -- --live --out /native/private/new-evaluation-directory
```

The opt-in command runs eight synthetic scenarios once each, without loading saved games. It saves exact prompts, raw output, model version, distributions, usage, latency and semantic rubric results. It fails on invalid output or a rubric failure. The fixtures cover private certainty, another seat/name, justified abstention, wolf voting, protection, inspection, pack consensus and defense listening. Do not interpret a handful of passes or concentration scores as a calibrated accuracy estimate.

Initial live run (2026-09-24, Jev 1.13.0): **8/8 passed**. Seven action cases used 763–826 input tokens and 329–475 ms; the multi-question auction used 1,921 input tokens and 353 ms. No recorded game was mutated. No new full live game was run.

Matched archived-format run: **7/8 passed**; the private-certainty ballot missed its rubric. Across eight cases the revised format used 7,463 input tokens versus 23,425 (68% fewer). Total measured latency was 2,959 ms versus 3,057 ms; this single run does not establish a latency improvement. Both runs used Jev 1.13.0, with no retries, invalid responses or transport errors. The fixtures required no LLM calls; production refreshes the brief in the existing mandatory reflection, not an additional per-decision call.

[Complete synthetic inputs, raw distributions and comparison receipts](ACTOR_EVALUATION.json). Reproduce the baseline with `npm run jev:actor-eval -- --workflow journal_v3 --live --out /native/private/new-baseline-directory`. The report builder `scripts/jev-actor-report.ts` verifies that the saved revised inputs match the current generator before combining receipts.
