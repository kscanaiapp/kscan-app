# Build 34 backend hostile-audit baseline

Status: frozen pre-repair staging snapshot  
Campaign: Build 34 full backend hostile audit, repair, and baseline  
Captured: 2026-09-17T11:08:50.863062+00:00  
Environment: staging only (`yzqjvdfgefveprobvvyw`, `us-west-1`)  
Baseline ID: `B34-20260917T110850Z-c6ee31ad-d24d4afd-268f9284`

## Absolute environment boundary

This campaign did not access, query, or change production. Production identifiers
found in repository configuration were treated only as static source text and were
never used as a remote target.

```text
PRODUCTION_ACCESSED=NO
PRODUCTION_QUERIED=NO
PRODUCTION_CHANGED=NO
```

## Source authority

```text
RELEASE_AUTHORITY_BRANCH=origin/release/kscan-pre-freeze-v1
RELEASE_AUTHORITY_SHA=c6ee31adb0932d4d476cc218c1a7bff434b10bc8
BACKEND_AUTHORITY_BRANCH=origin/rebuild/backend-authority-v2
BACKEND_AUTHORITY_SHA=d24d4afd214b55ae10f9f360d82b83e8c29be0b9
BUILD35_CONTAMINATION=NO
```

Fresh audit worktrees were created after `git fetch --all --prune`:

| Role | Worktree | Audit branch | Start SHA | Porcelain |
| --- | --- | --- | --- | --- |
| Release | `C:\src\BUILD34_RELEASE_AUDIT_20260917` | `codex/build34-release-backend-audit-20260917` | `c6ee31adb0932d4d476cc218c1a7bff434b10bc8` | clean |
| Backend | `C:\src\BACKEND_AUTHORITY_AUDIT_20260917` | `codex/build34-backend-hostile-audit-20260917` | `d24d4afd214b55ae10f9f360d82b83e8c29be0b9` | clean |

Open Build 34/backend PRs at capture time:

| PR | State | Base | Head | Disposition |
| --- | --- | --- | --- | --- |
| #431 | open, draft, unmerged | `release/kscan-pre-freeze-v1` | `claude/relaxed-noether-zqp4rl` @ `ccb1dd0f2d4b1e26f04285a12243abc7dc591a19` | Reaction/JWT governance evidence; do not merge in this campaign |
| #434 | open | `rebuild/backend-authority-v2` | `test/build33-closeout-live-probe-v1` @ `aae61ae91993c9ffaf37028e7e78cb44acb95993` | Test lane only |
| #435 | open | `rebuild/backend-authority-v2` | `claude/k-scan-backend-convergence-68gwew` @ `4d999354741cdfddc30e5e6d74059bd41a12b4fb` | Competing convergence work; not an authority input |
| #436 | open | `rebuild/backend-authority-v2` | `build33-scan-identify-prod-deploy-path` @ `25c8ef217a3cd2d2ce70a7320a24e32db7541cf5` | CI/CD infrastructure only; not an authority input |

PR #431's reaction migration is represented in backend authority under a
different migration version and is already in staging. Its later staging-only
token-binding migration is not yet represented in either selected source
authority and is baseline drift, described below.

## Staging inventory

Project health was `ACTIVE_HEALTHY`; Postgres was `17.6.1.155`.

### Edge Functions

Thirty-four active functions existed at capture time:

