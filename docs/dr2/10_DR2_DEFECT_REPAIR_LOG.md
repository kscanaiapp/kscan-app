# DR-2 Defect Repair Log

## F-1 P0 — E-4 wardrobe queries used `room_id`
- Wrong: `dressing_room_items` filtered/selected on nonexistent `room_id`.
- Why: retrieval returned empty under flags ON → advice silently starved.
- Root: E-4 DS mismatch vs schema (`dressing_room_id`).
- Fix: index.ts + retrieval readers use `dressing_room_id` (compat alias `room_id` on rows).
- Disposition: **REPAIRED AND VERIFIED**
- Tests: dr2Integration Deno/Node; E-4 suite still green.

## F-2 P1 — Room presence labeled `owned`
- Wrong: non-catalog room rows defaulted to owned language.
- Why: false ownership / prohibited purchase implication.
- Root: `roomItemRelationship` default.
- Fix: scanned/saved/unverified mapper; shared language "Shared with you".
- Disposition: **REPAIRED AND VERIFIED**

## F-3 P1 — Shared evidence attachment missing
- Wrong: no `shared_item` contract; wardrobe shared only.
- Why: client could not attach stable shared refs with server auth.
- Fix: parse/resolve/fetchSharedDressingRoomItems + eliseSharedRoomAccess + flags.
- Disposition: **REPAIRED AND VERIFIED**

## F-4 P1 — Shared access without owner staleness on visual resolver
- Wrong: participant shortcut / missing owner match on `fetchSharedRoomAccess`.
- Fix: membership+share+owner staleness only; no public tokens.
- Disposition: **REPAIRED AND VERIFIED**

## F-5 P2 — adviceMetadata ungated on client
- Wrong: always passthrough when object.
- Fix: `ELISE_ADVICE_METADATA_CLIENT_V1` server+client gate; malformed omitted.
- Disposition: **REPAIRED AND VERIFIED**

## F-6 P2 — Platform source parity undocumented
- Fix: parity matrix + fixtures; shared RN contract; Expo ios/android config.
- Disposition: **REPAIRED AND VERIFIED** (runtime/physical remain gates)
