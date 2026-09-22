# VTO V2 — Customer activation, product coverage, commerce loop

Source-development record for the lane that turns Virtual Try-On from a
technically capable subsystem into a reachable product experience.

**No deployment, no staging activation, no EAS, no paid generation was
performed by this lane.** Both feature gates remain default-OFF.

---

## 1. What was actually wrong

The VTO subsystem was not missing a router. It had three correct ones, and a
customer could not reach the answer they produced.

`components/vto/TryItOnEntry.tsx` — the only VTO entry point, mounted on both
shipped product surfaces — gated its visibility on `useVtoAvailability`, which
answers the **generative** question only:

```
if (!available && !upgradeOpportunity) return null;
```

`available` is false whenever the generative operator switch is off, or the
product's category is outside the *generative* allow-list. So a product with a
governed Live asset, on a Live-capable device, rendered **no Try On at all**
under the documented Live-pilot posture (`app_config.vto_generation.live.enabled
= true` with the generative `enabled` untouched — `docs/vto-live-productization-v1.md`
§8). `resolveVtoCapability` computed `mode: 'live'` and nothing on any screen
could call it.

That is the defect this lane closes. It is a coverage improvement of the kind
the brief's §43 case 2 describes — a product that was *incorrectly unavailable
because of an artificial client restriction* — and it is measured, not asserted:
see §5.

## 2. The single mode authority

`services/vto/vtoModeAuthority.ts#resolveVtoMode(garment, capabilityState, entitlementState)`

```
{ mode, status, reasonCode, productRef, liveAssetKey?, garmentImageRef?,
  supportedCategory?, liveReasonCode, capability, upgradeOpportunity }
```

- `mode` — `LIVE_LOCAL` | `PHOTOREAL_STILL` | `UNAVAILABLE`
- `status` — `PROVEN` | `SOURCE_CONNECTED_RUNTIME_UNPROVEN` | `UNAVAILABLE`
- `reasonCode` — a bounded enum (`VTO_MODE_REASON_CODES`), telemetry-safe

**It re-derives nothing.** It calls `evaluateVtoEligibility` (the generative
rule, still the client mirror the server re-derives and wins over),
`resolveLiveGarment` (the governed asset rule) and `resolveVtoCapability` (the
Live reason ladder), and decides only *order* and *reason reporting*.

**It is cheap.** Static verified facts only: a category string, a verified
https reference, the bundled registry, resolved flags, a cached native
self-check, resolved entitlement/quota. No I/O, no image bytes. Measured at
**0.007 ms per product** over the 16-record corpus
(`__tests__/vtoCustomerJourneys.test.js`, `[vto-perf]`).

**Decision order.** product identity → actor → entitlement → LIVE → PHOTOREAL
→ UNAVAILABLE. Live is tried first because it is local, non-billable and does
not depend on the generative operator switch — *not* to widen anything: it
still demands an exact governed asset for that exact `productRef`.

`hooks/useVtoMode.ts` is the one React binding. Nothing under `components/`
may call `useVtoAvailability`, `useVtoLiveCapability`, `evaluateVtoEligibility`
or `resolveVtoCapability` — asserted in
`__tests__/vtoModeAuthorityBlocking.test.js` (BLOCK-VTO2-00).

## 3. Runtime proof status — declared, never inferred

`VTO_RUNTIME_PROOF` is a frozen constant with its evidence cited inline:

| Mode | Status | Evidence |
| --- | --- | --- |
| `LIVE_LOCAL` | `SOURCE_CONNECTED_RUNTIME_UNPROVEN` | `docs/vto-live-productization-v1.md` §10: *"No frame has been rendered on a phone by this lane's code."* iOS physical runtime PENDING; the Android physical-camera hold (`ETIMEDOUT (-110)` — binds, reports RUNNING, never delivers a frame) PENDING RECLASSIFICATION. |
| `PHOTOREAL_STILL` | `SOURCE_CONNECTED_RUNTIME_UNPROVEN` | See §4. |

Changing either is a deliberate edit backed by new evidence. No UI, telemetry
event, or report in this lane may describe either mode as proven coverage.

## 4. Photoreal: what has and has not succeeded

