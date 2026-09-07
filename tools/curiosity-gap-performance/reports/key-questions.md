# KEY QUESTIONS Q1–Q16 — Curiosity Gap Performance Lab V1

**BENCHMARK STATUS: INTERNAL ENGINEERING ANALYSIS ONLY. SIMULATED TTFAR IS NOT A MEASUREMENT OF REAL-WORLD K SCAN SPEED.**

Source SHA `909df8646a690b55c5af6b7b8c80193df64a2ec8` · binding hash `3aaa8003…c94cc768`

---

**Q1 — What exact source event starts TTFAR?**
`runAnalysis` at `hooks/useKScan.js:390`, invoked by the "Analyze Scan" press
(`components/scan-room/CaptureReview.tsx:141` → `app.js:1002-1011`). **PROVEN.**
Deliberately *not* the shutter (`capturePhoto`, `useKScan.js:236`), which only
calls `takePictureAsync` and returns a URI — the user may still retake, and
folding that pause into TTFAR would make the metric meaningless. Compression,
digesting and upload all happen inside `runAnalysis` and are therefore on the
critical path.

**Q2 — What exact fields make a result actionable?**
Exactly two: **`productUrl`** and **`title`**. Presence is enforced at
`services/commerceHydration.ts:151` (`if (!productUrl || !title) continue;`);
actionability additionally requires the URL to survive `isSafeCommerceUrl`
(https, no credentials, non-private host — `services/commerceDestination.ts:56-69`),
applied at `PurchaseOptionsPanel.tsx:89`. **PROVEN.** Not required: retailer, id,
price, currency, availability, brand — and **not `imageUrl`**, because the shipped
purchase row renders no product image at all.

**Q3 — What is the first-result critical path?**
scan commit → frame yield → digest → **compress (896 px, q0.65, base64)** →
passthrough sanitize → digest again → `getSession` → **upload** → account gate
→ body parse → auth context → fingerprint → quota → **GEMINI** → garment
sanitize → quality gate → serialize → download → parse → paint identification →
**MODE B dispatch** → upload → account gate *again* → auth context *again* →
rate limit → query build → cache check → **fast fan-out (≤1900 ms)** → rank →
serialize → download → hydrate → **paint commerce**. Under funnel OFF the same
path runs but commerce is inline and the two paths coincide.

**Q4 — What is the full-completion critical path?**
Funnel ON: everything in Q3 plus the deferred enrichment hop (dispatch → upload
→ Farfetch3 ∥ KicksCrew bounded at 6000 ms → serialize → download → paint).
Funnel OFF: **identical to Q3** — the terminals coincide, which is itself the
most important structural difference between the two architectures.

**Q5 — Which operations are provably serial?**
Server: account gate → body parse → auth context → fingerprint → quota →
Gemini → garment sanitize → quality gate → commerce → similarity → serialize.
Client: frame yield → digest → compress → sanitize → digest → `getSession` →
upload. Also `shoppingProvider` internally (Serper awaited, then Brave only if
Serper returned zero) and legacy enrichment Groups D and E. **PROVEN — every
one is a plain `await` on the previous result.**

**Q6 — Which appear safely independent but need correctness validation?**
(a) The account gate and the auth context — both read auth state, neither
consumes the other's output, **but** the account gate deliberately runs before
`req.json()` as a security property, and the quota RPC *increments* so it must
stay after every rejecting gate. (b) Similarity and commerce on the funnel-OFF
path — similarity consumes the identification, not the commerce results. Both
are modelled in EXP-2; **neither is proven safe by this lane.** A faster model
output is not a correctness proof.

**Q7 — Does the slowest retailer/provider gate TTFAR?**
**NO — and it structurally cannot.** Under the fast path's early exit
(`FAST_COMMERCE_SUFFICIENT_RESULTS = 3`, OBSERVED firing as `early=true` on live
successful requests), a provider taking 13.9 s changes TTFAR by **zero**. With
the early exit removed it does gate — but only up to
`FAST_COMMERCE_DEADLINE_MS = 1900`, then the deadline cuts it. Fail-soft
throughout: a provider that throws is recorded as one that returned nothing.

**Q8 — Does the slowest retailer/provider gate the complete response?**
**Funnel ON: bounded** — enrichment is capped at 6000 ms and sits entirely off
the first-result path. **Funnel OFF: yes, and badly** — `Promise.all` waits for
both providers with no early exit (4500 ms), then two **serial, deadline-less**
enrichment hops, then optionally a full recursive second pass. The caller is
shielded by a 3000 ms outer race that **abandons but does not cancel** the work,
so the isolate keeps running after the response is sent.

