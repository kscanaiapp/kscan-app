# K SCAN AI — SCANNER PERFORMANCE MAP

**BENCHMARK STATUS: INTERNAL ENGINEERING ANALYSIS ONLY. SIMULATED TTFAR IS NOT A MEASUREMENT OF REAL-WORLD K SCAN SPEED.**

| | |
|---|---|
| SOURCE SHA | `909df8646a690b55c5af6b7b8c80193df64a2ec8` |
| BRANCH | `research/curiosity-gap-performance-v1` |
| SOURCE BINDING HASH | `3aaa80038736b843ca6b346cf82871b497144e13985ee456c95c6139c94cc768` |
| DATE | 2026-09-06 |
| LIVE TRAFFIC GENERATED | none. $0 spend, no provider call, no staging or production contact. |

---

## 0. The one-paragraph answer

The Scanner's first-actionable-result path is dominated by a single serial
term: one Gemini `:generateContent` call that is awaited to completion before
any commerce work begins. Everything K Scan itself controls — the four
sequential auth/quota round trips, image compression, base64 upload, ranking,
render — is a minority of the path. Commerce is **not** the bottleneck; under
the v127 funnel it is off the scan critical path by design, and the fast
fan-out is bounded at 1900 ms with an early exit, so **no provider, however
slow, can hold the first result hostage.** The structural surprise is on the
other side: with the funnel ON, the first actionable *commerce* result costs
**two full round trips**, and the entire four-round-trip auth prefix is paid
again on the second one.

---

## 1. The two architectures

`BACKEND_COMMERCE_FUNNEL_V127_ENABLED` does not tune the pipeline. It selects
between two structurally different ones, and they have different answers to
almost every question below.

| | Funnel OFF (source default, `commerceFunnelConfig.ts:32`) | Funnel ON (App Staging, audit doc:35) |
|---|---|---|
| Round trips to first actionable commerce result | **1** | **2** |
| Commerce position | inline, inside the scan response | deferred to a second `commerce_only` request |
| TTFAR vs completion | **coincide** — nothing is actionable until everything is | **separate** — identification paints first |
| Commerce budget | outer 3000 ms race over a 4500 ms fan-in plus unbounded serial enrichment | 1900 ms fast fan-out with early exit |
| Slowest provider gates the response the caller sees | bounded at 3000 ms by the outer race | bounded at 1900 ms by the deadline |

---

## 2. Stage-by-stage map (funnel ON — the App Staging configuration)

Legend: **S** serial · **P** parallel · **TTFAR** blocks first actionable result ·
**COMP** blocks completion · **OPT** optional · **C** client · **SV** server · **N** network

