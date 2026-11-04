# Build 35 bounded functional closure — November 4

This closes the requested source/integration work rather than reopening the historical hostile audit. The original PR #646 remains draft/held with **220 PASS / 1 FAIL / 2,875 NOT TESTED (354 N/A included)**. Its old failures remain historical evidence; these tests are not silently added to its population. Final exact merge/branch-CI dispositions are maintained in [#706](https://github.com/kscanaiapp/kscan-app/issues/706).

## Closure chain and source identity

| Item | Observed failure and repair | Verification and remaining gate |
|---|---|---|
| B35-INT-003 / P1 Scanner | Prepared proof was bound only to bytes; async preparation/auth could change actors, and the real locked SDK could attach B's token to A's queued image. Proof now binds actor generation; preparation and every send are fenced; dispatch requires and pins the validated preflight token | #723 merged `acbbff9dc6cecf8deb5db0ea541cb34a8b8644ab`. Reviewed head `d3a85732`, server candidate and merged tree `e03b2d21` equal.34 successful/20 conditional-skipped checks; no review holds.11563 Node PASS/96 skipped/0FAIL;1605 backend PASS/0FAIL. [Exact evidence](evidence/functional-privacy-1104/scanner-merge-closure.json) |
| B35-INT-004 / P2 Elise | Direct attachment captured candidate authority after encoding. The shared header-gallery callers likewise captured current identity after awaited compression/identification. Capture the initiating actor before work, carry it into staging, compose revision/cancellation fences and discard stale derivatives | Runtime `be3c0495867a156e57bf7feb5c6a4d996f1c6225`, based on merged #723.3 original cases PASS;4 additional affected-caller regressions PASS.36 affected and200 related checks PASS; TypeScript exit0 and parity PASS. Normal exact-head CI/merge/independent branch checks still required when this record is committed. [Evidence](evidence/functional-privacy-1104/elise-closure.json) |
| Watchlist W1/W2 deployed-source discrepancy | Previously deployed16-file tree lacked repaired input/ticket boundaries and canonical URL dependencies. Promote only `commerce-watch-refresh` through existing controlled workflows | Staging run41813090774 SUCCESS/v30; owner-and-environment-approved Production41820352202 SUCCESS/v19.17/17 returned files in each equal canonical backend `9047ce434e16a7b52f1f45edaeebafc2f1800757`. Same ESZIP digest `323a723e1e1553b61658f87e0943e718f0b3b589a065da90e6c6d4ef4dd08520`. Health/smoke PASS, rollback correctly skipped. [Readbacks and approval](evidence/functional-watchlist-deploy-1104/closure.json) |

The Watchlist source-manifest bundle hash `04f8bf0b2d6009f273087c8451e7f4d1dd2bee5a07c187598938a87294c3db3f` is not the exported ESZIP digest. Source identity, function version, health and real push delivery are distinct. Retained actual-handler regressions plus exact deployed source establish the repaired W1/W2 implementation; no new live malformed-provider or customer push test was performed. No migrations, flags, secrets, scheduler, prices, customer records or Scanner function deployment changed in this rollout. Protected prior-bundle recovery remains available; a successful run does not demonstrate executing rollback.

## Bounded #703 source privacy determination

The discovery batch contains exactly10 cases:7 Scanner and3 direct Elise. Across disjoint before-fix cases it produced2PASS/8FAIL; intermediate overlapping logs and harness failures are not summed. Four subsequent header-gallery regressions were necessary to verify the same Elise repair's existing callers, not another discovery campaign or extra original-matrix credit. No paid provider, real customer imagery, new binary or Production privacy probe was used.

