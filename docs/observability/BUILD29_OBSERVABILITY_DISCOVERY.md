# Build 29 Observability Discovery

## Repository baseline

- **Repository:** `https://github.com/kscanaiapp/kscan-app.git`
- **Starting staging branch:** `origin/staging/production-parity`
- **Starting staging SHA:** `194bbaa6bc410119bb3e14bab63c384c222e6c6d`
- **Baseline decision:** safe to proceed. PR #109 (`ops/backend-release-activation-pipeline-v1`) and its corrective PR #112 were merged before this branch was created.
- **Known integration risk:** draft PR #111 restores additional Build 29 product/compliance surfaces from an older base. It is not unresolved release infrastructure, but it may overlap `app.json`, auth, TextScan, Elise, and newly restored Edge Function inventory during later integration.

## Mobile build identity

- **App version:** `1.0.1`
- **iOS build number:** `23`
- **Android version code:** `23`
- **Expo SDK:** `~54.0.36` (SDK 54 config)
- **React Native:** `0.81.5`
- **EAS version authority:** `appVersionSource: remote`, with `autoIncrement` on preview, staging, and production.

## Monitoring and crash reporting

| Requirement | Baseline classification | Repository evidence |
| --- | --- | --- |
| Monitoring provider | **MISSING** | No Sentry, Datadog, Bugsnag, New Relic, Crashlytics, PostHog, or equivalent SDK/package/config. |
| Monitoring SDK version | **NOT_APPLICABLE** | No external monitoring SDK is installed. |
| Crash adapter | **PARTIAL** | `src/utils/errorLogger.ts`, the React error boundary, and the global React Native JS handler write to console only. No durable external transport exists. |
| Release attribution | **PARTIAL** | Backend release metadata and `/version` exist; mobile app metadata/source SHA were not centrally attached to errors. |
| Environment separation | **PARTIAL** | EAS Supabase targets are environment-separated, but monitoring events had no central environment context. |

Adding a monitoring vendor, account/project, SDK, project key, or source-map upload credential crosses the brief's owner gate. This branch therefore builds the provider-neutral foundation without selecting or provisioning a vendor.

## Release and source identity

| Requirement | Baseline classification | Notes |
| --- | --- | --- |
| Backend `releaseId` | **IMPLEMENTED** | Governed release manifest/bootstrap supplies `KSCAN_RELEASE_ID`. |
| Backend `sourceSha` | **IMPLEMENTED** | Governed release metadata supplies `KSCAN_SOURCE_SHA`. |
| Backend environment | **PARTIAL** | Health hardcoded staging safely, but general Edge telemetry had no governed environment value. |
| Mobile `release_id` | **MISSING** | No app-config field or common error context. |
| Mobile `source_sha` | **MISSING** | No build-time injection. |
| App/build/platform | **PARTIAL** | Present in Expo/native config, not attached to error context. |

Build 29 adds dynamic Expo config that prefers `KSCAN_SOURCE_SHA`, then the EAS-provided `EAS_BUILD_GIT_COMMIT_HASH`, then `GITHUB_SHA`, with a Git fallback only while build configuration is evaluated. The installed runtime never executes Git. `KSCAN_RELEASE_ID` remains supplied by the existing governed release invocation rather than deriving an unrelated identity in mobile code.

## Source maps and native symbols

| Requirement | Baseline classification | Notes |
| --- | --- | --- |
| JS source-map generation | **PARTIAL** | Expo/Metro dependencies support maps; no repository automation existed. |
| Source-map upload | **MISSING** | No provider or upload credential/command exists. |
| Release association | **MISSING** | No source-map manifest bound output to release/source/environment. |
| Android mapping | **PARTIAL** | Release minification/shrinking is configured; no monitoring upload integration exists. |
| Hermes maps | **PARTIAL** | Hermes is the Expo default; explicit Gradle Hermes flags are commented and Expo export can emit Hermes maps. |
| iOS dSYM | **DEFERRED_BUILD29** | The canonical staging tree is managed Expo and contains no `ios/` project to audit directly. Provider upload and proof require an authorized build. |
| Native symbolication proof | **DEFERRED_BUILD29** | Requires an authorized staging artifact and controlled crash. |