| Function | Version | `verify_jwt` | Governance classification |
| --- | ---: | :---: | --- |
| privacy-controls | 13 | yes | shipping, governed; source readback unavailable from Management API |
| public-sale-share-opt-out | 13 | no | shipping, governed; source readback unavailable from Management API |
| kickscrew-sneaker-description | 76 | yes | shipping, governed |
| stylechat-generate | 128 | yes | shipping, governed |
| handle-user-deletion | 81 | yes | shipping, governed |
| product-search-deals | 67 | yes | shipping, governed |
| privacy-correction-request | 65 | yes | shipping, governed |
| privacy-data-export | 64 | yes | shipping, governed |
| staging-health | 61 | no | staging-only health probe, governed |
| product-match | 59 | no | staging/internal, ungoverned, feature/secret gated |
| scan-identify | 72 | no | shipping, governed; custom JWT verification; source drift |
| restore-account | 60 | no | shipping, governed; custom auth |
| resend-restoration-email | 60 | no | shipping, governed; custom auth |
| process-account-deletions | 67 | no | shipping worker, governed; source drift |
| nike-shoe-details | 57 | yes | shipping, governed |
| search-vinted-secondhand | 57 | yes | shipping, governed; source drift |
| shared-room-image-url | 57 | yes | shipping, governed |
| style-outfit-generate | 59 | yes | shipping, governed |
| stylist-speech | 69 | yes | shipping, governed |
| apple-credential-link | 59 | yes | shipping, governed |
| apple-revoke-credential | 57 | no | shipping/internal, governed; custom auth |
| wearable-bridge | 27 | no | active external surface, ungoverned; custom session token |
| wearable-save | 25 | no | active external surface, ungoverned; custom session token |
| wearable-open-on-phone | 24 | no | active external surface, ungoverned; custom session token |
| wearable-scan | 28 | no | active external surface, ungoverned; custom session token |
| kplus-activate | 20 | yes | shipping, governed |
| kplus-reconcile-revenuecat | 20 | no | shipping/internal, governed; custom auth |
| vto-provider-diag | 17 | yes | retired 410 diagnostic stub; staging residue |
| rapidapi-key-diag | 12 | no | retired 410 diagnostic stub; staging residue |
| rapidapi-current-audit | 14 | no | retired 410 diagnostic stub; staging residue |
| vto-generate | 14 | yes | shipping, governed |
| commerce-watch-refresh | 12 | no | shipping worker, governed; live is ahead of source authority |
| tryon-clothes-pro | 10 | no | retired function, governed |
| deletion-status | 6 | no | shipping, governed; custom auth |

The backend authority manifest governs 25 function slugs. Staging contains 24 of
those (`reconcile-orphan-media` is absent) plus ten ungoverned slugs: the two
website/privacy surfaces, `product-match`, four wearable functions, and three
retired diagnostics.

The Management API returned complete source bundles for 32/34 functions.
`privacy-controls` and `public-sale-share-opt-out` repeatedly returned HTTP 500
for bundle retrieval and therefore remain explicit readback unknowns. Of the
downloaded source files, 153 were byte-identical to backend authority, eight
differed, and 28 were live-only. Release comparison yielded 144 identical, 16
different, and 29 live-only files.

### Database and storage

| Inventory | Count |
| --- | ---: |
| Applied migration ledger entries | 171 |
| Public tables | 83 |
| Storage tables inspected | 8 |
| RLS-enabled public + storage tables | 91/91 |
| Public functions | 130 |
| `SECURITY DEFINER` functions | 116 |
| Public views | 0 |
| Triggers | 42 |
| Indexes | 323 |
| Constraints | 478 |
| Public policies | 135 |
| Storage policies | 6 |
| Storage buckets | 5 |
| Cron jobs | 0 (cron schema absent) |
| Database webhook triggers | 0 |

All 116 security-definer functions have a controlled `search_path`; none grant
execute to `PUBLIC`. Three are anon-executable, 50 authenticated-executable, and
106 service-role-executable (roles overlap). Every client-executable definition
was inspected. None uses dynamic SQL; direct actor checks use `auth.uid()` or a
bounded helper. The three anon RPCs are the two token-bound public preview
functions and token-bound reaction counts.

The 25 RLS-enabled tables with no policies default-deny non-owners. Broad default
table grants remain on parts of the schema, but adversarial User A/User B tests
confirmed RLS isolation for privacy-export read/update/delete. Several existing
pgTAP failures assert the old implementation detail "no table grant" rather than
the security invariant "no cross-actor row visibility"; those failures were not
papered over by changing tests.

Bucket configuration:

| Bucket | Public | Limit | MIME policy | Baseline state |
| --- | :---: | ---: | --- | --- |
| image-ingestion-clean | no | 10 MB | images | empty |
| image-ingestion-quarantine | no | 10 MB | images | empty |
| investor-docs | no | none | none | 6 system/investor objects, 4.36 MB, null owner, outside mobile reference model |
| legal-documents | yes | none | none | empty |
| style-library-images | no | 5 MB | images | 30 objects, 10.66 MB, all deleted/unresolvable owners, zero known DB references |

