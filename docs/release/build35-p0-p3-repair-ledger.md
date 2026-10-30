# Current continuation repair status

## B35-C-011 — P3 — DNS hostname bypass of media network-topology guard

- CONFIRMED controlled local reproduction on canonical531f288f source (actual adapter/default Deno fetch wrapped only to restrict the synthetic garment destination): `deno test --no-config --node-modules-dir=none --allow-env --allow-read --allow-net=127.0.0.1:443,127.0.0.1.nip.io:443 C:/b35readback1030/media-dns-loopback.test.ts` returns0PASS/1FAIL. Our own127.0.0.1:443raw listener accepts1connection/64TLSClientHello bytes. Provider submits0; outcome invalid_garment_input/non-billable. Listener is closed by the fixture; if443 is occupied it refuses to contact the existing owner.
- Independent DNS lookup of127.0.0.1.nip.io and127.0.0.1.sslip.io returns127.0.0.1 locally; the actual pure URL guard accepts both. Metadata-alias DNS lookup returnedENOENT and is NOT presented as demonstrated metadata access.
- Exact source contract: `_shared/net/safeRemoteMedia.ts:assertSafeRemoteMediaUrl/isNonPublicHost` claims network-topology refusal but checks textual hostname forms only; `providers/aiLabToolsProvider.ts:fetchWithTimeoutAndCap` then calls the normal resolver/transport on accepted domain names. DNS aliases therefore reach a private TCP/TLS destination before TLS fails. Existing literal-IP and redirect controls do not close this route.
- Actual demonstrated impact: private network-contact boundary bypass in a controlled local runtime. No successful TLS or HTTP response, private content, credential exfiltration, provider charge, customer incidence or Production/Supabase egress exploit is demonstrated. P3 follows the reproducible restricted-destination contact; it is not inflated to P0/P1 from a hypothetical leak.
- Root cause: hostname validation is separated from actual socket-address resolution. A DNS precheck followed by a normal re-resolving fetch would leave a rebinding race and is not an acceptable complete fix.
- Repair investigation: current Deno public createHttpClient options do not expose a supported JS DNS-pinning option. A controlled Node-HTTPS custom-lookup compatibility test now proves1lookup/1connection to our own listener, without disabling TLS verification; initial missing-env and incorrect all-address callback fixtures are retained as INVALID HARNESS, not product failures. Node-HTTPS lookup is a viable source candidate; actual Supabase Edge compatibility still requires evidence.
- Source work pending: bounded validated-address transport retaining original hostname/SNI/certificate checks, per-hop URL guards, abort/size caps, no environment-proxy bypass, zero paid calls on denial, controlled resolver/rebinding/IPv4/IPv6 tests. No new provider, retailer preference, schema, auth policy or Production change is authorized/inferred.
- Serialized order13, after C010 canonical659 and its exact mobile promotion660. Shared adapter files are edited by the lead only; do not combine C010 and C011 into one repair PR. This finding is no longer the unconfirmed DNS lead; it remains OPEN until a complete source repair and required validation are prepared.

## Current October30 merge and new-reproduction status

Owner authorized merging fully green PRs. F007/#656 is MERGED in backend98c88ff1240b6596649d7967e9a180d43d7fa83e (tested treeffd3f40d identical; backend1523PASS; branch CI7/7SUCCESS). G008/#657 is MERGED in mobile9c66fe50f537179046bc4e8b160ec4ddd1c463b6 (tested37330f80 identical; Node11345PASS/0FAIL/98SKIP; branch CI9/9SUCCESS). Mobile promotion658 is in validation, head75610bc5da4e7c7ae2ba4fc0eb9a8cb8abe11f71. Its first full run correctly failed one meta-test expecting10static guard passes after an added11th control; exact count and named-test assertion were corrected without removing controls. Required full rerun/CI remain pending. Historical pending-owner statements below are superseded.

### B35-C-010 — P3 — remote VTO garment bytes bypass image-integrity rejection before dispatch

- CONFIRMED by two offline executions on148e48d26ac390de40ec21aed0efa41f29870775; affected VTO source bytes equal canonical backend98c88ff1. `deno test --allow-env --allow-read C:/b35readback1030/vto-remote-image-integrity.test.ts`:2PASS/4FAIL. Zero-byte,12-byte truncated PNG, HTML labelled image/jpeg and corrupt bytes labelled image/webp each reach the real adapter's POST boundary. Declared text/html is rejected; valid2918-byte PNG is the positive control.
- Full actual handler plus actual adapter reproduction: `deno test --allow-env --allow-read C:/b35readback1030/vto-remote-handler-integrity.test.ts`:0PASS/1FAIL. An HTML garment labelled JPEG followed by a simulated provider400 yields HTTP422/provider_rejected_input, submit1, complete-failed1, release0. Provider and quota storage are injected; no live charge, customer loss, live database mutation or paid-provider claim is made.
- Exact source/function: `supabase/functions/vto-generate/providers/aiLabToolsProvider.ts:189` fetchWithTimeoutAndCap checks MIME header/size only; `:433` generate wraps unchecked remote bytes into top_garment; `:446` dispatches POST. `vtoHandler.ts:599` forwards the validated URL to the adapter and `:641` onward retains a failed attempt for provider rejection. Contract: invalid/corrupt media must be rejected before unnecessary provider dispatch; an invalid retailer response must not consume a usable try-on attempt through a preventable paid-boundary call.
- Root cause: remote-media validation trusts a declared image MIME type without verifying bytes. Inline garment and result-media validation are separate existing paths; this finding is specifically the remote garment path. SeverityP3 reflects reproducible feature reliability/quota degradation, not an invented unauthorized charge or P0 exposure.
- Repair IN PROGRESS, lead-only dedicated C:/b35vtomedia1030, branch repair/build35-vto-remote-media-integrity-20261030, based canonical98c88ff1. Small bounded byte-integrity guard at the remote garment boundary, supported-format positive controls and real handler settlement regression planned. No public API/schema/provider-selection/flags/Production changes. Merge only after governed green checks under owner approval; subsequent exact mobile promotion is required.
- Serialized order:12, after656backend/657client and658discovery promotion. The lead alone edits adapter/manifest; no overlapping agent or combined defect PR.

