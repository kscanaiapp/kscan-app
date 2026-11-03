# Build 35 functional readiness and activation register

Status: **IN PROGRESS — integration repairs pending**. This phase follows the owner's November 3 transition from broad hostile auditing to integration, activation, functional verification and bounded defect repair.

## Current source and scope

- Mobile authority: `integration/build35-v1-convergence` at `40122f80e4a24a8761b22e3154f06934ae579653` (#691 source-closed; all nine independent post-merge workflows successful).
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
| Packing generation / refinement / errors / kept plan | **FAIL on current authority for the reproduced #711 recovery defects; combined proposed source PASS in controlled mounted tests** | #705 evidence retained. Updated head `e07b606e` adds the HTTP-authority correction; 57 combined affected checks, TypeScript and Edge parity pass | Complete #711 current-head green CI, merge identity and independent branch checks |
| Paywall → RevenueCat → webhook → Supabase → access | **PASS, webhook operational activation**; **PARTIAL, complete premium journey** | #713/#714 merged after green CI. Approved Production deployment and actual provider deliveries verified; see RevenueCat section below. #704 source/accounting evidence reused | Actual Apple/Google purchase, restore, store-driven unlock and revocation **NOT TESTED** under build hold. Do not repeat completed webhook probes |
| Saved Scans / Closet / Library save and restoration | **PASS, retained controlled source save/navigation/restore and persistence contracts** | Actual saved-scan action-row destination, cloud service, manifest/restore and actor-isolation tests retained with identical source. Restrictive saved-scan and owned-restore migrations applied to both environments; eight prior rollback-only Staging checks retained | Actual current-binary cross-device operation remains NOT TESTED; no migration or database-probe replay |
| Black-owned secondary discovery | **PASS, defined infrastructure and controlled source isolation boundary** | Discovery and catalog worker ACTIVE in both environments. Actual Scanner host invokes hook and renders optional shelf; primary does not await secondary. #705 failure/empty/hang cases and 47 backend checks retained | Empty legitimate catalog is expected and does not block infrastructure readiness. Merchant data and #694 scheduler prerequisites are separate; no fabricated inventory |
| Watchlist | **PASS, W2 source guard / controlled handler boundary; PARTIAL, complete deployed feature** | #691 merged at `40122f80` after 30 successful / 17 conditional-skipped checks; reviewed, tested and merged trees match. All nine independent post-merge workflows successful. Canonical W2 bytes and actual-handler regressions retained | No W2 deployment claim. Scheduling #688 is lower-priority owner automation configuration, not a core activation blocker |
| Live Camera VTO | **PASS, defined source entry/gate/controller integration; native runtime NOT TESTED** | Real Home → Studio composition, mounted source session/controller cases from #702, and unchanged native module/bridge source retained. Fixtures supply the native runtime and permissions | Camera/tracking/rendering accuracy requires later running-device QA; it is not a source merge blocker. No new artifact build |
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

1. **#691 Watchlist W2 — SOURCE-CLOSED:** original reviewed head `596e2c01`; combined reviewed head `d2d920b1f807c8efaa3b3f35b360d540143df64a` merged as `40122f80e4a24a8761b22e3154f06934ae579653`. All share tested tree `357447c080a1b087e5d4838140273b33d421fc8a` with GitHub's final candidate `5d33e628`. Canonical handler / regression bytes agree with backend. Affected checks: 57 PASS / 0 FAIL; TypeScript and Edge parity exit 0. Required CI: 30 successful / 17 conditional-skipped, no failures or pending; reviews and unresolved threads empty. All nine independent post-merge workflows succeeded. No deployment performed.
2. **#711 Packing — current-head CI running:** head `e07b606e1c1666358d0d227f76ade5d2ed47a553`, tree `f49e51fd6adc0c5459533b834be7436cdc62c20c`, includes #691 plus the HTTP failure correction below. Combined affected checks: 57 PASS / 0 FAIL (overlaps other focused populations; do not sum); combined TypeScript and Edge parity exit 0. The generator advanced Packing to `e327460f6a23ab33251ca426136c75d5b55b24cdc080707c05047803efad2f01` while preserving both Watchlist and both Closet identities. Published after the preceding shared Staging workflow completed; required CI, merge and independent branch checks remain pending.
3. **Combined functionality:** preserve all existing source fixes; add tests only for an identified missing customer workflow or concrete regression. No full hostile matrix or mutation campaign, paid canary replay or manual broad baseline.

The original missing Contract artifact on each PR is an operational CI failure. Required cancelled validation is being recovered; no security evaluator or required check is waived. No source repair is closed until its merged authoritative tree and independent branch checks are recorded.

## Integration repair B35-INT-001 — P3, proposed Packing source

The initial #711 error-body recovery accepted any versioned body with a string message. A `FunctionsHttpError` 403, 429 or 500 carrying a validated success-shaped plan therefore entered the normal success parser and moved the mounted screen to `ready`. The root is `services/packing/packingClient.ts:isPackingEnvelope` and its call in `requestPackingPlan`; `hooks/usePackingPlan.ts:170` also writes accepted plans to the cache.

Actual mounted regressions in `__tests__/packingHttpFailureAuthority.test.js` failed 0 PASS / 3 FAIL on #711 head `22160d9b`, with `ready !== failed`. This is a regression in the proposed patch, not a deployed Production finding. The minimal shared-platform correction recognizes only `error`, `not_entitled` and `no_result` outcomes in an HTTP-error envelope. Success/general guide bodies remain transport failures; the last plan and cache remain intact.

Three new cases and the original eight recovery cases pass 11/11 after correction; isolated TypeScript exits 0. First failure logs are retained. Final combined-source validation and green merge through the same #711 remain required. No backend API, migration, provider, entitlement rule or legal copy changed.

## User-facing access and activation qualifications

**November 3 read-only configuration check:** known-boolean digest equality confirms Packing, Elise brand voice, Scanner image mission, organic discovery and verified ownership badges are enabled in **both Staging and Production**. Sponsored placements, sponsorship sandbox and sponsorship shadow mode are all disabled in both. Receipt extraction is disabled in both. [Allowlisted boolean evidence](evidence/functional-integration-1103/activation-boolean-readback.json) contains no credentials, other secret metadata or secret values. No configuration was changed and no provider was called. Flags establish enablement, while the separately retained canaries and mounted paths establish their own narrower execution boundaries.

`components/home/HomeLuxuryTechV1.tsx:456` mounts the Packing route under its build flag, and `:508` routes active members into Watchlist through the shared K+ gate. `app/packing/index.tsx:190` uses the same gate; the server independently rechecks entitlement. Existing production build profiles set the Packing and Watchlist flags to true. Expired records in `kplusCapabilityProof.ts` govern benefit presentation, not those Home entries; they must not be relabeled as a feature outage or renewed from source-only fixtures. Actual paid store transactions remain a later verification boundary.

Receipt extraction is different: `EXPO_PUBLIC_RECEIPT_INTELLIGENCE_V1` defaults off and is absent from the reviewed EAS profiles; the library action obeys it. The independently verified server kill switch was also off. Security migrations and function deployment therefore do not establish customer activation. No switch was changed here. Enabling this paid processing path needs its existing owner quality/activation gates and governed rollout; it is not silently bundled into the source repairs.

Unchanged authentication, saved-scan, Closet, native Live VTO and K+ acquisition evidence is reused at its stated controlled boundaries. Source-level assertions do not establish actual password-email delivery, OAuth-provider completion, camera accuracy or store transactions. Only an identified missing functional path or concrete regression justifies new execution.

[Source-equivalence register](evidence/functional-integration-1103/evidence-reuse-and-source-equivalence.json) confirms 183 relevant source files are identical between retained mobile baseline `2c2c9da4` and combined proposed source `e07b606e`. All ten changed app-level paths are attributed to #707, #708, #712 or the current Packing/capability work. Backend #713/#714 changed recovery/deployment tooling and no Edge Function source. This supports reuse of the recorded results; it does not promote a mock to live-provider evidence or renew an expired capability proof.

## Current release boundary

No source freeze or release-readiness PASS is declared. Immediate source work is #691 and #711. Receipt extraction remains separately activation-gated despite its completed security rollout. No new Production changes, shared migrations, purchases, prices, store submissions or EAS builds are authorized by this register. TestSprite remains waived by the owner because the account has no credits.
