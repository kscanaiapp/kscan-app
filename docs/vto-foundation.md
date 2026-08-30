# Virtual Try-On — Alpha Foundation 01 ("See It On You")

Status: **foundation built, provider not attached, feature ships disabled.**
Branch: `feature/build34-vto-alpha-foundation-v1` off
`integration/build34-trackb-convergence-v1` @ `e771f2c`.

VTO closes the gap between *discovering* a garment in K Scan and *seeing it on
yourself*. It exists to reduce uncertainty in a fashion decision — not to
demonstrate that K Scan can generate an image.

---

## 1. The flow

```
Commerce product (existing candidate)
        ↓
Eligibility            services/vto/vtoEligibility.ts        (UX)
                       supabase/functions/vto-generate/vtoEligibility.ts (authority)
        ↓
"Try It On"            components/vto/TryItOnEntry.tsx
        ↓
Person image           services/vto/vtoPersonInput.ts        (explicit pick + metadata strip)
        ↓
Auth / flag / K+       supabase/functions/vto-generate/vtoHandler.ts
        ↓
Provider adapter       supabase/functions/vto-generate/providers/
        ↓
Result validation      supabase/functions/vto-generate/vtoResultValidation.ts
        ↓
Result UI              components/vto/VirtualTryOnSheet.tsx
```

## 2. Provider neutrality

No K Scan module outside `supabase/functions/vto-generate/providers/` knows a
provider's credential format, endpoint, status strings, or error text. The
boundary is:

```
K SCAN  →  VTO CONTRACT  →  PROVIDER ADAPTER  →  EXTERNAL MODEL
```

`types/vto.ts` (client) and `vtoContract.ts` (server) are peers rather than one
shared module, because the client is Metro/React Native and the server is Deno
with `.ts` specifiers. `__tests__/vtoContractParity.test.js` runs both against
one fixture table so drift is a failing test, not a field mystery.

**Adding a real provider** is: a new adapter file in `providers/`, registered in
`providers/index.ts`, its credential read from `Deno.env` *inside the adapter*,
its errors mapped into `VtoFailureCode` before returning, and the
`app_config.vto_generation.provider` value changed. Nothing else in K Scan
changes, and no app release is involved.

## 3. Provider state

**MOCK ONLY.** No generation vendor is contracted, credentialed, or called.

The development provider returns an approved placeholder asset
(`providers/mockResultAsset.ts` — a 256×320 indexed PNG vignette, deliberately
abstract, generated deterministically) and behaves like a network-bound
generator: real wall-clock latency (6s default), `AbortSignal`-aware, and seven
deterministic scenarios — `success`, `timeout`, `rejected_input`,
`provider_unavailable`, `invalid_output`, `moderation`, `rate_limited`. No
randomness, so no test flakes.

An unknown provider id resolves to `provider_unavailable` rather than falling
back to the mock: quietly serving placeholder art when a real vendor is
misconfigured would be worse than an outage, because nobody would notice.

### What a real provider needs before it can be attached

1. A contracted vendor and a decision about what its terms permit us to send.
2. Its secret set as an Edge Function secret (never committed, never in the RN
   bundle, never returned to a client). No secret was created or modified here.
3. `app_config.vto_generation.provider` set to the new adapter's id.
4. A category benchmark (see §8) to decide `supportedCategories`.

## 4. Privacy and media — exactly what happens

| Question | Answer |
|---|---|
| How is the image chosen? | The user picks it from the photo library, explicitly, for this operation. Never the profile avatar, Elise avatar, a Closet photo, a saved scan, or a previous try-on. |
| What sanitation runs? | `prepareImageForPrivacyUpload` re-encodes it to a fresh JPEG (max 1024px, q0.8), which genuinely strips EXIF/metadata. If the sanitizer reports it did **not** strip metadata, the image does not leave the device. |
| Face masking? | **No.** A recognizable image of the user reaches the provider. |
| Where does it live? | The app cache, as a transient derivative, for the duration of one operation. |
| Does K Scan persist it? | **No.** No Storage bucket, no table, no row, no history, no gallery, no Closet write. |
| What reaches the provider? | The sanitized person image as base64, the retailer's `https` garment image URL, the canonical category, and the slot. No K Scan identity — the adapter interface has no field for one. |
| What is retained? | Nothing by K Scan. Whatever a future provider retains is a contract question, unanswered until one exists. |
| What is logged? | `uid` (first 8 chars), request label, origin, provider id, slot, canonical category, failure code, latency, and bucketed input/output dimensions. |
| What is never logged? | The person image, its URI, its base64, any signed URL, the garment binary, a raw provider response, a prompt, a credential, or a full user id. Enforced by closed allowlists on both sides (`services/vto/vtoTelemetry.ts`, `supabase/functions/vto-generate/vtoTelemetry.ts`). |

