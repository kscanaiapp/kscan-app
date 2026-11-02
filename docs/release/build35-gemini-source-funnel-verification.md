# Gemini user-facing source funnel — November 2 verification

Source **fb7b3c5b2af1418dec0fc4fa43cc4841871b79c6**, canonical **19bcc5d699f878561aaef1f9bc914c998e2a0de7**. **CLOSED for the consent-to-permission source workflow**, not live provider or deployed-runtime certification. No new product defect was confirmed in this composed test. All seventeen previously confirmed P0–P3 repairs remain source-converged.

## Actual customer path

Home's profile/privacy action in components/home/HomeLuxuryTechV1.tsx:259 opens /privacy; app/privacy.tsx:749 mounts GeminiProcessingSettingsSection with the current actor. This is reachable settings UI, not an unused component. app/onboarding/index.tsx records current legal acceptance through services/legalAcceptance.ts before advancing to PermissionsStepV1. constants/legal.ts defines AI_PROCESSING_VERSION v2_google_gemini; services/onboardingCompletion.ts refuses legacy markers as completion authority.

The composed test mounts the actual onboarding and Privacy control, calls the actual services, executes the historical receipt migrations and 20261029184000 permission SQL in an isolated PGlite PostgreSQL engine, and invokes the actual server consent guard. Seven recorded transitions PASS: legacy denial; failed receipt write/retry; current acceptance/advance/authorization; saved withdrawal/denial; failed re-consent with visible retry; successful retry/re-consent without receipt rewriting; account-change isolation. One Node test PASS, zero failures/skips. Dispatch counts are guard-boundary counters, not Gemini requests. Host/native primitives, session supply and SQL transport adapter are controlled fixtures; no real JWT-signature or remote RLS result is implied.

## Transmitter binding and provider contract

Actual server guard bindings remain in scan-identify/index.ts:2501, stylechat-generate/index.ts:1019, style-outfit-generate/index.ts:327 and purchase-import-extract/handler.ts:253 (default dependency binds requireGeminiConsent at line121). The shared guard tests are explicitly enrolled by scripts/run-backend-tests.js:91 and are included in the retained 1,591-PASS backend candidate run. Approved commerce-only Scanner routing is intentionally preserved before AI consent. This composed test adds the mounted source funnel; it does not replace endpoint-specific tests.

Frozen model routing remains gemini-3.6-flash and gemini-3.5-flash-lite. The current [official Generate Content migration guide](https://ai.google.dev/gemini-api/docs/generate-content/whats-new-gemini-3.6) says these models remain production-available, sampling parameters are deprecated and ignored for these generations, and a final model-role turn is rejected. Existing temperature fields therefore do not establish a current request failure. StyleChat appends the current user turn at index.ts:2686–2691 and retry instructions stay on a user turn; the other inspected transmitter bodies use user turns. No model change or fabricated unsupported-parameter defect was introduced. Provider availability for this project's credentials, output quality, cost and latency remain untested here.

## Reproduction and retained evidence

Set B35_AUDIT_SOURCE_ROOT to a checkout of fb7b3c5b2af1418dec0fc4fa43cc4841871b79c6, with committed dependencies installed; run node --test docs/release/evidence/gemini-funnel-source-1102.test.cjs from this evidence package. The harness checks exact authoritative source bytes before execution. [Seven records](evidence/gemini-funnel-source-1102-results.json); [lossless output](evidence/resume1102-gemini-funnel-source-final-1102.log.gz). Initial Windows import-URL setup failure is retained separately, corrected using pathToFileURL; it was not a product failure. Existing original matrix totals remain 121 PASS /1 FAIL /2,974 NOT TESTED: these seven transitions are a separate evidence population, not seven automatically matching matrix cells.

## Separate rollout gate

The November2 readback found permission migration20261029184000 absent from both remote migration ledgers. No migration or function was deployed in this work. Source success requires the governed permission migration, compatible client/re-consent access, then strict function promotion with synthetic runtime checks and rollback monitoring. Source consent UX is usable under that source contract; current deployed strict enforcement is not claimed. The owner retains legal wording/website responsibility; only factual metadata was refreshed. Device certification and later QA are excluded from this source audit and do not make this source result FAIL.

Next existing work item: Packing Intelligence end-to-end source state and failure paths. K+ lifecycle/concurrency and user-facing Live Camera VTO remain queued; broader software-probe reconciliation still prevents declaring the entire audit complete.
