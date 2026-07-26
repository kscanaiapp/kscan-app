# Forensic addendum — two unrecovered migration identities

Scope: recovery of the original historical SQL for the two production migrations whose
ledger records are placeholder stubs rather than SQL.

```
20260722191013  account_deletion_lifecycle
20260723021514  account_deletion_security_hardening
```

All work read-only. No production mutation. No Git history rewritten. No file moved.

## What the production ledger actually records

| Version | Recorded `statements` | Length |
|---|---|---:|
| `20260722191013` | `applied via lifecycle rollout` | 29 chars |
| `20260723021514` | `-- applied from 20260723021145_account_deletion_security_hardening.sql via file contents in follow-up if needed` + `select 1;` | 121 chars |

Neither is SQL that could produce the live schema. The first is prose. The second is a
comment plus a no-op. Both migrations were therefore applied out-of-band, and the ledger
cannot corroborate what content was executed.

## Evidence sources searched

| # | Source | Method | Result |
|---:|---|---|---|
| 1 | All local Git refs | `git log --all` over both migration paths | Exactly **one** blob variant each |
| 2 | All fetched remote refs | included in `--all` after `git fetch --all --prune` | No additional variant |
| 3 | Reflogs (1256 entries retained) | `git log --reflog` over both paths | Same 4 commits, no additional variant |
| 4 | Unreachable / dangling objects | `git fsck --lost-found` | **Partial** — enumeration exceeded the run window; see uncertainty |
| 5 | Existing worktrees (12 checked) | recursive filename search + SHA-256 | All copies content-identical |
| 6 | Historical workspace copies on disk | `find` across `C:\src` and `C:\Users\jsmit` | All content-identical (earlier hash differences were CRLF only) |
| 7 | Supabase CLI caches / local state | `~/.supabase` traces + telemetry | Traces cover **2026-07-15 → 07-21 only**; no coverage of the 07-22/07-23 application dates. No `db push` recorded in any retained trace |
| 8 | CI / build-agent artefacts | tracked CI config enumeration | No CI workflows exist (only `.github/copilot-instructions.md`) |
| 9 | Deployment / operational archives | content search of `qa-evidence`, `KScan-build-artifacts`, `KC05-repair-evidence` | No references |
| 10 | Migration evidence documents | `git grep` across `docs/` on both RCs | No references |
| 11 | Team handoff reports | same corpus as 9–10 | No references |
| 12 | Production migration records | read-only `select` on `schema_migrations` | Stubs only (above) |

## Candidates and provenance

### `20260722191013 account_deletion_lifecycle`

| Field | Value |
|---|---|
| Candidate file | `supabase/migrations/20260722191013_account_deletion_lifecycle.sql` |
| Candidate blob | `c390be58ab56` — 27,949 bytes |
| Distinct variants found | **1** (estate-wide) |
| Introducing commit | `892f258` *feat(privacy): complete account deletion lifecycle with Render restoration email* |
| Commit timestamp | 2026-07-22 21:59:12 −0400 = **2026-07-23 01:59:12 UTC** |
| Production applied | version `20260722191013` = **2026-07-22 19:10:13** |
| Timestamp relationship | Commit is **≈6h49m AFTER** production application |
| Filename/version match | **Exact** — filename version equals the production version |
| Confidence | **Low–moderate.** Exact version match and a single variant, but the file was committed hours after the migration was applied, and the ledger records prose. The committed file cannot be shown to be what executed. |

### `20260723021514 account_deletion_security_hardening`

| Field | Value |
|---|---|
| Candidate file | `supabase/migrations/20260723021145_account_deletion_security_hardening.sql` |
| Candidate blob | `ccf38617bd29` — 14,658 bytes |
| Distinct variants found | **1** (estate-wide) |
| Introducing commit | `5f35b57` *fix(privacy): harden deletion lifecycle and add restore client path* |
| Commit timestamp | 2026-07-22 22:20:13 −0400 = **2026-07-23 02:20:13 UTC** |
| Production applied | version `20260723021514` = **2026-07-23 02:15:14** |
| Timestamp relationship | Commit is **≈5 minutes AFTER** production application |
| Filename/version match | **No** — file version `20260723021145` ≠ production `20260723021514` |
| Corroboration | The production stub explicitly names this file by filename |
| Confidence | **Moderate.** Tight 5-minute correlation plus an explicit by-name reference in the stub. Still not proof: the stub says "via file contents in follow-up **if needed**", which does not assert that the content was applied, and the versions do not match. |

## Remaining uncertainty

- Source 4 (unreachable/dangling objects) was only **partially** enumerated; the full scan
  exceeded its execution window. A complete `git fsck` sweep could still surface an
  unreferenced blob, though sources 1–3, 5 and 6 all independently converge on a single
  variant, which makes an alternative variant unlikely.
- The live schema can corroborate present state. It is **not** presented here as proof of
  original historical SQL, and no SQL in this addendum was reconstructed from it.
- Neither candidate can be promoted to canonical without an owner ruling, because in both
  cases the production record is a stub and cannot confirm execution.

## Verdict

```
SOURCE UNRECOVERED — FORENSIC PASS COMPLETE
```

Report C migration reconciliation remains **FAIL / BLOCKED** pending a separate owner
ruling on reconciliation strategy. Permitted directions include continuing recovery from
newly identified evidence, establishing a non-replayable historical marker with a separate
canonical local-development baseline, or keeping schema work blocked.

No executable placeholder migration was created to satisfy the version ledger.
