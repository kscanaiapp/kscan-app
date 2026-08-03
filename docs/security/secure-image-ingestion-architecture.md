# Secure Image Ingestion Gate — Architecture

- **Date**: 2026-08-03
- **Repository**: kscanaiapp/kscan-app
- **Branch**: security/secure-image-ingestion-gate
- **Base**: `ios/full-submission-readiness-v2` @ `cd418c7`
- **Companion docs**: `secure-image-ingestion-inventory.md` (Phase 1 tracing), `image-upload-threat-model.md`, `malware-scanner-operations.md`, `image-quarantine-and-retention.md`, `image-ingestion-rollback.md`

## Why this exists

Prior work on this repository (`docs/security/public-ingress-inventory.md`, `docs/security/supabase-exposure-audit.md`) hardened general API exposure — rate limits, auth, RLS, RPC grants. None of it validated image **content**. The Phase 1 trace for this pass found that every active image-ingress path in the repo has **zero server-side content validation and zero malware scanning**, and that the on-device "Zero-Knowledge" masking layer referenced in prior session notes does not exist on this branch — the one masking function that does exist (`services/privacyImageSanitizer.js`) is a hard-coded no-op. This gate is, today, the only content-safety layer between an uploaded image and (a) an external AI provider, (b) permanent storage, or (c) any other consumer.

## Design

### One reusable gate module, not per-endpoint logic

`security/ingestion-gate/` is a small set of dependency-light modules, each independently unit-tested:

| Module | Responsibility |
|---|---|
| `policy.js` | Loads and validates `security/uploads/image-ingestion-policy.json` — the single source of truth for allowed formats, size/dimension/pixel/frame limits, and re-encode settings. |
| `signatures.js` | Pure-JS magic-byte detection and header-only dimension/frame parsing (no native deps) — a cheap pre-check that runs before any decode. |
| `hashing.js` | SHA-256 of original and canonical bytes. |
| `clamdClient.js` | A from-scratch clamd INSTREAM protocol client (plain TCP, no dependency) — fails closed on any timeout/error/unrecognized response. |
| `reencode.js` | `sharp`/libvips-backed decode probe + re-encode + metadata strip. Gracefully reports unavailability if `sharp` isn't installed, rather than throwing, so the rest of the gate stays testable/usable independent of that native dependency's install state. |
| `verdict.js` | The `CLEAN`/`REJECTED_*`/`SCANNER_UNAVAILABLE`/... enum, the five allowed user-facing messages, and HMAC sign/verify for ephemeral (non-DB-backed) verdicts. |
| `gate.js` | Orchestrates steps 2–11 of the pipeline below over an already-buffered image. |

`gate.js`'s `runIngestionGate(buffer, options)` is the one function every call site uses. It does NOT handle step 1 (auth/account-state) or steps 12–13 (object-key generation, verdict persistence) — those are caller-specific (an in-memory `/api/analyze` call has no object key or DB row at all; the quarantine worker has both).

### The 13-step pipeline, and where each step actually lives

| # | Step | Where |
|---|---|---|
| 1 | Auth + account-state | Caller-specific (see "What this branch does NOT do" below) |
| 2 | Request-size enforcement pre-buffer | Policy's `requestLimits.preBufferStreamingCapBytes`; bucket-level `file_size_limit` for Storage paths; buffer-level backstop in `gate.js` |
| 3 | Allowed content-type precheck | `gate.js` via `policy.getFormatByMime` |
| 4 | Magic-byte/signature detection | `signatures.js:detectFormatId` |
| 5 | Extension/detected-type consistency | `gate.js`, gated by `policy.extensionConsistencyRequired` |
| 6 | Safe decoder probe | `reencode.js` (`sharp(..., {limitInputPixels, failOn:'error'})`) |
| 7 | Width/height/pixel/frame/memory limits | Two layers: cheap header-only precheck (`signatures.js:readHeaderMetadata`, catches obvious bombs before any decode) + authoritative check inside `reencode.js` after decode |
| 8 | Malware scan | `clamdClient.js`, invoked from `gate.js` when `scanEnabled: true` |
| 9 | Decode + re-encode to canonical format | `reencode.js` |
| 10 | Strip EXIF/GPS/profiles/thumbnails | Implicit in `reencode.js` — sharp strips all metadata by default; `.withMetadata()` is deliberately never called |
| 11 | Revalidate generated output | `gate.js` re-runs signature detection against its OWN output as a self-check |
| 12 | Server-controlled filename/object key | Caller-specific — see `security/scan-worker/scanQuarantineObject.js:buildCleanObjectKey` (content-addressed: `{userId}/{sha256Canonical}{ext}`) |
| 13 | Signed clean verdict | Two forms: an HMAC-signed ephemeral token (`verdict.js`, for in-memory call sites) and a DB row (`image_scan_verdicts`, for the quarantine flow) |

