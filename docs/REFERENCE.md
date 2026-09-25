# Game and API reference

The current testbed is Werewolf. These mechanics are specific to that environment.

## Role definitions

The Role Workshop edits the restricted `role_v1` JSON schema. Saving creates a new immutable
version. Mechanics are separate from model-facing descriptions:

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

Supported effects are `eliminate`, `protect`, `inspect_alignment`, `inspect_role`, `block`, and
`reveal`. Win predicates support alignment elimination, alignment parity, self survival, and nested
`all`, `any`, and `not` expressions. Action charges and target alignment constraints are enforced at
admission.

## API

Endpoint paths retain `/api/v1`; the application remains trusted-local and unauthenticated,
including V2 games.

- `GET/POST /api/v1/roles`
- `GET/POST /api/v1/games` (POST creates agent-protocol V3 games on the V2 rules schema; legacy
  snapshots remain readable)
- `GET /api/v1/games/:id?view=public|moderator|player|team&playerId=...&teamId=...&at=...`
- `POST /api/v1/games/:id/control`
- `GET /api/v1/games/:id/events`
- `GET /api/v1/games/:id/events/stream`
- `GET /api/v1/games/:id/decisions?view=moderator|player&playerId=...&at=...`
- `GET /api/v1/games/:id/decisions/:decisionId?view=moderator|player&playerId=...&at=...`
- `GET /api/v1/games/:id/export?view=public|moderator|player|team&playerId=...&teamId=...&format=json|jsonl&at=...`
- `GET/POST /api/v1/experiments`
- `GET /api/v1/experiments/:id`

Control actions are `start`, `pause`, `resume`, `step`, `step_decision`, `abort`, and `speed` at the
wire level. V2 observer controls use phase `step` and decision `step_decision`; legacy V1 control
attempts return `409` and the snapshot is replay-only. The background runner claims durable jobs
from SQLite. V1 repair/fallback can record a safe pass; V2 retries are bounded, and exhausted or
unresolved V2 work pauses without fabricating an action. Lease expiry also pauses the game and
requires explicit recovery.
