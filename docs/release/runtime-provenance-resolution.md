# Runtime provenance resolution

Resolution pass for the five runtime provenance questions left open by
`docs/release/master-staging-provenance-map.md`. This document records the
evidence and the decision for each; it does not restate the history analysis.

## Snapshot

| Field | Value |
| --- | --- |
| Repository | `kscanaiapp/kscan-app` |
| Staging at pass start | `a99616ea249348bf2b5d0f37a444b15fdb0b280f` |
| Master at pass start | `234885694036736702cf9e92628596bdc4550c00` |
| Merge base | `a601adfa607a2a0c592f9dae07e448b5968aaddf` |
| Divergence | master-only 43 commits, staging-only 508 commits |

Divergence since the previous provenance artifacts (staging `571f6492`, master
`4a9594ac`) is entirely release-governance: staging PR 84/86 and master PR 85.
No new runtime surface appeared, so the earlier map remains materially
applicable and was extended rather than regenerated.

## 1. Build 2.5 ancestry — DOCUMENTED / PRESERVE

Build 2.5 contribution (merge `d5ccc29`, its 20 second-parent commits ending at
`08015e7`) and activation `1f9b452` are already ancestors of staging. Per owner
directive this pass neither removes that history nor imports any further Build
2.5 branch or commit. The affected files stay inside the runtime release tree,
so certification cannot hide them by projection. No Build 2.5 branch was
merged, rebased, cherry-picked, deleted, or modified.

## 2. Master scan gateway — SUPERSEDED_BY_STAGING

Both branches created `supabase/functions/scan-identify/` independently after
the merge base. Master's is 28 KB plus three gateway modules; staging's is
137 KB plus 34 modules.

Comparison of the security-relevant surfaces:

| Control | Master | Staging |
| --- | --- | --- |
| JWT verification before provider call | yes | yes |
| Account-deletion guard | no | `assertAccountActiveIfAuthenticated` |
| Anonymous rate limit | none | 6 requests / 10 min per fingerprint |
| Authenticated per-user daily quota | none | `checkAuthenticatedScanQuota` |
| Image payload cap | 2 MB | 2 MB |
| Text-query injection/PII rejection | yes | yes |
| Attribute allowlist sanitization | yes | yes |
| Retired-model guard | local constant | shared `llmModelRouting` |
| Canonical gateway contract | present, flag-gated | absent |

Master's gateway layer is reached only when `USE_GATEWAY_WIRING === 'true'`,
which is not set. With the flag off its behavior is a strict subset of
staging's. Its privacy evaluation emits warnings and response sidecar metadata;
it does not block a provider call, so it is observability scaffolding rather
than an enforcement control.

Porting a dormant, flag-gated path into the larger staging function would add
risk without runtime benefit, and activating it would bypass staging's rate
limit, quota, and deletion guard. Staging is authoritative. No port. The
canonical-contract concept remains available to master as future work.

## 3. `/api/analyze` retirement — UNUSED_SAFE_TO_RETIRE (ported)

Consumer search across the staging tree:

- `hooks/useKScan.js` — camera path routes only through scan-identify and hard
  fails when `SCAN_IDENTIFY_BACKEND_ENABLED` is false. The comment at the call
  site records that the Render fallback was removed for submission.
- `app/text-scan/index.tsx` — imports `analyzeTextWithEdge`; the legacy
  `analyzeText` import is forbidden by `__tests__/textScanCanonicalPath.test.js`.
- `services/api.js` `analyzeImage` / `analyzeText` — exported but referenced
  only from tests. `__tests__/useKScanDuplicateGuard.test.js` already asserts
  `analyzeImage` is never called as a fallback.

No runtime consumer remains. Staging's own security inventory
(`docs/security/public-ingress-inventory.md`) classifies this route
`SHOULD_NOT_BE_PUBLIC`, describes it as the highest, most exposed surface with
no auth, no rate limit and no WAF, and records the fix as "prepared, not yet
applied". Master applied it.

Ported to staging:

- unconditional `app.all('/api/analyze')` 410 tombstone registered before the
  shared body parser, so request bodies are neither parsed nor logged;
