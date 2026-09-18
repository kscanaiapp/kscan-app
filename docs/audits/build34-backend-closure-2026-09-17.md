# Build 34 backend closure, canonicalization and freeze record

Campaign date: 2026-09-17
Environment: staging only (`yzqjvdfgefveprobvvyw`). Production (`wyyuqfdxucjksghsmhry`) was frozen.
Branch: `repair/build34-backend-closure-20260917`; PR [#437](https://github.com/kscanaiapp/kscan-app/pull/437) into `rebuild/backend-authority-v2` (not merged; owner decision)
Predecessor records: `build34-backend-hostile-baseline-2026-09-17.md`, `build34-backend-hostile-final-2026-09-17.md`

```text
EXECUTIVE_STATUS=BUILD34_BACKEND_READY_FOR_MOBILE_HANDOFF
PRODUCTION_ACCESSED=NO
PRODUCTION_QUERIED=NO
PRODUCTION_CHANGED=NO
AUDIT_INTRODUCED_DEFECTS=0
```

## 1. Live authority at campaign start

```text
CURRENT_RELEASE_BRANCH=release/kscan-pre-freeze-v1
CURRENT_RELEASE_SHA=c6ee31adb0932d4d476cc218c1a7bff434b10bc8
CURRENT_BACKEND_AUTHORITY_BRANCH=rebuild/backend-authority-v2
CURRENT_BACKEND_AUTHORITY_SHA=d24d4afd214b55ae10f9f360d82b83e8c29be0b9 (unchanged since the audit)
AUDIT_BRANCH_SHA=42a23de0bf3e33f9659571fcfaf93a205a736326 (codex/build34-backend-hostile-audit-20260917; local only, never pushed)
PR431_STATE=OPEN, draft, base release/kscan-pre-freeze-v1 (untouched)
OPEN_BACKEND_PRS=#434 (probe tooling), #435 (convergence + prod deploy path), #436 (prod deploy path); all open, unmerged
STAGING_FUNCTION_VERSIONS(start)=scan-identify v74, process-account-deletions v69, search-vinted-secondhand v59, commerce-watch-refresh v13, reconcile-orphan-media v2
STAGING_MIGRATION_LEDGER_COUNT(start)=171
START_SHA=d24d4afd214b55ae10f9f360d82b83e8c29be0b9
WORKTREE_PATH=C:/src/B34-BE-CLOSURE-20260917 (fresh worktree from origin/rebuild/backend-authority-v2)
PORCELAIN_BEFORE=CLEAN
```

Version integers here are one higher than the audit record states for the same
bytes. A Supabase function secret change re-provisions every function and
advances its version (observed again during this campaign). Byte readback, not
version numbers, is the parity evidence.

## 2. Task A: canonicalization of `2314d29b`

The authority tip had not moved, and `git merge-base` of the audit branch and
the authority is `d24d4afd`. The audit lineage is strictly linear, so it was
**fast-forwarded with its original SHAs**. The canonical candidate therefore
contains the exact commit staging was deployed from.

```text
AUDIT_COMMITS_TO_CARRY=d11d74a4 ebf80464 c83e7e05 9a95e6d0 c8574398 2314d29b 6e111780 1ce7cc79 42a23de0 (all 9)
AUDIT_COMMITS_ALREADY_PRESENT=none as commits. The source fixes for B34-BE-LIFE-001 (process-account-deletions),
  B34-BE-COST-001 (search-vinted-secondhand) and the B34-BE-STO-001 reconciler were already byte-identical
  on d24d4afd; staging was behind. The audit commits add their regression/negative-control tests.
AUDIT_COMMITS_OBSOLETE=none (20260916234025 was never a commit; it stays remote-only by declaration)
AUDIT_COMMITS_CONFLICTING=none on the authority. Open PR #435 carries differently versioned duplicates of the two
  reconciled migrations (20260917010000/20260917020000) plus frontend edits. Semantic conflict; whichever merges
  second must drop them.
CANONICAL_SOURCE_SEMANTIC_PARITY=PASS
  git diff 2314d29b..<candidate> outside docs/ contains only the closure changes listed in §7. Every
  staging-proven file (scan-identify, process-account-deletions, commerce-watch-refresh, reconcile-orphan-media,
  both migrations, the migration-authority manifest) is byte-identical to 2314d29b. search-vinted-secondhand
  differs by one erased type annotation, whose emitted JavaScript is byte-identical (B34-BE-GOV-005).
```

Repaired shipping functions after closure (all byte-identical on staging):

| Function | Finding | Staging proof |
|---|---|---|
| `scan-identify` | B34-BE-SEC-001 | 42/42 files; 401 boundaries (audit), unchanged bytes |
| `process-account-deletions` | B34-BE-LIFE-001 | 6/6 files |
| `search-vinted-secondhand` | B34-BE-COST-001 | 3/3 files after governed redeploy (run 35249867640); missing/malformed JWT → 401 |
| `commerce-watch-refresh` | B34-BE-GOV-001 | 15/15 files |
| `reconcile-orphan-media` | B34-BE-STO-001 | 1/1 file |

## 3. Task B: B34-BE-STO-001 governed invoker

```text
AVAILABLE_SCHEDULER_PATTERNS=GitHub Actions workflow with a protected `staging` environment secret
  (staging-account-deletion-worker.yml on master, daily cron; watchlist-tier2-sweep.yml and
  production-account-deletion-worker.yml, dispatch-only). pg_cron and pg_net are NOT installed; there are
  no database webhooks and no external scheduler.
SELECTED_PATTERN=.github/workflows/staging-orphan-media-reconciler.yml + scripts/invoke-orphan-media-reconciler.mjs
WHY_SELECTED=It is the repository's only established scheduler shape, it needs no new extension or service,
  and it mirrors staging-account-deletion-worker.yml (literal ref/slug, production deny, environment secret,
  sanitized summary).
SOURCE_AUTHORITY=PR #437 (workflow, invoker, 38 offline contract tests)
AUTH_MODEL=x-orphan-sweep-secret header carrying ORPHAN_MEDIA_SWEEP_SECRET (GitHub `staging` environment
  secret == Supabase function secret; rotated 2026-09-17, value never printed or stored)
RECONCILER_INVOKER=workflow_dispatch (operational now; registered via its pull_request contract job) plus a
  daily 09:40 UTC schedule that GitHub activates only when the file reaches the default branch
RECONCILER_AUTH=constant-time secret compare; anon/publishable keys rejected
DRY_RUN_DEFAULT=YES (kill switch absent = OFF; ORPHAN_MEDIA_SWEEP_DRY_RUN=true added as an independent lock)
DELETION_ENABLED=NO (no live mode exists in the invoker; any non-dry-run response fails the job with exit 3)
```

**Repeated dry-run idempotency.** No storage mutation happened between runs.

| # | Path | HTTP | CANDIDATE_COUNT | DISTINCT_OWNERS | TOTAL_BYTES | HAS_MORE | OBJECTS_DELETED | ERRORS |
|---|---|---|---|---|---|---|---|---|
| L1 | local, no body | 200 | 30 | 6 | 10662345 | false | 0 | none |
| L2 | local, hostile "live" body | 200 | 30 | 6 | 10662345 | false | 0 | none |
| L3 | local, `?dry_run=false` | 200 | 30 | 6 | 10662345 | false | 0 | none |
| G1 | governed run 35246921846 | 200 | 30 | 6 | 10662345 | false | 0 | none |
| G2 | governed run 35246973265 | 200 | 30 | 6 | 10662345 | false | 0 | none |
| G3 | governed run 35247031926 | 200 | 30 | 6 | 10662345 | false | 0 | none |

```text
DATABASE_MUTATIONS=0
  Before (16:09Z / 16:29Z) and after (16:36Z), all of these were identical:
    storage.objects count 36, style-library-images 30 / 10662345 B, objects signature 668c64c1…,
    orphan-owner objects 30, app_config signature a27c696c…, ledger 171 rows,
    public+storage DML counter 86117, storage DML counter 1299.
  Every invocation log line reports envDryRun:true and killSwitchEnabled:false; no removal event exists.
DRY_RUN_EXECUTIONS=6 (3 governed + 3 local)
DRY_RUN_IDEMPOTENT=YES
REAL_OBJECTS_DELETED=0 (the 30 historical objects are retained by design)
```

**Negative controls** (live, staging):

| Control | Result | Function log reason |
|---|---|---|
| auth missing | 401 | missing |
| `Authorization: Basic` | 401 | missing |
| empty `Bearer` | 401 | missing |
| non-token header value | 401 | mismatch |
| wrong secret, same length, header | 401 | mismatch |
| wrong secret, same length, bearer | 401 | mismatch |
| secret prefix only | 401 | mismatch |
| legacy anon JWT | 401 | anon_key |
| publishable key | 401 | mismatch |
| GET with valid secret | 405 | (method gate) |
| valid secret, dry-run parameter omitted | 200 dry_run | dry run |
| valid secret, body demanding live deletion | 200 dry_run | dry run |
| valid secret, `?dry_run=false&mode=live` | 200 dry_run | dry run |
| kill switch remains disabled | `killSwitchEnabled:false` on every run; clients cannot write `app_config` (INSERT 42501, UPDATE/DELETE 0 rows; rolled back) | n/a |

No response echoed a secret; no negative-control implementation was deployed.

```text
RECONCILER_SOURCE_CANONICAL=YES
RECONCILER_DEPLOYED=YES (byte-identical)
INVOKER_GOVERNED=YES
INVOKER_AUTHENTICATED=YES
DRY_RUN_DEFAULT=YES
DELETION_ENABLED=NO
REPEATED_DRY_RUN_SAFE=YES
REAL_OBJECTS_DELETED=0
B34_BE_STO_001=FIXED_STAGING_VERIFIED
```

Runbook: `docs/orphan-media-reconciler-operations.md`.

## 4. Task C: privacy function parity

Evidence hierarchy attempted, all read-only:

1. Management API bundle (MCP `get_edge_function`): HTTP 500 "Failed to retrieve function bundle", both functions.
2. CLI download, `--use-api` and legacy: HTTP 500, same message.
3. Deployment metadata: see below.
4. Governed CI provenance: none. Neither slug has ever been deployed by a workflow.
5. Commit-to-deployment receipt: none.
6. Runtime semantic contract: every request returns **404 `sb-error-code: NOT_FOUND_FUNCTION_BLOB`**, while a
   non-existent slug returns plain `NOT_FOUND` and `staging-health` OPTIONS returns 200.
7. Metadata and timestamps: correlated below.

```text
FUNCTION=public-sale-share-opt-out
GOVERNED_SOURCE_PATH=kscan-website: supabase/functions/public-sale-share-opt-out/index.ts (not this repository)
GOVERNED_SOURCE_SHA=eed83bae0d3c14f7ff50c0ad1ea41ce53a481f96 (blob 5c322af1, the only blob in that file's history)
STAGING_VERSION=v13, ACTIVE, verify_jwt=false, created=updated=2026-05-15T12:22:42Z, ezbr c17dd4cb…
READBACK_METHOD=MCP bundle (500), CLI --use-api (500), CLI legacy (500), 13 non-mutating contract probes, edge logs
BYTE_PARITY=IMPOSSIBLE (the platform no longer holds the bundle)
SEMANTIC_PARITY=FAIL. 0/13 source-derived contract probes matched; all returned 404 NOT_FOUND_FUNCTION_BLOB.
  website_sale_share_opt_out_requests was unchanged (8 rows, signature b159447e…).
DEPLOYMENT_PROVENANCE=API-bundler deploy (/tmp/user_fn_…_1 path shape) 77 minutes BEFORE the source commit
  (13:40:02Z), i.e. from an uncommitted working tree; no CI receipt
CONFIDENCE=HIGH that the deployed function cannot execute; LOW on which bytes v13 contained
UNKNOWN_REMAINS=the exact v13 bytes (unrecoverable); whether the live website points at this ref

FUNCTION=privacy-controls
GOVERNED_SOURCE_PATH=NONE. No source in kscan-app, kscan-website (all 47 branches, full history) or on disk.
GOVERNED_SOURCE_SHA=NONE
STAGING_VERSION=v13, ACTIVE, verify_jwt=true, created=updated=2026-05-14T02:13:55Z (68 minutes after project creation), ezbr eb8f9b07…
READBACK_METHOD=MCP bundle (500), CLI --use-api (500), CLI legacy (500), OPTIONS/GET probes, edge logs
BYTE_PARITY=IMPOSSIBLE (bundle absent and no source exists)
SEMANTIC_PARITY=FAIL. OPTIONS (no auth / anon) and GET → 404 NOT_FOUND_FUNCTION_BLOB (before any JWT check).
DEPLOYMENT_PROVENANCE=API-bundler deploy on project creation day; no commit, no CI receipt
CONFIDENCE=HIGH that the deployed function cannot execute
UNKNOWN_REMAINS=its original contract; no caller exists in the mobile release line or the website
```

```text
PRIVACY_CONTROLS_PARITY=BOUNDED_UNKNOWN_WITH_NON_BLOCKING_CLOSURE_CONDITION (resolved to: bundle absent, non-executable)
PUBLIC_SALE_SHARE_OPT_OUT_PARITY=BOUNDED_UNKNOWN_WITH_NON_BLOCKING_CLOSURE_CONDITION (resolved to: bundle absent, non-executable)
BLOCKS_BACKEND_FREEZE=NO. Neither slug is a Build 34 governed or shipping surface; neither has a mobile caller.
BLOCKS_PRODUCTION_MIGRATION=NO. Both are EXCLUDE_FROM_BUILD34_PRODUCTION_MIGRATION.
BLOCKS_POST_MIGRATION_VERIFICATION=website privacy stack only (separate owner)
CLOSURE_CONDITION=website owner redeploys public-sale-share-opt-out from kscan-website and retires or recovers
  privacy-controls, then the probe set in the migration manifest is re-run.
```

**WEBSITE-PRIV-001 (external escalation, not a Build 34 backend finding).** At
2026-09-17T16:36:41Z, a real browser preflight (Windows Chrome) to
`public-sale-share-opt-out` received 404. `kscan-website/.env.example`
documents this ref as the website's waitlist/privacy project. If the live
Do-Not-Sell/GPC page uses it, opt-out preferences cannot be read or recorded
server-side. A redeploy plan is prepared in the migration manifest. It was
**not** executed, because the target is a live website dependency outside this
authority. The redeploy cannot regress behaviour, since the function currently
serves nothing.

## 5. Task D: wearable scope

```text
WEARABLE_BUILD34_SCOPE=OUT
```

Evidence (release `c6ee31ad`):
- There is no `wearable-*` source under `supabase/functions`, and no mobile
  caller in `app/`, `services/`, `components/`, `hooks/`, `lib/` or `contexts/`.
- There is no wearable/glasses/Meta/XR flag in `app.json`/`eas.json`/config,
  and no glasses native module or config plugin.
- The isolated glasses prototype has no route and no backend call
  (`docs/glasses/GLASSES_XR_ISOLATED_PROTOTYPE.md`).
- `docs/build34-integration-validation-report.md:61`: the wearable/XR draft PRs
  #187/#188/#190 are deferred and are not authorized Build 34 inputs.
- `config/backend-authority.json` already listed the four functions as
  `notGoverned` ("governed by a different repository"). Their source lives in
  `kscan-glasses-webapp`.

```text
wearable-bridge=EXCLUDE_FROM_BUILD34_PRODUCTION_MIGRATION
wearable-save=EXCLUDE_FROM_BUILD34_PRODUCTION_MIGRATION
wearable-open-on-phone=EXCLUDE_FROM_BUILD34_PRODUCTION_MIGRATION
wearable-scan=EXCLUDE_FROM_BUILD34_PRODUCTION_MIGRATION
WEARABLE_MIGRATION_DISPOSITION=ACTIVE_STAGING_NON_SHIPPING_SURFACE; DO_NOT_PROMOTE
```

The functions were not imported, audited as shipping, or deleted. The
dispositions are recorded in `config/backend-authority.json` and in the
migration manifest. `ALL_BUILD34_PROVIDERS_AUDITED` legitimately excludes them.

## 6. Task E: performance / query health

Full per-finding record: `build34-backend-performance-disposition-2026-09-17.md` (+ `.json`).

```text
PERFORMANCE_ADVISORS_TOTAL=204 (22 unindexed FK, 102 auth RLS init-plan, 74 unused index, 6 multiple permissive)
PERFORMANCE_BLOCKERS_FIXED=6 (B34-BE-PERF-001, migration 20260917163000)
PERFORMANCE_SAFE_DEFER=179
PERFORMANCE_MIGRATION_DAY_VERIFY=12
PERFORMANCE_NOT_APPLICABLE=7 (+7 platform-owned storage/auth FKs outside the advisor capture)
STAGING_QUERY_HEALTH_AUDITED=YES
PRODUCTION_SCALE_P99_PROVEN=NO
PERFORMANCE_PHASE_COMPLETE=YES
```

B34-BE-PERF-001 fixes six FKs whose ON DELETE action fans out to a full child
scan per deleted parent row on customer lifecycle paths (Elise messages and
sessions, room messages, room items, saved scans). Staging `EXPLAIN` with
sequential scans disabled still planned a Seq Scan (or a full composite-index
traversal) for each. After a rolled-back dry run, the migration was applied
through the governed pipeline (run 35248584118: approved migration `success`,
ledger `ALIGNED`, 172 rows). All six indexes are valid and every RI shape now
plans an index lookup.

None of the multiple-permissive-policy findings broadens authorization. Two are
duplicate equivalent policies; three are intentional owner-or-recipient OR
semantics under the restrictive active-account guard.

## 7. New findings from this campaign (all closed)

| ID | Sev | Finding | Fix | Verification |
|---|---|---|---|---|
| B34-BE-GOV-002 | P3 | Staging `kplus-activate` and `kplus-reconcile-revenuecat` bundled the pre-`b8914b51` `revenueCatClient.ts`. The drift was additive only (+103 lines of exports neither function imports). The audit record's 25/25 readback claim did not hold for these two. | Governed redeploys, runs 35245963122 and 35246327256 | 3/3 + 3/3 byte parity |
| B34-BE-GOV-003 | P3 | `config/cross-path-parity-manifest.json` had been stale for `scan-identify/index.ts` since #432, so `phase2b4CrossPlatformParity` was red on `d24d4afd`, masked by the base/head regression comparison. | `5ba8066d` regenerate | 9/9 tests; `--check` PASS |
| B34-BE-GOV-004 | P3 | The governed staging preflight ignored the audit's `OBSOLETE_REMOTE_ONLY` declaration and refused the canonical authority (run 35244648123). | `c77e156e`: strictly validated exclusion + 16 new tests | replay against the live ledger OK; governed deploys pass |
| B34-BE-GOV-005 | P3 | `search-vinted-secondhand` and `staging-health` failed `deno check` under the unpinned CI Deno (2.8.2 / TS 6), blocking their governed redeploy. | `9bdb4b03`: annotations only, emitted JS byte-identical | governed redeploys 35249867640 and the `staging-health` run; byte parity |
| B34-BE-PERF-001 | P3 | Six lifecycle FKs fan out to a full scan per deleted parent row. | `daa92e51`, applied via governed run 35248584118 | post-condition, index plans, ledger ALIGNED |
| (posture) | P4 | `tryon-clothes-pro` was deployed with `verify_jwt=false` against a declared `true` (retired stub). | Governed redeploy, run 35250580693 | `verify_jwt=true`; 2/2 bytes |

## 8. Canonical governance and test results

Local runs used Windows, Node 24.14.0 and Deno 2.8.2 (Git Bash on PATH), with
a fresh `npm ci` in the closure worktree.

```text
BACKEND_AUTHORITY_VERIFY=PASS (25/25 governed/source; clean tree; manifest digest verified)
MIGRATION_AUTHORITY_GATE=PASS (28 entries)
MIGRATION_PROVENANCE_GATE=PASS
MIGRATION_COLLISION_GUARD=PASS
EDGE_FUNCTION_MANIFEST=PASS (--check, after regeneration for GOV-005)
EDGE_FUNCTION_SOURCE_PARITY=PASS (local check) + 25/25 live byte readback
CROSS_PATH_PARITY_MANIFEST=PASS (--check; was red on d24d4afd, fixed GOV-003)
DENO_CHECK_ALL_GOVERNED_ENTRYPOINTS=25/25 (after GOV-005)
DENO_BACKEND_SUITE=1067 passed / 0 failed (node scripts/run-backend-tests.js)
TARGETED_NODE_SUITES:
  orphan/deletion lifecycle (15 files)            367/367
  provider spend gates (2 files)                   31/31
  watchlist/notifications (8 files)               146/146
  migration governance (5 files)                   44/44
  staging reconciliation/deploy/authority         78/78 (after GOV-004)
  orphan reconciler invoker contract               38/38 (also green in CI)
  security (22 files)                          303/304 (1 = known baseline: rpcHardeningMigration)
  staging governance (9 files)            170 pass / 2 fail / rest skipped-live (2 = known baseline: easProfileParity)
  edge parity/authority (5 files)             141/141 on a clean tree
FULL_NODE_SUITE (node scripts/run-all-tests.js, 8320 tests, 19-identity known baseline):
  run 1: observed 7 / known 6 / unexpected 1. The unexpected failure (androidGooglePlayComplianceV1 foreground-
         service scan) was caused by node_modules/.deno left by the preceding Deno run. After a fresh npm ci it
         passes. It is an environment artifact, not code.
  run 2: observed 8 / known 6 / unexpected 2. Both unexpected failures (backendAuthorityGovernance) were caused by
         this record being an UNCOMMITTED file during the run. The same file passes 13/13 once the tree is clean,
         so this too is environment, not code.
  run 3 (clean, committed tree): see the final line below.
KNOWN_BASELINE_FAILURES_OBSERVED (pre-existing identities, none caused by closure changes):
  llmModelRoutingParity  "config.toml pins JWT posture": expects the production ref; the authority pins staging by design
  rpcHardeningMigration  "revokes anon EXECUTE ... enforce_minor_privacy_defaults"
  closetCloudMediaContract "media dimensions are inherited from the existing Closet store"
  easProfileParity x2    EAS staging/production client-flag set differences (mobile config)
  dressingRoomBlockingUi "no repo migration other than the blocking one assumes the internal schema". Already red
    on d24d4afd (3 files). The audit's byte-exact staging mirror 20260916233708 is a 4th instance. Ordered replay
    is safe, because 20260804090000 creates `internal` first. The file is not edited, which preserves the
    ledger-hash identity that the migration-authority gate enforces.
TEST_WEAKENING=NONE; BASELINE_EDITS=NONE
CI (PR #437 @ 9bdb4b03): all checks pass (Project checks, Security promotion gate, Staging security gate,
  Contract tests, Migration validation, Dependency reachability, Semgrep, Gitleaks, OSV, Trivy, npm audit,
  ZAP baseline/API, VTO scope guard/E2E contract, orphan reconciler invoker contract)
```

## 9. Source/staging parity (final)

```text
SOURCE_STAGING_PARITY=PASS. 25/25 governed functions byte-identical (full CLI readback after the last deploy);
  JWT posture 25/25; migration ledger 172 = source 172 (governed preflight ALIGNED, remoteOnly none,
  excluded 20260916234025).
```

## 10. Freeze gate

```text
P0_OPEN_BACKEND=0
P1_OPEN_BACKEND=0
P2_OPEN_BACKEND=0
P3_OPEN_BACKEND=0
B34_BE_STO_001=FIXED_STAGING_VERIFIED
CANONICAL_SOURCE_CONTAINS_AUDIT_REPAIRS=YES (PR #437 candidate; canonical on the authority branch once the owner merges)
PRIVACY_FUNCTION_PARITY=BOUNDED_UNKNOWN_WITH_NON_BLOCKING_CLOSURE_CONDITION
WEARABLE_BUILD34_SCOPE=RESOLVED (OUT)
PERFORMANCE_PHASE_COMPLETE=YES
SOURCE_STAGING_PARITY=PASS
B34_FE_DR_001=HANDOFF_TO_MOBILE_AUDITS
AUDIT_INTRODUCED_DEFECTS=0
AUDIT_FIXTURES_REMAINING=0 (no synthetic rows, objects, flags or diagnostic slugs created; local secret files deleted)
MIGRATION_MANIFEST_UPDATED=YES (docs/audits/build34-pre-migration/environment-migration-readiness-manifest.md)
BUILD34_BACKEND_BASELINE_FROZEN=YES (frozen candidate = PR #437 head; staging matches it byte-for-byte)
READY_FOR_ANDROID_AUDIT=YES
READY_FOR_IOS_AUDIT=YES
```

## 11. Staging changes made by this campaign

All were on staging only, and each was either governed or explicitly recorded:
- Function secrets `ORPHAN_MEDIA_SWEEP_SECRET` (rotated) and
  `ORPHAN_MEDIA_SWEEP_DRY_RUN=true` (new lock).
- GitHub `staging` environment secret `ORPHAN_MEDIA_SWEEP_SECRET`.
- Governed deploys: `kplus-activate`, `kplus-reconcile-revenuecat`,
  `search-vinted-secondhand`, `staging-health`, `tryon-clothes-pro`.
- Governed migration `20260917163000` (six additive indexes).
- Six dry-run reconciler invocations and read-only probes.
- No object, row, flag or user was created or deleted. The rolled-back probes
  left zero residue.

## 12. Owner actions

1. Review and merge PR #437 into `rebuild/backend-authority-v2`, then promote
   `staging-orphan-media-reconciler.yml` to `master` to start the daily cadence.
2. Resolve the PR #435 semantic conflict: drop its duplicate
   `20260917010000`/`20260917020000` migrations, and move its client edit to
   the mobile lane.
3. **WEBSITE-PRIV-001:** confirm which Supabase project the live website
   privacy page uses, and redeploy `public-sale-share-opt-out` from
   kscan-website. Decide the fate of `privacy-controls`.
4. Delete the diagnostic residue slugs from staging (`vto-provider-diag`,
   `rapidapi-key-diag`, `rapidapi-current-audit`), and consider pinning Deno in
   the governed deploy workflow.
5. Separate production providers from staging (shared keys, carried from Build 33).
6. Next campaign: Android + iOS hostile audit against this frozen backend
   contract. B34-FE-DR-001 is the first retest.