**Q9 — What timeout/retry walls exist?**
Client 20 s invoke / 32 s attempt (and a dead 45 s path); Gemini 14 s with
2 attempts and 250 ms→2 s exponential backoff under **one shared
AbortController**, so a retry consumes the same budget rather than extending it;
fast fan-out 1900 ms global *and* per child; enrichment 6000 ms global with
**hard-coded 4000 ms** per child; legacy discovery 4500 ms; inline commerce race
3000 ms (image) / 5000 ms (text); similarity 300 ms; intelligence 500 ms. Two
inconsistencies: the three client ceilings disagree, and the 3000 ms inline race
is **shorter than the 4500 ms budget it wraps**.

**Q10 — What image payload bytes does each platform profile generate?**
Both platforms produce the **same** bytes for the same source, because there is
**not one `Platform.OS` branch** on the Scanner client path. Post-resize geometry
is PROVEN at 896 px wide. Modelled request bodies: **48 494 B / 120 746 B /
241 170 B** (low/mid/high bpp bands), of which base64 adds a PROVEN fixed
**+33.3%**. Real post-compression bytes are `PENDING_RUNTIME` (B-03).

**Q11 — Under modelled network conditions, when does upload become a major TTFAR term?**
**Only below roughly 0.15–0.74 Mbps uplink**, depending on payload band, for
upload to reach even 25% of the path. At the mid payload on 5 Mbps / 100 ms RTT
it is ~4.7%. **Robust conclusion across the whole swept envelope: upload is not
where the TTFAR budget goes.** RTT matters more than bandwidth under funnel ON,
because it is paid across two round trips rather than one.

**Q12 — Does transport currently permit progressive results?**
**NO.** `index.ts:1091` returns one buffered `new Response(JSON.stringify(body))`;
zero non-test hits for `ReadableStream`, `text/event-stream`, `TransformStream`,
`Transfer-Encoding` or `streamGenerateContent` across `scan-identify/` and
`_shared/`; the Gemini call uses `:generateContent`. The client mirrors it —
`supabase.functions.invoke` buffers and the result commits in one `setState`.
**PROGRESSIVE DELIVERY: ARCHITECTURE CHANGE REQUIRED.**

**Q13 — Does ranking require full retrieval?**
**YES.** `filterAndDedupeProducts` (`qualityTuneCommerce.ts:449`) is synchronous
and whole-array: a global sort at `:531`, one shared cross-provider dedupe set at
`:498`, and coverage bands plus retailer-diversity caps computed over the entire
selected set (`commerceRelevanceDiversity.ts:96-124`). **The nuance that matters:**
the ranker requires the set *as delivered*, and `collectBounded` is allowed to
define "delivered" as a deliberately truncated fan-out — recorded as
`salvagedFromPartial`.

**Q14 — Would progressive delivery create reordering/UX risk?**
**YES, high.** Precisely because ranking is whole-array, an item emitted early
can subsequently be outranked, deduped away or diversity-demoted. That is
results moving under the user's finger and weaker products briefly appearing
first. `REQUIRES_UX_DECISION: YES`, `REQUIRES_QUALITY_VALIDATION: YES`.

**Q15 — Does the client wait for more information than the actionable schema requires?**
**YES.** It needs two fields but awaits the entire ranked, deduped,
diversity-capped array in one buffered body before rendering anything. It does
**not** re-sort (`commerceHydration.ts:243-262` preserves backend order
deliberately), image load does **not** block actionability, and secondary fields
do **not** block the card — so the over-waiting is entirely a transport property,
not a rendering one.

**Q16 — What top three performance candidates deserve later production evaluation?**
1. **OPP-01 — the identification call** (~72% modelled / ~74% measured of the
   path). Dominant, and the only change that can move TTFAR materially.
   `REQUIRES_QUALITY_VALIDATION`; needs a real visual corpus first.
2. **OPP-02 — the four serial auth/quota round trips**, paid twice under the
   funnel. Modelled 83–440 ms, fully owned by K Scan, `PERFORMANCE_PROMISING`
   for Arm A only. Arm B is a security trade and is not recommended.
3. **OPP-03 — the legacy inline commerce tail**: no early exit, two deadline-less
   serial enrichment hops, and an outer race shorter than the budget it wraps.
   The v127 config file already states the invariant that fixes it; Groups D and
   E simply never received it. `PERFORMANCE_PROMISING`, LOW complexity.