Every rejection path returns `{ ok: false, verdict: <code>, userMessage: <one of 5 generic strings> }` — `internalReason` (and, for malware, `signatureName`) are separate fields never surfaced to `userMessage`; see `__tests__/security/imageIngestionNoRawLogging.test.js`.

## Quarantine architecture (stored-upload model)

New, additive Supabase objects (none of them touch or rename anything pre-existing):

- **`image-ingestion-quarantine`** (private bucket) — clients may `INSERT` under their own `auth.uid()` path prefix; no `SELECT`/`UPDATE`/`DELETE` policy exists for `authenticated`/`anon` at all. Only `service_role` (the scan worker) can read or delete.
- **`image-ingestion-clean`** (private bucket) — owners may `SELECT` their own promoted objects; no `INSERT`/`UPDATE`/`DELETE` policy exists for `authenticated`/`anon`. Only the scan worker ever writes here, with `upsert: false` (never overwrite an object in place).
- **`image_scan_verdicts`** (table, RLS enabled) — owners may `SELECT` their own rows; no `INSERT`/`UPDATE`/`DELETE` policy for `authenticated`/`anon`. `verdict` is a `check`-constrained enum matching the ten codes in the brief.

`security/scan-worker/scanQuarantineObject.js` is the only code that moves an object from quarantine to clean. Per attempt it: enforces a per-user rate limit, checks for an existing unexpired `CLEAN` verdict for the same content hash (reuse instead of rescanning — see `image-quarantine-and-retention.md`), runs `gate.js`, and then either uploads the canonical bytes to the clean bucket + writes a `CLEAN` verdict + deletes the quarantine object, or writes a rejection verdict + deletes the quarantine object (bytes are never retained for rejected content), or — for a transient scanner failure — leaves the object in place for up to `MAX_TRANSIENT_RETRIES` attempts before giving up.

## Downstream enforcement

`supabase/functions/tryon-clothes-pro/index.ts` was rewritten to accept only `*_object_id` fields resolved against `image_scan_verdicts` (ownership via RLS, `CLEAN` verdict, non-expiry, and a SHA-256 hash match against the verdict record) before it will build an upstream request. This is a complete Phase 9 implementation — but it was only possible **because this function has no live caller today** (confirmed in the Phase 1 inventory). Rewriting its request contract carries zero user-facing risk.

## What this branch does NOT do (and why)

These are the four places this pass deliberately stopped short of full enforcement, each mapped to a specific "Autonomous authority" stop condition in the originating brief:

1. **`server.js /api/analyze` stays anonymous.** The endpoint was deliberately designed with no auth (rate-limited only), and adding an auth requirement would change what the client must send — a client-visible contract change. The gate's format/size/decode/re-encode steps run unconditionally regardless; only the auth step (Phase 3, step 1) is not added.
2. **Malware scanning is implemented but OFF (`IMAGE_SCANNER_ENABLED=false`) everywhere.** No clamd instance is deployed. Turning this on before a scanner exists would fail-closed-reject every image, breaking a live feature. This is a deployment/rollout decision, not a code gap — see `malware-scanner-operations.md`.
3. **The two direct-to-Storage client upload paths (Dressing Room "Add Scan," Style Library/Inspiration upload) are NOT retrofitted onto the quarantine flow.** The infrastructure is built and ready, but routing an existing live upload through quarantine means the object is no longer instantly usable after upload — it must wait for a `CLEAN` verdict. That is a client-visible contract change requiring explicit owner sign-off; flagged in `security/perimeter/image-ingestion-manifest.json` as `NOT_ENFORCED_PENDING_OWNER_DECISION`.
4. **No real ClamAV instance was deployed.** `security/scan-worker/clamav/` contains reviewable Dockerfile/compose/config, but provisioning and running it is external infrastructure deployment, outside this pass's autonomous authority.

## Rollout sequence (for the owner)

1. Review and merge this PR (source-only; nothing deploys automatically).
2. Verify the Render build succeeds with `sharp` added to `render.yaml`'s `buildCommand` (see `image-ingestion-rollback.md` if it doesn't).
3. Apply the three new migrations to staging (additive; see `image-quarantine-and-retention.md`).
4. Deploy a clamd instance per `malware-scanner-operations.md`; set `CLAMD_HOST`/`CLAMD_PORT`; flip `IMAGE_SCANNER_ENABLED=true`.
5. Decide, separately, whether to retrofit the two direct-to-Storage upload paths onto the quarantine flow (a real product/UX decision — uploads become asynchronous).
