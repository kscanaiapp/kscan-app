# Build 35 functional readiness and activation register

Status: **IN PROGRESS — integration repairs pending**. This phase follows the owner's November 3 transition from broad hostile auditing to integration, activation, functional verification and bounded defect repair.

## Current source and scope

- Mobile authority: `integration/build35-v1-convergence` at `8c0cd7756e6a692d0aea4407b0cd49d11a72ea5c`.
- Backend authority: `rebuild/backend-authority-v2` at `9047ce434e16a7b52f1f45edaeebafc2f1800757`.
- Historical audit: [PR #646](https://github.com/kscanaiapp/kscan-app/pull/646), preserved at evidence commit `28e49416e75c874f7d569c88486f8c3c7e045ac3`. Original population: 220 PASS / 1 FAIL / 2,875 NOT TESTED, including 354 explicitly N/A. This population is not being expanded or presented as an exhaustive audit PASS.
- Activation coordination: [Issue #706](https://github.com/kscanaiapp/kscan-app/issues/706).

PASS always names its boundary. A controlled mounted-source journey is not a device test. Operational webhook delivery is not a store purchase. Physical-device certification is outside this phase and does not block green source repair merges. Candidate builds remain on HOLD.

## Functional register

| Feature and user journey | Functional outcome and boundary | Integration / activation evidence | Remaining work |
|---|---|---|---|
| Onboarding / sign-in / recovery / consent | **PARTIAL** overall; existing v2 receipt, withdrawal, account-scope and denial-client controls retained | Server consent migration and gated Scanner/Elise deployments already verified; #707 corrected the consent-denial recovery instructions | Reconcile complete mounted entry-to-consent-to-return journey using existing coverage; current installed v1-only client cannot provide v2 acknowledgment. Compatible candidate rollout remains #706 |
| Scanner → recognition → shopping → outbound CTA | **PASS, retained controlled source and earlier Staging canaries** for the defined paths; customer-binary journey not certified | Actual `app/scan/index.tsx` mounts root `app.js`, which renders `ScanResultV2`; MODE B three-offer canary already executed. #712 contains OS-link failure; #708 preserves Android permission Settings recovery | Reuse #705 and paid canaries. Verify combined-source identity after pending repairs; no repeat paid model call |
| Elise conversation / styling / speech | **PARTIAL** overall; retained source handlers, persona, consent, prompt and missing-timing controls pass within their fixtures | Repaired StyleChat handler already promoted. Brand voice and real Staging advice previously verified; synthesis/animation source regressions retained | Check for missing user-visible session/recovery continuity only; provider/native audio behavior remains separately qualified |
| Packing generation / refinement / errors / kept plan | **FAIL on current authority for the reproduced #711 recovery defects; repaired source pending merge** | #705 completed eight mounted tests, baseline and related checks. Four root categories: lost non-2xx envelope, futile daily retry, timeout misclassification, failed-refresh narration | Complete #711 green CI and merge after #691; preserve both generated capability identities; run affected mounted paths on the combined source |
| Paywall → RevenueCat → webhook → Supabase → access | **PASS, webhook operational activation**; **PARTIAL, complete premium journey** | #713/#714 merged after green CI. Approved Production deployment and actual provider deliveries verified; see RevenueCat section below. #704 source/accounting evidence reused | Actual Apple/Google purchase, restore, store-driven unlock and revocation **NOT TESTED** under build hold. Do not repeat completed webhook probes |
| Saved Scans / Closet / Library save and restoration | **PARTIAL** overall; retained source save/restore, transaction-honesty and isolation controls | Restrictive saved-scan and owned-restore migrations applied to both environments; existing eight rollback-only Staging checks retained | Reconcile user-visible save → library → actor switch → restore coverage without replaying migrations or standard database probes |
| Black-owned secondary discovery | **PASS, defined infrastructure and controlled source isolation boundary** | Discovery and catalog worker ACTIVE in both environments. Actual Scanner host invokes hook and renders optional shelf; primary does not await secondary. #705 failure/empty/hang cases and 47 backend checks retained | Empty legitimate catalog is expected and does not block infrastructure readiness. Merchant data and #694 scheduler prerequisites are separate; no fabricated inventory |
| Watchlist | **PARTIAL; W2 invalid-body failure still open on mobile authority** | Canonical W2 guard merged in #700; W1 ticket validation source closed. #691 promotion matches canonical bytes and includes actual-handler regressions | Finish #691 current-source gates/merge. Scheduling #688 is lower-priority owner automation configuration, not a core activation blocker |
| Live Camera VTO | **PARTIAL** overall; source/native integration evidence retained | Existing real Home → Studio source composition and native session/controller tests retained from #702 and prior repairs | Reconcile actual entry/gates/available state transitions. Camera/tracking accuracy remains device-only QA; no new artifact build |
| Photo VTO | **PARTIAL** overall; retained source consent, reservation and conservative paid-dispatch accounting controls | Existing provider-boundary/error accounting evidence reused | Identify any missing user-visible result/recovery integration before adding tests; no new paid provider call |
| Analytics / image privacy | **PARTIAL / qualified** | Existing identity/privacy source controls retained. Residual image transport/race work remains assigned to #703 | Consume #703 evidence when available; do not duplicate its cases. Owner owns final legal wording and website; engineering may update factual metadata |
| Account lifecycle | **PARTIAL, scope limited to existing access restrictions** | Preserve active-account and actor-isolation controls used by in-scope workflows | Deletion-cycle changes remain owner-deferred. Public links retain approved revoke/purge behavior |

## RevenueCat operational activation — PASS

Accepted evidence: [final #706 checkpoint](https://github.com/kscanaiapp/kscan-app/issues/706#issuecomment-6614912477) and [human-approved protected deployment 41720529717](https://github.com/kscanaiapp/kscan-app/actions/runs/41720529717).

- Backend source: `9047ce434e16a7b52f1f45edaeebafc2f1800757`, including normal green merges #713/#714.
- Production: ACTIVE v18, `verify_jwt=false`; candidate OPTIONS 204; missing/wrong Authorization and missing/tampered signatures 401; correctly signed TEST 200/ignored. Real RevenueCat Production TEST delivery returned 200.
- Bundle digest: `fb65ff97143ac3a392f666dfaa2e1c3dd9277dd11f8e43e0c4850218bebba971`; verified six-file tree `1c3e8503c4579dafb14dea51ed9f4d310e83accecfca09ae5335fec5735c527b`.
- Staging: ACTIVE v14 with the same bundle digest; sandbox-only integration `whintgrf131e15447`. Corrected real RevenueCat TEST delivery returned 200. The initial header-mismatch 401 remains historical evidence.
- Real Staging handler/database lifecycle: initial purchase applied once, replay duplicate with one grant, foreign actor rejected with zero foreign grants, expiration applied. Two tagged synthetic actors and grants cleaned up. These normalized events are not real store purchases.
- Existing Production integration `whintgr048cedb053` remains production-only. Secure configuration and exact hashed readback were verified by the delegated agent without public credentials.
- The historical failed deployment/recovery-health verdict remains preserved. Its old bundle was independently verified as restored before the approved new deployment; no repeat recovery is required.

Actual Apple/Google sandbox purchase, restoration, premium unlock and store-driven revocation remain **NOT TESTED**, not FAIL, under the candidate-build HOLD. The primary manager consumes this evidence; it has not rerun or taken over the RevenueCat operations lane.

## Active repair sequence and validation

1. **#691 Watchlist W2:** original reviewed head `596e2c01`; combined local source with mobile `8c0cd775` is tree `357447c080a1b087e5d4838140273b33d421fc8a`, local merge commit `d2d920b1f807c8efaa3b3f35b360d540143df64a`. Canonical handler / regression bytes agree with backend. Affected source checks: 57 PASS / 0 FAIL; TypeScript exit 0; Edge parity exit 0. GitHub's retained merge candidate used an older base, so the existing PR is being advanced by a normal fast-forward to the tested combined tree. No runtime rewrite. Required current-head CI and merge remain pending.
2. **#711 Packing:** serial promotion after #691, resolving only any generated fingerprint overlap by recomputation. Reuse completed #705 evidence; verify affected mounted error and state paths against combined source, then require normal green CI/reviews and merge identity.
3. **Combined functionality:** preserve all existing source fixes; add tests only for an identified missing customer workflow or concrete regression. No full hostile matrix or mutation campaign, paid canary replay or manual broad baseline.

The original missing Contract artifact on each PR is an operational CI failure. Required cancelled validation is being recovered; no security evaluator or required check is waived. No source repair is closed until its merged authoritative tree and independent branch checks are recorded.

## Current release boundary

No source freeze or release-readiness PASS is declared. Immediate source work is #691 and #711. Receipt extraction remains separately activation-gated despite its completed security rollout. No new Production changes, shared migrations, purchases, prices, store submissions or EAS builds are authorized by this register. TestSprite remains waived by the owner because the account has no credits.
