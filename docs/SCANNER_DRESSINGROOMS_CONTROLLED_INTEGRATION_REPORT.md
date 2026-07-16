# Scanner + Dressing Rooms Controlled Integration Report

Date: 2026-07-16  
Branch: `integration/scanner-dressingrooms-final`  
Worktree: `C:\src\KScan-scanner-dressingrooms-integration-20260716`

## A. Verdict

```text
PASS WITH PHYSICAL/CROSS-DEVICE GATES — READY FOR CLEAN PUSH
```

## B. Environment

```text
Dressing Rooms source worktree: C:\src\KScan-elise-avatar-audit-20260715
Dressing Rooms HEAD:            e39426141f3394500ccf76986f0938b3b5a7e836
Scanner implementation worktree: C:\src\KScan-scanner-commerce-reconciliation
Scanner implementation HEAD:    d51d4399d32d15ac8fa3909a636be099248fab3f
Scanner audit worktree:         C:\src\KScan-scanner-final-audit-20260716
Scanner audit HEAD:             b8d8b1bdfc93c2ee94a0a9dfcdbadd9879400f1e
Integration worktree:           C:\src\KScan-scanner-dressingrooms-integration-20260716
Integration branch:             integration/scanner-dressingrooms-final
Starting HEAD:                  e39426141f3394500ccf76986f0938b3b5a7e836
Ending HEAD:                    2224e135260dc7dd70672c2a21bcba2cc9beaf6a
Clean status:                   source worktrees remained clean; integration branch committed only reconciliation artifacts
```

Preflight:

```text
DRESSING_ROOMS_HEAD: e39426141f3394500ccf76986f0938b3b5a7e836
SCANNER_IMPLEMENTATION_HEAD: d51d4399d32d15ac8fa3909a636be099248fab3f
SCANNER_AUDIT_HEAD: b8d8b1bdfc93c2ee94a0a9dfcdbadd9879400f1e
INTEGRATION_START_HEAD: e39426141f3394500ccf76986f0938b3b5a7e836
ALL_SOURCE_WORKTREES_CLEAN: True
```

## C. Evidence boundaries

- Dressing Rooms audit at `e394261` remained authoritative for authentication, shared rooms, memberships, shared-image signing, Elise/avatar, and platform parity outside Scanner persistence.
- Scanner final audit at `b8d8b1b` remained authoritative for Scanner commerce persistence, actor-bound scan lifecycle, purchase-option normalization, Saved Scan merge authority, and no-provider-rerun reopen behavior.
- This integration audit covered reconciliation damage risk, migration ordering, cross-feature contracts (Saved Scan → Dressing Room image usability), and combined automated validation. It did not reopen either completed audit.

## D. Changes integrated

| Scanner behavior | Source |
|---|---|
| Purchase-option normalization contract | `services/purchaseOptions.ts` (new from `b8d8b1b`) |
| Additive `purchase_options` column | `supabase/migrations/20260716035943_add_purchase_options_to_saved_scans.sql` |
| Local save/load with commerce + actor filter + mutation queue | `services/library.js` |
| Cloud mapping, merge authority, zero-row write failure, actor guards | `services/savedScansCloud.ts` |
| Library hydration actor/cloud gating | `hooks/useLibrary.js` |
| Actor-bound scan lifecycle / stale-result suppression | `hooks/useKScan.js` |
| Auth actor wiring + owned save + purchaseOptions render prop | `app.js` |
| Library reopen purchaseOptions + storage props preserved | `app/library.tsx` |
| PurchaseOptionsPanel on AnalysisCard without dropping Dressing Room CTA | `components/AnalysisCard.tsx` |
| Persistence / merge / actor tests | `__tests__/purchaseOptionsPersistence.test.js`, `__tests__/savedScansCloud.test.js`, `__tests__/useKScanDuplicateGuard.test.js` |
| Scanner audit evidence package | `docs/SCANNER_FINAL_PREMERGE_RELEASE_AUDIT.md` |

Ancestry:

- Merge base with both Scanner HEADs: `9a05113ffe5643b8bf6e53a79e5ea905df609aec`
- Scanner-unique commits on `b8d8b1b`: `d51d439`, `83739ad`, `e0eb58b`, `1e841b6`, `b8d8b1b`
- Audit-only docs: `1e841b6`, `b8d8b1b`
- Audit implementation fixes beyond `d51d439`: actor binding (`83739ad`) and commerce/actor hardening (`e0eb58b`)