**A real provider generation HAS completed. The governed customer path has
never produced one.** Both halves matter and neither may be reported alone.

| | |
| --- | --- |
| `PHOTOREAL_GENERATION_EVER_SUCCEEDED` | **YES — provider transport only. NO — through the governed `vto-generate` function.** |
| The successful generation | `docs/vto-provider-benchmark.md` §3.6: submit → real `task_id` (3.5s) → poll ×3 → `task_status: 2` → real `output.image_url`, `usage.image_count: 1` (a real billed generation). |
| Why it is not customer proof | It ran through a **temporary diagnostic function**, not the governed `vto-generate`, with **synthetic random-noise input**. The output was noise-shaped, which is the honest outcome of feeding noise to a person-detection-dependent model. §5 of that document records the governed function's own result path as *"not yet exercised inside the deployed `vto-generate` function itself"*. |
| `LAST_KNOWN_PROVIDER_RESULT` (governed staging path) | `rate_limited` / `submit_http_429`, three bounded calls (`docs/vto-live-bridge-contract.md`). |
| `LAST_KNOWN_ERROR_CLASS` | **RATE_LIMIT.** Distinguished by the adapter itself (`providers/aiLabToolsProvider.ts#mapSubmitFailure`): 401/403 is the subscription gate, 429 is the RapidAPI gateway rate limiter, 5xx is upstream. All three are marked `billable: false` because no AILabTools task exists in any of them. **Not** `QUOTA_EXHAUSTED`, **not** `PLAN_NOT_SUBSCRIBED`. |
| `PROVIDER_PLAN_STATUS` | **ACTIVE.** The earlier `403 {"message":"You are not subscribed to this API."}` went stale within its own session; a re-check produced an AILabTools-origin `400` (`error_code`/`error_code_str`/`error_detail`), which is past the gateway. |
| `CONTRACT_STATUS` | Adapter contract-complete and live-verified, including one bug found and fixed from live evidence (a terminal `413` was being retried as transient). |
| `CREDENTIAL_PATH_STATUS` | `RAPIDAPI_KEY` present in staging, authenticates, no new secret created or rotated. |
| `QUOTA_STATUS` | Server-owned (`vto_generation_reservations`). Not readable from the client — see §8. |

### 4.1 OWNER ACTION — paid smoke test

```
PAID_SMOKE_TEST_RECOMMENDED = YES
PROVIDER                    = AILabTools "Try On Clothes Pro" (existing, via RapidAPI)
MAX_GENERATIONS_REQUIRED    = 2   (one nominal, one deliberate refusal)
EXPECTED_MAX_COST_IF_KNOWN  = ~$0.008 per generation (measured, benchmark §3.6) -> ~$0.02 total
TEST_INPUT_CLASS            = a consented or synthetic NON-CUSTOMER person fixture
                              + one governed garment image. No user data.
WHAT_THE_TEST_PROVES        = that the GOVERNED vto-generate function -- with
                              real auth, K+ entitlement, eligibility, reservation,
                              idempotency, media safety and result validation in
                              the path -- produces a validated result the result
                              UI can render. Transport is already proven; this is
                              the only unproven link.
```

**Not run by this lane.** The existing zero-spend posture is already correct:
`vto-e2e.yml`'s `staging-full-certification` job requires a `workflow_dispatch`
with `confirm_paid_certification: YES`, which is an owner act.

Preferred posture when authorized: a small fixed count, a non-production
environment, a controlled fixture, no continuous live-frame upload.

```
WHAT PREVENTS FIRST SUCCESSFUL PHOTO GENERATION (governed path) =
  1. No owner-authorized paid execution against the governed function. (The
     blocker. Everything else below is downstream of it.)
  2. No consented non-customer person fixture exists to run it with.
  3. The legal question in section 9 is open for anything beyond a controlled
     internal test.
```

## 5. Coverage — measured, reported separately, never summed

`__tests__/vtoCoverageCorpus.json` (16 records) + `__tests__/vtoCoverageReport.test.js`.

**This is a FIXTURE corpus of product shapes. It is not catalog coverage and no
percentage from it may be reported as such.**

