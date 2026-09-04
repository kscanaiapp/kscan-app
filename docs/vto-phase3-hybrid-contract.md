# Live VTO Phase 3 — Hybrid Bridge: Read-Only VTO Contract Inventory

Section 20 deliverable: "Before building a bridge, inventory the current
governed generative VTO." This document is a **read-only** inventory,
independently re-verified this session directly against source (not
re-quoted from Phase 1-2's own `docs/vto-integration-candidate.md`, though
it agrees with that document everywhere the two overlap — see the
cross-reference at the end).

```
AUTHORITY:  integration/backend-kplus-complimentary-staging-v1
SHA:        f5ff48c8f764ab3158d1385ea2518e58265f3456
FILES READ (verbatim, via `git show <ref>:<path>`, never checked out into
this branch's working tree):
  supabase/functions/vto-generate/vtoContract.ts
  supabase/functions/vto-generate/vtoHandler.ts
  supabase/functions/vto-generate/vtoEligibility.ts
  supabase/functions/vto-generate/vtoEntitlement.ts
  supabase/functions/vto-generate/vtoFeatureControl.ts
  supabase/functions/vto-generate/vtoReservation.ts
  supabase/functions/vto-generate/vtoResultValidation.ts
  services/vto/vtoClient.ts
  services/vto/vtoPersonInput.ts
  services/vto/vtoResultExport.ts
  types/vto.ts
  constants/featureFlags.ts
  components/vto/VirtualTryOnSheet.tsx (grep only, for disclaimer copy)
```

No file above was modified, imported, or copied into this branch. No
network call was made against staging or production while producing this
document — every fact below is a source read.

---

## CLIENT ENTRY