## E. Conflict resolution

File-level overlap since merge base: **none**. Dressing Rooms changed auth/shared-room/Elise paths; Scanner changed Scanner persistence paths. Integration action for all Scanner-touched files was therefore **retain authoritative baseline structure + take audited Scanner behavior from `b8d8b1b`** (equivalent to checkout of those paths onto `e394261`).

| File | Dressing Rooms authority | Scanner behavior | Conflict type | Integration action |
|---|---|---|---|---|
| `services/purchaseOptions.ts` | n/a (absent) | required | none | add from `b8d8b1b` |
| `supabase/migrations/20260716035943_add_purchase_options_to_saved_scans.sql` | n/a | required | none | add; ordered after `20260716000001_shared_room_memberships` |
| `services/library.js` | preserve (unchanged on DR) | commerce + actor + queue | none | take `b8d8b1b` |
| `services/savedScansCloud.ts` | preserve (unchanged on DR) | mapping/merge/guards | none | take `b8d8b1b` |
| `hooks/useLibrary.js` | preserve | actor/cloud hydrate | none | take `b8d8b1b` |
| `hooks/useKScan.js` | preserve | actor-bound lifecycle | none | take `b8d8b1b` |
| `app.js` | preserve auth/session context already present | actor save + purchaseOptions prop | none | take `b8d8b1b` |
| `app/library.tsx` | preserve storage/AddScan wiring | purchaseOptions reopen prop | none | take `b8d8b1b` |
| `components/AnalysisCard.tsx` | preserve Dressing Room CTA | PurchaseOptionsPanel | none | take `b8d8b1b` |
| `constants/featureFlags.ts` | preserve | unchanged; cloud default off | none | retain `e394261` |
| `components/ProductShelf.tsx` | preserve | unchanged | none | retain `e394261` |
| `services/api.js` | preserve | unchanged | none | retain `e394261` |
| DR shared-image Edge Function / modals | preserve all | not in Scanner delta | none | retain `e394261` |

Shared-file detail:

### `app.js`
- Conflict: none textual with DR.
- Authoritative preserved: `useAuthSession`, Dressing Rooms freeze gates, AddScan modal flow.
- Scanner added: `useKScan(user?.id)`, `analysisActorId` owned save, `purchaseOptions` prop.
- Tests: `__tests__/useKScanDuplicateGuard.test.js`, integration suite.

### `components/AnalysisCard.tsx`
- Authoritative preserved: `onAddToDressingRoom` CTA and unavailable reason.
- Scanner added: normalized `PurchaseOptionsPanel` under price-discovery flag.
- Tests: `__tests__/scannerDressingRoomsIntegration.test.js`.

### `app/library.tsx`
- Authoritative preserved: `storageBucket` / `storagePath` / `AddScanToDressingRoomModal`.
- Scanner added: `purchaseOptions` into AnalysisCard reopen props.
- Tests: integration suite + existing styleObjects/dressing-room contract suites.

### `services/library.js` / `services/savedScansCloud.ts`
- Authoritative preserved: remote media fields and dressing-room image authority in merge.
- Scanner added: purchase-option snapshot, merge tombstones/explicit-empty rules, actor guards, zero-row write failure.
- Tests: `__tests__/savedScansCloud.test.js`, `__tests__/purchaseOptionsPersistence.test.js`.

## F. Migration order

| Item | Result |
|---|---|
| Migration filename | `20260716035943_add_purchase_options_to_saved_scans.sql` |
| Ordering | Index 57 of 58; immediately after `20260716000001_shared_room_memberships.sql` (index 56); after `create_saved_scans` and `saved_scan_media_backing` |
| Column | Additive `jsonb NOT NULL DEFAULT '[]'::jsonb` |
| Constraint | `saved_scans_purchase_options_is_array` |
| RLS / grants | Unchanged by Scanner migration; RLS remained enabled in replay |
| Image/storage fields | Unchanged (`storage_bucket`, `storage_path`, `media_status`, `image_uri`, `thumbnail_uri` present after media backing) |
| Deployment status | **Not deployed** |

Disposable replay (`scripts/replay-migrations-disposable.ps1`):

1. Applied saved-scans lineage subset with auth/profiles/inspiration stubs in disposable Postgres 15.
2. Default `[]` backfill for inserts omitting the column: PASS
3. Valid purchase-option array update: PASS
4. Empty array update: PASS
5. Invalid non-array JSON rejected by check constraint: PASS
6. Filename ordering vs Dressing Room memberships migration: PASS