**This is not zero-knowledge and must never be described as such.** K Scan's
edge-first privacy story does not extend to VTO, and the on-screen copy says
only what is true: metadata is stripped, the photo is sent for this try-on, and
it is not saved.

`services/privacyImageSanitizer.js` is deliberately **not** used: it is a
passthrough that returns its input unchanged, so routing person media through
it would look like sanitation while performing none.

Face masking / local segmentation / identity restoration remain open research.
They are not prerequisites for this foundation, and shipping a weak version of
one would be worse than admitting we do not have it.

## 5. Authority chain

`vtoHandler.ts`, fail-closed at every step, in this order:

1. **Drain the body.** Responding without consuming a streamed body is what
   produced the 160s hang / 503 in this project's other Edge Functions, so the
   body is read before anything — including before authentication.
2. **Identity** — `requireUser()`, the verified JWT only. No `user_id` field
   exists in the contract, so there is nothing to forge.
3. **Account guard** — `assertAccountActive()`.
4. **Feature control** — `app_config.vto_generation.enabled`.
5. **K+** — `public.user_entitlements`, key `k_plus`.
6. **Eligibility** — re-derived server-side; the client's opinion is advisory.
7. **Person input** — data-URI shape and a 2,000,000-char ceiling.
8. **Provider** — selected from server config, never from the body.
9. **Result validation** — a provider's 200 is not yet a K Scan result.

Steps 4 and 5 are in that order deliberately: a globally disabled feature must
never be reported to a free user as "buy K+ to unlock".

## 6. K+ authority

VTO reads the **existing** entitlement authority and defines no second notion of
premium. There is no `vto_paid`, no `premium_vto`, no `isVtoSubscriber`, no VTO
product, and no new table.

- **Client (UX only):** `useKPlusEntitlement` → `kplusEntitlementStore` →
  `kplusClient.fetchKPlusStatus` → RLS-scoped `user_entitlements` row. The entry
  point renders through the shared `KPlusGate` / `KPlusEarlyAccessSheet`, not a
  VTO-specific paywall.
- **Server (authority):** `vtoEntitlement.resolveVtoEntitlement` reads
  `user_entitlements` where `entitlement_key = 'k_plus'` with the service role,
  and treats a row as active only when `status = 'active'` **and** the grant has
  not expired. Complimentary, staff, admin, promo, trial and paid grants all
  resolve identically, because they are all just rows in that table.
- **Three outcomes, not two:** `active`, `denied`, and `unknown`. `unknown` (the
  row could not be read) denies the request but reports `authorization_failed`,
  so a user who already holds K+ is never told to buy it again.

## 7. Feature control / kill switch

Reuses `public.app_config` — the governed key/value table that already carries
`mobile_feature_freeze`. One new row (`vto_generation`), one **additive** RLS
read policy scoped to that key, no new table and no feature-flag platform.

```jsonc
{
  "schemaVersion": 1,
  "enabled": false,              // default; flipping this is the kill switch
  "provider": "mock",
  "supportedCategories": ["top", "outerwear", "blazer", "dress"],
  "mockLatencyMs": 6000,
  "mockScenario": "success"
}
```

Disabled means: no generation, no VTO entry points — and Commerce, Scanner and
Elise are untouched. Every unreadable or malformed state resolves to disabled on
both sides. The client's read is memoized in memory for 60s and **never**
written to storage: a kill switch that needs an app restart to take effect is not
a kill switch.

`EXPO_PUBLIC_VTO_UI_ENABLED` is a separate, build-time question — "does this
build carry the UI at all" — and defaults off. It is not the kill switch.

## 8. Eligibility

Centralized. No component re-derives it.

Canonicalization reuses the taxonomy Scanner and Commerce already speak
(`normalizeCategory` in `_shared/scanHelpers.ts`). Slots: `top` for
top/outerwear/blazer, `full_body` for dress/jumpsuit, `bottom` for pants/skirt.
Footwear, bags and accessories have no slot and are never eligible.

The launch allowlist is deliberately **narrower than the slot map**: bottoms are
understood but not enabled. Reliability beats breadth, and benchmark evidence —
not this commit — should pick the shipping set. Because the list lives in remote
config, narrowing or widening it needs no app release.

Outcomes: `eligible`, `unsupported_category`, `missing_garment_image`,
`feature_disabled`, `entitlement_required`, `provider_unavailable`,
`invalid_product_reference`.

## 9. Lifecycle and the stale result rule

