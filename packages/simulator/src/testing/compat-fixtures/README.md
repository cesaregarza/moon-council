# Compatibility fixtures (CES-1558)

Games written by the code before revisions were keyed by event sequence, each paused with work in
flight. `revision-compat.test.ts` loads them into a fresh database and resumes them with the current
code.

- **Source commit:** main `fe60af88c659224e719bd7ece8c1ac0a9f07efd9`, with fake providers (no model
  or Jev calls).
- **Generator:** `generate-compat-fixtures.ts` (sha256
  `e737ff1f89ea747badb21e7538a2b96775d6644084b078ac9031647b802974de`), attached to CES-1558. It
  isn't committed.
- **Command,** from the root of a checkout at that commit, with Node 24.19.0:
  `node --import tsx generate-compat-fixtures.ts OUT_DIR`
- **Format:** each file is the JSON the generator wrote (every row of the game's tables), gzip
  compressed at level 9 with mtime 0, then base64 with 76-character lines. The rows are exactly as
  the old code stored them; nothing was edited. `scripts/public-snapshot.py` scans these files as
  the JSON they decode to.
- **Integrity:** the loader checks each decoded file against the sha256 below before using it.

| Fixture           | Pause point                                                                                                                                                                                         | Decoded sha256                                                     |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `mid-refresh`     | Day 1 discussion. One seat's journal_update failed (a scripted outage), so its reflection is open.                                                                                                  | `a6e1cf6d6c41c45b1338a4000c07e36de6c7a1ca51892714ef64524a831da916` |
| `mid-auction`     | The same game, resumed to the next pause. After the day's first speech, one seat's bid failed, the other bids are submitted, and the auction (its key embeds that speech's event ID) is unresolved. | `317d468c983704f6a95442c7a2defc0888cdc0e15d198685ecaf6acfc68b6ec8` |
| `pending-ballot`  | The same game, resumed to the Day 1 vote. One voter's ballot failed, and the other seven ballots are saved but not committed. A Jev journal_v4 game whose seats hold decision briefs.               | `9ca32fd62eb63a179247a9e9349d2d94f1acc9f98997541384885b76847c441a` |
| `semantic-ballot` | The actor holdout `uncertain-last-wolf`. Its ballot `post-review-vote` is paused on a final semantically rejected Jev choice.                                                                       | `56cfa720bc5cbbc339f824dfd7889746f7753420b506fd54b65838f2a6e2aa7a` |
