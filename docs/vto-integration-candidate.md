# Live VTO — Integration Surface Map (documentation only)

**No integration code exists, and none is written by this program.** This
document records *how* the isolated Live VTO engine would eventually
interoperate with K Scan's existing governed VTO, so that the isolated work
stays shaped for a future, separately-authorized integration pass instead of
having to be reshaped later.

Everything below is measured against the real VTO authority —
`integration/backend-kplus-complimentary-staging-v1` @ `4af92f4c` — not
against `master`. See `docs/source-authority.md` for why that distinction
cost this program an audit correction.

## What already exists (and must not be duplicated)

| Concern | Existing owner on authority B |
|---|---|
| Commerce entry point | `components/vto/TryItOnEntry.tsx` |
| Operation surface | `components/vto/VirtualTryOnSheet.tsx` |
| Eligibility | `services/vto/vtoEligibility.ts` (`evaluateVtoEligibility`) |
| Feature control | `services/vto/vtoFeatureControl.ts` + `EXPO_PUBLIC_VTO_UI_ENABLED` |
| Person input | `services/vto/vtoPersonInput.ts` |
| Garment derivation | `services/vto/vtoCommerceGarment.ts` |
| Transport | `services/vto/vtoClient.ts` → `supabase/functions/vto-generate` |
| Result / save | `services/vto/vtoResultExport.ts` |
| Domain contract | `types/vto.ts` |

The Live engine adds a *mode*, not a parallel VTO.

## 1. Client entry

