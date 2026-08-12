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

---

# Addendum — Sentry provider integration

The Build 29 foundation was built provider-neutral and left the transport slot
open (`provider: null`, `uploadState: BLOCKED_NEW_PROVIDER_CONFIGURATION`). That
slot is now filled by Sentry. This addendum records what changed and, more
importantly, what deliberately did not.

## Provider

| Field | Value |
| --- | --- |
| Provider | Sentry |
| Organization | `k-scan-ai` |
| Project | `react-native` |
| SDK | `@sentry/react-native` 8.22.0 |
| DSN source | `EXPO_PUBLIC_SENTRY_DSN` (EAS environment; never committed) |
| Auth token source | `SENTRY_AUTH_TOKEN` (GitHub/EAS secret; never committed) |
| Minimum token scope | `org:ci` |

## Sentry is the transport, not the authority

K Scan keeps ownership of every identity and privacy concern. Sentry receives
them; it does not define them.

- **Release identity.** Sentry's `release` IS `extra.observability.releaseId`.
  Sentry's `dist` IS `extra.observability.buildIdentifier` — the same governed
  value `scripts/upload-observability-sourcemaps.mjs` passes as `--dist`, because
  Sentry matches an event to its source maps on the `(release, dist)` pair and a
  runtime `dist` that differs from the uploaded one never symbolicates. The
  native build number is carried separately as the `build` tag, and is used as
  `dist` only for builds that stamped no identifier — which are exactly the
  builds that cannot upload artifacts, so the two can never disagree. No
  provider-generated release is ever created. If K Scan cannot verifiably
  attribute the build (`sourceAttributionState !== 'VERIFIABLE'`), the provider
  stays OFF rather than reporting under an invented identity.
- **Correlation.** `X-KScan-Request-ID` and W3C `traceparent` remain the only
  correlation headers on K Scan requests. `tracePropagationTargets: []` stops
  the SDK injecting competing `sentry-trace`/`baggage` headers. Sentry mirrors
  the K Scan request/trace ids as tags via a correlation observer.
- **Privacy.** There is exactly one redaction boundary. The rules that governed
  the K Scan event pipeline were extracted to
  `services/observabilityRedaction.js`, and both `services/observability.ts` and
  the provider adapter consume it. `beforeSend` rebuilds every outbound event
  from the allowlist, so anything not explicitly re-added is dropped — including
  anything a future SDK version starts attaching by default.

  Two containers need more than shape-based redaction, because free text has no
  shape to match on:

  - `contexts` is allowlisted **by container name**. Device, OS, app, runtime,
    culture, OTA-update and trace contexts survive; every other container is
    dropped whole. Recursively redacting an arbitrary container did not work —
    `contexts.<anything>.<key>` carried ordinary prose off the device intact.
  - `exception.values[].value`/`.type`, the event `message` and the
    `transaction` name are reduced to a **diagnostic token**: a bounded value
    with no whitespace. This keeps K Scan's error contract (`TEXTSCAN_TIMEOUT`,
    `MALFORMED_EDGE_RESPONSE`, `AbortError`) and refuses prose, because an
    `Error` message is a free-text field that any provider SDK can populate with
    a response body. The deliberate cost is that third-party prose messages
    ("Network request failed") arrive redacted; the stack frames, error
    location, release, source SHA and operation tag are unaffected and remain
    the primary diagnostic signal.

  Stack frames keep their structure (file, function, line, column) but are
  stripped of `pre_context`/`context_line`/`post_context`/`vars`, which carry
  application source text rather than location.
- **Environment.** The build-time authority (`KSCAN_OBSERVABILITY_ENVIRONMENT`)
  still decides the environment. The provider re-checks it against the runtime
  mirror and fails OFF on mismatch.

## Fail-OFF switch

`EXPO_PUBLIC_KSCAN_OBSERVABILITY_ENABLED` governs the transport:

| Condition | Result |
| --- | --- |
| Flag missing | OFF |
| Flag malformed (`1`, `yes`, `on`, …) | OFF |
| Flag `false` | OFF |
| DSN missing or malformed | OFF |
| Environment unsupported, or mismatched against the build stamp | OFF |
| Observability contract version mismatch | OFF |
| Release identity not verifiable | OFF |
| SDK init throws | OFF, app unaffected |

Monitoring is never a runtime dependency: every disabled path leaves the app
fully operational, and the router root is returned unwrapped.

## EAS authorization

| Profile | Observability environment | Provider |
| --- | --- | --- |
| `development` | development | OFF |
| `preview` | staging | ON |
| `staging` | staging | ON |
| `production` | production | **OFF — Build 29 does not authorize production activation** |

## Entrypoint correction

The Sentry wizard wrote `Sentry.init` and `Sentry.wrap` into `app.js`. That file
is **not** the entrypoint — `package.json` `main` is `expo-router/entry`, so the
authoritative root is `app/_layout.tsx`. The wizard's `app.js` changes were
reverted and initialization moved to the governed root, where it runs once.

## Source maps

The local pipeline remains the identity authority: it exports maps, checksums
every artifact (SHA-256), and binds them to release/source/environment/
distribution/build. Sentry upload is the FINAL TRANSPORT STEP only. Before any
byte is transmitted, `upload-observability-sourcemaps.mjs` re-proves the
manifest identity against the build environment and re-verifies every checksum,
and refuses to run without an environment-supplied credential.

## What actually reaches the provider

| Failure path | Reaches Sentry | Mechanism |
| --- | --- | --- |
| Unhandled JS exception | Yes | The SDK's own `ReactNativeErrorHandlers`. `initializeObservabilityProvider()` runs at module scope in `app/_layout.tsx` **before** K Scan attaches its `ErrorUtils` wrapper, so the wrapper's `defaultHandler` IS the SDK handler and chains to it. One event, not two. |
| Unhandled promise rejection | Yes | Same integration (`patchGlobalPromise`). |
| React render error caught by `ErrorBoundary` | Yes | `captureHandledException` from `componentDidCatch`. A boundary swallows the error so `ErrorUtils` never sees it, and `Sentry.wrap` installs no boundary of its own — without this call the app's most visible failure produced no event at all. No duplicate: the boundary is the only observer. |
| Native crash | Yes | Native layer, reported on next launch. Does **not** pass through the JS `beforeSend`; see "Still deferred". |
| `logError(...)` from an ordinary catch block | Breadcrumb only | Deliberate. These are recovered, already-handled conditions; raising an event per call would be an event storm. They appear as context on whatever event follows. |

## Still deferred

- Real staging symbolication proof (requires an authorized EAS build).
- Native crash envelope proof. Native events are assembled and sent by the
  native SDK and do not pass through the JS `beforeSend` allowlist. The controls
  that bound them are `sendDefaultPii: false`, `attachScreenshot: false`,
  `attachViewHierarchy: false` and `Sentry.setUser(null)`, all of which are
  forwarded to the native layer at init — but the resulting envelope has not
  been inspected, and cannot be without an authorized build.
- Production activation decision.
- Session replay (see `BUILD29_SESSION_REPLAY_READINESS.md`).
- Dashboards, alerting, and quota/retention decisions.