```
LIVE_FIXTURE_ELIGIBILITY  = 2    (exactly the two real governed assets)
PHOTO_FIXTURE_ELIGIBILITY = 4
UNAVAILABLE               = 10
UNKNOWN                   = 0    (every record classifies to a declared mode)
```

### UNAVAILABLE reason distribution — this is the roadmap

| Reason | Count | What it means |
| --- | --- | --- |
| `UNSUPPORTED_CATEGORY` | 6 | bottoms, footwear, bag, accessory, an unknown category, an explicit non-fashion result |
| `NO_SAFE_GARMENT_IMAGE` | 3 | no image, an `http:` image, a `data:` image |
| `INVALID_PRODUCT_REFERENCE` | 1 | nothing stable to anchor a try-on to |

`NO_LIVE_ASSET` does not appear here, and that is the honest result rather than
a flattering one: the record it applies to has a working photo path, so it is
not UNAVAILABLE. Its Live gap is counted in the **Live blocker distribution**,
reported separately for exactly that reason:

```
LIVE_BLOCKERS = { NO_LIVE_ASSET: 1, UNSUPPORTED_CATEGORY: 9,
                  NO_SAFE_GARMENT_IMAGE: 3, INVALID_PRODUCT_REFERENCE: 1 }
```

### Before / after

| | Before | After |
| --- | --- | --- |
| Reachable try-ons under the **Live-pilot operator posture** (Live on, generative operator switch off) | **0** | **2**, both `LIVE_LOCAL` |
| Products that previously offered a try-on and now offer none | — | **0** (asserted) |

Both numbers are computed in the test, the "before" by evaluating the old entry
rule (one call to the same `evaluateVtoEligibility` that still owns it) over the
same corpus. No coverage is claimed from the router merely labelling things.

### Category gate finding

```
PHOTO_CATEGORY_GATE = HARD_PROVIDER_CONSTRAINT (bottoms)
                    + HARD_CONTRACT_CONSTRAINT (no body slot)
```

Investigated rather than assumed. `providers/aiLabToolsProvider.ts#unsupportedSlotReason`
serves `top` and `full_body` (a one-piece goes through `top_garment` with
`bottom_garment` empty) and genuinely cannot serve `bottom`: `top_garment` is
required, so a bottom-only submission would need an unrelated top image the
customer never chose. Footwear, bags and accessories resolve to **no body slot
at all** (`resolveVtoGarmentSlot` → `null`) — they are not a policy narrowing.

**Nothing was widened, and nothing artificial was found to remove on the photo
side.** The artificial restriction this lane removed was on the *entry point*,
not the category list. Live's narrow vocabulary (`top` only) was verified to be
a native-runtime fact (`LIVE_SUPPORTED_TEMPLATE_FAMILIES`), not a client
opinion — and it was confirmed that it was NOT being used to narrow Photoreal.

## 6. Customer entry and the flow

```
CUSTOMER_ENTRY_CONNECTED = YES
```

`components/vto/TryItOnEntry.tsx` is the VTO-owned Try-On action and was
already mounted on both shipped product surfaces — `PurchaseOptionsPanel`
(what a person actually sees, since `eas.json` sets
`EXPO_PUBLIC_SCAN_RESULTS_V2_UI=true` in every governed profile) and
`ProductShelf`. **No new mount was needed.** The shared files were edited for
exactly one thing: passing an existing Watch callback (§7).

Visibility is now honest per mode:

| Mode | Renders | Copy |
| --- | --- | --- |
| `LIVE_LOCAL` | yes | `TRY IT ON` — *"Opens live try-on using your camera"* |
| `PHOTOREAL_STILL` | yes | `TRY IT ON · PHOTO` — *"…with a photo you choose. It takes a moment to create."* |
| `UNAVAILABLE` | **nothing** | — |
| `UNAVAILABLE` + only K+ missing | `TRY IT ON · K+` | opens the one shared K+ surface |

Live and Photo deliberately do not read identically (§27 of the brief): one is
interactive and local, the other is a still that takes time. Neither string
names a technology or a vendor.

### `VtoEntryContract`