Full remote/local Supabase CLI `db reset` was not used (`supabase/config.toml` is excluded from this clone lineage). No production migration deploy was performed.

## G. Auth and actor safety

| Race / scenario | Evidence |
|---|---|
| Sign-out during scan | `__tests__/useKScanDuplicateGuard.test.js` — sign-out aborts/discards deferred result |
| Actor switch during scan | same suite — actor switch aborts/discards deferred result |
| Actor-bound completed analysis | completed analysis remains bound to starting actor |
| Actor switch during local save | `saveScan` requires matching `ownerId`; library load filters by actor |
| Actor switch during cloud save | `savedScansCloud` expected-actor guards + disabled default |
| Library hydration isolation | actor B load returns empty for actor A rows |
| Stale Actor A after Actor B sign-in | operation validity checks `activeOperationActorRef === currentActorRef` |
| New scan before old resolves | duplicate-guard + operation id invalidation |
| Unmount during analysis | late failure/success after unmount discarded |
| Add to Dressing Room after actor switch | actor-filtered library prevents Actor A scan from appearing for Actor B |

No cross-account leakage found in automated suites.

## H. Scanner persistence

| Stage | Evidence |
|---|---|
| Initial render | `app.js` passes `analysis.purchaseOptions` into `AnalysisCard` |
| Normalization | `services/purchaseOptions.ts` + persistence tests (HTTPS-only, alias collapse, malformed filter) |
| Local save | camera + upload sources persist `purchaseOptions` + `commerceSnapshotVersion` |
| Cloud mapping | row `purchase_options` map/read tests; cloud calls skipped when flag off |
| Merge authority | newest explicit commerce wins; metadata-only cannot erase; tombstone/stale/zero-row covered |
| Library reopen | reopen wires persisted `purchaseOptions`; no provider rerun assertions in duplicate-guard / persistence suites |
| Cold restart | local JSON persistence round-trip; cloud disabled by default so restore is local-authoritative |

## I. Dressing Room regression

| Check | Result |
|---|---|
| DR authoritative shared-image Edge Function / modals | untouched (`e394261` retained) |
| Library → AddScan modal storage props | preserved |
| Merge keeps remote storage authority with commerce present | `__tests__/savedScansCloud.test.js` |
| Save → hydrate storage → `resolveDressingRoomImageSource` usable | `__tests__/scannerDressingRoomsIntegration.test.js` |
| AnalysisCard Dressing Room CTA retained with purchase options | integration + source contract |

## J. Combined tests

| Command | Passed | Failed | Skipped | Unavailable | Difference from baseline |
|---|---:|---:|---:|---:|---|
| Authoritative DR Node reference | 1,509 | 0 | 0 | 0 | reference |
| Integration baseline Node on `e394261` (`node --test "__tests__/**/*.test.js"`) | 1,514 | 0 | 0 | 0 | +5 vs DR report (environment/count drift only; zero failures) |
| Post-integration Node | 1,547 | 0 | 0 | 0 | +33 vs integration baseline (Scanner + integration tests) |
| Deno `supabase/functions` (`--no-check --allow-read`) | 78 | 0 | 0 | 0 | broader than DR's reported 11; includes shared-room-image + stylist-speech |
| `.\node_modules\.bin\tsc --noEmit` | clean | 0 | 0 | 0 | same |
| `git diff --check` | clean | 0 | 0 | 0 | same |
| Focused Scanner closeout (purchase/cloud/useKScan) | 84 | 0 | 0 | 0 | matches Scanner audit closeout |
| Integration reconciliation suite | 4 | 0 | 0 | 0 | new |
| Disposable migration replay | pass | 0 | 0 | 0 | subset lineage + ordering proof |
| `npx expo-doctor` | 15 checks | 3 known findings | 0 | 0 | same known peer/config/patch findings; not introduced by merge |

Expo Doctor known findings (unchanged):

1. Missing `expo-asset` peer for `expo-audio`
2. Non-CNG native folder / app.json sync warning
3. Expo `54.0.35` vs expected `~54.0.36`

## K. Runtime smoke

