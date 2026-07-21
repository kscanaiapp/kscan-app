# DR-2 Overlap and Conflict Ledger

| File | DR-1 | E-4 | Class | Decision | Why | Test |
| --- | --- | --- | --- | --- | --- | --- |
| `attachmentContext.ts` | `dressing_room_item` + fetch | degradation outcomes; Closet-only sources | CLIENT-CONTRACT / BACKEND-WIRING | Keep both | Room attachments + degradation vocabulary | dr2SharedAuthorization |
| `index.ts` | owned room fetch via `dressing_room_id` | E-4 advice + wardrobe DS with buggy `room_id` | BACKEND-WIRING / AUTHORIZATION | Keep DR-1 column; merge E-4 advice; add shared fetch | Schema truth | dr2Integration |
| Canonical types/services | DR-1 only | unchanged | NO CONFLICT | DR-1 wins | Provenance authority | dressingRoom* tests |
| E-4 advice modules | absent | full pipeline | NO CONFLICT | Take E-4 | Styling intelligence | eliseAdviceE4 |
| `eliseWardrobeRetrieval.ts` | n/a | catalog→saved; else owned | PROVENANCE | DR-2 mapper: scanned/saved/unverified | Room ≠ ownership | roomItemRelationship tests |
| Client provider | no advice | adviceMetadata | FEATURE-FLAG | Gate with `ELISE_ADVICE_METADATA_CLIENT_V1` | Old-client safe | dr2Integration node |