No storage object was deleted during discovery. The 30 `style-library-images`
objects prove orphan-owner residue. The governed, dry-run-default,
secret-gated `reconcile-orphan-media` implementation exists in source but was
not deployed; its required secret was absent and no scheduler/invoker existed.

## Schema signatures

```text
COLUMN_SIGNATURE=29eac7f...
CONSTRAINT_SIGNATURE=01e90d...
INDEX_SIGNATURE=b62b55...
POLICY_SIGNATURE=90a270...
FUNCTION_SIGNATURE=a68b65...
TRIGGER_SIGNATURE=95cb12...
GRANT_SIGNATURE=e315e8...
BUCKET_SIGNATURE=95b44b...
MIGRATION_LEDGER_SHA256=981ecbcf716f9c336c36f497b378a5d3c787dde64874a4ed313b6e92bab92a3f
SCHEMA_SIGNATURE_SHA256=268f92841c4378b6e227c9042c4e14ff16e6637cd53a061e2caef08916bc8bc7
```

The abbreviated component signatures are retained as human correlation labels;
the full ledger and aggregate schema hashes are the mutation gates.

## Migration classification and drift

Release contains 168 migration files; backend authority contains 169; staging
records 171 versions. Three staging migrations require deliberate handling:

| Staging version | Name | Classification | Effective state |
| --- | --- | --- | --- |
| `20260916204355` | `reaction_counts_require_live_room_access` | `EXACT_CONTENT_RENUMBER` relative to backend authority | active |
| `20260916233708` | `reaction_counts_bind_anonymous_share_token` | `STAGING_REMOTE_ONLY`, required security tightening | active; source reconciliation required |
| `20260916234025` | `dressing_room_items_source_idempotency` | `STAGING_REMOTE_ONLY`, semantically wrong invariant | ledger says applied; unique index is absent; obsolete, must not be replayed |
| `20260916235651` | `dressing_room_items_dedupe_key_idempotency` | `STAGING_REMOTE_ONLY` | unique canonical dedupe index active; currently inert because all dedupe keys are null |

The reaction-count RPC now requires `(p_item_ids, p_share_token default null)`.
Owner/member access remains authenticated; anonymous access is bound to the exact
live share token. The Build 34 public-room client still calls the RPC with only
`p_item_ids`, so secure staging returns zero anonymous reaction counts. Restoring
the old backend behavior would weaken the capability boundary; this is a
frontend release-sequencing blocker, not a backend repair target.

The source-identity uniqueness proposal encoded "same product once per room",
not "the same mutation once". It is both absent from effective staging schema
and unsafe to reapply. The dedupe-key index is a better primitive but lacks a
stable client operation identity and is feature-disabled in current Build 34.

## Proven pre-repair findings

### B34-BE-SEC-001 — unauthenticated MODE B paid-provider boundary

Severity: P1  
Surface: `scan-identify`  
Evidence: live source lacks the backend-authority authentication, anonymous-user
rejection, durable quota, and mode canonicalization repairs. A safe request with
no JWT and an intentionally invalid MODE B body returned HTTP 400
`commerce_only_invalid`; the request therefore crossed the missing auth boundary.
The repaired candidate returns HTTP 401 before parsing or provider work.  
Rollback: redeploy the exact pre-change v72 readback bundle.  
Pre-change shipping tree: 37 files, 591,255 bytes,
`e36e9430d8918fed94b84995138aa5bab42c157097c4a00ce40c2ec638d4a70e`.  
Candidate shipping tree: 39 files, 604,122 bytes,
`7f7a2b99c0c5604a0b927318d57fd5f715a6b7ecabfb5152ff618c894a4e0ee5`.

### B34-BE-LIFE-001 — account-deletion worker fail-open flag parsing

Severity: P1  
Surface: `process-account-deletions`  
Evidence: live source predates the candidate's explicit worker-mode parser. With
the worker enabled and dry-run flag false, malformed/unreadable configuration can
resolve toward live deletion instead of failing closed. Live also lacks current
K+ resource coverage and RevenueCat mirror retirement.  
Rollback: redeploy exact pre-change v67 readback bundle.

### B34-BE-COST-001 — paid secondhand provider lacks account-state gate

Severity: P2  
Surface: `search-vinted-secondhand`  
Evidence: live source can reach Apify for an authenticated but deactivated,
locked, or pending-deletion account. Backend authority checks account state
before any provider call.  
Rollback: redeploy exact pre-change v57 readback bundle.

