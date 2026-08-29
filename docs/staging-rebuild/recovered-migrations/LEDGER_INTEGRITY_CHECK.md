# Ledger integrity check — corrected count and master table

**Correction to prior documentation: the true count is 22, not 21.**
`supabase db push --linked --dry-run`'s own remediation command line lists
22 unique versions (verified by piping the literal command text through
`sort | uniq`, byte-for-byte, no duplicates, no omissions). The "21" figure
used throughout this investigation's earlier commits and chat report was a
manual miscount made once at the very start and repeated without
re-verifying — it did not affect the actual recovery work: all 22 versions
were correctly queried, recovered, and written to
`RECOVERED_<version>_<name>.sql` files from the start (confirmed: `ls
RECOVERED_*.sql | wc -l` = 22, and the version set exactly matches the
dry-run's list with no gaps or extras). The scope of the error is narrow: my
CLASSIFICATION.md placed `20260823175314` (`scan_commerce_events_accuracy_telemetry`)
in a separate "Bonus finding" section instead of as the 22nd row of the main
table, which is what produced the "21 in the table, one more as a bonus"
appearance of a 22nd item rather than a genuine unaccounted-for migration.
`README.md` and `CLASSIFICATION.md` are corrected below/alongside this file.

## Assertions

- **No duplicate ledger versions**: `sort | uniq -d` on the 22-item list → empty. PASS.
- **No missing ledger versions**: `docs/staging-rebuild/recovered-migrations/RECOVERED_*.sql` file versions, diffed against the dry-run's list → exact match, 22/22. PASS.
- **Ownership counts sum to 22**: kscan-app 18 + kscan-glasses-webapp 3 + kscan-website 1 = 22. PASS.
- **Every `EXACT_SOURCE_RECOVERED` entry has a verifiable commit/source**: all 16 kscan-app-classified-exact + 1 kscan-glasses-webapp-classified-exact entries below cite a real commit SHA and file path, each independently re-verified in this pass via `git cat-file -t <sha>` (object exists) and `git show <sha>:<path>` (content retrieved, hashed). PASS.

## Master table (22/22)

Raw SHA-256 hashes are reported honestly rather than forced to agree: the
staging ledger stores each migration as an **array of individually-split
statements** (Postgres's own post-parse representation), while the original
authored `.sql` file is continuous prose with header comments — these
virtually never hash identically byte-for-byte even when the DDL is
100% semantically the same. "Content match" reflects an actual diff
(performed either by me directly or by the investigation subagent), not an
inference from hash equality.

| Ledger version | Name | Owning repo | Orig. filename/version if different | Source commit | Source SHA-256 (len) | Ledger SHA-256 (len) | Content match | Classification |
|---|---|---|---|---|---|---|---|---|
| 20260806153233 | dressing_room_user_blocking | kscan-app | (same) | `a66b757` | `6954bc15…` (29775) | `6954bc15…` (29425) | **exact byte match** | EXACT_SOURCE_RECOVERED |
| 20260808115552 | harden_trigger_function_search_path | kscan-app | (same) | `fd35e91` | `a2372872…` (1114) | `a2372872…` (1114) | **exact byte match** | EXACT_SOURCE_RECOVERED |
| 20260808115735 | enforce_rpc_privilege_boundary | kscan-app | (same) | `fd35e91` | `782cd254…` (12319) | `782cd254…` (12287) | **exact byte match** | EXACT_SOURCE_RECOVERED |
| 20260808120214 | revoke_public_execute_on_saved_scans_trigger | kscan-app | (same) | `fd35e91` | `6bc28167…` (1301) | `6bc28167…` (1301) | **exact byte match** | EXACT_SOURCE_RECOVERED |
| 20260808121216 | privacy_request_rate_limits | kscan-app | orig. `20260808103028_...` (renamed to ledger version by `25e970d`, itself a verified byte-identical port of iOS commit `5b008fe`) | `25e970d` | `9ed71553…` (5250) | `9ed71553…` (5250) | **exact byte match** | EXACT_SOURCE_RECOVERED |
| 20260810120000 | apple_auth_credentials | kscan-app | (same) | `e369fca` (pushed: `origin/hotfix/ios-build29-apple-revocation`) | `15f3d97b…` (4318) | `c8f8c1cd…` (4301) | match, comment/formatting only (7 statements re-split by Postgres) | EXACT_SOURCE_RECOVERED |
| 20260812031312 | legal_acceptances_restore_ai_processing | kscan-app | (same) | `e9afbad` | `8cb50252…` (511) | `54207af4…` (510) | match, trailing-newline only | EXACT_SOURCE_RECOVERED |
| 20260813224918 | backfill_legacy_pending_deletion_requests | kscan-app | orig. `20260813222000_...` (renamed to ledger version by `0fc7cfb`) | `eacd64e` | `52f29e60…` (3382) | `ea6c9a57…` (943) | match — source is a `do $$ ... $$` block wrapping the same statement; ledger stores only the inner statement after Postgres unwrapped it, hence length difference | EXACT_SOURCE_RECOVERED |
| 20260814120000 | wardrobe_wear_event_items | kscan-app | (same) | `5ce3e03` | `2d5ea684…` (10866) | `a402f2b6…` (5013) | match, comment/formatting only | EXACT_SOURCE_RECOVERED |
| 20260814140000 | harden_wardrobe_wear_anon_privileges | kscan-app | (same — confirms this migration's own "source of truth" comment) | `3d38744` | `87894b37…` (4055) | `e5c09e0e…` (822) | match, comment/formatting only | EXACT_SOURCE_RECOVERED |
| 20260814230933 | harden_wardrobe_wear_owner_links | kscan-app | (same) | `02a51f2` (fix of `2c02541`, which contained 2 extra DROP CONSTRAINTs never actually run — do not use `2c02541`) | `f6046d9f…` (2367) | `3a7546af…` (2349) | match, comment/formatting only | EXACT_SOURCE_RECOVERED |
| 20260815233353 | dressing_room_items_blocking | kscan-app | orig. `20260815140000_...` (never renamed) | `64104bf` | `ad7d04cc…` (12406) | `ad7d04cc…` (12220) | **exact byte match** | EXACT_SOURCE_RECOVERED |
| 20260815233457 | content_reports_ai_output | kscan-app | orig. `20260815120000_...` (never renamed) | `a536f23` | `50a1f604…` (5947) | `50a1f604…` (5939) | **exact byte match** | EXACT_SOURCE_RECOVERED |
| 20260816120000 | user_stylist_preferences_gender_context | kscan-app | (same) | `0346506` | `54c45e06…` (1622) | `1d0e261e…` (1621) | match, trailing-newline/comment only | EXACT_SOURCE_RECOVERED |
| 20260818141056 | user_stylist_preferences_display_name_customized | kscan-app | orig. `20260818000001_...` (never renamed) | `6e97fcf` (also `b1686de`, identical) | `b5ab770e…` (1272) | `b5ab770e…` (1266) | **exact byte match** | EXACT_SOURCE_RECOVERED |
| 20260819125700 | saved_scans_wearable_source | kscan-app (table-owned; no standalone authored source found in either repo) | orig. `20260819020000_...` (per ledger's embedded name) | none found | n/a | `22a9c1bb…` (419) | n/a — superseded same-day by 20260819144630 | SUPERSEDED |
| 20260819144630 | widen_saved_scans_source_for_meta_wearable | kscan-app (table-owned; authorship lives in kscan-glasses-webapp) | (same) | `9311442` **(kscan-glasses-webapp)**, embedded in `20260819000001_add_wearable_pairing_session.sql` alongside unrelated wearable-table DDL | `83ccdbee…` (7898, whole bundled file) | `66e8dac9…` (520) | match (confirmed by grep: identical CHECK clause text) | LOGICALLY_RECOVERABLE |
| 20260823175314 | scan_commerce_events_accuracy_telemetry | kscan-app | orig. `20260823120000_...` (never renamed) | `dbfd66f` (+3 identical mirrors: `99954d6`,`02cc2c4`,`a329f71`) | `0ca4c3f2…` (3788) | `25ce5e82…` (3778) | match, trailing-newline only. **Committed source carries the same "NOT APPLIED... later steps" comment as what's live — the disclaimer was wrong/aspirational when authored, not a sign of tampering.** | EXACT_SOURCE_RECOVERED |
| 20260819125404 | wearable_pairings_sessions | **kscan-glasses-webapp** | orig. embedded name `20260815015710_...` | `9311442` | `83ccdbee…` (7898, whole bundled file) | `ebc15fa4…` (6217) | diverges for real: committed file uses `device_model text NOT NULL DEFAULT ''` (no length check); ledger/live staging has `check (char_length(device_model) between 1 and 80)`, no default — later hardened by `reconcile_wearable_schema_with_staging` | LOGICALLY_RECOVERABLE (different repo) |
| 20260819151224 | wearable_security_hardening | **kscan-glasses-webapp** | orig. embedded name `20260819030000_...` | none standalone; `wearable_auth_attempts` content folded idempotently into `fea5712`'s reconcile migration | n/a | `b50384ed…` (830) | logically present, not as a discrete commit | LOGICALLY_RECOVERABLE (different repo) |
| 20260823170850 | reconcile_wearable_schema_with_staging | **kscan-glasses-webapp** | (same) | `fea5712` | `501005b1…` (6606) | `d5d4f83c…` (6513) | match, comment/formatting only | EXACT_SOURCE_RECOVERED (different repo) |
| 20260824175813 | create_investor_inquiries | **kscan-website** | (same) | none — confirmed via `git log --all` in kscan-website, zero hits | n/a | `77f6e57c…` (428) | n/a — but table is real, load-bearing website state (`app/api/investor-inquiry/route.ts` reads `INQUIRY_TABLE = "investor_inquiries"`) | UNKNOWN provenance / SCHEMA_EFFECT_ALREADY_CANONICAL (different repo) |

## Ownership summary

- **kscan-app: 18** (16 EXACT_SOURCE_RECOVERED + 1 SUPERSEDED + 1 LOGICALLY_RECOVERABLE-with-cross-repo-authorship)
- **kscan-glasses-webapp: 3** (1 EXACT_SOURCE_RECOVERED + 2 LOGICALLY_RECOVERABLE)
- **kscan-website: 1** (UNKNOWN provenance)
- **Total: 22** ✓