| # | Stage | Where | S/P | TTFAR | COMP | Timeout | Retry | Source |
|---|---|---|---|---|---|---|---|---|
| 1 | scan commit (`runAnalysis`) | C | S | ✔ | ✔ | — | — | `hooks/useKScan.js:390` |
| 2 | frame yield (rAF) | C | S | ✔ | ✔ | — | — | `hooks/useKScan.js:547` |
| 3 | digest source URI (SHA-256) | C | S | ✔ | ✔ | — | — | `hooks/useKScan.js:566` |
| 4 | **compress**: resize→896px, JPEG q0.65, base64 | C | S | ✔ | ✔ | — | — | `services/imageUtils.js:43-57` |
| 5 | privacy sanitize — **PROVEN NO-OP** | C | S | ✔ | ✔ | — | — | `services/privacyImageSanitizer.js:26` |
| 6 | digest compressed base64 (SHA-256 **again**) | C | S | ✔ | ✔ | — | — | `hooks/useKScan.js:587` |
| 7 | prepare evidence (sync) | C | S | ✔ | ✔ | — | — | `hooks/useKScan.js:620` |
| 8 | `auth.getSession()` | C | S | ✔ | ✔ | — | — | `services/scanIdentification.ts:488` |
| 9 | **upload** JSON-with-base64 | N | S | ✔ | ✔ | 20 s invoke / 32 s attempt | — | `services/scanIdentification.ts:553` |
| 10 | account gate (**2 serial round trips**, before body parse) | SV | S | ✔ | ✔ | — | — | `index.ts:1832` |
| 11 | `req.json()` — body drained here | SV | S | ✔ | ✔ | — | — | `index.ts:1872` |
| 12 | auth context (**2 more serial round trips**) | SV | S | ✔ | ✔ | — | — | `index.ts:1966`, `:1223`, `:1239` |
| 13 | rate-limit fingerprint (sha256) | SV | S | ✔ | ✔ | — | — | `index.ts:2498` |
| 14 | quota RPC (fails **closed**, increments) | SV | S | ✔ | ✔ | — | — | `index.ts:2534`, `scanQuota.ts:83` |
| 15 | **GEMINI `:generateContent`** | SV | S | ✔ | ✔ | **14 s** | **2 attempts**, 250 ms→2 s backoff | `index.ts:2656`, `:185`, `:2770` |
| 16 | sanitize garments (≤5, sync) | SV | S | ✔ | ✔ | — | — | `multiItemGarments.ts` |
| 17 | quality tune + quality gate (sync) | SV | S | ✔ | ✔ | — | — | `scannerQualityGate.ts:457` |
| 18 | serialize — **one buffered JSON** | SV | S | ✔ | ✔ | — | — | `index.ts:1091` |
| 19 | download | N | S | ✔ | ✔ | — | — | — |
| 20 | parse + map (sync) | C | S | ✔ | ✔ | — | — | `hooks/useKScan.js:659` |
| — | *floor* MIN_ANALYSIS_MS 600 ms (from commit) | C | P | ✔ | ✔ | — | — | `hooks/useKScan.js:31` |
| — | *floor* MIN_DISPLAY_MS **1500 ms** (from mount) | C | P | ✔ | ✔ | — | — | `AnalyzingScan.tsx:28` |
| 21 | **paint identification** | C | S | ✔ | ✔ | — | — | `hooks/useKScan.js:488-492` |
| 22 | MODE B dispatch (effect, after paint) | C | S | ✔ | ✔ | — | — | `hooks/useKScan.js:1115-1119` |
| 23 | upload MODE B (**no image** — image keys are rejected) | N | S | ✔ | ✔ | — | — | `index.ts` PROHIBITED_IMAGE_KEYS |
| 24 | account gate **again** | SV | S | ✔ | ✔ | — | — | `index.ts:1832` |
| 25 | auth context **again** | SV | S | ✔ | ✔ | — | — | `index.ts:1966` |
| 26 | commerce rate limit (40 / 10 min) | SV | S | ✔ | ✔ | — | — | `index.ts:2009`, `:204` |
| 27 | query build + weak-query gate (sync) | SV | S | ✔ | ✔ | — | — | `commerceRelevanceQueries.ts` |
| 28 | result-cache read (in-memory, per-isolate) | SV | S | ✔ | ✔ | TTL 10 min | — | `commerceResultCache.ts:124` |
| 29 | **FAST FAN-OUT**: Serper∥Poshmark | SV | **P** | ✔ | ✔ | **1900 ms** global **and** per child | none | `scanCommerceRouter.ts:1071-1119` |
| 30 | rank + dedupe — **whole-array, sync** | SV | S | ✔ | ✔ | — | — | `qualityTuneCommerce.ts:449` |
| 31 | serialize | SV | S | ✔ | ✔ | — | — | — |
| 32 | download | N | S | ✔ | ✔ | — | — | — |
| 33 | hydrate — drops entries lacking productUrl/title | C | S | ✔ | ✔ | — | — | `commerceHydration.ts:148-152` |
| 34 | **PAINT COMMERCE — FIRST ACTIONABLE RESULT** | C | S | ✔ | ✔ | — | — | `hooks/useKScan.js:1083` |
| 35 | enrichment dispatch | C | S | ✘ | ✔ | — | — | `hooks/useKScan.js:1101-1110` |
| 36 | enrichment fan-out: Farfetch3 ∥ KicksCrew | SV | **P** | ✘ | ✔ | 6000 ms global, **4000 ms per child hard-coded** | none | `scanCommerceRouter.ts:1295-1313` |
| 37 | paint enriched — **COMPLETION** | C | S | ✘ | ✔ | — | — | — |

---

## 3. Fan-out / fan-in authority

| Group | Children | Concurrency | Per-child timeout | Global timeout | Failure policy | Response gate | Slowest child gates COMPLETE? | Slowest child gates FIRST ACTIONABLE? |
|---|---|---|---|---|---|---|---|---|
| **A** v127 fast discovery | Serper (→Brave), Poshmark | concurrent | `min(remaining, 1900)` | 1900 ms | **fail-soft** — a throw is recorded as "returned nothing" | all-settled **OR** ≥3 usable **OR** deadline | **NO** — capped at 1900 ms | **NO** when the early exit fires (OBSERVED `early=true`); otherwise **YES but capped at 1900 ms** |
| **B** v127 deferred enrichment | ≤2 URL enrichments | concurrent | **4000 ms, hard-coded in the provider** — `providerDeadlineMs` is *not* applied | 6000 ms | fail-soft | deadline | YES, capped at 6000 ms | **NO** — entirely off the first-result path |
| **C** legacy discovery | Serper, Poshmark | concurrent | 4500 ms / 4000 ms | 4500 ms | fail-soft (`withDeadline` resolves a sentinel, never rejects) | **`Promise.all` waits for BOTH — no early exit** | **YES** | **YES** (they coincide) |
| **D** legacy URL enrichment | Farfetch then KicksCrew | **serial with each other**, concurrent within each | 4000 ms each | **NONE** | fail-soft | — | **YES — unbounded except by provider aborts** | YES |
| **E** legacy fallback query | a full second pass of C+D | serial after the first | — | **NONE** | — | — | YES | YES |