`services/vto/vtoRequestStore.ts` is module-scoped (not React state) so a late
`finally` is rejectable after the component that started it has unmounted.

A result may be applied **only** when both hold:

- its monotonic generation token is still the newest the store issued, **and**
- the actor context it captured is still current (`services/actorContext`).

The second half is load-bearing, not defensive: a captured user id still matches
after a sign-out/sign-in as the same person, which is exactly what
`advanceActorEpoch` exists to reject — and person imagery is what makes getting
that wrong unacceptable rather than untidy.

Consequences:

- A double tap cannot leave two live generations racing; the second start bumps
  the token and aborts the first.
- Dismissal tears the operation down and deletes both cache derivatives. The
  provider request may still finish; it has no authority to update anything.
- `resetVtoRequestState()` runs inside `resetActorScopedRuntimeState`, so an
  actor transition drops the photo, the result, and the files behind them before
  the next actor exists.
- Retry is deliberate and never automatic — a generation costs money and
  re-sends the user's photo.

## 10. Failures

Provider strings stop at the adapter. The UI receives a `VtoFailureCode` and
K Scan copy; an unrecognised code degrades to `unknown` rather than passing
anything through. `retryable` is a promise about the next attempt, so
`entitlement_required`, `feature_disabled` and `unsupported_category` are false.

## 11. Retailer neutrality and ownership

VTO visualizes whichever candidate Commerce already surfaced. It does not sort,
rank, score, reorder, or choose a retailer, and `Shop` reuses the card's existing
destination. A try-on is **evidence, not ownership**: nothing is added to the
Closet, marked owned, written to purchase history, or fed into Signature Style.

## 12. Hard boundaries

- **No fit claims.** VTO answers "what might this look like on me", never "will
  this fit" or "what size". That is the separate Fit Intelligence program.
- **No body inference.** No BMI, body fat, composition, weight, fitness, health,
  posture, body score, attractiveness, or ideal proportions — and no field in the
  contract for one. Pinned by test.

## 13. The prior experiment: `tryon-clothes-pro`

**REJECTED**, and left exactly as it was (still undeployed, still on the
perimeter guard's held-functions list).

What it is: a 189-line Edge Function proxying `try-on-clothes-pro.p.rapidapi.com`
with the shared `RAPIDAPI_KEY`, plus `services/tryOnClothesPro.ts`, a client
service **imported by nothing** — it is unreachable from the app.

Why it is not the foundation:

| Gap | `tryon-clothes-pro` |
|---|---|
| Authentication | None. No `requireUser`, no account guard. |
| K+ | None. |
| Kill switch | None. |
| Eligibility | None. Any category, any caller. |
| Person input | An arbitrary caller-supplied string — the server can be pointed at any remote image. |
| Privacy | No sanitation, no metadata handling. |
| Failures | Raw upstream body echoed back on 400 (`detail: errBody`). |
| Result validation | None. |
| Telemetry | `console.log` only. |
| Provider neutrality | The vendor is the contract. |

Reusing it would have meant rebuilding all ten. What *was* taken from it is
knowledge, not code: RapidAPI hosts try-on models with a
person-image + top/bottom-garment shape, which is why `VtoGarmentSlot`
distinguishes top/bottom/full_body. It is not activated, not extended, and not
deleted — deleting a governed, manifested function is a separate decision.

## 14. Cost and quota readiness

No product quota is invented — there is nothing to measure yet. The architecture
leaves room for one: generation is server-controlled and single-entry, so a limit
has exactly one place to live. The content-free telemetry already records what an
estimate needs (request count, success/failure mix, failure class, latency, retry
count, payload buckets). Bounds that exist today are safety bounds, not product
policy: a 45s server generation ceiling, a 55s client invoke ceiling, and a
~2MB person payload cap.

## 15. Regenerating the mock asset

```js
// node, from the repo root — produces the base64 in providers/mockResultAsset.ts
const zlib = require('zlib');
const W = 256, H = 320;
// 16-entry ivory→plum ramp, radial vignette, PNG colour type 3 (indexed).
// Indexed + a smooth field is what keeps it ~3KB instead of ~400KB.
```

Full generator: see the commit that introduced `providers/mockResultAsset.ts`.
The asset is a placeholder, not a rendering of anyone.

## 16. Deployment posture

- `vto-generate` is registered in `config.toml` with `verify_jwt = true` and in
  the governed edge-function manifest.
- It is **deliberately not** in `security/scripts/staging-deployment-allowlist.js`.
  A first deployment stays an explicit decision, not a side effect of source
  landing on a branch.
- The migration ships `enabled: false` and uses `on conflict do nothing`, so
  re-running it never clobbers an operator's live setting.