Authorities remain mobile `c86bf3d052806c6105ce7830a03ac2b1501d34a1` and backend `f4df2a5a525fb7ee1b22f16c9a4bc55c1c8831af`. The nine historical repairs are MERGED IN SOURCE; older prepared/unmerged statements below are historical, not the current verdict. No repaired runtime has been deployed during this continuation.

| Serialized order | Finding | Current source repair | Evidence and gate |
|---|---|---|---|
| 10 | B35-F-007 P3, restricted-account discovery | PR #656, `ffd3f40d48b1e45c08b976cd623c41dbaab6e3da`, backend authority target; READY FOR REVIEW, UNMERGED | Real Staging active/pending/locked fixture; 8 focused and 1,523 backend tests pass; CI 32 successful/14 skipped/0 failed at last readback. Owner merge approval pending; mobile promotion and deployment are separate gates. |
| 11 | B35-G-008 P3, analytics identity failure | Draft PR #657, `37330f804fbb5cca38cf706a84041fcbdeb2c687`, based on mobile c86bf3d0; SOURCE PREPARED, UNMERGED | Actual wrapper fixture reproduces event capture under A after a failed switch to B. See [finding and reproduction](build35-g008-evidence.md). Final focused16/16, TypeScript0; eight PR workflows successful. Full642-file2worker suite11345PASS/0FAIL/98SKIP; six source gates0. Owner merge approval required. No live vendor/device test or deployment claimed. |

Two newly confirmed P3 findings are separate from H-001's unresolved legal assessment and H-003's device-dependent masking investigation. No new P0, P1 or P2 is established. Private-room account restriction passed its separate real Staging fixture; it is not a defect. Shared runtime files are edited serially by the lead. Required merge order: owner-approved #656 backend source, governed equivalent mobile backend promotion, and separately approved G-008 client repair; none is silently included in an evidence-only merge.

## NEW B35-F-007 ? P3 ? Discovery ignores authoritative account restriction

Confirmed on current source c86bf3d0/f4df2a5a and real Staging v5 using one tagged synthetic actor. Active request returns200/empty/quota1; admin-controlled pending_deletion then locked profile still returns200/empty, quota2 then3, while Auth user endpoint remains200 with same valid JWT. Evidence continuation-discovery-lifecycle-staging.json; reproducible guarded script staging-discovery-lifecycle.ps1. Synthetic actor tag verified before deletion, cleanup HTTP200. No customer content/merchant fabrication/paid provider call.

Exact root cause: supabase/functions/black-owned-discovery/index.ts:43 authenticate:requireUser validates identity only; handler.ts:60-69 then claims quota and discovers without the shared assertAccountActive used by other customer functions. _shared/deletion/common.ts:294 rejects either restricted profile state/account_locked_at. This contradicts authoritative account restriction before normal authenticated operations. SeverityP3 follows limited catalog/quota effect, not account isolation or paid provider compromise.

Repair queued in dedicated backend-authority worktree C:/b35discoveryguard1029: wrap verified nonanonymous identity with existing assertAccountActive before any claim/catalog operation, preserve disabled zero-I/O and anonymous denial. Regression must use actual createDiscoveryHandler pipeline, verify0quota/0catalog for pending/locked/missing/error, and retain active baseline. No schema/flag/JWT changes or deployment. Owner merge gate remains required.

> ACTIVE CONTINUATION CHECKPOINT: authorities independently verified c86bf3d0/f4df2a5a, nine prior repairs merged;110archives verified. New PostHog70/70 and discovery7/7 source probes; current Scanner nullP4 remains reproduced. H001 UNCONFIRMED/legal authority pending; H003 native accuracy not certified/ADB0targets. All3041 outstanding cells now have execution dispositions (300N/A,2443local,285Staging,8sandbox,4native,1artifact); classification is not coverage completion. See [high-risk privacy evidence](build35-high-risk-privacy-verification.md) and current checkpoint. Full campaign remains INCOMPLETE; no newP0-P3 finding or runtime repair.