`components/vto/TryItOnEntry.tsx` is the single Commerce seam (per Phase
1-2's `docs/source-authority.md`, unchanged this session): renders nothing
unless the item is eligible, owns sheet open/minimize state, one card/one
sheet/one operation. `components/vto/VirtualTryOnSheet.tsx` is the
operation surface itself. Gated by three independent layers — see FEATURE
FLAGS below.

## PERSON IMAGE CONTRACT

Source: `services/vto/vtoPersonInput.ts`, `types/vto.ts`.

```ts
export type VtoPersonInputSource = 'photo_library'; // the only member today
export interface VtoPersonInput {
  source: VtoPersonInputSource;
  sanitizedUri: string;      // local file:// URI, app cache only
  width: number | null;
  height: number | null;
  metadataStripped: boolean; // attested by the sanitizer, checked before trust
  sanitizerVersion: string;
}
```

- Input path: `expo-image-picker`'s system photo library picker
  (`launchImageLibraryAsync`) — **no camera capture today**, and
  deliberately **no pre-picker permission gate** (the app declares no
  `READ_MEDIA_IMAGES`/`READ_EXTERNAL_STORAGE`; the system picker needs
  none).
- Sanitization: `prepareImageForPrivacyUpload` performs a genuine
  metadata-stripping **re-encode** (a fresh JPEG). `services/
  privacyImageSanitizer.js` is explicitly NOT used — the source calls it "a
  passthrough that returns its input unchanged."
- Bounds: `VTO_PERSON_MAX_DIMENSION = 1024`, `VTO_PERSON_JPEG_QUALITY = 0.8`,
  transport ceiling `VTO_PERSON_PAYLOAD_MAX_CHARS = 2_000_000` base64 chars
  — enforced on **both** client (`vtoPersonInput.ts`) and server
  (`vtoContract.ts`'s identical constant, checked in `vtoHandler.ts`'s
  `PERSON_DATA_URI_PATTERN` + length check).
- Teardown: `releaseVtoPersonInput` deletes every cache derivative;
  idempotent, safe on partially-built inputs.
- Nothing is persisted. The person image exists only for the life of one
  request; the server writes no row and no Storage object
  (`vtoHandler.ts`'s own header: "NO PERSISTENCE").

## GARMENT INPUT CONTRACT

Source: `types/vto.ts`, `supabase/functions/vto-generate/vtoEligibility.ts`.

```ts
export interface VtoGarmentInput {
  productRef: string;         // correlation handle ONLY -- never authorization
  imageUrl: string;            // remote https retailer image
  category: string;            // K Scan category string, as Commerce produced it
  brand: string | null;
  commerceSource: string | null; // telemetry/debug only, never a ranking input
}
```

- `imageUrl` must be `https:` (`isSupportedGarmentImageUrl` — `data:`,
  `file:`, `content:`, `http:` all rejected). **New finding this session,
  not previously recorded in Phase 1-2's inventory:** the server additionally
  runs `assertSafeRemoteMediaUrl` on the URL before eligibility (SEC-KPLUS-002)
  — this rejects loopback/RFC1918/link-local addresses and the cloud
  metadata endpoint, not just the URL scheme. `isSupportedGarmentImageUrl`'s
  scheme-only check is necessary but not sufficient; the SSRF-safety check is
  a separate, later gate in `vtoHandler.ts`.
- Category is re-canonicalized server-side (`toCanonicalVtoCategory` →
  `normalizeCategory` from `_shared/scanHelpers.ts`) and mapped to a slot
  (`resolveVtoGarmentSlot`: `top|outerwear|blazer|dress|jumpsuit` →
  `top`/`dress`/`jumpsuit`→`full_body`, `pants|skirt`→`bottom`). Default
  supported categories: `['top', 'outerwear', 'blazer', 'dress']` — bottoms
  recognized in the vocabulary but not enabled pending benchmark evidence
  (unchanged from Phase 1-2's finding).
- The client's own eligibility check (`services/vto/vtoEligibility.ts`, not
  read this session — see Phase 1-2's inventory) is UX-only; the server
  re-derives eligibility independently and wins on any disagreement
  (`__tests__/vtoEligibilityParity.test.js`, per source comment).

## REQUEST

Source: `services/vto/vtoClient.ts#requestVtoGeneration`,
`supabase/functions/vto-generate/vtoHandler.ts`.

Client → server body, exactly as constructed in `vtoClient.ts`:

```ts
{
  requestId: string,
  origin: VtoOrigin,   // 'commerce_product'|'scan_result'|'dressing_room'|'elise'|'dev_harness'
  person: { dataUri: string },
  garment: { productRef, imageUrl, category, brand, commerceSource },
  requestGeneration?: string,  // VTO-QUOTA-001 idempotency generation token
  devScenario?: string,        // dev-only, ignored unless VTO_ALLOW_DEV_SCENARIOS is set
}
```

Transport: `supabase.functions.invoke('vto-generate', { body, signal })` — a
single Supabase Edge Function invoke, not a REST call the bridge could reach
independently outside the Supabase client.

Server processing order (`vtoHandler.ts`, fail-closed at every step,
verbatim from source comment): drain body → authenticate (verified JWT
only) → account-active guard → feature control (`app_config.vto_generation`)
→ K+ entitlement → eligibility (server re-derived, includes the SSRF check
above) → person-input shape/size validation → provider resolution
(server-config-selected, never client-chosen) → **entitlement re-checked a
second time immediately before the paid call** (INT-KPLUS-007 — K+ can lapse
in the window since step 5) → reservation/idempotency (SEC-KPLUS-004) →
generate, bounded → result validation.

## ASYNC OPERATION MODEL

**Not a polling model.** One bounded `invoke` call per attempt:

- Client ceiling: `VTO_INVOKE_TIMEOUT_MS = 55_000` (`vtoClient.ts`).
- Server ceiling: `GENERATION_TIMEOUT_MS = 45_000` (`vtoHandler.ts`).
- **Deliberately client > server**, so a hung provider always surfaces as
  the server's own `provider_timeout` classification winning the race,
  rather than an opaque client-side abort.
- Client-side UX lifecycle is a separate 10-state status machine
  (`VTO_STATUSES` in `types/vto.ts`: `idle, selecting_input, validating,
  ready, preparing, generating, validating_result, success, failed,
  cancelled`; 3 terminal: `success, failed, cancelled`) driven by the one
  invoke plus local progress staging — not by backend polling.
- Reservation/idempotency (`vtoReservation.ts`): idempotency key =
  SHA-256(`userId | productRef | garmentImageUrl | SHA-256(personDataUri) |
  requestGeneration-or-'default'`) — **a digest of the person image, never
  the bytes**, so no private user media is stored in or derivable from the
  key. Daily cap (`VTO_DAILY_GENERATION_LIMIT`, default 10), lease
  (`VTO_RESERVATION_LEASE_MINUTES`, default 5). A provably-unsent/refused
  submit (`billable: false`) releases the user's attempt rather than
  charging it; anything else (including a provider-side failure after
  submit) stays counted.

## RESULT CONTRACT

Success (`vtoHandler.ts` response, `types/vto.ts#VtoGenerationResult` on the
client after `vtoClient.ts#normalizeSuccess`):

```ts
{
  requestId: string,
  provider: string,        // opaque id, telemetry only
  dataUri: string,          // data:image/...;base64,...  ephemeral, in-memory only
  mediaType: string,        // image/jpeg | image/png | image/webp
  width: number | null,
  height: number | null,
  isAiVisualization: true,  // ALWAYS true -- literal-typed, cannot be omitted
  latencyMs: number,
}
```

Server-side validation before this is ever returned
(`vtoResultValidation.ts`): media type in the allowed set, a real
`data:<type>;base64,<payload>` URI whose declared type matches its own
header, base64 actually decodes, decoded size in
`[VTO_RESULT_MIN_BYTES=1024, VTO_RESULT_MAX_BYTES=8*1024*1024]`, and magic
bytes agree with the declared type. **Deliberately does not attempt identity
fidelity, garment fidelity, body-integrity, or visual-corruption
judgement** — source comment: "inventing an unreliable quality classifier
would be worse than admitting we have none."

Failure: **only an enum** reaches the client —
`{ requestId, status: 'failed', error: { code: VtoFailureCode, retryable:
boolean } }`. 16 codes (`VTO_FAILURE_CODES` in `vtoContract.ts`, mirrored in
`types/vto.ts`); provider text/detail is logged server-side only
(`providerDetail`) and never serialized into the response.

## SAVE/DRESSING-ROOM FLOW

Source: `services/vto/vtoResultExport.ts`.

- The result `data:` URI is **ephemeral, in-memory, session-scoped** — never
  written to Closet, gallery, or any durable store by the foundation itself.
- A durable copy is created **only** on an explicit "Save to Dressing Room"
  tap: `exportVtoResultToCache` parses the data URI (strict allow-list of
  `image/jpeg|jpg|png|webp`), writes it to
  `<cacheDirectory>/kscan-vto-export/vto-<requestId>-<timestamp>.<ext>`, and
  fails closed (`VtoExportError`, deletes any partial file) on a missing/
  empty write.
- `discardVtoResultExport` removes the file if the save flow is abandoned
  before completion — best-effort, non-fatal on delete failure.
- **The person photo is never exported** — only the generated visualization.

## DISCLAIMERS

Verbatim, confirmed by direct grep of `components/vto/
VirtualTryOnSheet.tsx` this session (byte-identical to Phase 1-2's quoted
copy — no drift):

- Header: `AI VISUALIZATION — NOT A PHOTO, AND NOT A FIT PREDICTION`
- Body: `AI-generated visualization for inspiration only. Check the `
  **size guide** ` for your exact fit.` (the "size guide" segment is a
  tappable link to the retailer's own sizing page when Commerce supplied
  one; plain text otherwise — `DISCLAIMER_LEAD`/`DISCLAIMER_LINK`/
  `DISCLAIMER_TAIL` constants).

## FEATURE FLAGS

Three independent layers, all fail-closed, source-verified this session:

1. **Build-time UI gate** — `EXPO_PUBLIC_VTO_UI_ENABLED`
   (`constants/featureFlags.ts#resolveVtoUiEnabled`: only the literal string
   `'true'` enables; missing/anything else → `false`). Unset in
   `production`/`staging`/`preview`/`development` EAS profiles; `'true'`
   only in `staging-certification`. **A production build carries no VTO UI
   affordance at all** — not hidden by a runtime check, structurally absent
   from the bundle.
2. **Remote kill switch** — `app_config.vto_generation`, read fresh (never
   cached to storage) by `vtoFeatureControl.ts#readVtoFeatureConfig` server-
   side. Missing row, unreadable table, malformed value, or unexpected
   `schemaVersion` → `DISABLED_VTO_CONFIG`. **Also fails closed on the
   provider**: an `enabled: true` config naming no provider (or an unknown
   one) resolves to no provider, never a silent substitution of the mock —
   "a default of 'mock' here would have... served placeholder art to a real
   person as though it were a generation from their own photo" (source
   comment).
3. **K+ entitlement** — `vtoEntitlement.ts#resolveVtoEntitlement`, delegates
   to the canonical `kplus_has_active_entitlement` RPC (same authority every
   other K+ surface uses), with a REST fallback applying the identical rule.
   Checked **twice** per request (see ASYNC OPERATION MODEL / INT-KPLUS-007).

`VTO_UI_ENABLED` (the resolved build-time constant) gates only UI
existence; flags 2 and 3 are enforced server-side regardless of what the
client believes, so a compromised or stale client cannot bypass them.

---

## Cross-reference to Phase 1-2's own inventory

Everything above agrees with `docs/vto-integration-candidate.md` and
`docs/source-authority.md` wherever they overlap (client entry, person
input bounds, feature-flag layering, disclaimer copy, the `vto-generate` vs
retired-`tryon-clothes-pro` distinction). This document adds, beyond what
Phase 1-2 recorded:

- The `assertSafeRemoteMediaUrl` SSRF-safety gate on the garment `imageUrl`
  (SEC-KPLUS-002), which sits between eligibility's scheme check and the
  provider call and is not mentioned in the Phase 1-2 documents.
- The exact server-side processing order and the double entitlement check
  (INT-KPLUS-007) at the paid-call boundary.
- The exact reservation/idempotency key composition and quota semantics
  (SEC-KPLUS-004 / VTO-QUOTA-001 / VTO-QUOTA-003).
- The exact result-validation checks (magic bytes, size bounds, media-type/
  header agreement) that stand between a provider's `200` and a value this
  program's bridge would ever see.

No incompatibility was found between this contract and the Phase 3 bridge
design in `docs/vto-phase3-photoreal-intent.md` /
`packages/photoreal-bridge`: the bridge's `PhotorealBridgePayload` →
`VtoGenerateRequestShape` mapping (see
`packages/photoreal-bridge/src/mockBridgeAdapter.ts`) matches this
contract's REQUEST shape field-for-field, using only fields the bridge can
legitimately produce (an explicit still + a commerce-sourced garment
reference). See Section 25 disposition in
`docs/vto-phase3-end-report.md`: **GENERATIVE BACKEND MUTATION: NO.**
