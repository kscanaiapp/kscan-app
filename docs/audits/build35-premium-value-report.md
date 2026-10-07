# Build35 Premium Value activation audit

BUILD35_PREMIUM_VALUE_ACTIVATION=PARTIAL

Two capabilities earned real Staging runtime evidence: Packing generation plus refinement, and Watchlist create/read/price observation. The Packing evidence binds the exact implementation now shipping. The Watchlist evidence was earned against the Staging backend deployed before this PR's provider-side K+ recheck existed, so it is historical and does not authorize the claim against the current source until the current backend is deployed and re-exercised (see Capability build authority). Cloud outbound/media sync, an actual isolated-client restore, scheduled worker behavior, and both platform push flows remain unproven. Their availability claims remain hidden. This is source and service-transport proof, not native device certification or a purchase transaction certification.

## Identity and authority

| Field | Result |
| --- | --- |
| START_SHA / FINAL_BASE_SHA | `911ac0856d4eb02d6a60645c8412026bdad60df8` |
| BASE_ANCESTRY_VERIFIED | YES; merged Speech PR #514 is included |
| END_SHA | Git commit containing this report; see PR head |
| BRANCH | `feature/build35-premium-value-v2` |
| PR | [Draft #517](https://github.com/kscanaiapp/kscan-app/pull/517), against `integration/build35-v1-convergence` |
| FILES_CHANGED | Authoritative PR diff; implementation groups listed below |
| VTO ownership check | PR #513 OPEN; latest inspected head `386ad70e1b171cf228510979586f8e4b386495c0`; no shared Gate/membership/catalog/Watch presentation edits |
| Shared overlap | Mechanical catalog-import/approved-gate/backend-path test inventories and generated Edge manifest. KPlusGate exposes presentation visibility, and KPlusMembershipSheet forwards native onDismiss to sequence Watch acquisition; their layouts and entitlement semantics are unchanged. VTO PR has no edits to those shared files. No StyleChat or VTO source overwritten |
| Mid-lane convergence | Integration fetched immediately before PR preparation; tip remains the exact starting SHA |

The user-supplied addendum supersedes the base prompt's request to turn Today off. Its actual integration baseline must be preserved. Production is read-only. RevenueCat, canonical entitlement reader/store, grant authority, Speech lifecycle, VTO lifecycle, Signature Style and Scanner pipeline implementations are unchanged. New protected-source tests compare normalized source hashes against that precise integration authority, without widening a regression baseline.

## Today hold

Flag order: Today / generated greeting / weather. These are effective inherited profile values, not only raw overrides.

| Profile / field | Baseline and final |
| --- | --- |
| TODAY_STAGING | true / true / true |
| TODAY_STAGING_CERTIFICATION | true / true / true |
| TODAY_PRODUCTION | false / true / true |
| TODAY_PRODUCTION_CERTIFICATION | true / true / true |
| TODAY_BUILD35_TESTING | true / true / true |
| Preview and development | true / true / true |
| TODAY_BASELINE_STATES | `config/build35-premium-value-baseline.json` |
| TODAY_PROFILE_STATE_DRIFT | NONE |
| TODAY_SOURCE | REVIEWED_NOT_CHANGED |

## Capability truth

CAPABILITY_TRUTH_MECHANISM=typed immutable dated evidence consumed by the existing single activation catalog and discovery surfaces. Environment is resolved from the actual configured Supabase hostname. The record's implementation fingerprint must equal the content identity of the governed source that is shipping, and explicit runtime status, nonempty evidence reference, proof type, proof date and expiration must match. Missing, malformed, unknown, source-only, future, expired, mismatched or differently-implemented evidence fails closed. An open memoized membership list also removes a claim at expiration. This projection cannot grant an entitlement.

| Capability | Proof record | Runtime / expiry UTC | Presentation |
| --- | --- | --- | --- |
| PACKING_PROOF_RECORD | PROVEN_RUNTIME / Staging / identity `7131b140…` / generation_and_refinement | 2026-10-07 13:24:08.530 / 2026-10-14 13:24:08.530 | Eligible only with build flag and valid scoped proof; identity matches the shipping source |
| WATCHLIST_PROOF_RECORD | PROVEN_RUNTIME / Staging / identity `3ad59c01…` (pre-recheck backend) / tracking | 2026-10-07 13:26:10.541 / 2026-10-14 13:26:10.541 | Does not authorize against the current source (identity is now `c1fd61b2…`); hidden until renewed. Worker and each push platform require separate proof |
| WATCHLIST_PROVIDER_BOUNDARY_RECORD | none / provider_entitlement_boundary | not proven | Pending deploy of the current backend and one governed exercise; never implied by the tracking record |
| CLOUD_CLOSET_PROOF_RECORD | PROVEN_SOURCE_ONLY / Staging / identity `fed5873f…` / outbound_sync | Source review dated 2026-10-07; expires 2026-10-14 | Hidden until real outbound proof; restore copy additionally requires isolated-client restore proof |

Production has no new premium-value runtime record. Existing Voice Scan and live VTO presentation authorities are preserved; neither was newly certified in this lane. Wardrobe Concierge retains its existing unconfirmed state. Evidence: `services/kplus/kplusCapabilityProof.ts`, `docs/audits/build35-premium-runtime.json` and the ledger.

### Capability build authority

CAPABILITY_BUILD_AUTHORITY_METHOD=governed source fingerprint per proof type. A static label (`build35-premium-value-v2`) was the previous binding; it was removed because it stayed equal while the code under a proof changed. No immutable build or commit identity reaches the client at runtime (no build-SHA export exists in `app.config`, `eas.json` or `constants`), and a commit SHA could not be recorded inside the commit that contains the record, so a content hash was the smallest sound mechanism.

- The identity is sha256 over the CRLF-normalised content of each governed file, defined in `scripts/premium-capability-fingerprint-lib.js`. Edge Function entrypoints contribute their full local import closure (a function is one deploy unit); tests, hooks, screens and components are excluded because the proof harness drove the real clients and deployed functions directly and `nativeAppCertified` is false.
- The device cannot read its own source, so current identities are generated into `services/kplus/kplusCapabilityFingerprints.generated.ts` (`npm run generate:premium-fingerprints`). `__tests__/premiumCapabilityFingerprint.test.js` fails while that file and the real source disagree, so governed source cannot change with the old identity left in place, and a changed identity withdraws the old proof at runtime until a record naming the new identity exists.
- Proof types with no governed domain (worker behavior, iOS push, Android push) have no identity and can never authorize.
- Each record carries a `fingerprintBasisCommit`; the test recomputes the identity from that commit in git and requires it to equal the record. In a shallow clone that commit is absent and those three checks skip; they are not the merge gate.

| Proof type | Identity when the run executed (`a57527d1`, equal to the integration base `911ac085`) | Identity of this head | Result |
| --- | --- | --- | --- |
| packing_generation_and_refinement | `7131b140…` | `7131b140…` | PACKING_SOURCE_IDENTITY_MATCH=YES. No commit changed the Packing client, types or `stylechat-generate` after the run; the later hook and screen edits are outside the governed set |
| watch_tracking | `3ad59c01…` | `c1fd61b2…` | Changed. `commerce-watch-refresh/index.ts` and the new `watchEntitlementGuard.ts` were committed at 10:16 EDT, after the 09:24-09:26 EDT run |
| closet_outbound_sync | `fed5873f…` | `fed5873f…` | Source-only record; cannot authorize |

Residual assumption, stated rather than hidden: the run read its sources from the working tree, and the identities above assume the governed files there equalled the committed `a57527d1` content. The harness did not record a tree hash at run time.

Consequence for presentation: until the current backend is deployed to Staging and the Watchlist run is repeated, no proof record authorizes the Watchlist claim for this source, so it is not advertised. The earlier tracking result is preserved, not erased; it is simply bound to the implementation that earned it. Any later change to the shared `stylechat-generate` function (for example by the VTO lane) changes the Packing identity and requires a Packing re-proof; that is intended, because the function is one deploy unit.

Effective compiled flags (Packing / Watchlist / sync / restore / legacy migration): ordinary Staging and Production are unset and default OFF; Staging certification, Production certification and build35-testing are true / true / true / true / true. Only the three Staging certification Cloud overrides were added. An enabled compiled flag does not confer capability proof, and the actual Supabase environment must match the record.

## Packing

Root cause: the previous screen returned an upgrade block before mounting the trip form for Free users. It could not retain a trip setup through acquisition. The form now stays mounted behind the existing membership sheet and is keyed by actor scope; resolving state cannot start work. The common request path re-reads the canonical entitlement snapshot, protecting stale callbacks after lapse. Server precheck and post-retrieval K+ checks remain intact.

| Field | Result |
| --- | --- |
| SOURCE_STATUS / PACKING_SOURCE | PASS |
| BUILD_FLAGS | Existing Packing flag unchanged; Staging certification compiled on; ordinary Production remains off |
| SERVER_SWITCH_STAGING | Existing server authority unchanged; real deployed handler served both requests |
| SERVER_RUNTIME_PROOF / PACKING_STAGING_RUNTIME | PASS: generation and pack-light refinement returned valid plans, each with 7 owned fixture items and 4 outfits |
| PROVIDER_INVOCATIONS / PACKING_PROVIDER_INVOCATIONS_USED | 2 / limit 3; no dispatched failure hidden |
| KPLUS_PRECHECK / KPLUS_POST_RETRIEVAL_CHECK | PRESERVED; real handler mutation controls fail if either authority check is removed |
| PERSISTENCE | Existing owner-scoped plan/checklist cache retained; source tests passed; no native offline certification |
| FREE_TO_KPLUS_RETURN / PACKING_POST_PURCHASE_RETURN_STATE | PASS source component execution: destination, dates, activities and note survive Free → membership → resolving → canonical active → submit |
| DISCOVERY / PACKING_DISCOVERABLE | YES for builds with flag plus valid Staging proof; fail closed elsewhere |
| KPLUS_CATALOG_STATE | Proof-gated entry in existing catalog |
| PACKING_RUNTIME_PROVEN | 1 |

The refinement request used the real existing client and deployed function with `packLight: true`. The recorded assertions validate successful, owned-only output; they do not claim native visual quality, a particular lighter item count, or a paid purchase occurred.

## Smart Watchlist

Root cause: Free product actions opened acquisition before capturing the selected listing and intent. They now open the existing intent picker, which retains listing, intent and target while the shared membership sheet opens. On iOS the picker yields its native Modal and waits for onDismiss before opening membership; returning also waits for membership native dismissal. Android uses its existing presentation behavior without depending on an unsupported dismissal callback. The picker component remains mounted throughout. Both platform sequences are executed in source tests; physical UI remains unverified. Row reads survive lapse, automatic premium refresh stops, and reactivation refreshes once. A fresh canonical server check immediately before provider observation closes the claim-to-dispatch lapse race; this backend change is source-tested and has not been deployed by this lane.

| Field | Result |
| --- | --- |
| SOURCE_STATUS / WATCHLIST_SOURCE | PASS |
| BUILD_FLAGS | Existing Watchlist flag unchanged; certification on; ordinary Production remains off |
| STAGING_WORKER_FLAG / STAGING_WORKER_STATE | Existing scheduled worker enabled; no config write |
| STAGING_SCHEDULE | Existing scheduled workflow reviewed read-only |
| STAGING_RUNTIME_PROOF / WATCHLIST_STAGING_RUNTIME | PASS tracking against the pre-recheck backend (identity `3ad59c01…`): real canonical create, own-row read, one real Kicks Crew adapter refresh, available finite price and last-checked timestamp. WATCHLIST_TRACKING_EXISTING_RUNTIME=PROVEN, bound to that implementation |
| WATCHLIST_PR_HEAD_BACKEND_RUNTIME | PENDING_DEPLOY. The fresh provider-side K+ recheck (`runEntitledWatchObservation`), lapse-before-provider protection and the new worker source are source-tested only; none is runtime-certified |
| FORCED_REFRESHES / WATCHLIST_FORCED_REFRESHES_USED | 1 manual single-Watch refresh / limit 2; 0 forced worker dispatches |
| IOS_PUSH / ANDROID_PUSH | UNPROVEN; prompts and push availability copy withheld |
| DISCOVERY / WATCHLIST_DISCOVERABLE | NO for this source: the tracking record's identity no longer matches, so it is withheld until the current backend is deployed and the run repeated. Claim bound for when it returns: "Track eligible products and check price changes." No continuous-monitoring, push, lapse-race or scheduled-worker claim |
| FREE_TO_KPLUS_RETURN / WATCHLIST_POST_PURCHASE_RETURN_STATE | PASS source component execution: canonical listing URL, buy-under intent and target 123.45 survive acquisition |
| KPLUS_CATALOG_STATE | Tracking only; no autonomous monitoring or alert claim |
| WATCHLIST_ENTITLEMENT_LAPSE | PASS source tests: rows retained, refresh stops, fresh provider check fails closed |
| WATCHLIST_REACTIVATION | PASS source tests: refresh resumes once |
| WATCHLIST_WORKER_BEHAVIOR | BLOCKED / UNPROVEN actual fixture behavior |
| WATCHLIST_WORKER_EVIDENCE | Scheduled Staging run 37579235736: HTTP 200, enabled=true, claimed=0; proves operation only, not behavior on an eligible Watch |
| PRODUCTION_WORKER_STATE_READ_ONLY | Existing enabled flag observed; unchanged |
| PRODUCTION_SCHEDULE_STATE_READ_ONLY / PRODUCTION_WATCHLIST_SCHEDULER_OBSERVATION | Run 37578944725 pending with no jobs at observation; prior 37510627994 cancelled with no jobs |
| PRODUCTION_WATCHLIST_SCHEDULER_CAUSE | UNPROVEN |
| WATCHLIST_RUNTIME_PROVEN | 1 for tracking only, bound to the pre-recheck backend identity; 0 for the current source |

An eligible worker claim requires buy-under, push enabled, and canonical K+. This lane found no governed fixture-adapter seam that could establish real worker behavior while safely suppressing customer push. It did not alter Production, force a shared worker, fabricate a provider observation, or infer behavior from claimed=0. Protected-environment approval is only a hypothesis for the Production observation.

## Cloud Closet

Root cause: there was no customer status projection over the existing sync/restore authority. The new card reads the durable per-actor sidecar and actual current-process engine activity; it invokes only the existing migration, sync and restore passes. Running state is never persisted. Process restart therefore reconciles pending work to WILL RETRY rather than pretending it is still syncing. A prior capability proof cannot mean current data is up to date.

| Field | Result |
| --- | --- |
| SOURCE_STATUS / CLOUD_CLOSET_SOURCE | PASS |
| SYNC_FLAG / RESTORE_FLAG / MIGRATION_FLAG | New explicit overrides only in Staging certification. Existing Production certification and build35-testing already compile all three on and remain unchanged; ordinary Staging/Production are unset, default off. Proof gating independently withholds all Cloud claims |
| CUSTOMER_VISIBILITY / CLOUD_CLOSET_CUSTOMER_VISIBILITY | HIDDEN_PENDING_RUNTIME_PROOF; the card exists but is not advertised as available |
| KPLUS_GATE / CLOUD_CLOSET_KPLUS_GATE | PASS source: shared membership gate plus existing engine/server canonical guards |
| LOCAL_CLOSET_FREE / LOCAL_CLOSET_REMAINS_FREE | YES; local content remains outside the paid card |
| STAGING_OUTBOUND_SYNC / STAGING_MEDIA_UPLOAD | UNPROVEN; inserting synthetic facts for Packing is not outbound-engine/media proof |
| STAGING_RESTORE / STAGING_MEDIA_RESTORE | UNPROVEN |
| STAGING_EDIT_PROPAGATION / STAGING_DELETE_PROPAGATION | UNPROVEN runtime; existing engine regression tests passed |
| ACCOUNT_SWITCH_ISOLATION / CROSS_ACTOR_ISOLATION | PASS source engine tests and non-vacuous actor-guard mutation control; no native certification |
| ENTITLEMENT_LOSS / CLOUD_ENTITLEMENT_LOSS_NONDESTRUCTIVE | PASS source: local/restored facts and media retained; no new cloud query/download on lapse |
| ENTITLEMENT_REACTIVATION | PASS source: existing restore resumes |
| CLOUD_STATUS_RESTART_RECONCILIATION | PASS pure projection tests: stalled durable pending work becomes WILL RETRY; errors become RETRY NEEDED |
| CROSS_DEVICE_PROOF_TYPE | BLOCKED; no actual second isolated app client |
| CROSS_DEVICE_BLOCKER | Windows host cannot run iOS; no attached ADB device or established isolated second native app client |
| CROSS_DEVICE_STEP_EVIDENCE | Setup preflight only; no restore execution, no media/edit/delete/account-switch device assertions |
| PHYSICAL_TWO_DEVICE_CERTIFIED | NO |
| CLOUD_CLOSET_RUNTIME_PROVEN | 0 |

The cross-device attempt did not substitute a mocked Node engine for a second app client and did not consume an unbounded setup window. The card can say SYNCED ON THIS DEVICE only when actual current local revisions, server IDs and ready media all reconcile and outbound runtime proof is valid. It never says UP TO DATE. Cross-device wording requires separate actual restore proof.

## K+ value presentation and discovery

| Field | Result |
| --- | --- |
| CAPABILITIES_ADVERTISED | Preserved Voice/VTO rules; Packing only where its Staging proof identity and build flag match; Watchlist withheld until its tracking proof is renewed against the current backend; Cloud and Concierge hidden |
| PACKING_COPY | Smarter trip planning from your Closet. |
| WATCHLIST_COPY | Track eligible products and check price changes. |
| CLOUD_CLOSET_COPY | Hidden; bounded backup copy prepared, cross-device copy withheld |
| UNPROVEN_CLAIMS / UNPROVEN_CAPABILITY_ADVERTISING | NONE / NO |
| CURRENT_MEMBERSHIP_COMPONENTS | KPlusMembershipSheet, KPlusMembershipStep and shared KPlusBenefitsList, activation/catalog consumers |
| BENEFIT_LIST_OWNER | Existing KPlusBenefitsList in `components/kplus/KPlusPaywallParts.tsx` |
| BENEFIT_LAYOUT_OWNER | Existing paywall layout in `components/kplus/KPlusMembershipStep.tsx`, using `KPlusPaywallParts.tsx`; layout unchanged |
| EXISTING_GRID_OR_CARD_PRIMITIVE | Existing one-line benefit rows; no second paywall or pricing engine |
| SHARED_WITH_VTO_LANE | Catalog consumers are shared; VTO PR has no current semantic membership/catalog overlap |
| KPLUS_EARLY_ACCESS | OFF across governed profiles; implementation unchanged |
| REVENUECAT_CHANGED / VTO_CHANGED / SPEECH_CHANGED / SCANNER_CHANGED | NO implementation changes in protected lifecycles/pipeline |
| KPLUS_AUTHORITY | PRESERVED; no direct entitlement-table write or client injection |
| ACTIVATION_RUNTIME_COUNT | 2 |
| ACTIVATION_STATUS | SOURCE_COMPLETE_RUNTIME_PROVEN_FOR_2 |

Existing content-free K+ exposed/started/completed/acquisition events are reused. Packing Home exposure is recorded only when eligible for display; Watch intent retains existing start/completion events; Cloud card and sync events are allowlisted but remain runtime-blocked because its card is hidden. No analytics funnel metric is invented. No destination, trip note, wardrobe content, product URL, price target, login or JWT is emitted by the new telemetry.

## Staging governance

The user authorized a dedicated actor, not repurposing shared synthetic-active. Three dedicated public-signup attempts were used: the first stopped on a harness module-loader mismatch before any provider dispatch and was cleaned; the next two served Packing and Watch proof. Login values existed only in process memory and temporary GitHub staging environment secrets. Fresh password-grant JWTs used the existing synthetic-auth helper, were immediately registered for masking, and were never printed or persisted. The K+ mutation path was service-role canonical RPC only, promotional source, unique Build35 grant keys and four-hour expiration.

| Field | Result |
| --- | --- |
| STAGING_WRITES_TOTAL | 24 enumerated Staging mutations; plus 12 GitHub environment-secret set/delete operations = 36 ledger entries |
| STAGING_WRITES_RESTORED | All 3 temporary grants revoked through canonical RPC; resolved FREE verified for the two runtime actors; all 3 actors deleted |
| STAGING_WRITES_PERSISTED | 0 retained fixture/config/deployment changes; revoke restores access before auth deletion cascades dedicated canonical grant state |
| STAGING_SYNTHETIC_STATE_CLEANED | YES: read-only verification shows 0 auth/closet/watch/session/daily-usage/canonical-grant rows for all 3 actors; 0 temporary login secret names remain |
| STAGING_WRITE_LEDGER / RUNTIME_BUDGET_LEDGER | `docs/audits/build35-premium-value-ledger.json` |
| Ledger pending outcomes | 0 |
| Shared security actor | Unchanged; canonical FREE |
| Production writes / feature flags / functions / app_config changes | 0 / NO / NO / NO |

Signup trigger side effects and auth-delete cascades are recorded under their parent resource operations. Synthetic Packing quota/session/fact rows and the Watch row/event are removed by actor cleanup. No synthetic media or device-push fixture was created. No migrations, storage policy, auth configuration, server switch or Edge deployment was changed.

## Tests and negative controls

| Check / field | Result |
| --- | --- |
| TARGETED_TESTS | PASS final focused groups; 57 premium-value cases, shared gate/VTO/enforcement group 150 pass, final claim/scope/premium group 112 pass; earlier catalog/VTO 95 pass; surface/config/Cloud groups 223 pass |
| NEGATIVE_CONTROLS | PASS; all below reject a mutant or exact profile drift |
| FULL_REGRESSION_OBSERVED / KNOWN / UNEXPECTED (Windows) | 31 / 13 / 18 on lane and exact untouched base; configured baseline remains 19 identities, unchanged |
| WINDOWS_LOCAL_FAILURES | 31; exact identities in `build35-premium-windows-comparison.json` |
| WINDOWS_LOCAL_NEW_FAILURE_IDENTITIES | 0 |
| Full Windows inventory | 557 test files found and executed; 1 fixture directory excluded with explicit reason; 10,335 tests, 10,205 pass, 31 fail, 99 skip |
| BACKEND_TESTS | PASS governed Deno runner: 1,252 passed, 0 failed; new provider-boundary tests included |
| TYPECHECK | PASS `npx tsc --noEmit` |
| EDGE_PARITY / EDGE_MANIFEST | PASS source bundle parity and manifest currency; only generated commerce-watch-refresh bundle changed semantically |
| DEPENDENCY_REACHABILITY | PASS; no baseline or exception widening |
| Migration provenance / native config parity | PASS |
| SECURITY | PASS security unit checks and validation runner; its expected localhost ZAP rejection is an intentional negative control |
| TestSprite | UNVERIFIED_BECAUSE_UNDEPLOYED: CLI/auth and linked backend project verified; no MCP tunnel available, and new source is not on a reachable deployed target |
| LINUX_CI_FULL_SUITE_RESULT / LINUX_CI_UNEXPECTED_FAILURES | PASS / 0 on source commit `f62be2d16360c4fa72e5446d26ea75202d08b49d`: 557 files executed; 13 observed, 13 configured-known, 0 unexpected; baseline unchanged. This result covers that earlier commit only. The truth-binding change adds a test file and edits proof consumers; its own Linux result is recorded separately and this line is not evidence for it |
| WINDOWS_TRUTH_BINDING_RUN | 558 files; 31 observed, 13 known, 18 unexpected; all 18 unexpected identities are in the base list, 0 new |

The Windows-only observed failures include pre-existing path-separator/mutation-harness and PostHog module-loading failures. They are measured against a second untouched worktree at the exact base, not relabeled as passing or added to a baseline. The latest focused tests also cover tests added after the full run. No old deployed build was used as TestSprite evidence for this source change.

Initial PR CI found the existing VTO guard's broader backend allowlist did not enumerate this lane's three Watch worker files. Its VTO-owned source guard passed. The test inventory now includes only the worker entry point, fresh entitlement guard and guard test, justified by the owner's Premium Value brief and P1-WATCH-LAPSE. An additional control rejects Watch provider, push and database paths. This is an exact authorized-path inventory update, not a failure-baseline widening or VTO implementation change.

The first inventory repair briefly added a new static test, which violated the existing MODE A test-count invariant in Linux CI. Its assertions were folded into the existing per-path rejection test; the invariant and all enforced scope tests pass without changing the required count. Subsequent native modal sequencing required mechanical updates to assertions that expected immediate sheet opening. Their resolving-state, canonical K+ and intent-preservation contracts remain tested.

| Negative control | Assertion exercised |
| --- | --- |
| NC-PV-01 (addendum replacement) | Any effective Today flag drift in any governed profile fails the hold |
| NC-PV-02 | Removing real Packing server precheck admits client-only access and fails the test |
| NC-PV-03 | Removing Packing second check admits a retrieval-time lapse and fails the test |
| NC-PV-04 | Removing real restore K+ guard admits lapsed cloud work and fails the test |
| NC-PV-05 | Removing real restore actor guards applies a foreign actor's page and fails the test |
| NC-PV-06 | Removing Cloud build-flag containment advertises a dark build and fails the test |
| NC-PV-07 | Admitting unconfirmed/source-only capability posture fails the claim contract |
| NC-PV-08 | Removing the actual Watch modal platform-proof guard shows an unproven alert prompt and fails the test |
| NC-PV-09 | Replacing canonical Watch creation SQL authority with client state fails the guard |
| NC-PV-10 | Altering RevenueCat or legacy Early Access source fails the protected release guard |
| NC-PV-FP-01 | Removing the implementation-fingerprint equality lets a stale proof authorize, and the mutated-source guard fails |
| NC-PV-FP-02 | Removing the identity shape check lets two equal malformed values authorize, and the malformed-identity guard fails |
| NC-PV-FP-03 | The membership expiry hook must use the shared authority predicate, not a private copy of the old label comparison |
| FP-B | Mutating any single governed file of any proof type changes its identity and withdraws the old proof (every governed file is exercised) |
| Extra lapse / expiry controls | Removing fresh Packing/provider K+ checks or open-membership expiration invalidation fails executed tests |

## CI and remaining verification

PROJECT_CHECKS=PASS; SECURITY_CODE=PASS; PROMOTION_GATE=PASS; DEPENDENCY_GATE=PASS; STAGING_SECURITY=PASS; VTO_E2E=PASS_CONTRACT_AND_SCOPE; ZAP_BASELINE=PASS; ZAP_API=PASS; PR_CHECKS=ALL_APPLICABLE_GREEN on source commit `f62be2d16360c4fa72e5446d26ea75202d08b49d`. Paid live VTO certification, dry-run and cleanup jobs are inapplicable/skipped; no paid VTO execution was inferred. The final documentation-only commit is checked again in the handoff. No automatic merge is authorized.

CI evidence: [Project checks + security](https://github.com/kscanaiapp/kscan-app/actions/runs/37637872490), [promotion](https://github.com/kscanaiapp/kscan-app/actions/runs/37637871943), [dependency](https://github.com/kscanaiapp/kscan-app/actions/runs/37637872209), [Staging security](https://github.com/kscanaiapp/kscan-app/actions/runs/37637872004), [VTO contract/scope](https://github.com/kscanaiapp/kscan-app/actions/runs/37637871791), [ZAP Baseline](https://github.com/kscanaiapp/kscan-app/actions/runs/37637871952), [ZAP API](https://github.com/kscanaiapp/kscan-app/actions/runs/37637872089).

OPEN_BLOCKERS: actual second isolated app client and Cloud outbound/media/restore proof; native iOS/Android visual, keyboard and purchase-return checks; platform push certification; real worker fixture behavior; deployed TestSprite execution. Provider budgets are not exhausted. No shared-surface owner decision is currently pending.

VERDICT=PARTIAL. Cross-device setup is blocked and its capability is hidden. Packing and tracking runtime evidence are real and bounded; all source mutation tests pass, dedicated state is cleaned, and Production writes remain zero. The PR is a concrete source review artifact, not authorization to advertise Cloud, push, scheduled behavior, or Production availability.

Implementation file groups: `app/packing/index.tsx`, `PackingTripForm`, `usePackingPlan`; `ProductShelf`, `PurchaseOptionsPanel`, `useWatchlist`, `app/watchlist/index.tsx`, `commerce-watch-refresh` fresh guard; `CloudClosetCard`, `app/library.tsx`, `closetCloudStatus`, existing sync/restore in-flight readers and telemetry; existing Home discovery, activation catalog, acquisition mapping and live capability hook; Staging certification flags, generated manifest, exact baseline, runtime harness and audit artifacts; focused and mechanical regression test updates. The PR diff is the full file inventory.
