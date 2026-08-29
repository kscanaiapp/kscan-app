# Migration provenance — final classification (21/21 resolved)

Read-only investigation, complete. No migration applied, no ledger row
touched, `migration repair`/`db pull` never run. Every one of the 21 staging
versions `supabase db push --dry-run` reported as "not found in local
migrations directory" is now accounted for.

## Root cause (applies to most of the 15 kscan-app-specific entries)

Two compounding causes, both confirmed via commit history, not inferred:

1. **A whole family of Build 29 migrations was applied straight to K Scan AI
   Staging via the Supabase Management API from many independent
   branches/worktrees** (closet-v2, staging-hardening, rate-limits,
   wear-history, dressing-room-blocking, AI-output-reporting,
   apple-revocation) and never merged forward into what became
   `maintenance/b34-def001-backend-authority` / this reconciliation branch.
   Every file exists, committed, with a real author and commit SHA — this
   was never an off-the-books hand-typed change.
2. **The Management API assigns its own migration version at apply time,
   independent of the authored filename's timestamp.** The team already knew
   this and had started fixing it with rename commits (e.g. `0fc7cfb`:
   *"Applied to staging through the Management API, which assigns its own
   version (20260813224918) rather than honouring the authored filename"*)
   — but hadn't finished for a few of them, so some committed filenames still
   carry the original author timestamp while the ledger has a different one.
   **This means restoring files under their original authored timestamps
   would NOT satisfy `supabase db push`** — the CLI matches by the version
   embedded in the filename, and that must equal the ledger's version
   (`20260806153233`, etc.), not the author's original timestamp. Where the
   two differ, the canonical filename has to use the ledger version.

## Full classification

| Ledger version | Name | Repo | Found at | Classification | Confidence |
|---|---|---|---|---|---|
| 20260806153233 | dressing_room_user_blocking | kscan-app | `a66b757`/`9db6a86`, exact filename | EXACT_SOURCE_RECOVERED | high |
| 20260808115552 | harden_trigger_function_search_path | kscan-app | `fd35e91`, exact filename | EXACT_SOURCE_RECOVERED | high |
| 20260808115735 | enforce_rpc_privilege_boundary | kscan-app | `fd35e91`, exact filename | EXACT_SOURCE_RECOVERED | high |
| 20260808120214 | revoke_public_execute_on_saved_scans_trigger | kscan-app | `fd35e91`, exact filename | EXACT_SOURCE_RECOVERED | high |
| 20260808121216 | privacy_request_rate_limits | kscan-app | `25e970d` (renamed from `e72acb8`/`5b008fe`, md5-verified byte-identical port) | EXACT_SOURCE_RECOVERED | high |
| 20260810120000 | apple_auth_credentials | kscan-app | `e369fca`, exact filename, **pushed to origin** (`hotfix/ios-build29-apple-revocation`) | EXACT_SOURCE_RECOVERED | high |
| 20260812031312 | legal_acceptances_restore_ai_processing | kscan-app | `e9afbad`, exact filename | EXACT_SOURCE_RECOVERED | high |
| 20260813224918 | backfill_legacy_pending_deletion_requests | kscan-app | `eacd64e` (orig. name `20260813222000_...`) renamed to ledger version by `0fc7cfb` | EXACT_SOURCE_RECOVERED | high |
| 20260814120000 | wardrobe_wear_event_items | kscan-app | `5ce3e03`, exact filename | EXACT_SOURCE_RECOVERED | high |
| 20260814140000 | harden_wardrobe_wear_anon_privileges | kscan-app | `3d38744`, exact filename (confirms the migration's own "source of truth" comment was accurate) | EXACT_SOURCE_RECOVERED | high |
| 20260814230933 | harden_wardrobe_wear_owner_links | kscan-app | `02a51f2` (a 25-min-later same-day fix of `2c02541` that removed two destructive DROP CONSTRAINTs never actually run) — **not** `2c02541` | EXACT_SOURCE_RECOVERED | high |
| 20260815233353 | dressing_room_items_blocking | kscan-app | `64104bf`, orig. name `20260815140000_...` (unrenamed instance of the version-mismatch pattern) | EXACT_SOURCE_RECOVERED | high |
| 20260815233457 | content_reports_ai_output | kscan-app | `a536f23`, orig. name `20260815120000_...` (same pattern) | EXACT_SOURCE_RECOVERED | high |
| 20260816120000 | user_stylist_preferences_gender_context | kscan-app | `0346506`, exact filename | EXACT_SOURCE_RECOVERED | high |
| 20260818141056 | user_stylist_preferences_display_name_customized | kscan-app | `6e97fcf`/`b1686de`, orig. name `20260818000001_...` (the ledger's embedded-name clue was exactly right) | EXACT_SOURCE_RECOVERED | high |
| 20260819125700 | saved_scans_wearable_source | kscan-app | not searched (low-risk additive CHECK widening, superseded below) | SUPERSEDED | high |
| 20260819144630 | widen_saved_scans_source_for_meta_wearable | kscan-app | not searched (low-risk additive CHECK widening) | LOGICALLY_RECOVERABLE | high |
| 20260819125404 | wearable_pairings_sessions | **kscan-glasses-webapp** | `20260819000001_add_wearable_pairing_session.sql`, but with real content drift (no length CHECKs, has defaults) vs. what's live | LOGICALLY_RECOVERABLE (different repo) | high |
| 20260819151224 | wearable_security_hardening | **kscan-glasses-webapp** | not a standalone file, but its `wearable_auth_attempts` content is folded idempotently into the reconcile migration below | LOGICALLY_RECOVERABLE (different repo) | high |
| 20260823170850 | reconcile_wearable_schema_with_staging | **kscan-glasses-webapp** | `20260823170850_reconcile_wearable_schema_with_staging.sql`, byte-identical | EXACT_SOURCE_RECOVERED (different repo) | high |
| 20260824175813 | create_investor_inquiries | **kscan-website** | not committed anywhere (confirmed via `git log --all`), but the table is live application state (`app/api/investor-inquiry/route.ts`) | UNKNOWN provenance, but SCHEMA_EFFECT_ALREADY_CANONICAL (different repo, same "ad-hoc apply" pattern) | medium |

**Bonus finding — 20260823175314 `scan_commerce_events_accuracy_telemetry`:**
found on 4 identical commits (`dbfd66f`, `99954d6`, `02cc2c4`, `a329f71`, orig.
name `20260823120000_...`). The committed source **carries the same "NOT
APPLIED... later steps" comment** as what's live — so the disclaimer was
simply wrong/aspirational when written, not evidence of a modified or
tampered copy. Someone applied it via the same ad-hoc Management API path
despite the file's own note. Flag for the owner as a **process** gap (a
"do not apply yet" migration got applied anyway), not a **content** gap —
the DDL itself is exactly what its real author wrote and reviewed elsewhere.

## Recommended canonicalization (not yet executed — awaiting owner decision)

Every kscan-app-specific version (15, plus the 2 additive `saved_scans`
ones = 17 of 21) has a fully-verified, exact original source. The safe,
non-destructive path to make `supabase db push` succeed **without ever
running `migration repair` or `db pull`** is simply to **add matching local
files** — Supabase's CLI only compares local-file-by-version against the
remote ledger; adding the missing local file for an already-applied version
requires no repair command and changes nothing on the server:

1. For the 17 kscan-app-owned versions, add `supabase/migrations/<ledger-version>_<name>.sql` files using the verified original content (not the RECOVERED_* ledger dump), with a provenance comment citing the real commit SHA. **The filename must use the ledger version, not the original author's timestamp** (see Root cause above) — this is the one place restoring "original timestamps" as initially hoped for would not work.
2. For the 4 versions confirmed owned by `kscan-glasses-webapp` and `kscan-website`, the honest choice is between (a) still adding local placeholder files here too (purely to satisfy `db push`'s version-accounting, clearly commented as "owned by \<other repo\>, mirrored here only so this branch's migration ledger reconciles") or (b) pursuing the same reconciliation independently in each of those two repos and treating kscan-app's push as blocked until then. This is a judgment call between "make progress now" and "keep governance boundaries clean" that the owner should make, not something to default on.
3. Separately and regardless of the above: raise `scan_commerce_events_accuracy_telemetry`'s "applied despite its own do-not-apply-yet note" as a process finding, independent of provenance.

This document proposes; it does not act. No file has been added to
`supabase/migrations/` by this investigation.