- **Scanner:** actual preparation/transport/proof modules and the actual locked Supabase SDK2.105.4 execute under synthetic auth/fetch/native boundaries. Source tests establish exact derived bytes, stale proof rejection, no new dispatch after observed actor invalidation, cleanup, and retention of the initiating token during SDK token resolution. They do not establish real detector accuracy or cryptographic JWT validation.
- **Closet:** retained actual privacy-boundary, primary/thumbnail and cloud-sync contract evidence applies to unchanged source. Covered paths use sanitized derivatives; plate-like regions are blocked under that policy. These fixtures do not certify native recognition accuracy or a running device's network capture.
- **Elise:** `privacyImageUpload.ts` explicitly uses metadata-stripping re-encoding. It is **not face/plate masking**, and transport truthfully avoids a masking attestation. Direct attachment and header staging remain private actor-scoped candidates, without automatically creating a saved scan or owned Closet item. Current repairs fence the producer before the existing candidate library's independent write authority.
- **Consent:** reuse completed deployed Gemini grant/withdrawal/denial evidence and existing client denial handling. The supported guarantee is no new authorized provider request after effective denial is observed; already-dispatched data cannot be recalled. No new permission migration, consent wording or provider canary was repeated.
- **Photo VTO:** intentionally transmits a separately disclosed/consented person image. It must not inherit the Scanner local-masking claim. Existing lifecycle/cost evidence is retained.
- **Analytics:** retained explicit-property/identity/queue/opt-out controls remain qualified source evidence. No conclusion about lawful processing or provider retention is inferred from a limited ingestion sample. Final legal wording, website, retention/deletion commitments and processor terms remain owner/legal responsibilities.

H-003 remains **native accuracy NOT TESTED**, assigned to later platform QA rather than classified as a confirmed source P0. H-001's legal/vendor questions remain qualified dependencies, not invented unlawful-processing findings. There is no universal Zero-Knowledge or all-image masking certification.

### Original matrix relationship — no blanket PASS

| Original record | Related new evidence | Adjudication |
|---|---|---|
| B35-MAND-2134, Scanner account switch in flight |7 real source-boundary controls, including cached proof and real SDK token race |PASS at these controlled service/transport boundaries after repair; full camera/selected/multi-item UI-to-authority population is not exhausted. Historical cell remains unchanged |
| B35-MAND-2435, Elise account switch in flight |3 original direct-image cases plus4 header repair regressions |PASS at preparation/candidate-producer boundary after repair. Native picker/store/RLS are not independently certified by these fixtures; historical cell unchanged |
| B35-MAND-2135/2136 and2436/2437, supersession/shared-cache poisoning | Actor/proof and candidate fencing are relevant partial evidence |No full-scenario PASS inferred. Preserve NOT TESTED for unmatched properties rather than counting similar assertions as coverage |

Original source fingerprints for both Elise modules are equal at prior baseline `6e187a3c`, Scanner review `d3a85732`, and merged baseline `acbbff9d`; retained original counterexamples remain applicable. Lossless archives, source blobs, commands, harness-only failures and exact outcome populations accompany this record. The historical raw evidence is preserved.

## User-facing feature integration

The [functional register](build35-functional-readiness-report.md) retains source/staging evidence for mounted Scanner results/commerce CTAs, actual Elise session/retry/persistence, Packing generation/refinement/kept plans, Library/Closet destinations and restore, accessible paywall/premium gates, secondary discovery, Photo VTO state transitions and Home-to-Live-VTO controller composition. These are qualified journeys, not merely file existence or HTTP200 claims.

Already-completed Gemini, MODE B, saved-scan/RLS, discovery, Packing and RevenueCat checks were reused. RevenueCat Production v18 webhook activation is PASS from its separate approved deployment and real provider TEST deliveries; Apple/Google purchase/restore remains NOT TESTED under build HOLD. Empty verified discovery catalog is expected and is not an infrastructure failure. Watchlist scheduler automation is separate and lower priority. Account-deletion-cycle changes remain owner-deferred; existing isolation is retained.

## Candidate-build decision

**Recommend GO to lift the candidate-build HOLD only when the Elise repair completes normal green CI, merge/tree verification and independent branch checks in #706. Until that closure, the demonstrated P2 remains the source gate.** Scanner post-merge checks are also recorded there. This is a precise pending engineering gate, not a requirement to re-execute all historical audit cells.

After that source gate, the remaining checks belong to candidate QA and release preparation: native camera/masking accuracy with captured synthetic payloads, audio/animation/interruption, real iOS/Android permissions and URI handling, OAuth/password-email delivery, Apple/Google sandbox purchase and restore, signed-artifact manifests/assets/declarations, and owner legal/website reconciliation. Receipt extraction remains intentionally OFF under its separate quality/activation gate; no activation is implied. The current source work does not authorize or generate an EAS build, store upload, new Production configuration or store submission.

GO for candidate evaluation is not customer-live or store-submission certification. If final CI identifies a concrete regression, repair that regression and keep HOLD until it is resolved; do not launch a new exhaustive campaign or weaken a required gate.