`TryItOnEntry` already renders one affordance and owns "one card, one sheet,
one operation". The natural shape is that the existing entry gains a mode
choice — **AI Photo** (today's behavior, unchanged) and **Live Preview** — and
that `VirtualTryOnSheet` remains the operation surface for the AI Photo path
exactly as it is.

Constraints this implies for the isolated engine, all of which it already
satisfies:

- Live Preview must be presentable as a *sibling* of the existing flow, not a
  replacement, so nothing in the existing sheet needs restructuring to add it.
- The Live engine must never import Commerce, ranking, or destination
  selection. It receives a garment; it does not choose one.
- `TryItOnEntry` returns `null` when an item is not eligible. A Live mode must
  be gated by *its own* flag in addition to VTO's, so that Live can be off
  while AI Photo is on. It must never widen VTO's eligibility.

## 2. Garment input — mapping Commerce data to `.ksgarment`

Today: `buildVtoGarmentFromCommerceRecord` produces
`VtoGarmentInput { productRef, imageUrl, category, brand, commerceSource }`,
and `toCanonicalVtoCategory` reduces free-form categories to canonical tokens
(`top`, `outerwear`, `blazer`, `dress`, `pants`, `skirt`, `footwear`, `bag`,
`accessory`), with `resolveVtoGarmentSlot` mapping those to
`top | bottom | full_body`.

The isolated `GarmentDescriptor` maps onto that vocabulary like this:

| `GarmentDescriptor` | Source on authority B | Notes |
|---|---|---|
| `productId` | `VtoGarmentInput.productRef` | Correlation handle only, never authorization |
| `category` | `toCanonicalVtoCategory(garment.category)` | The isolated contract currently carries the older `master` enum (`Tops`/`Outerwear`/…). **Action for a future pass: adopt the canonical tokens as the primary vocabulary.** |
| `templateFamily` | derived from canonical token + subcategory | Live supports only `t-shirt`, `simple-top`, `sweater`; everything else is `unsupported` |
| `color`, `pattern`, `textureClass`, `materialClass`, `silhouette` | not available from Commerce | Legitimately `unknown` — the descriptor is built to represent that rather than fabricate it |
| `assetVersion` | `.ksgarment` manifest | Pinned per Section 12 |

**The gap that matters:** `VtoGarmentInput.imageUrl` is a *remote https
retailer image*, and `isSupportedGarmentImageUrl` deliberately rejects
`data:`/`file:`. The Live engine needs a local `.ksgarment` bundle (texture +
alpha + control points). Producing one from a retailer image is exactly the
P1-D3 asset pipeline, which is **not solved** — no real shot classifier,
segmentation, or control-point detector is integrated, and
**REAL CATALOG ASSET VIABILITY: BLOCKED — FIXTURE CORPUS REQUIRED**. A Live
integration is gated on that pipeline, not on the renderer.

Live's supported set must also be a *subset* of VTO's remote
`supportedCategories`, never a superset — two allowlists that can disagree is
how a garment becomes tryable in one mode and not the other for no reason a
customer can see.

## 3. Person input — the narrowest and most important seam

Today `VtoPersonInputSource` is a single-member union: `'photo_library'`. The
comment on it is explicit that alpha supports explicit user selection only —
never a profile avatar, Elise avatar, Closet photo, or a previous result.

A guided-capture or Live-capture path would add **one member and one
producer**, leaving the rest of `VtoPersonInput` untouched:

```
VtoPersonInput {
  source: 'photo_library' | <new member>      // one addition
  sanitizedUri, width, height,
  metadataStripped, sanitizerVersion          // unchanged
}
```

Non-negotiable properties any new producer must preserve:

- **Explicit user confirmation of a still.** Section 14's cloud-transition
  boundary and the existing contract agree: a photo goes to the provider only
  because the user chose it. A Live session must produce a *confirmed still*,
  not a silently-sampled frame.
- **Real re-encoding.** It must use `prepareImageForPrivacyUpload`, which
  strips metadata by producing a fresh JPEG. It must **not** use
  `services/privacyImageSanitizer.js` — `vtoPersonInput.ts` documents that as
  "a passthrough that returns its input unchanged, so it would give the
  appearance of sanitation without performing any."
- **Same bounds.** `VTO_PERSON_MAX_DIMENSION` 1024, quality 0.8, payload
  ceiling 2,000,000 base64 chars — the server enforces the same.
- **Same teardown.** `releaseVtoPersonInput` deletes every cache derivative.
- **Honest privacy copy.** The existing path already states plainly that it
  does not mask faces and is "not zero-knowledge". Live Preview's local
  processing does not change what AI Photo does. Candidate copy that stays
  true of both: *"Pose and Live Preview processing happen on this device. A
  photo is sent only if you choose AI Photo."*

## 4. Result — the AI Photo experience stays as it is

`VirtualTryOnSheet` renders a `VtoGenerationResult` (`data:` URI, ephemeral,
`isAiVisualization: true`) and `vtoResultExport` materializes a file only on an
explicit "Save to Dressing Room" tap.

The Live engine must **not** be imported by that path. The bridge runs one
way: Live produces a confirmed still that enters the *existing*
`VtoRequestDescriptor` unchanged; the result comes back through the existing
sheet. No Live renderer internals, no `BodyFrame`, no `BodyProxy`, and no
`.ksgarment` asset should ever appear in a `vto-generate` request.

Disclaimers already in place and correct for both modes:
`AI VISUALIZATION — NOT A PHOTO, AND NOT A FIT PREDICTION`, plus the size-guide
line. Live Preview needs its own labelling too — candidate:
`LIVE PREVIEW — APPROXIMATE VISUALIZATION` alongside
`VISUALIZATION ONLY — NOT A FIT PREDICTION`. Final wording is legal/product's,
not this program's.

## 5. Feature flagging

Live Preview must be independently gateable, and must fail closed the same way
VTO does:

- **Build gate** — a Live-specific `EXPO_PUBLIC_*` flag, defaulting off, in
  the same family as `EXPO_PUBLIC_VTO_UI_ENABLED`. Set it per EAS profile;
  a production profile that omits it carries no Live UI at all.
- **Remote kill switch** — a Live key in `app_config`, read uncached like
  `vtoFeatureControl.ts` does, disabled when unreadable. A cached "enabled"
  is not a kill switch.
- **Device capability** — `classifyDeviceCapability` already returns
  `UNSUPPORTED`, and `LIVE_UNAVAILABLE_FALLBACK_MESSAGE` already reads *"Live
  Preview isn't available on this device right now. Try AI Photo."* That
  fallback path is what makes an independent Live gate safe: turning Live off,
  anywhere in the stack, leaves a working AI Photo flow.

Live must never gate AI Photo. The dependency runs one way.

## 6. Rebase assessment for PR #291

**Not required, and not performed.** `kscan-live-vto/` imports nothing from
the app and is imported by nothing in it, so there is no interface
incompatibility to resolve — only the two documentation updates recorded
above (bridge target is `vto-generate`, not the retired `tryon-clothes-pro`;
and the canonical category vocabulary). Pulling an entire release branch into
an isolated research PR would buy nothing. If a human decides the research
line should track the integration branch rather than `master`, that is a
governance decision to make explicitly, not a side effect of this pass.
