# Image Upload Threat Model

- **Date**: 2026-08-03 · companion to `secure-image-ingestion-architecture.md`

Attacker-goal-oriented model for every path a bad actor could use image upload as an attack vector, cross-referenced to the specific mitigation and the test that proves it.

## 1. Remote code execution / server compromise via a malicious file

**Goal**: get arbitrary code executed on the server or a downstream consumer by disguising a non-image payload as an image.

| Technique | Mitigation | Proof |
|---|---|---|
| Upload an executable/script with a `.jpg` extension and `image/jpeg` Content-Type | Magic-byte detection (`signatures.js`) is the sole source of truth for type — declared extension/MIME are only cross-checked against it, never trusted alone | `imageIngestionGate.test.js`: "invalid magic bytes (SVG XML content)", "archive (zip) magic bytes" |
| Polyglot: valid JPEG bytes + appended executable/script content | Full decode + re-encode (`reencode.js`) reads only pixel data through libvips; the re-encoded output cannot contain the trailer | `imageIngestionGate.test.js`: "polyglot: valid JPEG with trailing appended script-like bytes re-encodes cleanly, discarding the trailer" |
| Malformed/crafted container structure targeting a parser vulnerability | `sharp(..., {failOn:'error'})` rejects malformed structure outright (`REJECTED_MALFORMED`); the gate never hands raw bytes to a provider without this decode step passing | `imageIngestionGate.test.js`: "truncated JPEG", "corrupted JPEG" |
| Actual malware payload embedded in the file | ClamAV INSTREAM scan (`clamdClient.js`), fail-closed on any non-CLEAN verdict | `imageIngestionGate.test.js` + `imageIngestionClamdClient.test.js`: EICAR pattern → `REJECTED_MALWARE` |

## 2. Denial of service via resource exhaustion ("image bomb")

**Goal**: cause the server to allocate excessive memory/CPU decoding a small file that claims enormous dimensions, or an animated file with excessive frames.

| Technique | Mitigation | Proof |
|---|---|---|
| Tiny file, forged header declaring e.g. 50000×50000 pixels | Header-only precheck (`signatures.js:readHeaderMetadata`) rejects before any decode is attempted — sub-millisecond | `imageIngestionGate.test.js`: "excessive dimensions (header-declared)... before a full decode", "decompression-bomb-shaped fixture... never reaches the decoder" (asserts <500ms) |
| A file whose header looks fine but decodes to something huge | `sharp(..., {limitInputPixels})` is libvips' own bomb guard, applied even if the header precheck somehow missed it | `reencode.js` design; covered indirectly by the pixel-limit test using an artificially tiny `maxTotalPixels` |
| Animated image with excessive frames | `maxAnimationFrames: 1` for every allowed format (animation is disallowed entirely, since no ingress path needs it); checked both at the header level (WebP `VP8X` ANIM flag, PNG `acTL` chunk) and via `sharp`'s `metadata().pages` after decode | `imageIngestionSignatures.test.js` + `imageIngestionGate.test.js`: "animated content is rejected... via the header precheck" |
| Repeated huge uploads to exhaust bandwidth/storage/scan capacity | Per-user rate limit in the scan worker (`checkRateLimit`, 30/hour default); pre-buffer streaming cap in policy | `imageIngestionScanWorker.test.js`: "rate-limited users are deferred without downloading or processing anything" |

## 3. Data exfiltration / privacy leakage via metadata

**Goal**: an uploaded image carries EXIF GPS coordinates, camera identifiers, or embedded thumbnails that leak more than the visible picture (location of the user, device fingerprint), and that metadata survives into storage or a provider request.

| Mitigation | Proof |
|---|---|
| `reencode.js` never calls `.withMetadata()` — sharp strips EXIF (incl. GPS), ICC, IPTC, XMP, and embedded thumbnails by default on any re-encode | `imageIngestionGate.test.js`: "EXIF GPS metadata is stripped from the canonical output"; `imageIngestionServerWiring.test.js`: "the EXIF the client sent must have been stripped before reaching the provider" |
| The gate's own revalidation step re-checks the canonical output for `exif`/`icc` presence and fails `REENCODE_FAILED` if either is somehow still present | `gate.js` step 11; exercised via the module-cache-injection test in `imageIngestionGate.test.js` |
| No original filename is retained — object keys are content-addressed (`{userId}/{sha256}.{ext}`), never the client's filename | `imageIngestionScanWorker.test.js`: "buildCleanObjectKey: deterministic, content-addressed, server-controlled" |

## 4. Verdict/authorization forgery

**Goal**: bypass the scan entirely by presenting a forged "clean" verdict, reusing someone else's verdict, or substituting different bytes under an already-approved object id.