- the 232-line POST handler removed;
- `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` and
  `USE_OPENROUTER` removed from `render.yaml`, so the service holds no paid
  provider credentials;
- `scripts/qa-fixtures.js` and `scripts/qa-convergence.js` no longer default to
  the retired hosted endpoint and now fail loudly when unconfigured.

Master additionally tombstones `/catalog-images/*`. That was **not** ported:
`data/catalog.json` resolves product imagery through that mount on staging, so
retiring it would break catalog images. A regression test pins this difference.

## 4. Transactional email ownership — AUTHORITATIVE_MASTER_RUNTIME (ported)

`supabase/functions/_shared/deletion/common.ts` on staging POSTs account
deletion restoration mail to
`${KSCAN_EMAIL_RENDER_URL || 'https://kscan-app-1.onrender.com'}/internal/email/account-deletion-restoration`
with an `x-kscan-email-secret` header. Staging's `server.js` implements no email
route at all; master's implements exactly that path and header.

Both branches define the same Render service `kscan-api` in `render.yaml`, with
mutually incompatible environments: staging provisions LLM credentials and no
email configuration, master provisions email configuration and no LLM
credentials.

This is a verified cross-branch runtime coupling, recorded as DEFECT-RRR-001.
Staging holds the consumer without the provider, so if the Render service is
deployed from staging every account-deletion restoration email fails.

| Property | Resolution |
| --- | --- |
| Source of truth | this repository, `services/transactionalEmail.js` |
| Runtime host | Render service `kscan-api` |
| Deployment owner | Render, from this repository |
| Authentication boundary | `x-kscan-email-secret` shared secret, checked before any body parser |
| Secrets expected | `RESEND_API_KEY`, `KSCAN_EMAIL_INTERNAL_SECRET` (both `sync: false`) |
| Staging equivalent | none — consumer only |

Ported to staging: `services/transactionalEmail.js` (byte-identical to master's
blob), both `/internal/email/*` routes with `requireInternalEmailAuth` and
per-route bounded body parsers, their JSON error handlers, and the four email
environment entries in `render.yaml`.

No Render or Resend infrastructure was deployed in this pass. The service
degrades closed: without `RESEND_API_KEY` or `KSCAN_EMAIL_INTERNAL_SECRET` the
routes answer `503 EMAIL_SERVICE_NOT_CONFIGURED`.

**Owner action remaining:** set `RESEND_API_KEY` and
`KSCAN_EMAIL_INTERNAL_SECRET` on the Render service, and confirm which branch
Render deploys from. Until that is confirmed, restoration email delivery is
unverified in either direction.

## 5. `eas.json` — RECONCILED

Reconciled by intent rather than by branch. Differences were mapped across
profiles, environment selection, release channel and submit behavior.

| Concern | Staging before | Master | Reconciled |
| --- | --- | --- | --- |
| `preview` Supabase target | production `wyyuqfdxucjksghsmhry` | staging | **staging** |
| `development` Supabase target | production `wyyuqfdxucjksghsmhry` | absent | **staging** |
| `staging` profile | present, staging target | absent | kept, unchanged |
| `production` profile | production target | staging target | kept as production |
| Feature-flag environment | full sets | stripped | kept in full |
| `appVersionSource` | `remote` | `local` | kept `remote` |
| `submit.production.ios.metadataPath` | `./store.config.json` | removed | kept |

The security defect was that `preview` and `development` — internal
distribution profiles — pointed at the production Supabase project. Both now
target staging. Master's wholesale flag removal was not adopted, because the
staging runtime is flag-gated and would regress. Master's repointing of the
`production` profile at staging was also not adopted; a store profile targeting
production is correct.

No Build 2.5 release behavior was imported. No production build or submission
was activated.

Configuration validation is enforced by
`__tests__/runtimeProvenanceResolution.test.js`: no non-production profile may
name the production project ref or anon key, every profile must declare its
Supabase target explicitly rather than inherit it, the production profile must
still target production, and the iOS store metadata binding must survive.

## 6. `scan-identify` semantics — RECONCILED (staging retained)