> **CURRENT STATUS (2026-10-29, supersedes SHA/merge statements below):** the nine P0–P3 repairs are merged under owner approval. Build 35 authority `integration/build35-v1-convergence` = `c86bf3d052806c6105ce7830a03ac2b1501d34a1` (PR #648; tree identical to candidate `751e3815`). Backend authority `rebuild/backend-authority-v2` = `f4df2a5a525fb7ee1b22f16c9a4bc55c1c8831af` (PRs #649 → #653 → #647). #644/#645/#650/#651/#652/#654/#655 are superseded by #648. Final-SHA validation: Node 11,336/0 fail/98 skip, TypeScript and six gates exit 0 at `c86bf3d0`; Deno 1,515/0 at `f4df2a5a`. No deployment, migration application, flag change or build occurred; migration `20261029184000` remains unapplied. See [final source convergence](build35-final-source-convergence.md). Open items (B35-B-004, H-001, H-003, the probe matrix and device/artifact phases) are unchanged.

> FINAL STOP-STATE: Latest complete full Node validation:751e3815,11336 passed/0failed/98skipped,total11434; log candidate-node-permission-matrix-final.log and exit0 captured. Runtime source is unchanged froma376f2f7 (TypeScript and six source gates0), backend unchanged from53b93724 (1531/0failed). No combined-SHA runtime claim.

> OWNER STOP: current candidate751e3815; PR654 now36020928 with29/29 focused tests after12 added failure injections; runtime repair source unchanged. Source-prepared9,merged0,deployed0. Exact wording APPROVED, merging/deployment not approved. Latest complete Node/source gates ata376f2f7; collect pending751e3815 rerun before certifying.

# Build35 current repair ledger

Current disposition supersedes the dated discovery/planned/blocked entries preserved below. Nine confirmed P0-P3 findings: P1=4,P2=3,P3=2; P0=0 confirmed. Nine source repairs prepared, zero merged, zero deployed. One owner-gated P4 remains unimplemented. Owner authorized durable withdrawal SOURCE work; wording is owner-approved; merge remains gated. No defect is declared operationally repaired.

| Order | ID / priority | Separate repair PR / original source | Prepared candidate commit | Regression / current gate |
|---|---|---|---|---|
|1|G-001 P2|644 bd2827e7|da480d9b,84fe1c89|22/22; owner approval, review promotion648 rather than Build34 target|
|2|C-001 P1|645 8c86a9fd; decoder backport fb08e845|e2395662|39/39; explicit owner merge approval; latest CI pending after decoder|
|3|F-002 P1|647 aedfbf78; decoder backport9ab4a2da|95468f05,7624ab3f|38/38; promotion artifact/CI rerun clearance required|
|4|C-002 P1|649 ded0ee8d; decoder backport6f768494|1dd0ac17,84e5a628|41 gate tests plus3 source-neutrality controls; required CI and coordinated consent rollout|
|5|COST-003 P2|650 dae4ff07|1db2ef1c|54/54; conservatively retains ambiguous paid dispatch; old stacked CI red, candidate validation separate|
|6|G-004 P3|651 31d2f53c|29ba460c|Controlled mounted before failure,25/25 after; old stacked CI red, final candidate tests pass|
|7|C-004 P3|652 fc503112; decoder backport1c3433e2|50088fd0|Three actual provider/client/engine missing-timing failures before;85 focused after; no physical-device lip-sync PASS|
|8a|C-005 P1 backend|653 5b5c471a; decoder backport394645c2|40b0d52e|41 gate/108 SQL-governance focused;1508 backend and8533 Node source-branch passes; new migration unapplied|
|8b|C-005 P1 client|654 a5fb7f75; decoder backport26c06e73|53b93724|17/17 actor/revision/error/duplicate/platform cases; Owner wording APPROVED; merge approval required|
|9|F-006 P2|655 37a519bc,b4ba29c8|9f0eb834,a376f2f7|3/3 actual query consumer/provenance tests; clean install; dependency gate PASS, final Node11324/0fail/98skip, TypeScript0|

No shared-file parallel edits. Lowest-risk independent changes were committed before serial consent/index/manifest changes; table is the candidate preparation order, NOT a merged-PR history. Candidate648 is a376f2f7fc6694b30e5623998a56522eccf20280, clean and pushed. Authoritative integration remains65a1e7cd. Explicit644/645 approval cannot be bypassed by merging648. Older stacked650/651 CI inherits earlier base failures; passing candidate does not mark those checks green or authorize red merges.

## Latest withdrawal repair evidence

C-005 root cause is a positive immutable receipt treated as current permission. Source migration supabase/migrations/20261029184000_gemini_processing_permission.sql:1-74 adds own-read RLS, no client table writes, expected-actor/revision RPC fences, retained receipt authority for grant and cascade deletion. Server _shared/geminiConsent.ts:36-46 rechecks live state before each model transfer and fails closed on missing migration/backend/malformed/foreign state. An absent override preserves a valid current receipt; an explicit withdrawal denies403. It does not recall already-dispatched data.

Client services/geminiProcessingPermission.ts:7-32 validates actor/version/type/revision/ack with timeout; components/settings/GeminiProcessingSettingsSection.tsx:11-43 uses actor-generation fences, synchronous double-submit lock and unknown+retry after ambiguous save. Existing app/privacy.tsx:749 mounts it; no new screen/tab/modal/library. Draft copy is visible in654 for review. Tests use actual SQL migration/PGlite plus platform-injected clients/components. Withdrawal, re-consent, legacy/no receipt, A/B IDOR, direct-write denial, anonymous caller, concurrent stale grant, duplicate withdrawal, account cascade, account switch, write401/timeout/wrong response, no optimistic success and both platform paths are executable evidence. No Production migration or feature activation.

Source/runtime distinction: new migration declared KNOWN_FUTURE_UNAPPLIED in both authorities. Required path is protected migration approval -> matching backend rollout -> client version/copy rollout with existing-user re-consent -> synthetic authorized staging E2E -> platform artifacts. Deploying v2 enforcement before supported clients can acknowledge v2 is a rollout risk, not silently authorized here.

## Latest decoder repair evidence

Before command node --test __tests__/uriDecoderSecurity.test.js on vulnerable locked consumer fails bounded replacement assertion:1031 replacements on7171 bytes. After official0.5.1 algorithm compatibility patch:5 replacements,3/3 tests. Full candidate a376f2f7:11324 passed,0 failed,98 skipped; npx tsc --noEmit exit0; six source gates including dependency reachability exit0. Captured uri-decoder-before.log,uri-decoder-after.log,candidate-node-decoder-final.log and candidate-source-gates-decoder.json. No SDK upgrade, contract change or advisory exception. Algorithm source SHA is pinned and tested after reversing only module export/legacy-plus adapters; MIT retained.

## Historical discovery/reproduction entries (status statements superseded above)

# Build 35 P0–P3 repair ledger (source repairs prepared; owner-gated)

## B35-G-001 — P2 — malformed secondary response can break primary result rendering

- State: CONFIRMED, source repair committed; draft PR #644, unmerged and undeployed. Shared iOS/Android client.
- Source: services/blackOwnedDiscovery.ts, requestBlackOwnedDiscovery response validation; services/blackOwnedDiscoveryHost.ts, displayableSecondary productUrl.split; components/scan-results/ScanResultV2.tsx calls displayableSecondary in render.
- Contract: invalid secondary results must be hidden and must never interfere with primary commerce.
- Reproduction executed: `node --test __tests__/blackOwnedDiscoveryClient.test.js`; new malformed-field regression fails on `{productUrl:42}`. Evidence: evidence/discovery-before.log.
- Code argument: response validation accepts any productUrl type; host calls split on a truthy productUrl. A numeric URL therefore throws during parent render. Non-string price/image fields also reach React/native props. No runtime incidence claim.
- Root cause: TypeScript assertion was used at an untrusted network boundary without validating display fields.
- Planned repair: reject malformed optional display fields and unsafe/non-HTTPS destinations at the service boundary; preserve fail-closed secondary semantics and primary ordering.
- Regression: malformed-field fixture; focused discovery client and host tests.
- PR #644; commit bd2827e7bb524cf149ac01ae5443f2901bbb29f6. Focused 22/22 pass. CI snapshot evidence/repair-ci.json shows green checks plus explicit skips. Merge and authoritative reverification NOT DONE.

## GOV-01 — authority conflict (operational gate, no fabricated product priority)

RESOLVED by existing scoped governance: RP-108 reserves pre-freeze for Build 34; Build 35 targets integration/build35-v1-convergence. The 5/512 divergence and four conflicts were reconciled in prepared PR #648, without Build 35 ancestry on pre-freeze. #644 must not merge to its original pre-freeze target; its repair is promoted with provenance into #648. No authority override or merge performed.

## Runtime gate — organic discovery deployment

Authenticated Production function inventory contains no black-owned-discovery slug. Source merged is verified; backend deployed is CONTRADICTED for the current readback. Protected deployment is a separate owner-approved action. No new feature or merchant data will be manufactured to hide this gap.

## B35-C-001 — P1 — Gemini provider/text consent omitted and legacy acceptance remains sufficient

- CONFIRMED on integration baseline 65a1e7cd. Reproduction: `node --test __tests__/build35GeminiConsentDisclosure.test.js` fails both assertions. Evidence: evidence/gemini-consent-before.log.
- Exact source: app/onboarding/index.tsx:680 says only “I consent to AI image processing”; constants/legal.ts:4 retains AI_PROCESSING_VERSION=v1; services/onboardingCompletion.ts:68 accepts a matching local version marker without rechecking the ledger; services/style-chat/providers/edgeStyleChatProvider.ts:364 sends chat text to stylechat-generate, whose provider is Gemini.
- Contract violated: provider-specific disclosure and explicit consent covering Elise text, including existing-user upgrade flows, before transfer.
- Root cause: image-only disclosure and unchanged acceptance version do not cover Gemini text processing. Existing v1 marker is accepted as current.
- Repair scope: explicit Gemini/photos/text/Elise disclosure adjacent to the short Gemini-consent checkbox; version-bound upgrade forces existing v1 users through current acknowledgment. No binding Terms/Privacy rewrite or invented provider retention claim.
- Regression: real legal constants plus legacy local marker fixture; source disclosure assertion; existing legal/onboarding suites.
- PR #645; commit 8c86a9fd (full SHA in convergence record). Focused 39/39 pass; CI pending. Merge and authoritative reverification NOT DONE. Cross-platform device enforcement and direct backend consent authority remain NOT TESTED.
- Merge order: 1 B35-G-001 (#644); 2 B35-C-001 (separate disjoint files, integration branch). Lead is sole editor; no shared-file parallel repairs.

## B35-F-002 — P1 — outfit generation lifecycle check fails open

- Confirmed by source contract: backend authority `supabase/functions/style-outfit-generate/index.ts`, lifecycle block after verified `userId`, reads `.from('profiles').select('account_status').eq('id', userId).maybeSingle()` but discards the error and rejects only pending_deletion/locked. Missing/RLS-hidden rows, lookup errors and other non-active states proceed to Gemini and saved-look work.
- Contradicts the existing server-authoritative account-active contract used by Scanner and StyleChat in `_shared/deletion/common.ts:assertAccountActive`, which fails closed and resolves missing profiles through Auth plus effective deletion state.
- Repair queued: replace local two-status check with shared account-active guard through a testable response adapter; no schema/policy or Production mutation.
- Regression planned: missing/error/deactivated guard failures produce 403 and zero downstream work; active account proceeds; index wiring guard precedes parsing/provider/reservation.
- Owner/merge: lead only, dedicated backend-authority repair branch/PR, separate from consent work. Status OPEN.

## B35-C-002 — P1 — Gemini transfer endpoints do not enforce the consent receipt

- Source contract evidence on backend authority 3efcb6cb: scan-identify/index.ts authenticates paid inference then calls Gemini without reading legal_acceptances; stylechat-generate/index.ts has auth/account gates then Gemini/Packing dispatch without a receipt check; style-outfit-generate/index.ts and purchase-import-extract/handler.ts likewise omit it. These are the complete discovered Gemini transmitters (Packing is dispatched through stylechat).
- This contradicts the campaign's before-transfer consent contract: PR #645 only changes onboarding, and direct authenticated clients can bypass route/onboarding state.
- Repair queued: shared fail-closed receipt check requiring the exact v2_google_gemini version for the verified actor before quota/provider work on all four entries. Preserve MODE B commerce-only behavior. No raw content, credentials or legal rows logged.
- Backend authorization behavior explicitly flagged; no Production deployment authorized by this source patch. No schema or wire-body change planned.
- Revocation remains a distinct authority gap: legal_acceptances is an immutable receipt ledger, not a withdrawal ledger. Do not claim a version check implements revocation.

## B35-COST-003 — P2 — VTO certification can misclassify an accepted paid submission as not dispatched

- Reproduced on source-converged candidate 4c09c44d: full Node suite fails `vtoE2eUserGarmentProbe.test.js:598`, which proves authorization_failed can now be returned after generation began (durable settlement/receipt failure in canonical VTO-001–005 repairs).
- Exact source: scripts/vto-e2e/lib/userGarmentProbe.mjs NOT_DISPATCHED_FAILURE_CODES includes authorization_failed; dispatch classification later uses that list to set zero dispatch. Contract requires ambiguous post-submit outcomes to remain accounted, never authorize a second paid test call.
- Planned repair: remove only authorization_failed from the zero-dispatch list and explicitly pin the conservative classification. All other zero-submit codes retain the source/adapter negative control.
- Scope: test/certification cost accounting; no provider, billing, entitlement or quota configuration changed. Dedicated repair follows source promotion, not a weakened assertion.

## B35-G-004 — P3 — ownership badges can remain visible beyond their known expiry

- Exact source: components/luxury/ProductCard.tsx renders hasVerifiedOwnership only on React renders; components/scan-results/PurchaseOptionsPanel.tsx does the same for primary rows. Neither schedules a refresh at verifiedUntil. An idle mounted result can therefore retain a verified badge after its supplied timestamp expires.
- Reproduction executed on convergence source: `node --test __tests__/ownershipBadgeExpiry.test.js` with controlled clock and real ProductCard. A valid displayed badge schedules zero expiry updates (expected one); ordinary unrelated card control passes. Evidence badge-expiry-before.log.
- Contract: expired ownership records must not continue producing verified badges. No claim of observed Production incidence (organic discovery is currently disabled/undeployed there).
- Repair queued: one shared expiry-refresh hook used at both rendering patterns, no new tokens/layout/copy, no extra network/provider call, stable hook order. Test the expiry-triggered update and unrelated card.
- Shared-file serialization: lead only; ProductCard and PurchaseOptionsPanel source promotion already committed before this repair starts. Separate stacked repair PR targets the convergence branch.

## Verified repair disposition (supersedes earlier queued/planned status)

No repair has merged. All six have source-level regression evidence; all remain unavailable in the authoritative release head until governed promotion and explicit owner approval where required.

| ID | Priority | Repair PR / source commit | Candidate promotion | Regression evidence | Current gate |
|---|---|---|---|---|---|
| B35-G-001 | P2 | #644 bd2827e7 | da480d9b / 84fe1c89 | discovery-before.log -> discovery-after.log, 22/22 | Owner approval; original pre-freeze target forbidden for Build 35; review #648 promotion |
| B35-C-001 | P1 | #645 8c86a9fd | e2395662 | disclosure/version before failure -> 39/39 | Owner explicitly requires merge approval; green CI snapshot pr645-ci-latest.json |
| B35-F-002 | P1 | #647 aedfbf78 | 95468f05 plus canonical manifest/privilege reconciliation 7624ab3f | outfit-gate-before.log -> outfit-gate-after.log 38/38 | Backend-authority PR CI/review; no production deployment |
| B35-C-002 | P1 | #649 ded0ee8d | 1dd0ac17 / 84e5a628 | four transfer wiring failures -> 41 passing receipt/import tests; 3/3 neutrality proof | Green backend CI; owner/governed backend promotion; no durable withdrawal claim |
| B35-COST-003 | P2 | #650 dae4ff07 | 1db2ef1c | test at vtoE2eUserGarmentProbe.test.js:598, 54/54 after conservative classification | Stacked PR inherits older convergence failures; replacement source in #648; no paid probe |
| B35-G-004 | P3 | #651 31d2f53c | 29ba460c | badge-expiry-before.log FAIL -> badge-expiry-after.log 25/25 | Ownership subsystem owner gate; stacked review source is #648 |

C-002 root cause/repair: verified actor must have an exact legal_acceptances ai_processing:v2_google_gemini receipt before any Gemini reservation or transfer. _shared/geminiConsent.ts rejects absent/old/foreign/wrong-schema receipts (403), backend lookup failures (503), and rechecks without a cache. Scanner commerce-only MODE B stays before this gate. Purchase import, outfit, chat (including Packing), and image inference are covered. This changes backend authorization behavior, explicitly flagged; no database policy/schema, subscription price or provider selection changed. Receipt disappearance/re-consent tests are not proof of an approved durable withdrawal workflow. Immutable legal receipts and the absence of a Gemini withdrawal authority require owner/legal resolution before universal consent certification.

F-002 root cause/repair: use the existing shared assertAccountActive authority, not the two-status local comparison that ignored lookup errors. The response adapter fails before request/provider work. Its shared import legitimately carries a larger static privilege footprint; the source inventory was reconciled rather than hiding those dependencies.

G-004 root cause/repair: mounted cards did not rerender at their supplied verification deadline. useOwnershipExpiryRefresh schedules a bounded expiry refresh, cleans up on unmount/supersession and is called unconditionally in ProductCard and PurchaseOptionsPanel. No ranking/layout/copy, provider request or visual primitive changed.

### Serialized candidate preparation / merge order

Preparation order (not merges): canonical mobile discovery source -> G-001 parsing -> canonical backend closures/migrations -> C-001 disclosure -> F-002 lifecycle -> C-002 transfer receipt -> COST-003 accounting -> G-004 expiry -> exact VTO scope provenance. Shared files are edited by the lead only. Backend F-002 precedes C-002 where both touch outfit index.ts. Candidate contains equivalent cherry-picked commits; individual PR commits are not misrepresented as merged. Proposed governed merge order is backend #647 then #649, owner-approved mobile #645 and reviewed #648 convergence; #644/#650/#651 must be explicitly dispositioned as provenance/superseded or retargeted under Build 35 governance, never merged into an unrelated authority to manufacture convergence.

## B35-B-004 ? P4 ? JSON null Scanner body escapes controlled input handling

- CONFIRMED: qa/security/edge-entrypoint-hostile.test.ts calls the real scan-identify handler with body null; one TypeError, zero provider dispatch and zero privileged writes. Evidence hostile-entrypoints-enabled.log / hostile-entrypoints-results.json. No service compromise, customer incidence or paid amplification demonstrated.
- Exact code argument: scan-identify/index.ts:1907 assigns req.json() without an object guard; v2Activation.ts:258 treats missing version as legacy; index.ts:1945 then dereferences body.mode. JSON null is valid JSON but not an object, so the parse catch does not contain it.
- Expected: controlled invalid-body response; actual: uncaught TypeError. Proposed smallest fix is an object/non-array guard immediately after parsing plus real-handler negative fixtures. Complexity low, shared backend scope, both platforms receive the same response.
- Safe P4 repair condition 4 fails: scan-identify is explicitly an owner-confirmation subsystem. Source repair is gated; priority is not inflated to escape the gate. Standalone hostile test remains red and report retains FAIL. No patch or schema/wire change has been made.

## CI/governance repairs (no invented product severity)

- #646 source-inventory terminology: exact historical evidence file classified, count reconciled with all original detector negative controls retained (7/7). Current evidence expansion must pass the same gate before ready-for-review.
- #648 migration fixtures: current authoritative ledgers verify four later migrations applied in both projects; fixed explicit source rosters and retained original frozen-snapshot controls (159/159 SQL/governance subset).
- #648 VTO scope: four exact files were already copied byte-equivalent from backend 3efcb6cb (original attempt settlement 34de6e0d, media validation 58ff6dc0). Added their individual manifest reasons/source, an exact canonical-byte parity test, and adjusted the static-test count 8 -> 9 solely for the added parity assertion. Live enforced scope now passes; all original refusal controls retained. Commit 72eee2fb.

## B35-C-004 ? P3 ? normalized absent provider timing starts fabricated lip movement

- Confirmed by real provider adapter -> real client -> real AvatarRuntime fixture. Three tests (empty/missing/malformed timing) fail before the patch; frames include closed,halfOpen,open,closed,closed even though timing evidence is absent. Evidence speech-empty-timing-before.log. No physical animation or latency incidence claim.
- Exact source: supabase/functions/stylist-speech/elevenLabsClient.ts normalizes unusable alignment to null; services/avatars/stylistSpeechClient.ts:58 previously returns null unchanged; services/avatars/engine/runtime/AvatarRuntime.ts:280 selects speaking-fallback for null. The isolated engine empty-array test was insufficient because the actual boundary loses that distinction.
- Contract: successful audio with empty timestamps must not animate unsupported lip sync. Root cause is the cross-layer representation of absent evidence, not ElevenLabs provider failure.
- Repair: normalize null timing to the engine's existing explicit empty timeline in the client; valid audio is retained, lips remain closed. Valid aligned timing and direct malformed response rejection retain their existing behavior. No backend API, wire schema, provider, copy, platform divergence, animation token or consent policy change.
- Dedicated branch repair/build35-speech-empty-timing-20261029, commit fc503112. Focused speech/engine/consent/interruption/recovery 85/85 passed, zero skips. PR pending creation at this checkpoint. Candidate serial promotion follows all prior shared-file repairs. Hardware sync remains NOT TESTED; no TestSprite deployment exists.

## B35-C-005 ? P1 ? Gemini consent has no durable withdrawal authority

- CONFIRMED code/contract contradiction: _shared/geminiConsent.ts:requireGeminiConsent reads only legal_acceptances for the exact actor/version. It does not read revocation state. services/thirdPartyAiConsent.ts:THIRD_PARTY_AI_FEATURES is a closed union containing only virtual_try_on and elise_speech, so its withdrawal implementation cannot revoke Gemini processing. services/legalAcceptance.ts:recordLegalAcceptances only inserts idempotent receipts. 20260617000001_create_legal_acceptances.sql:56-57 grants authenticated select/insert, not receipt mutation/deletion; the later restored AI type does not provide withdrawal. No durable Gemini revocation control was found in the actual privacy/onboarding routes.
- Stated contract: campaign mandatory consent withdrawal/re-consent, plus Apple's current App Review Guideline5.1.1(ii) requires accessible withdrawal. Official source checked: https://developer.apple.com/app-store/review/guidelines/#data-collection-and-storage . No invented universal24h response rule or vendor contract.
- Reproduction by source: accept current ai_processing receipt; no supported Gemini revoke call exists; every subsequent server check reads the same positive immutable receipt. Local VTO/speech withdrawal cannot affect that query. PR649's simulated receipt-disappearance test is not proof of a real withdrawal path.
- Root cause: immutable legal evidence was reused as current permission authority without a revocable state model. Material consent gap; not downgraded to an unconfirmed privacy concern. No claim a customer withdrew and was observed leaking data.
- Proposed complete repair: preserve immutable receipts; introduce actor-bound revocable consent state; recheck before all four Gemini transfers; add withdrawal/re-consent to the existing Privacy settings; verify stale/failed state and account switch; legal-reviewed copy. Requires source/data/UI changes beyond safe polishing.
- BLOCKED ON OWNER DECISION: user UX prohibitions forbid a new consent flow without owner decision. Asynchronous request asks authorization for the existing-Privacy-setting/durable-state repair and separate legal-copy/merge review. No dependent source work or Production mutation while pending. Other audit/CI work continues.

## B35-F-006 ? P2 ? shipped navigation query decoder has input-driven denial of service

- CONFIRMED exact contract/source: npm audit identifies decode-uri-component0.2.2 in the committed lock; query-string/index.js requires that decoder, and @react-navigation/core/src/getStateFromPath.tsx:750 calls queryString.parse on deep-link query input. Expo Router is imported by shipped routes. Dependency reachability correctly rejects a build/dev-only exception for that live path.
- Primary advisories GHSA-vcc3-ghjq-m6fr (recursive/exponential fallback) and GHSA-qr28-fpjm-wq7f (quadratic whole-string replacement) affect the installed version; patched upstream0.5.1 is ESM-only, while this SDK's query-string consumer requires a CommonJS callable. Blindly overriding to the registry ESM release can break navigation. Sources: https://github.com/advisories/GHSA-qr28-fpjm-wq7f and https://github.com/SamVerschueren/decode-uri-component/releases/tag/v0.5.1 .
- Scope/impact: input-driven JS CPU/availability, not credential disclosure or remote code execution. No attack sent to Production or a customer's device; physical Hermes timing remains unverified. P2 follows actual shipped parser reachability, not a CVSS label alone.
- Dedicated branch/worktree repair/build35-uri-decoder-dos-20261029 at C:/b35decode1030, based53b93724. Repair in progress: preserve Expo54/React Navigation versions; use exact upstream patched algorithm with documented CommonJS/legacy-plus compatibility and MIT license; verify deterministic replace-call bound, legitimate query decoding, source provenance, locked resolution and unchanged dependency gate. No broader security exception.
- Existing CI failures on #646/#648/#652/#653 are now additionally blocked by this newly ingested advisory; prior green checks are time-specific, not proof the new advisory was handled.

Owner update: exact PR654 Gemini control wording APPROVED; this does not authorize merging or deployment. Broader Terms/Privacy/store disclosure reconciliation remains a separate legal handoff.

## Latest exact state — supersedes earlier checkpoint snapshots

Mobile8bdcaaba986b169a15cb5545008ffef34c7b65f7 branch CI9/9SUCCESS; backend98c88ff1240b6596649d7967e9a180d43d7fa83e branch CI7/7SUCCESS. Source658merged and exact tested tree equality verified. C010repair659now412761fb0ea480e69bf910adad96a08dd07e592e, runtime/config byte-identical to tested7dc257bb;59focused/1531backendPASS. Initial scope CI correctly refused3new files;3exact justified declarations plus unrelated-sibling refusal added,52enforced-scopePASS/0skip. CI pending, unmerged, unpromoted, undeployed.

Original matrix3096:67PASS/6FAIL/3023NOTTESTED,300N/A. Five newly reconciled failures all describe C010, not five findings; applicable pending2723, local2426/Staging284/sandbox8/native4/artifact1.150lossless archives integrity-verified. Owner legal language/website handoff and factual metadata saved. Exact next: finish659CI and governed integration, merge current source into evidence646 without overwriting uncommitted work, preserve/push this batch serially, then continue high-risk probes. The audit is INCOMPLETE, with a confirmed unrepaired-in-authorityP3 until659converges.

## Owner-requested status checkpoint — October30

Mobile d342087cef908e806c891d5f19264d4eeeb8d665 (#660) branchCI9/9SUCCESS; backend531f288fe52ab7ff8ef733408779d19ba4d93c6b (#659) branchCI7/7SUCCESS. C010 exact canonical/mobile promotion verified; mobile11348PASS/0FAIL/98SKIP,1547backendPASS; TypeScript/six gates0. C010 initial2Node failures were frozen governance digest/roster, independently reconciled to canonical source with original holds/refusals retained.

New C011P3 confirmed actual controlled DNS/socket and actual handler; source repair661 at8384e8b0ec32312f2da978448d645fac44d7d5a5 is PUSHED, clean worktree C:/b35dns1030.73focused/1553backendPASS at runtime-identicala4a5fa1a,2actual networkQA plus1handler regressionPASS, public W3C TLS301->200 PNG1848bytes,52enforced scopePASS,24specifier-gatePASS after exact-four/VTO-only Node builtin declaration. First a4 CI correctly rejected node:dns under old remote-only gate; raw failure retained, no suppression. Current8384CI pending, draft/unmerged; no mobile promotion/deployment. Docker daemon unavailable; localDeno2.8.2 is not actual SupabaseEdge certification.

Matrix3096 now72PASS/3FAIL/3021NT,300N/A;2721applicablepending (2424local/284Staging/8sandbox/4native/1artifact). C010 five reverified cells PASS; C011 two socket/handler SSRF cells FAIL plus known P4B004.13confirmedP0-P3 total (P0=0/P1=4/P2=3/P3=6),12source-merged/1source-prepared. H001/H003 privacy investigations remain unresolved, not automatically P0. Preserve all raw archives/hashes and old68failure dispositions. Owner maintains policy/website text; factual legal metadata updated.

Exact next: collect8384/661CI, repair only real gating causes, verify ordinary governed source merge conditions and runtime compatibility requirements, then exact C011 mobile promotion/source proof. Do not reset C:/b35dns1030. Continue remaining high-risk coverage; the audit is not complete. Evidence646 remains current documentation lane, now based on merged d342source. Commit/push this status batch after current source staging gate clears; do not create another evidence PR. No paid generation, production write/deployment/migration/flag change, EAS or store action.

## Latest owner status cut — canonical DNS merge

Backend now3bab42e47817da8a4941efc4a509afee73879015 (#661), exact reviewed8384tree.13repairs source-merged in owning authorities,12fully mobile-converged; C011 mobile promotion and runtime verification remain. Fresh backend branch CI5successful/2pending; mobile d342branch9/9successful.

PROCESS DEVIATION:661merge occurred while3ready-refreshed checks werepending, violating owner fully-green condition despite earlier same-head green. Refreshed PRchecks subsequently32success/14skip; no deployment or protection override. Orchestration must branch on check result before any merge, never combine a read with unconditional mutation. This is recorded in the owner status report, not hidden as successful gate compliance.

Exact next: inspect3babbranchCI, finish exact C011mobilepromotion/source validation, continue high-risk coverage. Owner-requested status report is build35-status-report-2026-10-30.md; current matrix72PASS/3FAIL/3021NT remains qualified until candidate C011 convergence. Evidence171archives validated. No new owner merge permission needed; production/build/store gates remain separate.
