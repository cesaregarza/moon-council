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

| Fixture          | Pause point                                                                                                                                                                                                                                                                | Decoded sha256                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `pending-ballot` | The same game, resumed to the Day 1 vote. One voter's ballot failed, and the other seven ballots are saved but not committed. A Jev journal_v4 game whose seats hold decision briefs.                                                                                      | `9ca32fd62eb63a179247a9e9349d2d94f1acc9f98997541384885b76847c441a` |
| `saved-bid`      | CES-1575 part 3. An `auction_every_turn` game written by main `19017ee8c7814ec9e0d568812386dc60eb6152b1`: Gale's Day 1 speech challenges Briar, and Briar's `discussion_score` bid, its packet holding that speech in its response docket, failed (a scripted Jev outage). | `24a6ba49a30d22d6c72f1cb7b76edfacb16f4ce828a5677839e96b71d6b336c0` |

`saved-bid` comes from a separate generator, `generate-saved-bid.ts` (sha256
`492c630b409a6f82130c524d6e7f511ca0d187994dba75cd7979c97b4aacb72c`), attached to CES-1575 and not
committed. It was run from the root of a fresh checkout of main
`19017ee8c7814ec9e0d568812386dc60eb6152b1` with its own `npm ci`, Node 24.19.0, fake players and a
scripted Jev: `node --import tsx generate-saved-bid.ts OUT.json`. Encoding and integrity are as
above.
