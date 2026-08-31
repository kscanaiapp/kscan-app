# VTO Phase 02 — Real Provider + Category Proof

Status: **provider access ACTIVE; full transport/lifecycle proven live end-to-end; one real (content-meaningless) generation completed; quality-meaningful Discovery blocked only on real test-person imagery.**
Branch: `feature/build34-vto-provider-benchmark-v1` off `feature/build34-vto-alpha-foundation-v1` @ `dae8b65`.

This document was written in two passes on the same day. The first pass
found the RapidAPI account not subscribed to AILabTools' listing and
concluded NO-GO / NOT YET. That finding went stale within the same session:
a re-check found the subscription active, and a full real submit → async
task → poll → complete → result round trip was then run live. **Read §3.**
The first pass's text is preserved below only where it's still accurate;
everything else was rewritten rather than patched, so this reads as one
coherent document, not a diff.

---

## 1. Provider evaluation

| Provider | Why considered | Verified capability | Access state | Verdict |
|---|---|---|---|---|
| **AILabTools "Try On Clothes Pro"** (via RapidAPI, host `try-on-clothes-pro.p.rapidapi.com`) | Already integrated speculatively (Foundation 01's rejected `tryon-clothes-pro`), and the account behind `RAPIDAPI_KEY` already has working, billed access to sibling APIs | Person + top_garment (required) + bottom_garment (optional) → async task → poll → result. **Fully verified live**, including a genuine 24s-ish real generation (§3). | **ACTIVE** — real task created, real result returned, real usage billed | **Selected. Working.** |
| FASHN v1.6 | Explicit auto-detection of tops/bottoms/one-pieces; also supports bottom-only garments (AILabTools genuinely cannot — §8) | $0.075/generation, 10–55s async, 864×1296 output | No account, no key | Not tested — would require new account creation |
| fal.ai (CatVTON / Kling Kolors v1.5 / FLUX Try-On Pro) | Multiple VTO models, one platform | CatVTON is research-only (no commercial clearance); Kolors v1.5 has commercial license | No account, no key | Not tested |
| Replicate `cuuupid/idm-vton` | "Very cheap" (~$0.025/run) | Community-reported pricing only | No account, no key | Not tested |
| Google Virtual Try-On (Vertex) | Per fal.ai's own comparison article | Pricing not published in sources checked | No account, no key | Not tested |
| **Gemini 3.1 Flash Image ("Nano Banana 2")** | `GEMINI_API_KEY` is *already live and billed* in this exact staging project (confirmed via real `gemini_success` log lines minutes before this check, model `gemini-3.5-flash-lite`), and Google's own docs describe a documented garment-compositing/virtual-try-on capability for the image-output model family | Not yet exercised for image OUTPUT — K Scan has only ever used this key for text/JSON-output calls. Model id and endpoint shape need independent confirmation before use (see §22) | Key **live for text calls**; image-generation capability **unconfirmed** | Investigated as a parallel already-authorized candidate; superseded once AILabTools proved live — see §22 |

No new account was created and no new credential was entered for any
candidate. AILabTools became viable through account/subscription state that
changed **during this session**, not through any account action taken by
this session.

Sources: [fal.ai — 10 Best Virtual Try-On APIs in 2026](https://fal.ai/learn/tools/best-virtual-try-on-apis-2026), [FASHN API](https://fashn.ai/products/api), [AILabTools — Try on Clothes Pro](https://www.ailabtools.com/docs/ai-portrait/editing/try-on-clothes-pro), [AILabTools RapidAPI listing](https://rapidapi.com/ailabapi-ailabapi-default/api/try-on-clothes-pro) (found via the RapidAPI marketplace search, not the AILabTools direct docs — see §3), [api.market listing](https://api.market/store/ailabtools/try-on-clothes-pro), [AILabTools Privacy Policy](https://www.ailabtools.com/privacy-policy).

## 2. Selected provider

**AILabTools "Try On Clothes Pro"**, via the RapidAPI marketplace listing,
using the `RAPIDAPI_KEY` secret already present in staging.

- **Real adapter state:** contract-complete, **live-verified**, one real bug
  found and fixed from live evidence (§3, §6) —
  `supabase/functions/vto-generate/providers/aiLabToolsProvider.ts`.
- **Credential/config state:** the secret authenticates and the account is
  subscribed. No new secret was created, requested, rotated, or modified.
- **Staging deployment state:** the adapter is registered in the provider
  registry and selectable via
  `app_config.vto_generation.provider = 'ailabtools_tryon_clothes_pro'`.
  `vto-generate` itself has **not** been deployed to staging this phase —
  every real-path proof so far went through a temporary diagnostic function,
  not the governed function, because no real test-person image exists yet to
  exercise the governed function meaningfully (§9, §16).

## 3. What actually happened, in order

**3.1 — First check (stale within the session).** An empirical probe against
the live endpoint returned `403 {"message":"You are not subscribed to this
API."}`. This was accurate at the time.

**3.2 — Re-check, per explicit instruction not to re-litigate RapidAPI
account health but to check this one listing specifically.** A request that
passed local body validation (non-empty `person_image`/`top_garment` string
fields) was sent to the existing `tryon-clothes-pro` function. It returned:

```
HTTP 400
{"error":"Bad request","detail":{"error_code":400,"error_code_str":"UNSUPPORTED_PARAMETER_VALUES",
"error_detail":{"status_code":400,"code":"UNSUPPORTED_PARAMETER_VALUES","code_message":"Invalid parameter values.",
"message":"Invalid parameter values. - person_image: Cannot be empty."},
"error_msg":"Invalid parameter values. - person_image: Cannot be empty."}}
```

This response shape (`error_code`, `error_code_str`, `error_detail`) is an
**AILabTools-origin** error, not a RapidAPI-gateway 403. The request had
passed the subscription gate. **The subscription is active.** It also
independently confirmed §older-finding: the old function sends
`person_image` as a URL-encoded string field, which AILabTools reads as
empty regardless of its content — proof, not just documentation, that only a
real `multipart/form-data` file upload (what `aiLabToolsProvider.ts` does)
can work.

**3.3 — Full multipart submit, via a temporary diagnostic mirroring the real
adapter, with synthetic non-personal test images (~700–1500 bytes each,
below the vendor's 5KB floor — this mattered, see 3.4).**

```
HTTP 200
{"error_code":0,"task_id":"1788109088348.1e968d25-86f6-cef9-9010-69b485b12ecd","task_type":"async", ...}
```

A real async task was created. **Polling then 404'd on every attempt** —
`{"message":"Endpoint '/common/query-async-task-result' does not exist"}` —
against the path AILabTools' own direct-API documentation specifies. Ten
plausible path guesses were also tried; all 404'd identically at the
RapidAPI gateway level (not from AILabTools), meaning none were registered
endpoints on this listing at all.

**3.4 — Finding the real polling path.** WebFetch could not render RapidAPI's
JS-heavy listing pages (returned empty/hallucinated content — see the
sidebar on this in §22). The actual browser tool was used instead: searched
`rapidapi.com` for "try-on-clothes-pro", opened the real listing
(publisher `AILabAPI`, not the guessed slug from earlier attempts), and read
its **second documented endpoint** directly from the rendered playground UI:

```
GET https://try-on-clothes-pro.p.rapidapi.com/api/rapidapi/query-async-task-result?task_id=...
```

This is **this RapidAPI listing's own path**, unrelated to AILabTools'
direct-API path (`/common/query-async-task-result`). Polling the existing
real task_id at the correct path returned instantly:

```
HTTP 413
{"error_code":413,"error_code_str":"FILE_SIZE_EXCEEDS_LIMIT",
"error_detail":{"message":"...the size of image ranges from 5kb to 5mb"}}
```

A real, terminal, correctly-shaped AILabTools processing error — the
synthetic test images were simply too small. **Full plumbing proven: submit,
real async task, correct poll path, real terminal error, all live.**

**3.5 — A real bug this exposed, fixed live.** The adapter's poll loop had
`if (!pollResponse.ok) continue;` **before** checking the body's
`error_code` — so a real terminal error like the 413 above (HTTP-level
non-2xx, but a fully legitimate, parseable AILabTools error) would have been
treated as transient and retried for the entire poll budget (~36s), then
reported as `provider_timeout` instead of `provider_rejected_input`. Fixed:
a non-2xx poll response is now terminal whenever it carries a parseable
`error_code`, and only genuinely bodyless/unparseable non-2xx responses are
treated as transient. Regression-tested with the exact response above,
pinned verbatim as a "LIVE-VERIFIED 2026-08-30" test case.

**3.6 — One full real generation (synthetic input, not quality-meaningful).**
With correctly-sized (400×600 / 300×300, ~270–720KB) but still **synthetic,
non-personal** (random-noise) test images, a full cycle completed:

```
submit  -> 200, real task_id                              (3.5s)
poll ×3 -> task_status 1, 1, then 2 (complete)             (~9s total)
result  -> real output.image_url on AILabTools' CDN
        -> usage.image_count: 1  (a REAL BILLED generation)
```

The result image was downloaded and inspected: **it is visually
indistinguishable from random noise** — the model received noise and, since
it detected no person or garment structure, returned a noise-shaped output.
This is the expected, honest outcome of feeding synthetic non-personal input
to a person-detection-dependent model. **It is not evidence of VTO quality
in any direction** — not a pass, not a fail, not "the model doesn't work."
It is exactly, and only, proof that the entire pipeline — auth, submission,
async processing, polling, completion, result retrieval — works for real,
live, right now.

The image was inspected locally and then deleted; it was never committed to
git, never uploaded anywhere beyond the one download for inspection (§16).

**3.7 — Cleanup.** The temporary diagnostic function (`vto-provider-diag`)
was redeployed one final time as an inert 410 stub after all of the above.
**The owner should remove this function slug from staging** — this MCP
surface has no `delete_edge_function` tool, so a stub is the safest
available neutralization; it has made zero outbound calls since.

## 4. What was NOT attempted, and why

- **No new provider account was created** (FASHN, fal.ai, Replicate,
  Google) — none were needed once AILabTools proved live.
- **No RapidAPI subscription action was taken by this session** — the
  subscription was found active on re-check; whether and when it was
  activated (by the user, by a delay in propagation, or otherwise) is not
  something this session can determine and does not need to.
- **No real human research/test photo was used, anywhere, at any point in
  this phase** — every live call used synthetic, non-personal, randomly
  generated placeholder images. This is the one deliberate limit that
  remains in place; see §9 and §21.

## 5. Real end-to-end proof: **TRANSPORT COMPLETE; CONTENT NOT MEANINGFUL**

The target chain —

```
Product → Try It On → person input → sanitation → staging Auth/Flag/K+
  → real provider → result validation → result UI
```

| Stage | Status | Evidence |
|---|---|---|
| Sanitation, Auth, Flag, K+ | Proven in Foundation 01 (unchanged) | `vtoHandler.test.ts`, `vtoGuards.test.ts` |
| Provider transport (host/path/headers/multipart) | **Proven live** | §3.3 — real task_id from a real multipart submit |
| Provider async task + polling contract | **Proven live**, path corrected from live evidence | §3.4 — real poll → real terminal response |
| A real generation completing end to end | **Proven live** | §3.6 — real `task_status:2`, real billed `usage.image_count:1` |
| Result validation against a REAL provider response | Exercised against the adapter's own decode/validate path with real response shapes (via tests pinned from live data); **not yet exercised inside the deployed `vto-generate` function itself** | §3.6, `aiLabToolsProvider.test.ts` |
| Result UI with real output | **Not exercised** — no real person/garment pair exists to review meaningfully | §9 |

**What's actually left is narrow:** route a real person + real garment
image through the *governed* `vto-generate` function (not a diagnostic) and
look at the result. The transport risk that made this uncertain is gone.

## 6. Benchmark scope

**Zero quality-bearing generations.** One real, live, fully-completed
generation exists (§3.6), and it is explicitly excluded from benchmark
scope because its input was synthetic noise, not a person or a garment.
Discovery (Pass A) and Certification (Pass B) both require real person
imagery to review, which this session does not have and will not source
without the owner's decision (§9, §21).

**This section is intentionally short. Fabricating benchmark rows would be
worse than reporting none.**

## 7. Quality evidence

**None available.** No identity preservation, garment fidelity, body
integrity, decision-usefulness, or repeatability data exists, because no
real person has ever been an input to this pipeline.

## 8. Category verdicts

All categories: **NOT YET** — real generation is now proven possible, but no
category has real output to review.

Two category-shaped findings remain from the documented contract (unchanged
from the first pass of this document, both still believed correct, neither
yet exercised with real people/garments):

- **`dress` / `full_body`: SUPPORTED.** A one-piece garment is submitted
  through `top_garment` with `bottom_garment` omitted — documented verbatim,
  identically, across two independent AILabTools doc pages. Not yet
  exercised with a real dress image.
- **`bottom`: genuinely unsupported.** `top_garment` is REQUIRED; there is
  no documented way to submit a bottom-only garment. Today's default
  `supportedCategories` does not include pants/skirt, so this has no
  practical effect yet.

## 9. Input contract

| Requirement | Source | Confidence |
|---|---|---|
| `person_image`: full-body front view, hands visible, JPG/JPEG/PNG/BMP, 150×150–4096×4096px, ≤5MB | Vendor docs | **PROVEN** (documented, and the 5KB **floor** additionally confirmed live — §3.3/3.4) |
| `top_garment`: flat-lay, single item, simple background, minimal pattern; **required** | Vendor docs | **PROVEN** (documented) |
| `bottom_garment`: same shape, optional, cannot be sent alone | Vendor docs | **PROVEN** (documented) |
| Async task, poll `task_status` 0/1/2, result at `output.image_url` | **PROVEN LIVE** — real values observed: 1 (processing) → 2 (complete) | §3.6 |
| Real poll path is `/api/rapidapi/query-async-task-result`, NOT AILabTools' own `/common/...` path | **PROVEN LIVE** | §3.4 |
| Whether framing/lighting/background variations in practice change output quality | — | **UNKNOWN** — needs a real person photo |
| Whether the model performs face/person detection and rejects non-person input, vs. silently processing anything | Partially observed: noise input was NOT rejected outright, it was processed into noise-shaped output | **LIKELY it does not hard-reject** absent a real face — genuinely needs a real photo to confirm normal behavior |
| Whether `restore_face`/`resolution` params meaningfully change output | Vendor docs list them; behavior unverified | **UNKNOWN** |

## 10. Latency

Real, live samples now exist, though still only n=1 per stage (not enough
for percentiles — reported as single data points, not statistics):

- Subscription-gate 403 round trip (stale finding): 279ms.
- Real submit (undersized images): not separately timed.
- Real submit (correctly-sized images): **3,531ms**.
- Real poll-to-completion (correctly-sized images): **3 polls, ~9,087ms total**
  (task_status 1, 1, then 2).
- **End-to-end submit→complete: roughly 12–13 seconds**, one sample.

This is one real trace, not a latency profile. It is enough to know the
orchestrator's 45-second generation ceiling and the mobile client's 55-second
invoke ceiling (Foundation 01) both have real headroom against this
provider's actual behavior — it is not enough to promise anything about the
distribution's tail.

## 11. Cost

- Undersized-image attempt (§3.3/3.4): **not billed** — AILabTools' pricing
  page states failed requests aren't billed, consistent with a
  `FILE_SIZE_EXCEEDS_LIMIT` processing rejection.
- Correctly-sized synthetic-noise attempt (§3.6): **billed** —
  `usage.image_count: 1` in the real response. Documented rate: **30 credits
  ≈ $0.0081/successful request**. Total real spend this phase: **one
  generation's worth, on the order of one cent.**

No cost ceiling is proposed. This is one real sample; a meaningful
per-generation and per-category cost model needs the actual Discovery pass.

## 12. Privacy questionnaire — AILabTools

Unchanged from the first pass of this document; answered from AILabTools'
published privacy policy (https://www.ailabtools.com/privacy-policy).

| # | Question | Answer |
|---|---|---|
| 1 | Retains person images? | User Content auto-deleted within **24 hours** |
| 2 | If yes, how long? | 24 hours |
| 3 | Retains generated outputs? | Generated Content auto-deleted within **24 hours** |
| 4 | Inputs used for training? | **No**, absent explicit separate consent |
| 5 | Outputs used for training? | **No**, same clause |
| 6 | Training/data use optional or configurable? | Consent-based opt-in only |
| 7 | Subprocessors involved? | **Yes** — payment processing, analytics, cloud infrastructure, security services (unnamed) |
| 8 | Processing/storage regions? | **UNKNOWN** |
| 9 | Can processed media be deleted? | Automatic within 24h; account-level deletion also available |
| 10 | DPA available? | **UNKNOWN** |
| 11 | Commercial usage rights on outputs? | **UNKNOWN** |
| 12 | Restrictions on displaying results in a commercial product? | **UNKNOWN** — needs the vendor's ToS, not yet reviewed |

**This is not zero-knowledge.** A recognizable photo of the user reaches
AILabTools' infrastructure and is held there for up to 24 hours. The one
real generation this phase produced was itself stored, briefly, on
AILabTools' CDN (`ailab-outputs.oss-accelerate.aliyuncs.com`) before this
session downloaded and then deleted the local copy — direct, live
confirmation of exactly this retention path, not just policy text.

## 13. K Scan privacy path (real, not hypothetical, as of this phase)

```
user's photo (photo library, explicit selection)
        ↓
prepareImageForPrivacyUpload  -- re-encodes, strips EXIF (the ONLY sanitation claim)
        ↓
vto-generate (staging, authenticated)  -- validates JWT, account, flag, K+, eligibility
        ↓
aiLabToolsProvider.ts  -- fetches the garment image server-side, builds multipart form
        ↓
AILabTools (via RapidAPI)  -- receives person image + garment image; NO K Scan identity
        ↓
poll (correct path, proven live) → image_url (their CDN, ~24h TTL)
        ↓
vto-generate fetches that URL server-side, re-encodes as a data URI
        ↓
validateVtoResultMedia  -- structural check only
        ↓
returned inline to the client; NOTHING written to K Scan storage at any step
```

Every arrow above except the first two has now been exercised for real
(§3.6). What leaves the device: the sanitized, metadata-stripped photo, as
base64, over TLS. What K Scan's server sees: that image, in memory, for one
request. What the provider sees: that image plus the garment image, no K
Scan identity. What is retained: nothing by K Scan; up to 24h by AILabTools.

## 14. Background / lifecycle

Still not exercised against real backgrounding behavior — the one real
generation completed in ~12s while the diagnostic ran to completion
synchronously. Foundation 01's stale-result rule (monotonic token + actor
epoch) is unchanged and untouched by this phase; nothing observed this phase
suggests it needs to be.

## 15. Failures (real, observed)

Three real failure/completion modes were observed live this phase:

1. `403` — RapidAPI subscription gate (stale; no longer reproducible as of
   §3.2) → `provider_unavailable`.
2. `400 UNSUPPORTED_PARAMETER_VALUES` (via the old, unrelated
   `tryon-clothes-pro` function, not the new adapter) — confirms the
   multipart-vs-urlencoded finding; not itself exercised through the new
   adapter's own failure mapping.
3. `413 FILE_SIZE_EXCEEDS_LIMIT`, discovered at **poll time** — real,
   terminal, correctly mapped to `provider_rejected_input` after the §3.5
   fix; regression-tested verbatim.
4. `task_status: 2` with a real `output.image_url` — the success path,
   proven live end to end.

Every other failure path in the adapter (`429`, `5xx`, moderation-flagged
`error_msg`, a missing `task_id`, an oversized/malformed result) remains
built from documented shapes and unit-tested, **not yet observed live**.

## 16. Research artifact handling

- All live-call inputs across this phase were **synthetic, non-personal,
  deterministically generated placeholder images** (solid-color or
  random-noise PNGs, generated by local Node scripts). No real photo of any
  person was created, sourced, or used at any point.
- The one real generated output image (§3.6) was downloaded once to local
  session scratch, visually inspected (confirmed noise-in/noise-out, no
  quality-relevant content), and then **deleted**. It was never committed to
  git, never uploaded anywhere beyond the one download, and no longer exists
  locally.
- AILabTools' own CDN copy of that image is subject to their documented
  ~24h auto-deletion (§12) and was not otherwise interacted with.
- **Confirmed:** no customer data of any kind was touched at any point in
  this phase. No substantive benchmark imagery was committed to git history
  (there is none to commit).

## 17. Tests / validation

| Command | Result |
|---|---|
| `deno test --allow-read --allow-env supabase/functions/vto-generate/providers/aiLabToolsProvider.test.ts` | **28 passed / 0 failed** (up from 25 — added the live-verified round-trip regression test and the terminal-vs-transient poll-error test) |
| `deno test --allow-read --allow-env --allow-run=deno supabase/functions/vto-generate/` (whole directory) | **94 passed / 0 failed** (up from 91) |
| `node scripts/run-backend-tests.js` | **496 passed / 0 failed** (38 backend test files) |
| `node scripts/run-all-tests.js` | **21 known baseline failures, 0 unexpected** (unchanged from Foundation 01) |
| `npx tsc --noEmit` | 1 pre-existing unrelated error (`closetMediaPrivacy.ts:154`, confirmed pre-existing on the base branch) |
| `node scripts/check-edge-function-parity.js` | PASS |
| Live calls against `try-on-clothes-pro.p.rapidapi.com` | 1 subscription-check (400, real AILabTools error, $0), 1 undersized submit+poll (200 submit, 413 at poll, $0), 1 full real generation (200/200/200, ~$0.008) |

## 18. Code changes (this pass, in addition to the first pass's adapter)

- `aiLabToolsProvider.ts`: poll path corrected from
  `/common/query-async-task-result` (AILabTools' direct-API path, never
  reachable via this RapidAPI listing) to `/api/rapidapi/query-async-task-result`
  (this listing's own path, found via its playground UI). Poll-loop bug
  fixed: a non-2xx response with a parseable `error_code` is now terminal
  immediately, instead of being retried as transient until
  `provider_timeout`.
- `aiLabToolsProvider.test.ts`: two new tests — a live-verified regression
  pinning the exact real submit/poll/413 transcript from §3.4–3.5, and a
  test confirming a genuinely bodyless non-2xx poll response is still
  treated as transient (so the fix didn't overcorrect).
- Staging: one temporary diagnostic function iterated through several
  versions during path discovery, ending neutralized (§3.7).

## 19. Adjacent repairs

The poll-loop terminal-vs-transient bug (§3.5, §18) — found only because a
real live response exposed it; no mocked test had covered a non-2xx poll
response carrying a real error body. Fixed in the same file the rest of this
phase touches; not a repair to Foundation 01.

## 20. Remaining work

**BLOCKER — none for transport.** The subscription/account blocker from the
first pass of this document is resolved.

**NEXT (the actual remaining gap):**
- **A real, rights-cleared research person photo.** This is now the *only*
  thing standing between this branch and quality-meaningful Discovery
  evidence. It is a content/consent decision, not a technical or billing
  one, and this session will not source one unilaterally (no browsing
  arbitrary photos of real people, no using a stock photo of an identifiable
  person without clear rights for AI processing). The owner should either
  supply approved internal/consented photos, point to a licensed test-image
  set, or explicitly authorize a specific sourcing approach.
- Once real photos exist: run the actual "one real generation" milestone
  *through the governed `vto-generate` function* (this phase's real
  generations all went through temporary diagnostics, deliberately, to keep
  the governed function's first real invocation meaningful rather than
  wasted on synthetic-noise plumbing tests).
- Then Discovery: a handful of real person/garment pairs across `top`,
  `outerwear`, `blazer`, `dress`, reviewed against the quality rubric.
- Real per-category latency and cost from actual generations, not the n=1
  samples here.

**LATER**
- Face-masking research.
- Concurrency/backgrounding observation against a real provider.
- Comparison-UI depth.
- Gemini image-generation as a second real adapter (§22) — parked, not
  needed now that AILabTools works, but the live-proven `GEMINI_API_KEY`
  liveness and the model/endpoint research already done means this is cheap
  to pick back up later if AILabTools' quality proves weak in Discovery.

## 21. Final program verdict

# WAITING FOR PROVIDER ACCESS → **ACCESS ACTION REQUIRED FOR QUALITY EVIDENCE, NOT FOR TRANSPORT**

More precisely: **transport, entitlement, and the full technical pipeline are
proven and working.** This is not a NO-GO — nothing about the real evidence
gathered this phase suggests a technical or product problem with AILabTools
or with VTO. The single remaining gap is a real research-consent person
photo, which is a content decision for the owner, not an engineering one.

**Exact next action for the owner:**
1. Supply or approve a small set (2–4) of rights-cleared, non-customer
   research person photos — internal team members with consent, a licensed
   test-image set, or an explicitly authorized sourcing method.
2. Once supplied, the next session should run those through the governed
   `vto-generate` path end to end and proceed directly into Discovery
   (§8's category matrix) — no further architecture or provider work is
   needed first.

## 22. Note on tool reliability during this phase

Two independent research failure modes surfaced and are worth recording so
a future session doesn't repeat them:

1. **WebFetch hallucination risk on JS-rendered pages.** Multiple WebFetch
   calls against `ai.google.dev`'s image-generation docs returned a
   confident-sounding but almost certainly fabricated REST contract
   (`POST .../v1beta/interactions`, `response_format`, `interaction.output_image`)
   that does not match the real, decade-stable Gemini API convention this
   codebase already proves correct in `scan-identify`/`stylechat-generate`
   (`generationConfig`, `inline_data`, `candidates[].content.parts[]`).
   The model ID it returned (`gemini-3.1-flash-image`) was independently
   corroborated by two other fetches and is likely correct; the endpoint
   shape was not corroborated anywhere and was not trusted or used.
2. **WebFetch cannot render RapidAPI's listing pages at all** — every
   attempt returned empty or a "Page Not Found" for a guessed URL slug.
   The actual browser tool (`navigate` + `get_page_text` + `find` +
   `read_page`), not WebFetch, is what found the real listing and its real
   second endpoint (§3.4). **For any future RapidAPI-listing contract
   question, go straight to the browser tool; do not spend cycles on
   WebFetch against `rapidapi.com` first.**

Neither issue affected anything committed to the adapter: the Gemini
endpoint guess was never used, and the RapidAPI poll path was corrected from
the real, browser-verified source before being written into the adapter.