| Item | Evidence |
|---|---|
| Emulator present | `emulator-5554` / `sdk_gphone16k_x86_64` / Android 17 |
| Cloud Saved Scans env | `EXPO_PUBLIC_CLOUD_SAVED_SCANS_ENABLED=false` (default off preserved) |
| Scan-identify env | enabled in local smoke env (`true`) for live analysis when a build installs |
| iOS simulator | Unavailable on Windows host |
| Interactive authenticated upload→save→reopen→room smoke on this branch | Not completed in this session: first assemble reached native compile then failed on missing local `debug.keystore` (restored from `~/.android/debug.keystore`, gitignored); subsequent assemble hit Windows MAX_PATH (`Filename longer than 260 characters`) under the agent Gradle cache path. Not treated as product/regression defect. |
| Scanner audit prior combined-tree emulator smoke | Documented in `docs/SCANNER_FINAL_PREMERGE_RELEASE_AUDIT.md` for the same Scanner+`e394261` file set; not re-claimed as this session's interactive evidence |

This integration does **not** claim physical-device, true cross-device, or ending-HEAD interactive emulator auth smoke.

## L. Platform parity

| Capability | Android | iOS | Intentional difference | Evidence |
|---|---:|---:|---|---|
| Camera scan | Static + prior audit emulator camera UI | Static contract | iOS simulator unavailable on Windows | Shared `useKScan` |
| Photo upload | Static + automated persistence (upload source) | Static contract | same | `purchaseOptionsPersistence` camera/upload loop |
| Purchase options | Automated + UI wiring | Same JS bundle | none for data contract | AnalysisCard / purchaseOptions service |
| Save | Automated | Automated | none | library tests |
| Library reopen | Automated | Automated | none | library.tsx wiring + tests |
| Cold restart | Local persistence contract | Same | none | library JSON store |
| Actor switch | Automated | Automated | none | useKScan + library actor filter |
| Add to Dressing Room | Contract + integration tests | Same services | none | dressingRoomItemContract + integration |
| Shared image | DR authoritative path preserved | Same | none | untouched Edge Function + merge storage fields |
| Cloud Saved Scans | Default off | Default off | none | `CLOUD_SAVED_SCANS_ENABLED` |
| Permissions | Unchanged | Unchanged | iPad `supportsTablet: false` remains | no permission churn in Scanner delta |

## M. Findings fixed

No merge-introduced BLOCKER / P0 / P1 required a post-port repair. The port was a clean application of `b8d8b1b` Scanner paths onto an unchanged DR file set for those paths.

| ID | Severity | Root cause | Fix | Test | Commit |
|---|---|---|---|---|---|
| — | — | — | No merge defect found | 1,547 Node / 78 Deno / migration replay | n/a |

## N. Remaining gates

```text
Physical Android: outstanding
Physical iPhone/iPad: outstanding
True cross-device: outstanding (cloud Saved Scans intentionally default off; schema not deployed)
Other external gates:
  - Ending-HEAD interactive Android emulator authenticated smoke (blocked here by Windows native path-length / local debug keystore bootstrap, not by merge defects)
  - Expo Doctor three known findings before store release
  - Optional full supabase db reset when config.toml-enabled local stack is available
```

## O. Commits

| SHA | Subject |
|---|---|
| `c74db5e` | feat(scanner): integrate audited commerce persistence |
| `aa320df` | test(integration): cover scanner dressing room reconciliation |
| `28af426` | docs(integration): record controlled merge evidence |
| `2224e13` | docs(integration): finalize controlled merge report evidence |

Ending HEAD: `2224e135260dc7dd70672c2a21bcba2cc9beaf6a`

## P. Push/build recommendation

```text
READY FOR CLEAN PUSH; HOLD TESTER BUILD
```

Hold tester build until interactive authenticated emulator (or physical) smoke on the ending HEAD is confirmed in the release pipeline. Code, automated tests, and migration replay are integration-ready for clean push.

## Q. Final contract statement

```text
The audited Scanner reconciliation has been integrated into the clean Dressing Rooms authoritative baseline without regressing authentication, shared rooms, shared images, memberships, platform behavior, or actor isolation. The integrated application performs one actor-bound camera or upload analysis, persists normalized matching products and purchase options, restores Saved Scans without provider reruns, supports add-to-Dressing-Room, preserves durable image references, and is ready for clean push and tester-build preparation subject only to documented physical-device and cross-device gates.
```

Confirmed for code, automated tests, migration replay, actor-isolation suites, and Dressing Room shared-image contract preservation. Physical/cross-device and full interactive ending-HEAD emulator auth smoke remain external gates.