### B34-BE-GOV-001 — watchlist live source ahead of authority

Severity: P2 governance/reproducibility defect  
Surface: `commerce-watch-refresh`  
Evidence: staging contains N-4/N-5 receipt processing and observability files
from the release line that are missing from backend authority. Redeploying the
current authority would regress active notification behavior.  
Repair direction: reconcile the byte-identical live/release implementation into
backend authority; do not deploy the older authority bundle.

### B34-BE-STO-001 — orphan reconciliation is not operational

Severity: P3  
Surface: `reconcile-orphan-media` and `style-library-images`  
Evidence: 30 orphan-owner objects exist; governed reconciler is undeployed,
required secret is absent, and there is no invoker or schedule.  
Repair direction: deploy the canonical dry-run-default function, establish
secret-gated dry-run proof, and leave deletion disabled. Scheduling remains an
explicit owner decision because this project has no scheduler authority.

### B34-FE-DR-001 — public reaction counts omit share token

Classification: `BUILD34_FRONTEND_BLOCKER`  
Severity: P2  
Platform: shared iOS + Android React Native route  
Feature: public Dressing Room shares  
Files: `services/styleObjects.ts`, `app/(public)/rooms/[token].tsx`  
Backend contract: anonymous callers must pass the exact live `p_share_token`.  
Client behavior: calls `get_item_reaction_counts` with only `p_item_ids`.  
User impact: public-room reactions render as zero despite stored reactions.  
Minimum future repair: thread the route token through the shared service call and
add anonymous live/revoked/wrong-token regression coverage. No backend weakening
is acceptable.

## Runtime and validation baseline

Safe staging probes (no provider spend and no customer data):

| Probe | Result |
| --- | --- |
| `staging-health` | HTTP 200; n=5, p50 703 ms, p95 1,564 ms |
| `stylechat-generate`, missing JWT | HTTP 401 `UNAUTHORIZED_NO_AUTH_HEADER`; n=3, p50 159 ms |
| `stylechat-generate`, malformed JWT | HTTP 401 |
| `scan-identify` MODE B, missing JWT, invalid body | HTTP 400 `commerce_only_invalid`; n=3, p50 302 ms (negative control for B34-BE-SEC-001) |
| `scan-identify`, malformed JWT | HTTP 401 |
| reaction-count RPC, empty ids/no token | HTTP 200 with empty result |
| deletion worker, no secret | HTTP 401 |

Validation before mutation:

- Backend authority `npm run test:backend`: 1,065/1,065 passed.
- Security suite: 303/304 passed; the sole failure is a stale literal-source
  assertion in `rpcHardeningMigration.test.js`, while effective grants and
  function definitions passed direct inspection.
- Security validation script passed; its ZAP localhost rejection is expected.
- Edge source-parity and backend-authority verification gates passed.
- Release `npm run test:all`: 27 failures (13 established baseline failures,
  13 PostHog fixture/loader failures, one Windows path assertion). This is not a
  green release baseline and is not represented as one.
- DB cache hit was 100% and DB size was about 29.38 MB. Staging data volume is
  too small to claim p99 or production-scale query behavior. No table over 100
  rows showed a sequential-scan-to-index-scan ratio above 2x.
- Advisors reported 22 unindexed foreign keys, 102 auth RLS init-plan findings,
  74 unused indexes, and six multiple-permissive-policy findings. Direct schema
  inspection found 25 unindexed FKs when storage internals were included.

## Mutation gate

No staging mutation may begin unless all of the following remain true:

```text
PRE_CHANGE_SOURCE_SHA=d24d4afd214b55ae10f9f360d82b83e8c29be0b9 (or an attributable descendant)
PRE_CHANGE_WORKTREE_STATUS=clean
PRE_CHANGE_MIGRATION_LEDGER=981ecbcf716f9c336c36f497b378a5d3c787dde64874a4ed313b6e92bab92a3f
PRE_CHANGE_SCHEMA_SIGNATURE=268f92841c4378b6e227c9042c4e14ff16e6637cd53a061e2caef08916bc8bc7
PRODUCTION_TARGET=forbidden
```

Every repair lane must additionally record function version/tree, targeted
tests, negative control, rollback bundle, readback parity, runtime proof, and
post-deploy health before the next lane begins.
