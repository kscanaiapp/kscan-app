# Multi-item image handoff repair

## Observed failure

The production upload review displayed the selected pink outfit, but the next
analyzing and result screens displayed a previously scanned orange hoodie. The
stale hoodie result was then available to save and reopen.

## Root cause and first broken boundary

The multi-item confirmation components kept candidate selection in local UI
state. Their Find Matches actions only navigated within products from the first
response; they did not return the selected candidate, parent image, or scan
session to Scanner orchestration for an authoritative second request. This left
the selected-item transition without a stable image identity contract and made
it possible for stale legacy result state to remain visible.

The first broken boundary was:

```text
confirmation UI -> Scanner orchestration
```

## Repaired identity path

```text
upload review source image
-> stable scanSessionId
-> one prepared image payload and digest prefix
-> multi_item_detection request
-> detectedGarments confirmation state
-> selectedCandidateId only
-> selected_item request using the same prepared payload and digest
-> selected-garment result
```

Candidate selection does not mutate `sourceImageUri`, `preparedImageUri`, or
`scanSessionId`. Selected-item retry reuses the same session and prepared image.
Missing session, image, candidate, or digest state now produces an explicit
error instead of selecting a sample or fallback asset.

## Correlation metadata

Client and server diagnostics use only:

- `scanSessionId`
- `candidateId`
- URI hash or suffix where available
- image digest prefix
- request mode

Image bytes and full private URLs are never logged. The server recomputes the
image digest and rejects a selected-item request whose supplied digest does not
match the request image.

## Provider and fallback audit

- Production multi-item and selected-item requests use the existing Gemini API
  and `scan-identify` Edge Function.
- The multi-item prompt is compact and explicitly handles real-world,
  overlapping, layered, and partially occluded garments.
- The sanitizer accepts one to five bounded candidates and preserves order.
- The exact `Ralph Lauren` fixture is test-only.
- QA garment images are guarded by `__DEV__` and are not used by this path.
- The scan-results demo data is disabled while confirmation candidates exist.
- No production selected-item fallback image is used.

## Regression coverage

Focused tests capture the Supabase request body and cover:

- production multi-item request gating;
- legacy behavior for false, missing, and malformed flags;
- multi-item versus selected-item prompt routing;
- one-to-five candidate sanitization and bounds handling;
- full candidate-list bridge preservation;
- controlled scalar candidate selection;
- exact prepared-image, session, and digest reuse across two requests;
- selected candidate ID, category, and bounds in the second request;
- duplicate initial-submit protection.

Runtime deployment and physical-device evidence are recorded in the task
handoff after verification.

## Runtime verification

- Production project: `wyyuqfdxucjksghsmhry`
- Edge Function: `scan-identify`
- Verified deployed version: `119` (`ACTIVE`)
- Real-world two-call proof: passed
- Detection result: two bounded candidates (`top`, `bottom`)
- Selected-item result: selected `top`, returned `top`
- Edge Function calls in the acceptance run: exactly two
- Parent image payload: byte-for-byte identical in both calls
- Session ID and image digest prefix: preserved in both responses
- Demo or fallback image: not used

The first live attempt exposed a second provider-boundary defect: valid Gemini
garments were discarded when location bounds were absent or used Gemini's box
array format. The sanitizer now accepts object and array boxes and does not
discard an otherwise valid garment solely because optional bounds are absent.
The multi-item detection and selected-item follow-up now use compact structured
output schemas and deterministic sampling; the legacy single-item prompt does
not use either schema.

The bundled Android debug APK built successfully. Installation on the connected
physical phone could not be completed because the older installed debug build
uses a different signing certificate. Before the data-preserving replacement
could begin, the phone disconnected from ADB. No uninstall or app-data change
occurred. Physical UI confirmation therefore remains required on the fresh
client build.