`services/vto/vtoEntryContract.ts` publishes the typed boundary:
`resolveMode(product)`, `startTryOn(product, decision)`, `resumeTryOn(session)`.
A product surface supplies only a verified product reference and opaque
callbacks it already owns. It never learns an `assetKey`, that MediaPipe or a
camera exists, a native capability shape, clean-frame internals, or a provider.
`sessionRefForDecision` **refuses a decision about a different product**, which
makes "product A's completion opens product B's try-on" unreachable at the
entry rather than merely superseded later.

## 7. Result → Commerce loop

| Action | Path | New code |
| --- | --- | --- |
| **Shop / View** | the injected `onShop` callback the product surface already owns; disabled when Commerce supplied no destination | none |
| **Save** | existing `VtoSaveToDressingRoom` → `AddScanToDressingRoomModal` | none |
| **Watch** | **new action, existing path**: `onWatch` opens the surface's own `WatchThisModal` with its own server-authored `watchCandidate`, gated by its own `canWatchPurchaseOption` / `canWatchProduct` | one optional prop |

VTO creates no price, currency, stock, availability, retailer or purchase URL,
and no VTO module understands what a watch is. A browse-only product gets no
Buy action. **TRY ON ≠ OWNED; result ≠ OWNED; SAVE/WATCH/SHOP ≠ OWNED** —
Closet remains the ownership authority.

```
VTO_RESULT_SHARE_FOLLOWUP_REQUIRED = YES
```
Dressing Rooms already support sharing, and a saved try-on result becomes a
Dressing Room item through the existing path — so sharing a *saved* result
already works. Sharing a *session-scoped, unsaved* result has no governed path
and none was built here: that is a social-surface decision, not a VTO one.

## 8. Entitlement, quota, account state

- **Entitlement**: the existing K+ policy, unchanged and un-priced. Both modes
  require it; `__tests__/kplusCoreFreeBoundary.test.js` still pins
  `components/vto/TryItOnEntry.tsx -> vto`. A still-loading entitlement is
  never rendered as an upgrade prompt.
- **Quota**: the resolver gate is wired and tested (`QUOTA_EXHAUSTED` is
  refused before the customer enters a paid flow, and never takes Live away —
  Live costs no provider call). **The client passes `'unknown'` today, and that
  is deliberate.** Quota lives in `vto_generation_reservations` and reaches the
  client only as a `rate_limited` refusal, which the server also returns for a
  duplicate in-flight request and which the provider adapter also returns for a
  gateway 429. Inferring quota from an ambiguous code would hide a working Try
  On after a transient provider blip. The seam is one field.
- **Account state**: server-authoritative (`assertAccountActive` in
  `vto-generate`). The client holds no suspension / pending-deletion signal, so
  it asserts only that a session exists. Kept as a distinct resolver input so a
  future client signal wires in one place.

An unentitled or ineligible actor triggers **no camera startup, no asset load
and no provider work** — the entry returns before any of it.

## 9. Privacy and data boundary

```
LIVE_FRAME_CLOUD_EGRESS = NONE
```

| Data | Where it goes |
| --- | --- |
| **Continuous live camera frames** | **On device only.** No router, telemetry event, Commerce callback or eligibility request can carry one. The new V2 modules are asserted to contain no network client and no camera-data vocabulary at all (BLOCK-VTO2-08/19). |
| **Clean person still** | Leaves the device **only** after an explicit customer capture, through the existing governed handoff: `assertCleanPersonFrame` (refuses a `PREVIEW` by declared kind — never by a pixel heuristic), harness refusal, metadata-stripping sanitizer, then the same store → client → `vto-generate` chain a picked photo uses. |
| **Garment image** | The retailer image URL, to the existing provider contract. |
| **Product reference** | A bounded correlation handle. Never an authorization input. |
| **Never sent** | Closet context, Signature Style, Elise transcript, Commerce shelf memory, body data of any kind. |

The customer's own face is **not** masked in a still they deliberately supplied
for try-on. That is the point of the feature and it changes nothing about
Scanner/bystander controls.

```
GARMENT_IMAGE_SOURCE                        = the retailer/catalog image on the commerce record
GARMENT_IMAGE_RIGHTS_STATUS_KNOWN           = NO
GARMENT_IMAGE_SENT_TO_PROVIDER              = YES (existing behaviour, unchanged by this lane)
LEGAL_OPEN_RETAILER_IMAGE_GENERATIVE_USE    = YES
```