Covered by decision 2. Staging's implementation is retained unchanged. Nothing
was deployed to any Supabase project in this pass, so no before/after function
snapshot was required. Privacy architecture is unaffected: no raw facial or PII
logging was introduced, no rate limit was weakened, and no obsolete provider
behavior was restored.

## Defect log

### DEFECT-RRR-001 — staging holds the transactional email consumer without the provider

- **PREEXISTING_OR_INTRODUCED:** preexisting
- **SYMPTOM:** account-deletion restoration email cannot be delivered from a
  staging-deployed Render service
- **EXPECTED_BEHAVIOR:** the deletion Edge Function's POST reaches a served
  `/internal/email/account-deletion-restoration` route
- **ACTUAL_BEHAVIOR:** staging `server.js` serves no such route; the request
  404s, and `render.yaml` provisions none of the email environment
- **ROOT_CAUSE:** the transactional email service was implemented only on
  master while its Supabase consumer shipped on staging
- **SECURITY_IMPACT:** privacy/account-lifecycle — a user who requests deletion
  may not receive the restoration path they are entitled to
- **RELEASE_IMPACT:** blocks runtime convergence; the branches define the same
  Render service with incompatible environments
- **FILES_WORKFLOWS:** `server.js`, `services/transactionalEmail.js`,
  `render.yaml`, `supabase/functions/_shared/deletion/common.ts`
- **FIX:** ported the provider (routes, service module, environment) to staging
- **REGRESSION_TEST:** `__tests__/runtimeProvenanceResolution.test.js` —
  "the deployed restoration route matches the Supabase deletion consumer"
- **VERIFICATION:** 14/14 new assertions pass; 182/182 across the server- and
  scan-dependent suites
- **FINAL_STATE:** resolved in code; owner must still provision the two Render
  secrets and confirm the deploy branch

### DEFECT-RRR-002 — non-production EAS profiles targeted the production Supabase project

- **PREEXISTING_OR_INTRODUCED:** preexisting
- **SYMPTOM:** `preview` and `development` internal builds read and write the
  production project
- **EXPECTED_BEHAVIOR:** only the `production` store profile targets production
- **ACTUAL_BEHAVIOR:** both internal profiles carried the production URL and
  anon key
- **ROOT_CAUSE:** profiles were copied from the production block when the
  staging project was introduced
- **SECURITY_IMPACT:** internal QA traffic and test accounts land in production
  data
- **RELEASE_IMPACT:** any native release run built from these profiles would
  have exercised production
- **FILES_WORKFLOWS:** `eas.json`
- **FIX:** both profiles repointed at the staging project
- **REGRESSION_TEST:** `__tests__/runtimeProvenanceResolution.test.js` —
  "no non-production build profile targets the production Supabase project"
- **VERIFICATION:** assertion passes; production profile unchanged
- **FINAL_STATE:** resolved

### DEFECT-RRR-004 — certification mapped infrastructure faults to a security verdict

- **PREEXISTING_OR_INTRODUCED:** preexisting, in
  `security/scripts/parse-native-mobile-evidence.js`
- **SYMPTOM:** an emulator crash, a failed build, or a missing Maestro report
  certified as `BLOCKED` instead of `OPERATIONAL_FAILURE`
- **EXPECTED_BEHAVIOR:** per the calibrated semantics in this contract, runner
  and build infrastructure faults are `OPERATIONAL_FAILURE`; only a critical
  flow failure or untrustworthy evidence is `BLOCKED`
- **ACTUAL_BEHAVIOR:** when the runner reported `OPERATIONAL_FAILURE` with no
  flow results, the parser derived `REQUIRED_MOBILE_FLOW_MISSING` and returned
  `BLOCKED` before reaching its own operational-failure branch
- **ROOT_CAUSE:** coverage failures and evidence-integrity failures shared one
  unconditional blocking list, evaluated ahead of the infrastructure check
- **SECURITY_IMPACT:** none directly — both outcomes are non-`PASS`, so no
  release could pass on a fault. The harm is diagnostic: a flaky emulator was
  indistinguishable from a real mobile security failure, which erodes trust in
  the gate and invites overriding it
- **RELEASE_IMPACT:** operators cannot tell a retryable fault from a genuine
  blocker