| Technique | Mitigation | Proof |
|---|---|---|
| Client fabricates a verdict token | HMAC-signed with a server-only secret (`verdict.js:sign/verify`); `timingSafeEqual` comparison | `imageIngestionVerdict.test.js`: "rejects a token signed with a different secret", "...whose payload was tampered with" |
| Client reuses an expired verdict | `expiresAt` checked in both `verdict.js:verify` and `tryon-clothes-pro`'s `resolveCleanImage` | `imageIngestionVerdict.test.js`: "rejects an expired verdict"; `tryon-clothes-pro/index.test.ts`: "an expired CLEAN verdict is rejected" |
| Client references another user's clean object by id | RLS on both `image_scan_verdicts` (owner-scoped `SELECT`) and the `image-ingestion-clean` bucket (owner-path-prefix `SELECT`) — a foreign object id simply matches no row for the caller's own JWT, it is never "found but denied" (which would confirm existence) | `tryon-clothes-pro/index.test.ts`: "an object id with no verdict row at all is rejected (unknown / cross-user reference)" |
| Object at a clean path is swapped/corrupted after the verdict was issued | `resolveCleanImage` re-hashes the downloaded bytes and compares to `sha256_canonical` in the verdict row before use | `tryon-clothes-pro/index.test.ts`: "a hash mismatch... is rejected (forged/substituted object)" |
| A non-CLEAN (e.g. still-PENDING or rejected) verdict is presented | Every lookup filters `.eq('verdict', 'CLEAN')` explicitly; `verdict.js:verify` also rejects non-CLEAN payloads | `imageIngestionVerdict.test.js`: "rejects a non-CLEAN verdict even if the signature is valid" |

## 5. Scanner-availability attacks

**Goal**: force the scanner offline (or exploit a race where it's down) to get unscanned content approved, or cause a scanning-service outage to silently degrade into "allow everything."

| Mitigation | Proof |
|---|---|
| `SCANNER_UNAVAILABLE`/`SCAN_TIMEOUT` are terminal rejection verdicts, never mapped to `CLEAN` — "fail closed when the scanner cannot establish a clean result" is structural, not a fallback branch that could be misconfigured to allow | `imageIngestionClamdClient.test.js` + `imageIngestionGate.test.js`: connection-refused and silent-server scenarios both resolve to a rejection, never `CLEAN` |
| CI's `evaluateScannerHealth` treats an unparseable/missing signature date as stale (fail closed on ambiguity) | `imageIngestionGateGuard.test.js`: "an unparseable version string is treated as stale (fail closed)" |
| Scanning is currently OFF by explicit configuration (no scanner deployed) rather than silently degrading from an expected-on state — a real operational distinction the architecture doc calls out | `secure-image-ingestion-architecture.md` §"What this branch does NOT do" |

## 6. Abuse / cost exhaustion

**Goal**: run up provider API costs, storage costs, or scanner compute by uploading the same or many images repeatedly.

| Mitigation | Proof |
|---|---|
| Duplicate-hash reuse — an unexpired `CLEAN` verdict for the same user + content hash is reused rather than rescanned or restored a second time | `imageIngestionScanWorker.test.js`: "duplicate hash reuses the existing CLEAN verdict, never rescans or double-stores" |
| Per-user rate limit in the scan worker; existing per-IP rate limit on `/api/analyze` (pre-existing, unmodified) | `imageIngestionScanWorker.test.js` rate-limit tests |
| Transient-failure retry ceiling (`MAX_TRANSIENT_RETRIES`) — a permanently-unreachable scanner doesn't retain quarantine bytes forever | `imageIngestionScanWorker.test.js`: "transient failures give up after MAX_TRANSIENT_RETRIES and clean up" |

## 7. Information disclosure via error responses

**Goal**: learn internal implementation details (scanner engine, signature names, bucket paths, thresholds) from error messages to plan a more targeted attack.

| Mitigation | Proof |
|---|---|
| Exactly five generic user-facing messages exist; every verdict code maps to one of them; `signatureName`/`internalReason` are structurally separate fields never interpolated into `userMessage` | `imageIngestionVerdict.test.js`: "never leaks internals"; `imageIngestionNoRawLogging.test.js`: structural assertions on `gate.js`/`verdict.js` |
| `tryon-clothes-pro`'s `resolveCleanImage` collapses four distinct failure reasons (no row, wrong verdict, expired, hash mismatch) into one identical response | `tryon-clothes-pro/index.test.ts`: "an unresolvable object id never echoes its own path/content back in the error" |

## Residual/accepted risk (see architecture doc for full reasoning)

- `/api/analyze` remains unauthenticated by design (pre-existing, out of scope to change here).
- Malware scanning is implemented but not yet active anywhere (no scanner deployed).
- Two live direct-to-Storage upload paths are not yet retrofitted onto quarantine (owner decision pending — client-visible contract change).
- `scan-identify` (a different branch lineage) is entirely outside this pass's reach and unaudited.
