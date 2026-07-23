# 18 — Security and Privacy Review

## Does the repair weaken security/privacy below the known-good baseline?  **No.**
The known-good v13 baseline shipped with `sanitizeImageBeforeUpload` = **passthrough**
(`return input`) and **no** masking. The "Zero-Knowledge face/plate masking" the 2026-07-17
series demanded was **never a functional shipped feature** — it existed only as an
unsatisfiable gate that broke all upload. Restoring passthrough + metadata-strip re-encode
returns the app to its actual v13 posture; nothing that ever worked is removed.

## Privacy posture after repair (accurate description)
- Local images are **re-encoded** before transmission: Scanner via `compressForUpload`
  (resize ≤896, JPEG, EXIF/metadata dropped); Elise via `prepareImageForPrivacyUpload`
  (resize ≤1024, JPEG, metadata dropped).
- The `policy` object is **honest**: `faceDetectionAvailable:false`, `faceMaskApplied:false`,
  `plateDetectionAvailable:false`, `plateMaskApplied:false`, `metadataStripped:true`. It does
  **not** falsely claim pixel masking.
- Client still sends `localPrivacyFiltered:true` (attestation that local prep ran). The backend
  parses but does **not** rely on it (H8) — no server trust is misplaced.

## Auth / validation integrity (unchanged, verified)
- Sign-in guard in `identifyScanImage` intact (unauthenticated → fail before invoke).
- Client-side 413-class oversized-payload guard intact.
- Abort/cancellation ownership intact; temp cleanup best-effort and non-throwing.
- No secrets, tokens, env, or RLS touched. No backend/Edge Function change.

## Flagged for product/legal (out of scope — KS-DOC-006)
Any user-facing/marketing/privacy-policy copy that claims **on-device face or license-plate
masking** must be reconciled with the actual behavior (metadata strip + compression only). The
code no longer makes that claim; **document/UX copy** should be audited separately. Not changed
by this task.

## Net
Security/privacy: **no regression vs baseline; posture is now internally consistent and honestly
represented in code.**
