# Build 35 EAS candidate readiness

Status: **PREPARED, NOT FROZEN**. No EAS build or signing artifact has been generated.

Reviewed integration source: `6fad4856e185ea72916f29389b32ecd04c3074cd`; backend authority: `fdc6c4d4b7677b8249306c15e2966b2b407b412d`. Publication of this document changes no build input. Both store profiles resolve to the approved Production project and retain the Today hold.

## Completed source checks

- Latest integration code/dependency CI [38271653131](https://github.com/kscanaiapp/kscan-app/actions/runs/38271653131) succeeded. The validated source includes 10,802 passing Node tests and 1,371 passing Deno tests; no test failure baseline was expanded.
- Release-profile guards pass for production and build35-release; native declarative parity passes all 17 checks.
- Offline Expo dependency compatibility reports dependencies up to date. Public Expo configuration resolves version 1.0.1, Android package and iOS bundle com.kscanai.app, source Android code23 and iOS build26. EAS version source is remote; source counters are not promised next build identities.
- All 29 governed runtime bundle hashes match backend authority. Backend tooling remains confined to its authoritative branch; mobile integration remains non-authoritative.
- Signing presence is verified through metadata, without credential download/regeneration. Actual artifact signing, permissions and physical behavior remain post-build checks.
- RevenueCat/K+ source review found no P0/P1/P2 defect. Core Elise and Speech remain Free; Watchlist uses canonical K+ authority. No purchase or store configuration was changed.

## Remaining shipping closure

| Item | Evidence and next step |
| --- | --- |
| Scanner workflow verdict | Live173, ACTIVE/JWTfalse, exact42-file source match, private recovery present, deploy-time health/provider-free contracts pass. Existing run38265655585 must finish its original verification jobs before formal deployment PASS. Do not redeploy or repeat completed certification. |
| Speech function | Production migration20261011222213 PASS; schema, RLS, grants and disabled zero-budget controls verified. Promote reviewed handler in function-only run38269987837 using the single-approval workflow. Its old live handler does not enforce the new reservation RPC. |
| Speech source configuration | Both store profiles still have Speech OFF while environment promotion is pending. Reconcile the shipping switch and release guard after runtime enforcement is verified, preserving approved consent and zero paid activation. |
| Watchlist function | Production's stale entrypoint lacks the current entitlement guard. Promote commerce-watch-refresh separately, JWTfalse, no migration, preserving workerfalse. Staging matches all16 current files. |
| Paid operational activation | Speech enabled=false/budget0; Watchlist workerfalse. Enabling either provider workstream needs separately authorized allocation/activation. No paid call or Production test actor is authorized for this pass. |
| Final freeze | Close backend/source configuration items, update exact candidate evidence and complete any newly affected regression plus independent final review. Do not represent this preparation record as a frozen all-feature release. |

Exact live store identities, Apple subscription metadata, Play product/base-plan state, RTDN and actual billing delivery remain **store-readiness evidence**, deferred by the owner to K+ certification/submission. They do not block unrelated engineering. Physical audio/push/privacy and built-app purchase/restore/lifecycle checks are post-build verification, requiring authorized devices/actors/allocation.

Actual EAS builds still require owner authorization after the candidate is concrete and reviewable. See `build35-deployment-verification.md` and `OWNER_DEPENDENCIES.md` for deployment and external evidence.