Whether retailer-sourced product imagery may be sent to an external generative
system has not been established by this program. It does not block source
architecture, and this lane changed nothing about it — but it is a
**production / user-exposure gate**, and it is an owner and counsel decision,
not an engineering one.

## 10. Telemetry and the future binding metrics

Seven events added to the **existing** governed sink
(`services/vto/vtoTelemetry.ts`, auto-registered through
`services/analytics/analyticsEventRegistry.ts`). No direct PostHog call, no new
vendor, no arbitrary string.

| Funnel step | Event |
| --- | --- |
| `VTO_ENTRY_SEEN` | `vto_entry_shown` *(new)* |
| `VTO_UNAVAILABLE_SHOWN` | `vto_entry_unavailable` *(new)* |
| `VTO_MODE_RESOLVED` | `vto_mode_resolved` *(new)* |
| `VTO_TRY_ON_TAPPED` | `vto_entry_tap` *(reused)* |
| `VTO_SESSION_STARTED` | `vto_request_start` *(reused)* |
| `VTO_CAPTURE_COMPLETED` | `vto_capture_completed` *(new)* |
| `VTO_HANDOFF_READY` | `vto_handoff_ready` *(new)* |
| `VTO_RESULT_COMPLETED` | `vto_request_success` *(reused)* |
| `VTO_SAVE_ACTION` | `vto_result_save_opened` *(reused)* |
| `VTO_SHOP_ACTION` | `vto_result_shop` *(new)* |
| `VTO_WATCH_ACTION` | `vto_result_watch` *(new)* |
| `VTO_FAILURE` | `vto_request_failure` *(reused)* |

`vto_entry_impression` was **not** reused for the entry impression: it fires
when the *sheet* opens, and using it as a start-rate denominator would put a
false number in front of whoever reads this later.

Payloads carry `resolvedMode`, `status`, `reasonCode`, `liveReasonCode`,
`origin` — bounded lower-cased enums only. `__tests__/vtoModeAuthorityBlocking.test.js`
drives every emitter through the real sink and asserts no `productRef`, image
name, URL, retailer, category text, `file://` or base64 can appear.

### Future binding metrics (definitions only — this lane is not activated)

```
TRY_ON_START_RATE      = vto_entry_tap / vto_entry_shown
TRY_ON_COMPLETION_RATE = (successful Live session | vto_request_success) / vto_request_start
TRY_ON_TO_SAVE_RATE    = vto_result_save_opened / vto_request_success
TRY_ON_TO_WATCH_RATE   = vto_result_watch      / vto_request_success
TRY_ON_TO_SHOP_RATE    = vto_result_shop       / vto_request_success
REPEAT_TRY_ON_RATE     = actors with >1 vto_request_start in the analytics window
                         / actors with >=1
```

**No value is reported for any of them.** The lane is not activated; runtime
activation later supplies the data.

## 11. Performance (local code only)

Measured over the 16-record fixture corpus, 200 iterations, on CI hardware
(`__tests__/vtoCustomerJourneys.test.js`):

```
MODE_RESOLUTION_MS         = 0.0067   (per product)
ASSET_LOOKUP_MS            = 0.0008   (per product)
CAPABILITY_CACHE_LOOKUP_MS = 0.0006
HANDOFF_PREFLIGHT_MS       = 0.0001   (the local clean-frame gate)
```

No provider latency and no device frame rate is reported — neither has been
observed. The decision path is asserted to contain no `fetch`, no filesystem,
no image decode and no `async`, which is what keeps these numbers local.

`services/vto/vtoCapabilityCache.ts` memoizes the native self-check so a shelf
of ten product cards costs **one** bridge call instead of ten (asserted). It is
memory-only — no persistent device fingerprint exists to leak — with a short
TTL on a negative answer so a runtime that finishes initializing later is not
locked out until relaunch.

## 12. Data lifecycle

```
NEW_PERSISTENT_USER_DATA = NO
```

No new table, no new migration, no new persisted state. The only new
module-scoped state is a device-capability memo that dies with the JS context.

---

# VTO V3.1 addendum — provider rate-limit truth

