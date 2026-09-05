# VTO Phase 4 — Source Authority (verified 2026-09-04)

This document is the mechanically-verified starting point for Phase 4 (Asset
Automation & Catalog Economics). Every SHA below was re-checked against
GitHub at session start — the SHAs quoted in the Phase 4 task brief were
**not** trusted blindly, and two of them turned out to be stale (the
integration branch has moved twice since the brief was written).

## Verified SHAs

| Authority | Ref | SHA | Note |
|---|---|---|---|
| Integration branch (real app-side VTO authority) | `integration/backend-kplus-complimentary-staging-v1` | `3c00804a96efd6bc5c14200ada022768e1dcf276` | Brief said `5da57d2f...`; actual head is one merge (#299, "vto-harness-repair") ahead of that. |
| `master` | `master` | `688dc35e5bc19bed603eea9835d3f8f12afba3be` | Also the fork point for PR #291 and PR #295 (`base.sha` on both PRs matches exactly). No `main` branch exists in this repository. |
| PR #291 head | `claude/kscan-live-vto-phase1-phase2-lcqyg9` | `769db5002dff9dbc58eade514bd613488efb1a71` | Matches the brief. Open draft, read-only reference authority — not merged anywhere. |
| PR #295 head | `claude/kscan-phase3-realism-bridge-xw9avl` | `266ab1a8538ed73b91a50e58f7089ae41b784c2b` | Matches the brief. Open draft, read-only reference authority — not merged anywhere. |

`git merge-base master integration/backend-kplus-complimentary-staging-v1` returns
nothing — the two histories are **unrelated** (confirmed independently; this
matches what PR #295's own source-authority doc already found). This
repository therefore has three genuinely separate lines of VTO-relevant work
that do not share history:

1. **`master`** — the plain app, no VTO code at all.
2. **`integration/backend-kplus-complimentary-staging-v1`** — the real,
   Commerce-wired, app-side Live VTO integration (`components/vto/`,
   `services/vto/`, `types/vto.ts`, `types/vtoLive.ts`, the capability
   router, the existing VTO test suite). This is the actual shipping-track
   code, currently gated fully off.
3. **PR #291 / PR #295 (`kscan-live-vto/`)** — an isolated npm workspace,
   forked from `master` (not from the integration branch), containing the
   garment-deformation research: control-point math, body model, static
   renderer, realism modules, and an existing `packages/asset-pipeline`
   package from Phase 1-2. It is mechanically prevented from being a
   dependency of the real app (`scripts/check-vto-live-integration-scope.js`,
   `VTO_ALLOWED_IMPORTS` test) and is **not** merged into the integration
   branch. Phase 3's own source-authority doc independently confirms this
   same unrelated-histories finding.

**Consequence for this lane's branch strategy.** The task brief's
"integration authority" and "research authority" are two different, disjoint
codebases, not two versions of the same one. Phase 4 needs both: the real
Commerce/VTO contracts (for product identity, category, and the capability
router it must not destabilize) live only on the integration branch; the
existing garment-contract/anchor/control-geometry math and the existing
`asset-pipeline` package live only in the PR #291/#295 research workspace.
This branch (`claude/vto-phase4-asset-automation-o8hhgo`) is therefore based
on the **integration branch** (matching task section 5's instruction to
branch from "the verified integration authority"), and the PR #291/#295
research workspace is consulted **read-only**, via `git show <sha>:<path>`
against the fetched PR-head refs, exactly as PR #295 itself did for the
integration branch. Nothing from PR #291/#295 is merged or copied wholesale;
specific contracts (garment coordinate space, anchor names, asset-pipeline
package conventions) are read and then re-implemented inside this branch's
own new Phase 4 package, citing the source file/line they were taken from.

This branch previously pointed at `master`'s tip (identical content, zero
unique commits — confirmed via `git log origin/master..HEAD` before
resetting) and has been reset to the integration branch's verified head
above; no work was discarded by that reset.

## Current VTO garment contract authority

There is no single frozen "garment" type — two deliberately different
shapes exist on the integration branch:

- **Generative (AI Photo) shape** — `VtoGarmentInput` in `types/vto.ts`:
  `{ productRef, imageUrl, category, brand, commerceSource }`. Produced by
  `buildVtoGarmentFromCommerceRecord()` in `services/vto/vtoCommerceGarment.ts`.
- **Live-runtime shape** — `LiveVtoGarmentDescriptor` in `types/vtoLive.ts`:
  `{ productRef, imageUrl, canonicalCategory, templateFamily }`, where
  `templateFamily` is one of `LIVE_SUPPORTED_TEMPLATE_FAMILIES = ['t-shirt',
  'simple-top', 'sweater']`. Produced by `evaluateLiveGarmentEligibility()`
  in `services/vto/vtoLiveGarment.ts`. Only one category currently maps to a
  template family: `top → simple-top` (`TEMPLATE_FAMILY_BY_CANONICAL` in the
  same file). This descriptor **deliberately carries no anchors, silhouette,
  neckline, texture, or material fields** — the file's own header says this
  app has no source of truth for them today.

Phase 4's output eligibility (`live2d`/`live3d`, see below) and its
garment-family economics reporting (t-shirt / simple-top / sweater) are
grounded in this `LIVE_SUPPORTED_TEMPLATE_FAMILIES` list, not an invented
taxonomy.

**Anchor / control-geometry semantics** (task section 23/25) are not defined
anywhere on the integration branch — they only exist in the PR #291/#295
research workspace, specifically `kscan-live-vto/packages/garment-contract`
and `kscan-live-vto/packages/body-model` (control-point targets computed in
a garment-local frame, per PR #291's description). Phase 4's anchor
generator is built against that contract, read-only, with citations — see
`docs/vto-phase4-corpus-discovery.md`.

## Current Commerce product contract authority

There is no single frozen "Product" type either — Commerce records arrive
in inconsistent shapes and the contract is a **narrowing reader**, not a
type:

- `VtoCommerceRecord = Record<string, unknown>` (any of: backend
  `RankedScanProduct`, a persisted snapshot, or `ProductShelf`'s `Product`).
- Field precedence (from `services/vto/vtoCommerceGarment.ts`):
  image → `['imageUrl','image_url','thumbnail','thumbnailUrl','image_src','product_image_url']`
  (first hit, normalized via `normalizePersistedCommerceUrl`); purchase URL →
  `['productUrl','purchaseUrl','affiliateUrl','product_url','purchase_url','url','link']`
  (resolved via `selectCommerceDestination`, not key order); retailer →
  `['retailer','brand','source','merchant','store']`; product ID → `record.id`,
  else purchase URL, else image URL, else `null` (no try-on entry at all).
- **No images array, no variants array, no selected-variant field** exists
  in this contract — one flat `imageUrl` string per commerce record.
- The richer `CanonicalDressingRoomItem` (DR-1) contract in
  `types/canonicalDressingRoomItem.ts` — "one contract across Scanner →
  Closet → Room → Shared → Elise → commerce" — does carry
  `commerce.purchaseOptions: CanonicalPurchaseOption[]`, each with its own
  `retailer`, `productId`, `imageUrl`, and a free-text nullable `variant:
  string | null` field. This is the closest thing to a "variant" concept
  this app has, and it is **not a canonical enumerated identity** — it is
  one retailer listing's own label. Per task section 14, Phase 4 treats
  variant identity as ambiguous whenever more than one purchase option
  disagrees on `variant`/`imageUrl` for what a human would call "the same
  product," and marks it `VARIANT_AMBIGUOUS` rather than inferring color
  from pixels.

`RECOMMENDED_PRODUCT = { id, title, source, price?, type, imageUrl?,
productUrl?, brand?, commerceType? }` (`shoppingProvider.ts`) is the
rawest upstream shape these narrow down from.

**Required invariant** (task section 10) — `productRef` is the same string
across the generative and Live shapes ("One product identity", per
`types/vtoLive.ts`'s own comment), and is documented as **correlation only,
never authorization**. Phase 4 asset identity uses this same `productRef`
as its product-ID component (see `docs/vto-phase4-corpus-discovery.md` for
the full asset-identity derivation) — it does not invent a second ID system.

## Current VTO capability authority

`services/vto/vtoLiveCapability.ts::resolveVtoCapability()` is the single
authoritative, synchronous, fail-closed decision layer for `mode: 'live' |
'ai_photo' | 'unavailable'`. Reason ladder (first match wins):
`feature_disabled → device_unsupported → native_module_missing →
runtime_unavailable → garment_unsupported → permission_unavailable`. Gated
by the AND of a build-time flag (`EXPO_PUBLIC_LIVE_VTO_ENABLED`) and an
independent server-side operator switch (`vto_generation.live.enabled`
in `app_config`, parsed by `services/vto/vtoFeatureControl.ts`). Both
default off in every environment (dev/staging/staging-certification/
production) per `docs/vto-live-integration-manifest.md`'s flag table.

Phase 4 does not modify this router's existing gates or reason ladder. Task
section 53 permits exactly one narrow, additive extension: a new **optional**
input the router can consume to learn "this product's Live asset is/isn't
eligible," defaulting to today's behavior when absent (see
`docs/vto-phase4-defect-ledger.md` / final report for whether this was
implemented and how it was proven not to change any of the 18
`vtoLiveCapabilityRouter.test.js` matrix cases).

## Prior program holds (carried forward, not resolved by Phase 4)

```
P3-A HUMAN VISUAL VERDICT:                 PENDING
CASE 8 COLOR-FIDELITY HUMAN DISPOSITION:   PENDING
NATIVE LIVE RUNTIME:                       NOT VALIDATED
PHYSICAL DEVICE:                           NOT VALIDATED
REAL PERSON LIVE VTO:                      NOT VALIDATED
```

These do not block Phase 4 asset-pipeline engineering and are not converted
to PASS by anything in this lane.