- **FILES_WORKFLOWS:** `security/scripts/parse-native-mobile-evidence.js`
- **FIX:** split the blocking conditions. Evidence-integrity failures (SHA
  mismatch, run-id mismatch, missing build identifier, TestSprite runner,
  invalid result) still block unconditionally and cannot be escaped by
  self-declaring a fault. Coverage failures are evaluated only when the run
  actually executed
- **REGRESSION_TEST:** `__tests__/security/nativeReleaseRunner.test.js` — the
  per-platform "an infrastructure fault is OPERATIONAL_FAILURE, never BLOCKED"
  and "a missing report is OPERATIONAL_FAILURE" cases, alongside the wrong-SHA,
  wrong-run-id and TestSprite cases that must still block
- **VERIFICATION:** 35/35 pass across the new runner suite and the pre-existing
  `nativeMobileEvidence.test.js`, so the prior contract is unchanged
- **FINAL_STATE:** resolved

### DEFECT-RRR-003 — retired analyze route left reachable on staging

- **PREEXISTING_OR_INTRODUCED:** preexisting
- **SYMPTOM:** an unauthenticated, unrate-limited Gemini proxy remained served
- **EXPECTED_BEHAVIOR:** no reachable public analysis surface once the scan
  runtime moved to scan-identify
- **ACTUAL_BEHAVIOR:** `POST /api/analyze` still parsed bodies and called the
  provider, with LLM credentials provisioned on the service
- **ROOT_CAUSE:** the client migration to scan-identify completed without the
  corresponding server retirement
- **SECURITY_IMPACT:** documented `SHOULD_NOT_BE_PUBLIC` surface; provider-cost
  exhaustion and unauthenticated image upload
- **RELEASE_IMPACT:** open finding against the staging perimeter
- **FILES_WORKFLOWS:** `server.js`, `render.yaml`, `scripts/qa-fixtures.js`,
  `scripts/qa-convergence.js`
- **FIX:** pre-body 410 tombstone, handler removed, provider credentials
  removed, QA defaults removed
- **REGRESSION_TEST:** `__tests__/runtimeProvenanceResolution.test.js` —
  tombstone, no-resurrection, credential and QA-default assertions
- **VERIFICATION:** 14/14 new assertions pass; `analyzeContract.test.js` still
  passes, so the retained parsing/normalization exports are unaffected
- **FINAL_STATE:** resolved

## Defects found by running the native runners

RRR-001 through RRR-004 were found by reading the repository. Everything below
was found by dispatching the runners against a real candidate. RRR-005 to
RRR-008 and RRR-010 were introduced by this workstream's own runner
implementation; RRR-009 was pre-existing.

### DEFECT-RRR-005 — iOS runner pinned to an image whose Xcode is too old

- **ORIGIN:** introduced (native iOS runner, first implementation)
- **SYMPTOM:** run `31317122515` failed at `pod install` with
  `[!] Invalid Podfile file: Please upgrade XCode.`
- **ROOT_CAUSE:** Expo SDK 54 / React Native 0.81 generate a Podfile that
  rejects Xcode 15, the `macos-14` default image
- **SECURITY_IMPACT:** none
- **RELEASE_IMPACT:** no iOS evidence could be produced at all
- **FILES:** `.github/workflows/native-ios-release-tests.yml`
- **FIX:** `runs-on: macos-15`, with the toolchain pinned via
  `maxim-lobanov/setup-xcode` rather than inherited, and the resolved version
  recorded in the evidence `device` field
- **REGRESSION_TEST:** covered by workflow YAML contract validation; the real
  guard is the live dispatch, since no static check can predict an image default