Discovered during the VTO V3 preflight, repaired before any money was spent.

## The defect

Three unrelated situations all left `vto-generate` as `rate_limited`, and the
app rendered every one of them as **"You've reached the try-on limit for now."**

| What actually happened | Old code | Was the copy true? |
| --- | --- | --- |
| the actor really did spend their daily allowance | `rate_limited` | yes |
| a duplicate request was already in flight | `rate_limited` | **no** |
| the vendor gateway was throttling K Scan | `rate_limited` | **no** |

The distinction existed internally the whole time — `stage` is
`reservation_quota` / `reservation_duplicate` / `provider_outcome`, and the
adapter records `providerDetail: submit_http_429` — but `fail()` returns only
`{ code, retryable }`, so all three collapsed at the response boundary. Two
shoppers in three were told they had used something up when they had not.

## The split

| Cause | Code | HTTP | Copy | Retryable |
| --- | --- | --- | --- | --- |
| the actor's own daily allowance | `quota_exhausted` | 429 | "You've reached the try-on limit for now. Try again later." | yes |
| duplicate already running | `request_in_flight` | 429 | "This try-on is already running. Give it a moment." | **no** |
| vendor throttling K Scan | `provider_busy` | 503 | "Photo try-on is temporarily busy. Try again shortly." | yes |

`request_in_flight` is deliberately **not** retryable: a retry button there
asks for exactly the second submission idempotency just suppressed.

`rate_limited` stays in the vocabulary — a client build can still receive it
from an older deployment — but nothing emits it any more, and its copy is now
neutral rather than an accusation about the customer's allowance.

`stage` and `providerDetail` remain server-log only. No vendor name, host,
HTTP status or raw body reaches the client, and no customer string names one.

## `Retry-After`

Previously never parsed at all, so §19's "honour Retry-After" could not be
executed by code. Now `parseRetryAfterSeconds` accepts **both** RFC 9110 forms
(delta-seconds and HTTP-date) and returns bounded whole seconds within
`[VTO_RETRY_AFTER_MIN_SECONDS, VTO_RETRY_AFTER_MAX_SECONDS]` = `[1, 3600]`.

Anything else — absent, empty, negative, zero, fractional, non-numeric, a
400-digit string, a date in the past, or a value outside the window — returns
`null`, and the response simply omits the field. **Out-of-range values are
discarded rather than clamped**: clamping ten days down to an hour would invent
a wait nobody promised, and the copy already degrades honestly to "try again
shortly" when there is no number.

The value is carried as `error.retryAfterSeconds`, the only provider-derived
number that reaches a client. **It is guidance, not a trigger** — nothing
retries automatically, the submit is issued exactly once, and the second
attempt (if there is ever one) remains the certification harness's single
authorized call.

## What did not change

`NEW_PROVIDER=0 · NEW_MODEL=0 · NEW_LLM_CALLS=0`

Idempotency key composition, reservation locking, duplicate suppression and
billing accounting are untouched, and pinned as such: a gateway 429 still
**releases** the attempt (no vendor job existed), a billable failure still
settles it `failed`, and an adapter that omits `billable` still counts. Retry
timing is deliberately absent from the idempotency identity — a key that varied
with a vendor's `Retry-After` would defeat duplicate suppression outright.

Covered by `BLOCK-VTO31-00..10` in `__tests__/vtoRateLimitTruth.test.js`, which
drives the **real** `handleVtoRequest` and the **real** adapter against injected
transports rather than matching source text.

---

# Build 35 addendum — result and decision-loop polish