**Sub-group:** `shoppingProvider` is internally **serial** — Serper is awaited,
then Brave runs only if Serper returned zero (`shoppingProvider.ts:528,541`).
The "shopping" child can therefore cost up to 2× its per-call timeout.

**The invariant the funnel fixed, in its own words** (`commerceFunnelConfig.ts:60-67`):
Phase 3 paired a 4.5 s global deadline with a 4.5 s per-provider timeout, so one
slow provider could consume the entire window. v127 bounds every provider by
whichever is smaller. **Group B is the exception that was missed** — its
per-child timeout is a provider-local constant, not a budget-derived one.

---

## 4. Serial vs parallel

**PROVABLY SERIAL** (each awaits the previous; none is speculative):
account gate → body parse → auth context → fingerprint → quota → **Gemini** →
garment sanitize → quality gate → commerce → serialize. Plus, on the client:
frame yield → digest → compress → sanitize → digest again → getSession → upload.

**ALREADY PARALLEL**: Group A (Serper ∥ Poshmark), Group B (two enrichments),
Group C (`Promise.all` over both providers).

**APPEARS INDEPENDENT — CORRECTNESS VALIDATION REQUIRED** (never assume):

| Candidate | Shared state | Ordering dependency | Side effects | Failure coupling | Why parallelism *appears* safe |
|---|---|---|---|---|---|
| account gate ∥ auth context | both read auth state | account gate deliberately runs **before `req.json()`** so a deactivated account is rejected before its body is parsed — that ordering is a security property | none | quota fails **closed**; a race must not resolve as allow | neither consumes the other's output |
| similarity ∥ commerce (funnel OFF) | none found | `index.ts:3907` runs similarity **after** commerce | none | independent races | similarity takes the identification, not the commerce results |
| MODE B prefix elision | session state | — | — | — | **NOT safe** — this is a security boundary, not a redundancy. See EXP-2. |

---

## 5. Client render gate

| Question | Answer | Evidence |
|---|---|---|
| Does the client wait for the full body? | **YES** | `supabase.functions.invoke` buffers; `scanIdentification.ts:553` |
| Does it wait for the full result set? | **YES** | one `setAnalysis` commit, `useKScan.js:488-492` |
| Does it re-sort after receiving? | **NO** | `commerceHydration.ts:243-262` states backend order is preserved exactly; zero `.sort(` in the client result path |
| Does image load block actionability? | **NO** | the shipped purchase row renders no image at all |
| Do secondary fields block the card? | **NO** | every non-required field has a fallback or is omitted |
| Does the client wait for more than the actionable schema needs? | **YES** | it needs `productUrl` + `title`, but receives and awaits the entire ranked, deduped, diversity-capped array |

---

## 6. Progressive delivery feasibility

| Axis | Verdict | Evidence |
|---|---|---|
| **Transport** | **NO** | `index.ts:1091` returns one buffered `new Response(JSON.stringify(body))`. Zero non-test hits for `ReadableStream`, `text/event-stream`, `TransformStream`, `Transfer-Encoding`, `streamGenerateContent` across `scan-identify/` and `_shared/`. The Gemini call itself uses `:generateContent`, not `:streamGenerateContent`. |
| **Client** | **PARTIAL** | Partial-result *state* already exists (`commerceStatus`, `multiItemCommerce`, `useKScan.js:123-134`) and the client already patches a rendered shelf after the fact. What is missing is an incremental *transport*, not incremental state. |
| **Ranking** | **BLOCKING** | Ranking is whole-array and synchronous: global sort (`qualityTuneCommerce.ts:531`), one shared cross-provider dedupe set (`:498`), coverage bands and retailer-diversity caps computed over the entire selected set (`commerceRelevanceDiversity.ts:96-124`). |
| **UX risk** | **HIGH** | Because ranking is whole-array, an item emitted early can afterwards be outranked, deduped away or diversity-demoted — items moving under the user's finger. |

**PROGRESSIVE DELIVERY: ARCHITECTURE CHANGE REQUIRED.**

Worth stating plainly: K Scan **already ships the coarse-grained version of this
idea.** The v127 funnel exists precisely to take commerce off the scan critical
path — *"COMMERCE MAY LOAD AFTER THE SCAN. COMMERCE MUST NOT HOLD THE SCAN
HOSTAGE."* (`commerceFunnelConfig.ts:13-15`). What remains unbuilt is
progressive delivery *within* the commerce shelf, and EXP-3 finds that
uninteresting: its ceiling is the 1900 ms the fan-out is already bounded to,
while a 5–7 s serial term sits upstream.