- **LIVE_VERIFICATION:** run `31317967934` reached `pod install` successfully
- **FINAL_STATE:** resolved (PR #89, mirrored to staging in PR #90)

### DEFECT-RRR-006 — iOS build selected a dependency scheme, producing no app

- **ORIGIN:** introduced (native iOS runner, first implementation)
- **SYMPTOM:** run `31317425126` logged `Build Succeeded` followed by
  `no .app produced`
- **ROOT_CAUSE:** the workflow used `workspace.schemes[0]`. In a Pods workspace
  that is a dependency scheme (`EXConstants`, `hermes-engine`, …), which builds
  a static library and emits no app bundle. The correct scheme was computed from
  `app.json` earlier in the same step and then never used.
- **SECURITY_IMPACT:** none directly, but a green build with a missing artifact
  is precisely the shape of failure that gets waved through
- **RELEASE_IMPACT:** no installable app, so no iOS evidence
- **FILES:** `.github/workflows/native-ios-release-tests.yml`
- **FIX:** select the scheme matching the generated workspace name and fail
  loudly listing available schemes if absent; exclude `XCFrameworkIntermediates`
  from the `.app` search; keep and upload the raw `xcodebuild` log, which
  `xcpretty` otherwise hides. Both runners additionally now emit evidence when
  the build fails, instead of producing no artifact at all.
- **REGRESSION_TEST:** `__tests__/security/nativeReleaseRunner.test.js` —
  build-failure and missing-report classifications
- **LIVE_VERIFICATION:** run `31317967934` built and installed the app
- **FINAL_STATE:** resolved (PR #92, mirrored to staging in PR #90)

### DEFECT-RRR-007 — bashism aborted the Android emulator script before any flow ran

- **ORIGIN:** introduced (native Android runner, first implementation)
- **SYMPTOM:** run `31317121437` built the APK and booted the emulator, then ran
  zero flows: `/usr/bin/sh: 1: set: Illegal option -o pipefail`
- **ROOT_CAUSE:** `reactivecircus/android-emulator-runner` executes its `script`
  with `/bin/sh` (dash). `set -o pipefail` is a bashism and aborted line 1, so
  Maestro was never invoked and no JUnit report was written.
- **SECURITY_IMPACT:** none
- **RELEASE_IMPACT:** no Android flow evidence
- **FILES:** `.github/workflows/native-android-release-tests.yml`
- **FIX:** POSIX `set -eu`, Maestro's exit status captured explicitly rather than
  via `pipefail`, log written by redirection. The step exits 0 on a flow failure
  deliberately, so the failure reaches the evidence builder and is classified
  `BLOCKED` rather than lost as a step error. Timeout raised to 120 minutes after
  observing ~10 min Gradle and ~12 min emulator boot.
- **REGRESSION_TEST:** workflow YAML contract validation; the shell-dialect
  constraint is documented inline at the step
- **LIVE_VERIFICATION:** pending the next Android dispatch
- **FINAL_STATE:** resolved in code (PR #93), live re-verification outstanding

### DEFECT-RRR-008 — Debug simulator build shipped no JS bundle

- **ORIGIN:** introduced (native iOS runner, first implementation)
- **SYMPTOM:** run `31317967934` completed every pipeline stage, then failed
  25/25 flows on one identical assertion:
  `Assertion is false: id: onboarding-welcome-screen-v1 is visible`
- **ROOT_CAUSE:** proven from the xcodebuild log, not inferred. React Native's
  "Bundle React Native code and images" phase self-skips for a Debug simulator
  build:

  ```
  + [[ Debug = *Debug* ]]
  + [[ ! iphonesimulator == *simulator ]]
  + [[ -n 1 ]]
  + echo 'SKIP_BUNDLING enabled; skipping.'
  ```

  The installed `.app` therefore contained no `main.jsbundle` and could only
  render against a Metro dev server. Maestro launched a native shell with no UI.
- **SECURITY_IMPACT:** none directly. The danger is interpretive: 25 uniform
  failures read as a catastrophic product regression when the app under test was
  never runnable.
- **RELEASE_IMPACT:** iOS could never reach `PASS`, and its failure mode
  impersonated a critical flow failure
- **FILES:** `.github/workflows/native-ios-release-tests.yml`,
  `security/scripts/build-native-mobile-evidence.js`
- **FIX:** build `-configuration Release` for the simulator, which makes the
  first test false so bundling runs and the candidate's JS is embedded. A
  release certification runner must exercise a self-contained artifact rather
  than one wired to a temporary bundler. Adds a bundle-presence gate
  (`NATIVE_JS_BUNDLE_MISSING`) and a launch probe (`NATIVE_APP_LAUNCH_FAILED`),
  both resolving to `OPERATIONAL_FAILURE`.
- **REGRESSION_TEST:** `__tests__/security/nativeReleaseRunner.test.js` — each
  new reason is `OPERATIONAL_FAILURE` with no per-flow verdicts, and never
  `BLOCKED`; a wrong SHA still outranks an operational fault
- **LIVE_VERIFICATION:** run `31321344975` against candidate `e791f04`
- **FINAL_STATE:** resolved (PR #90, mirrored to master in PR #95)

### DEFECT-RRR-009 — security scanner version probes died of SIGPIPE

- **ORIGIN:** pre-existing (`.github/workflows/security-code.yml`)
- **SYMPTOM:** the OSV-Scanner required check exited 141 before scanning
  anything (run `31317383348`)
- **ROOT_CAUSE:** `VERSION="$(osv-scanner --version | head -n 1)"`. `head`
  closes the pipe after one line, `osv-scanner` dies of SIGPIPE (128+13), and
  `set -o pipefail` propagates 141 as the step result.
- **SECURITY_IMPACT:** the gate failed operationally while presenting as a
  security check failure — the same category confusion as RRR-004. A real
  finding and a broken probe were indistinguishable.
- **RELEASE_IMPACT:** a required check blocked PRs while reporting no
  vulnerability data at all
- **FILES:** `.github/workflows/security-code.yml`
- **FIX:** capture the full version output, then slice its first line in the
  shell. Two further instances of the same pattern were found by the new
  contract test and repaired: the `semgrep` probe (unguarded, live exposure) and
  the `trivy` probe (guarded by `|| echo unknown`, latent). No `|| true`, no
  relaxed pipefail, nothing made advisory.
- **REGRESSION_TEST:** `__tests__/security/securityWorkflowContract.test.js` —
  fails if any scanner is piped into `head`, and separately asserts the OSV step
  still has strict mode, still scans, and has not been made advisory
- **LIVE_VERIFICATION:** PR #94's own OSV required check
- **FINAL_STATE:** resolved (PR #94)

### DEFECT-RRR-010 — release flow IDs overstated their coverage

- **ORIGIN:** introduced (release flow authoring)
- **SYMPTOM:** three flows asserted something other than what their ID claimed,
  so a green run would have reported coverage that did not exist
- **ROOT_CAUSE:** flows were authored against verified testIDs without
  confirming each ID's subject matter had a matching affordance
- **SECURITY_IMPACT:** `dressing_room.report_or_block` is a UGC safety control.
  Asserting the share button would have certified content-reporting as covered
  while never exercising it.
- **RELEASE_IMPACT:** inflated confidence in the required inventory
- **FILES:** `.maestro/flows/release/dressing-room-report-or-block.yaml`,
  `privacy-correction-and-export.yaml`,
  `privacy-account-deletion-request.yaml`, `resilience-deep-link.yaml`
- **FIX:** the report flow now exercises the real per-message Report control
  (`room-message-report-*`) and its "Report content" disclosure, then cancels.
  The privacy flows assert the real surfaces from `app/privacy.tsx`
  ("Request Data Export", "Request permanent account closure") instead of loose
  substrings. The deep-link flow navigates away first, so it cannot pass without
  proving routing. All remain non-destructive.
- **REGRESSION_TEST:** `__tests__/security/nativeReleaseRunner.test.js` — each
  flow must exercise behavior beyond initialization, safety and privacy flows
  must assert their own subject matter, and none may confirm a destructive
  action
- **LIVE_VERIFICATION:** run `31321344975`
- **FINAL_STATE:** resolved (PR #90, mirrored to master in PR #95)

## Known limitation — Android tests a debug JS bundle

The Android runner starts Metro and installs a debug APK. Android's `release`
buildType requires `KSCAN_STORE_FILE` / `KSCAN_KEY_ALIAS` credentials the runner
does not hold and must not fabricate, so a self-contained Android build needs an
owner-provided keystore. iOS has no such constraint: a simulator Release build
needs no signing identity, which is why the two platforms differ here.

**Owner action:** provide an Android keystore if release-bundle coverage is
required on that platform. Until then Android proves flows against a debug
bundle.