TRY → RESULT → COMPARE → DECIDE → SHOP / WATCH / SAVE / TRY ANOTHER. A
refinement of the existing surface, not a new VTO: no provider, eligibility,
schema, flag or runtime change. Base: `fix/notifications-final-convergence-v1`
@ `d66f03d6` (the #414 merge).

## Source authorities (traced, not taken from older diagrams)

| Concern | Authority |
| --- | --- |
| Mode decision (`LIVE_LOCAL` / `PHOTOREAL_STILL` / `UNAVAILABLE`) | `services/vto/vtoModeAuthority.ts#resolveVtoMode`, bound once by `hooks/useVtoMode.ts` |
| Entry CTA, product → session contract | `components/vto/TryItOnEntry.tsx`, `services/vto/vtoEntryContract.ts#sessionRefForDecision` |
| Mounts (the only two) | `components/scan-results/PurchaseOptionsPanel.tsx`, `components/ProductShelf.tsx` — both `origin="commerce_product"` |
| Photo flow, review, generation, result, cancel, retry | `components/vto/VirtualTryOnSheet.tsx` over `hooks/useVirtualTryOn.ts` over `services/vto/vtoRequestStore.ts` |
| Live flow | `components/vto/VtoLivePanel.tsx`, `hooks/useVtoLiveSession.ts`, `services/vto/vtoLiveSession.ts` |
| Result decision rules (new) | `services/vto/vtoDecisionLoop.ts` — pure, imports only `types/vto` |
| Shop | the surface's `onShop` (its existing destination), passed through unmodified |
| Watch | the surface's `onWatch` → its own `WatchThisModal` → `createWatch`; DB unique `(user, url)` |
| Save | `components/vto/VtoSaveToDressingRoom.tsx` → `components/AddScanToDressingRoomModal.tsx` (`upload_inspiration`) |
| Stale completion, cancellation, double tap | `vtoRequestStore.ts` generation token + actor epoch; supersede-and-abort |
| Actor switch | `contexts/AuthSessionContext.tsx` → `resetVtoRequestState()` |
| Error taxonomy / copy | `services/vto/vtoFailures.ts` (client), `supabase/functions/vto-generate/vtoContract.ts` (server) |
| Result lifetime / cleanup | see "Image memory" below |

## What changed

| Area | Before | After |
| --- | --- | --- |
| Hierarchy | Shop (primary) + Watch + Try again + Save + Compare, roughly equal weight, Save inside the scroll body | **Primary** Shop · **Secondary** Save this try-on, Watch · **Tertiary** Try again, Try another piece. Decided by `planVtoResultActions` |
| No purchase path | a primary Shop rendered *disabled* | no Shop button; "This listing has no shop link right now." (supersedes §7's "disabled" row) |
| Identity | result rendered for any `success` snapshot | rendered, with its actions, only when `vtoResultBelongsToProduct` — same `productRef`, same garment image, same request — else nothing (fails closed) |
| Product context | title in the header only | "YOU TRIED" + brand (when supplied) · title under the result. No price restated: a try-on is not a fresh read of commerce truth |
| Compare | one "SHOW ORIGINAL" toggle | a two-option switch (TRY-ON / YOUR PHOTO) with `tab` role, selected state and an on-image text badge. Both images are on-device; no fetch |
| Try again / Try another | Try again only | Try again = same piece, new attempt (`vto.retry`). Try another piece = back to the options the sheet was opened over, **nothing generated**, session photo kept |
| Progress | "Analyzing garment / Mapping the fit / Rendering visualization", advanced by a timer while the provider call was still out | "Preparing your photo… / Creating your try-on… / Finishing your result…" = the store's `preparing / generating / validating_result` exactly; after 15s, "Still working on it. You can minimize and keep shopping." |
| Retry-After | server sent `error.retryAfterSeconds`; client dropped it | carried through transport → failure (validated `[1, 3600]`, retryable codes only) → "Try again in about 30 seconds."; Try again disabled locally until it elapses. No timer schedules a request |
| Non-retryable failure | still rendered "Try it on" wired to `vto.retry` — a NEW intent, i.e. a second paid job beside the one `request_in_flight` said was running | no regenerate button; Choose a different photo / Close remain |
| Save copy | "Add Scan to Dressing Room … Avoid faces, bystanders…", "Continue Scanning" | try-on variant: "Save this try-on — This try-on contains the photo you chose to use for it. It's added to the Dressing Room you pick, and anyone that room is shared with can see it." / "Back to try-on". Scan copy unchanged |
| Save confirmation | none in the sheet | "Saved to {room}." only from `onSaved`, after the write resolves; dropped with the result |
| View Dressing Room from a try-on | navigated with the try-on sheet still open on top | closes the sheet first (`onBeforeNavigate`) |
| Watch from a try-on | opened the surface's modal while the sheet's modal was up | the sheet collapses through the existing keep-mounted minimize first; the pill brings it back ("Back to Try-On" when nothing is running) |
| Live | no decision affordance | "Looks good?" → Shop / Watch / Try another piece while a Live session is entered. No frame captured or persisted for it |

## Status flags

```
MODE_AUTHORITY_DUPLICATED=NO
LIVE_FRAME_CLOUD_EGRESS=NONE            (unchanged; the Live exit reads props only)
PHOTO_AI_DISCLOSURE_PRESENT=YES
FIRST_CLASS_VTO_PROVENANCE=NO           (saved as upload_inspiration)
RESULT_SCREEN_ADDED_NETWORK_CALLS=0
DATABASE_SCHEMA_CHANGED=NO  MIGRATION_CHANGED=NO  EDGE_FUNCTION_DEPLOYED=NO
STAGING_MUTATED=NO  PRODUCTION_MUTATED=NO  NEW_PROVIDER=NO  PAID_GENERATIONS_RUN=0
LIVE_DEVICE_PROOF=SOURCE_CONNECTED_RUNTIME_UNPROVEN      (VTO_RUNTIME_PROOF, unchanged)
PHOTO_PROVIDER_PROOF=SOURCE_CONNECTED_RUNTIME_UNPROVEN   (VTO_RUNTIME_PROOF, unchanged)
```

## Image memory

```
VTO_RESULT_CACHE_LIFETIME     in-memory data URI in the store snapshot; dropped on a new
                              attempt, a new product, a new/removed photo, the actor
                              boundary, or process end. Never written to disk except the
                              explicit Save export.
VTO_RESULT_CLEANUP_AUTHORITY  vtoRequestStore.ts (snapshot + person derivatives),
                              vtoMediaCache.ts (startup orphan sweep),
                              vtoResultExport.ts#discardVtoResultExport (the Save copy:
                              deleted when the save flow closes, and now also when the
                              result changes, disappears or the sheet unmounts, including
                              a result that changes while the file is being written).
```

Compare adds no copy: it switches between the in-memory result and the
existing sanitized person derivative.

## Navigation

The sheet is a modal over the surface that opened it, so Close and Try another
return to exactly that surface with its own state (Commerce shelf, filters,
recent options) intact — no new navigation or shelf store. Every shipped mount
is `commerce_product`; `VtoOrigin` also names `scan_result`, `dressing_room`
and `elise`, but no Watchlist, Elise or Dressing Room surface mounts Try It On
today, so there is no loop to return to there (see deferred).

## Deferred

| Tag | Item |
| --- | --- |
| `BACKEND_FOLLOWUP_REQUIRED` / `FIRST_CLASS_VTO_PROVENANCE_FOLLOWUP` | a dedicated try-on Dressing Room item kind (provenance, retention, sharing policy for person imagery) |
| `HAPTICS_FOLLOWUP_REQUIRED` | the shared Build 35 haptic authority is PR #427, still open. This lane keeps `services/haptics` (`selectionTick` / `successPulse` / `warningPulse`) and adds no haptic call site or dependency |
| `COMMERCE_V2_FOLLOWUP` | reflecting "Watching" in the result needs either a watch lookup (a network read the result screen must not add) or a confirmed-watch callback through `PurchaseOptionsPanel.tsx`, which is hash-bound by `tools/curiosity-gap-performance/authority/source-bindings.json`. Watch success is shown truthfully by the existing modal instead |
| `COMMERCE_V2_FOLLOWUP` | Watchlist → VTO, Elise → VTO, Dressing Room → VTO entry points do not exist; building them is a product decision, not polish |
| P4 | a product-image compare option: the catalog image is remote, and compare is deliberately local-only |
| P4 | `request_in_flight` cannot hand back the job that is still running (no status read exists); the customer must choose a photo again to start a new intent |
| `LIVE_DEVICE_PROOF_PENDING` / `PHOTO_RUNTIME_PROOF_PENDING` | unchanged; this lane proves source behaviour only |

Covered by `__tests__/vtoDecisionLoop.test.js` (`BLOCK-VTO-DL-00..22`, journeys
8/9/14/15, Retry-After end to end through the real transport and store).