---

## 7. Payload and network

**Transport format (PROVEN):** a JSON document with the JPEG base64-encoded
inside it. Not multipart, not a binary body, not a storage upload plus URL.

Base64 costs a fixed **+33.3%** over the compressed JPEG. The base64 alphabet
needs no JSON escaping, so the request body is exactly
`base64_bytes + envelope + 2`.

| Band | Compressed JPEG | On the wire | Uplink below which upload reaches 25% of the path |
|---|---|---|---|
| low | 36 127 B | 48 494 B | ~0.15 Mbps |
| mid | 90 317 B | 120 746 B | ~0.37 Mbps |
| high | 180 634 B | 241 170 B | ~0.74 Mbps |

**Conclusion (robust across the whole swept envelope): upload is not a dominant
TTFAR term.** At the mid payload on 5 Mbps / 100 ms RTT it is ~4.7% of the
first-result path. It would take a sub-1 Mbps uplink for upload to matter, and
even then the identification call still dominates.

> This partially diverges from the Build 34 audit's remark that *"transport and
> base64 upload account for most of the rest"* (audit doc:297). That remark was
> not decomposed per term. The divergence is flagged for a future device
> measurement rather than treated as a correction — this lane's upload figure is
> MODELED.

**A real payload hazard, PROVEN:** `manipulateAsync` is called with a
width-only resize, which sets the width *exactly*. A source narrower than 896 px
is therefore **upscaled**. Measured against the committed corpus: **5 of the 8
`assets/qa_fixtures` images upscale**, `dress.jpg` by **4.49×** in pixel count.
This costs encoded bytes and upload time for zero added detail. It bites the
**gallery/upload** entry path (small or screenshot sources), not the camera path.

---

## 8. Platform

**ZERO `Platform.OS` or `Platform.select` branches exist anywhere on the Scanner
client path.** iOS and Android run byte-identical JavaScript for capture,
resize, compression, encoding and request construction. Every platform
difference on this path lives inside the native implementations of
`expo-camera` and `expo-image-manipulator` — principally the JPEG encoder's
output size at quality 0.65, which is the one client term that propagates into
network time.

**PLATFORM EVIDENCE LEVEL: SOURCE-MAPPED. DEVICE-MEASURED: NO.**

---

## 9. Timeout and retry walls

| Wall | Value | Where | Note |
|---|---|---|---|
| Client attempt ceiling | 32 000 ms | `useKScan.js:36` | `Promise.race` at `:687`; **not applied to `analyzeSelectedCandidate`** |
| Client invoke timeout | 20 000 ms | `scanIdentification.ts:35` | the effective client ceiling |
| Legacy `analyzeImage` timeout | 45 000 ms | `services/api.js:17` | **dead path** — zero production callers |
| Gemini | 14 000 ms | `index.ts:185` | env-overridable, clamped `[2000, 20000]` |
| Gemini attempts | 2 | `llmModelRouting.ts:33` | **one AbortController covers the whole loop**, so a retry consumes the same 14 s rather than extending it |
| Gemini backoff | 250 ms base, 2000 ms cap | `llmModelRouting.ts:182-183` | exponential + 25% jitter |
| Fast commerce fan-out | 1900 ms | `commerceFunnelConfig.ts:45` | global **and** per child |
| Deferred enrichment | 6000 ms global, 4000 ms per child | `commerceFunnelConfig.ts:89`; provider files | per-child is **not** budget-derived |
| Legacy discovery | 4500 ms | `scanCommerceRouter.ts:222` | paired with 4500/4000 ms per-provider ceilings |
| Inline commerce race | 3000 ms image / 5000 ms text | `index.ts:188-189` | **shorter than the 4500 ms it wraps** |
| Similarity | 300 ms | `index.ts:187` | serial *after* commerce |
| Intelligence capture | 500 ms | `index.ts:186` | |

**Three client ceilings disagree** (20 s / 32 s / 45 s) and the innermost wins.
**The inline-commerce race (3000 ms) is shorter than the discovery budget it
wraps (4500 ms)**, so on the legacy path two of the three timeout layers can
never be reached by the caller — and the abandoned work is not cancelled.

---

## 10. Caching

Both caches are module-level `Map`s inside a Deno edge isolate. Neither is
persistent and neither is shared across instances, so hit rate is bounded by
isolate lifetime.

| Cache | Contents | TTL | Key | Bound |
|---|---|---|---|---|
| `commerceResultCache` | the final ranked shelf | 10 min | FNV-1a over category/subtype/brand/hypothesis/query/locale/currency/country | 200 entries, oldest-first eviction; empty shelves never cached |
| `shoppingProvider` CACHE | raw Serper/Brave results | 60 min | lowercased literal query | hard failures deliberately not cached |