Build 29 adds deterministic, checksummed Expo source-map generation and secret-shape scanning. Automated upload remains **BLOCKED_NEW_PROVIDER_CONFIGURATION**; configuration alone is not claimed as symbolication proof.

## Request and trace correlation

| Requirement | Baseline classification | Notes |
| --- | --- | --- |
| Repository-wide request ID | **CONFLICTING** | Several domain IDs exist (`scanreq_*`, evidence IDs, UUIDs, timestamp/random IDs); none is a single HTTP correlation contract. |
| Canonical request header | **MISSING** | `x-request-id`/`x-scan-id` appeared only on legacy backend reads. |
| External ID validation | **MISSING** | User-controlled IDs could be sliced/accepted as business request IDs in some functions. |
| Response correlation | **MISSING** | No common response header/body metadata. |
| W3C trace context | **MISSING** | Installed `@supabase/supabase-js` is `2.105.4`, below the documented automatic tracing threshold (`2.106.0`), and no OpenTelemetry SDK is installed. |
| Backend request context | **MISSING** | Existing telemetry modules use local allowlists but no common request/release/trace context. |

Build 29 uses `ksr_` plus 32 lowercase random hex characters and header `X-KScan-Request-ID`. W3C `traceparent` is generated and validated manually through the already-supported custom-header invocation path; no fake span tree or user-derived tracing metadata is created.

## Existing telemetry privacy posture

| Surface | Baseline classification | Notes |
| --- | --- | --- |
| Closet telemetry | **IMPLEMENTED** | Strong event/property allowlists and bounded values. |
| Scan quality telemetry | **PARTIAL** | Privacy assertions exist, but not one common redactor/context. |
| Elise backend telemetry | **PARTIAL** | Strict allowlist exists; request IDs are local business IDs, not canonical transport correlation. |
| Mobile error logger | **CONFLICTING** | Logged raw `Error` and arbitrary `extra`, which could contain forbidden data. |
| Recursive redaction | **MISSING** | No common recursive layer for observability. |

## Health and version

| Surface | Classification | Notes |
| --- | --- | --- |
| `/health/live` | **REUSE** | Existing `staging-health` route is cheap and dependency-free. |
| `/health/ready` | **REUSE** | Bounded database/core-table checks; no AI provider call. |
| `/version` | **REUSE** | Reports service, staging environment, release/source/tree/digest, health contract, and deployment time. |
| `/health/dependencies` | **DEFERRED_BUILD29** | Not a small necessary extension; readiness already covers bounded critical dependencies. |
| Provider canaries | **DEFERRED_BUILD29** | No existing near-complete canary and no paid-provider calls belong in readiness. |

No parallel health system is created.

## Session replay

- **Baseline state:** **NOT_SUPPORTED** in the installed stack because no replay-capable monitoring SDK/provider exists.
- **Replay SDK version:** not applicable.
- **Camera/gallery/image masking:** no replay controls exist.
- **Kill switch:** no replay runtime exists; Build 29 config adds an explicit `replayEnabled: false` invariant only.
- **Production replay:** off.
- **Implementation decision:** `DEFERRED_BUILD29`; see `BUILD29_SESSION_REPLAY_READINESS.md`.

## Requirement classification summary

- **IMPLEMENTED / REUSE:** governed backend release identity; staging live/ready/version contract; several narrow privacy-safe domain telemetry allowlists.
- **PARTIAL:** mobile crash handling, release attribution, source-map capability, native symbol config, environment tagging, request IDs, telemetry privacy unification.
- **MISSING:** monitoring provider/SDK, durable error transport, automated provider source-map upload, canonical transport correlation, trace context, recursive common redaction, replay controls.
- **CONFLICTING:** multiple domain request-ID shapes cannot be repurposed as a transport correlation ID; raw mobile error logging was incompatible with the privacy requirements.
- **NOT_APPLICABLE:** monitoring/replay SDK version while no provider exists.
- **DEFERRED_BUILD29:** provider selection/provisioning, actual symbolication proof, full distributed tracing, dependency-health expansion, paid provider canaries, session replay activation/certification, physical-device proof, dashboards/alerts.

