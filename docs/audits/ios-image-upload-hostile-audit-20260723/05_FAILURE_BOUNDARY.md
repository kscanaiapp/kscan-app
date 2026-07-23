# 05 — Observed Failure Classification (Phase 3)

## Physical evidence available
- Device class: physical iPhone (iOS). Exact model/iOS version not supplied to this audit.
- v13: image upload **worked**. v15: image upload **failed**. v14: expired, unknown.
- App: v15 = version 1.0.1, buildNumber 15 (`32addd5`).
- Fine-grained device telemetry (HTTP status, correlation IDs, backend timestamps) was **not**
  supplied. Runtime boundary is therefore reconstructed from source + the deterministic
  fail-closed control flow, which is unambiguous.

## Failure boundary (source-determined)
At v15, the scanner path executes:
`compressForUpload` → **`sanitizeImageBeforeUpload`** → `identifyScanImage`.
`sanitizeImageBeforeUpload` (state at v15) **throws unconditionally**
(`PrivacySanitizerUnavailableError`) before any request is constructed. Even if it were
bypassed, `identifyScanImage` returns `failed(PRIVACY_PROTECTION_REQUIRED_MESSAGE)` because the
caller supplies no (unsatisfiable) `privacyProof`.

**→ No image bytes ever leave the device on v15.** The request is never constructed or
dispatched.

## Classification (per taxonomy)
- **Primary: G — Request construction fails** (blocked at local sanitize/identify guard,
  pre-dispatch), driven by a privacy fail-closed gate.
- Also **P — Multiple contributing failures** (three independent fail-closed points, all from
  the same 2026-07-17 series).
- NOT A/B/C/D (picker/permission fine), NOT H–N (never dispatched), NOT J/K/L (backend never
  reached), NOT backend at all (see 08 H8).

## Scope of the runtime failure
Unconditional gate ⇒ affects **every** source, format, session state, and both platforms at
source level:
- Scanner camera ✔ broken · Scanner gallery ✔ broken · multi-image/multi-item ✔ broken
- Elise camera/gallery attachment ✔ broken (via `isPrivateImageUploadAvailable=false` + prepare throw)
- StyleChat intake ✔ broken (shared sanitizer) · savedScanMedia ✔ broken (shared sanitizer)
- Recent Scan / saved-product / Dressing-Room / Shared-Room **reuse** of already-stored images:
  not gated by the sanitizer (they reference stored URLs), so those reuse paths were less
  affected; **new** image intake was fully blocked.

Only iOS was physically tested; the defect is platform-agnostic at source (Android equally
affected had it shipped).
