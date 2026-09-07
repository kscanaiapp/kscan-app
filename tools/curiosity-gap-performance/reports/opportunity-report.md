# OPPORTUNITY REPORT — Curiosity Gap Performance Lab V1

**BENCHMARK STATUS: INTERNAL ENGINEERING ANALYSIS ONLY. SIMULATED TTFAR IS NOT A MEASUREMENT OF REAL-WORLD K SCAN SPEED.**

Source SHA `909df8646a690b55c5af6b7b8c80193df64a2ec8`.
No classification below is `PRODUCTION_READY` — that verdict is not this lane's to give (§34).

---

## P1 — OPP-01 · The identification call is the path

| | |
|---|---|
| **FINDING** | One Gemini `:generateContent` call is awaited to completion before any commerce work begins. It is ~72% of the modelled first-result path and was independently measured at ~74% of wall time. Nothing else on the path is close. |
| **EVIDENCE CLASS** | Structure **PROVEN**; magnitude **OBSERVED** |
| **SOURCE** | `index.ts:2656`, `:185` (14 s), `:2770`; `docs/BUILD34_SCANNER_SCAN_RESULTS_DEEP_AUDIT.md:288` (4909–7256 ms across 8 live scans) |
| **TTFAR IMPACT** | **DOMINANT.** No other single change can move TTFAR comparably. |
| **COMPLETION IMPACT** | Same term, same dominance. |
| **NETWORK IMPACT** | None. |
| **PLATFORM IMPACT** | None — server-side. |
| **QUALITY VALIDATION REQUIRED** | **YES, and it is the whole difficulty.** Every available lever (model, prompt size, output schema) trades accuracy for speed. |
| **UX DECISION REQUIRED** | No |
| **CORRECTNESS VALIDATION REQUIRED** | No |
| **COMPLEXITY** | HIGH · **RISK** HIGH · **PRIORITY P1** |
| **CLASSIFICATION** | `REQUIRES_QUALITY_VALIDATION` |
| **NOTE** | This is the same conclusion the Build 34 audit reached as SCAN-002 and deliberately left open. This lane independently confirms it from a different method and does **not** propose a repair: the prerequisite is a real visual corpus, which is a quality-lane asset. The most-cited candidate remains reducing detection output tokens — `visual_observation` is 200 chars × up to 5 garments. |

---

## P2 — OPP-02 · Four serial auth/quota round trips, paid twice

| | |
|---|---|
| **FINDING** | Before any useful work: `requireUser` → `assertAccountActive` → `hasValidProjectAccess` → `auth.getUser` → quota RPC, all strictly serial. Under the v127 funnel the entire prefix runs **again** on the MODE B commerce request. |
| **EVIDENCE CLASS** | **PROVEN** (structure); MODELED (magnitude) |
| **SOURCE** | `index.ts:1832`, `:1966`, `:1223`, `:1239`, `:2534`, `:2004` |
| **TTFAR IMPACT** | Modelled 83–440 ms depending on band (EXP-2 Arm A). Small against 6–14 s — but one of the very few terms K Scan fully owns. |
| **COMPLETION IMPACT** | Same absolute saving. |
| **NETWORK IMPACT** | Removes network round trips from a serial chain, so the saving *grows* on poor networks. |
| **PLATFORM IMPACT** | None. |
| **QUALITY VALIDATION REQUIRED** | No — no query, ranking or provider behaviour changes. |
| **UX DECISION REQUIRED** | No |
| **CORRECTNESS VALIDATION REQUIRED** | **YES.** The account gate deliberately runs *before* `req.json()` so a deactivated account is rejected before its body is parsed — a security property that must survive. The quota RPC **increments**, so it must stay strictly after every gate that can reject. `scanQuota.ts:56` fails closed; concurrency must not let a race resolve as allow. |
| **COMPLEXITY** | MEDIUM · **RISK** MEDIUM · **PRIORITY P2** |
| **CLASSIFICATION** | `PERFORMANCE_PROMISING` (Arm A only) |
| **EXPLICITLY NOT RECOMMENDED** | Eliding the MODE B prefix (Arm B). It looks like removing redundancy; it is removing a security boundary. A deleted or deactivated account would still fetch commerce in the window between the two requests. |

---

## P2 — OPP-03 · Legacy inline commerce has an unbounded serial tail

| | |
|---|---|
| **FINDING** | With the funnel OFF — **the source default** (`commerceFunnelConfig.ts:32`) — the inline commerce path is: `Promise.all` over both providers with **no early exit** (4500 ms), then **two serial URL-enrichment hops with no deadline of their own** (`scanCommerceRouter.ts:1470`, `:1481`), then optionally a **full recursive second pass** (`:1527`). The caller is shielded only by an outer 3000 ms race (`index.ts:3810`) that **abandons but does not cancel** the work. |
| **EVIDENCE CLASS** | **PROVEN** |
| **TTFAR IMPACT** | Capped at 3000 ms for the caller — but on this path TTFAR and completion coincide, so it is 3000 ms of pure TTFAR. |
| **COMPLETION IMPACT** | **Isolate-side work is unbounded** except by provider aborts (~4 s each), continuing after the caller has been answered. |
| **NETWORK IMPACT** | None. |
| **PLATFORM IMPACT** | None. |
| **QUALITY VALIDATION REQUIRED** | No, if the change is only to bound the deadline. |
| **UX DECISION REQUIRED** | No |
| **CORRECTNESS VALIDATION REQUIRED** | Low. |
| **COMPLEXITY** | LOW · **RISK** LOW · **PRIORITY P2** |
| **CLASSIFICATION** | `PERFORMANCE_PROMISING` |
| **NOTE** | The v127 config file already articulates exactly this invariant — *"a provider may never be given a deadline longer than the budget that remains for the whole fan-out"* (`commerceFunnelConfig.ts:60-67`) — and applies it to the fast path. **Groups D and E never received it.** Two smaller instances of the same gap: the deferred-enrichment children use a hard-coded 4000 ms rather than `providerDeadlineMs`, and the 3000 ms outer race is *shorter* than the 4500 ms budget it wraps, so two timeout layers are unreachable by the caller. |

---

## P3 — OPP-04 · The width-only resize upscales small sources

| | |
|---|---|
| **FINDING** | `manipulateAsync(uri, [{ resize: { width: 896 } }], …)` sets the width *exactly*, so a source narrower than 896 px is **upscaled**. Measured on the committed corpus: **5 of 8** fixtures upscale, `dress.jpg` by **4.49×** in pixel count — more encoded bytes and more upload time for zero added detail. |
| **EVIDENCE CLASS** | Transform **PROVEN**; geometry **PROVEN** (read from real JPEG SOF markers); byte impact **MODELED** |
| **SOURCE** | `services/imageUtils.js:45`; `assets/qa_fixtures/*` |
| **TTFAR IMPACT** | Small on good networks (upload is ~4.7% of the path at mid payload / 5 Mbps) and **larger on poor ones**, where payload matters most. |
| **COMPLETION IMPACT** | Same. |
| **NETWORK IMPACT** | Direct — this is a payload-size defect. |
| **PLATFORM IMPACT** | Identical on both platforms (no `Platform.OS` branch exists). |
| **SCOPE** | Bites the **gallery/upload** entry path (screenshots, saved images), not the camera path, whose captures are far wider than 896 px. |
| **QUALITY VALIDATION REQUIRED** | **YES** — clamping the resize changes the pixels the model sees for small sources, which could affect detection on low-resolution inputs. |
| **UX DECISION REQUIRED** | No |
| **CORRECTNESS VALIDATION REQUIRED** | Low. |
| **COMPLEXITY** | LOW · **RISK** LOW · **PRIORITY P3** |
| **CLASSIFICATION** | `REQUIRES_QUALITY_VALIDATION` |

---

## P3 — OPP-05 · The client work that is redundant or unbounded

| | |
|---|---|
| **FINDING** | Three small, fully-owned client facts. (a) SHA-256 runs **twice** per scan — once over the source URI and once over the base64 (`useKScan.js:566`, `:587`). (b) `sanitizeImageBeforeUpload` is a **proven no-op** (`return input`) still sitting on the critical path, and `localPrivacyFiltered` is therefore always `false`. (c) Three client ceilings disagree — 20 s invoke, 32 s attempt, 45 s on a dead path — and `analyzeSelectedCandidate` has **no** attempt ceiling at all, so the selected-item request is bounded only by the 20 s transport timeout. |
| **EVIDENCE CLASS** | **PROVEN** |
| **SOURCE** | `useKScan.js:31`, `:36`, `:566`, `:587`, `:683`, `:835`; `privacyImageSanitizer.js:26`; `scanIdentification.ts:35`; `services/api.js:17` |
| **TTFAR IMPACT** | Small and `PENDING_RUNTIME` — the digest cost has never been measured on a device. |
| **COMPLETION IMPACT** | Same. |
| **NETWORK IMPACT** | None. |
| **PLATFORM IMPACT** | Identical on both. |
| **QUALITY VALIDATION REQUIRED** | No |
| **UX DECISION REQUIRED** | No |
| **CORRECTNESS VALIDATION REQUIRED** | Medium — the two digests may serve different purposes (session identity vs payload identity); that must be checked before either is removed. |
| **COMPLEXITY** | LOW · **RISK** LOW · **PRIORITY P3** |
| **CLASSIFICATION** | `INCONCLUSIVE` pending a device measurement |
| **NOTE** | The missing attempt ceiling on `analyzeSelectedCandidate` is a robustness asymmetry, not a latency win. Recorded, not repaired (§E). |

---

## Recorded and explicitly NOT pursued

| ID | Finding | Why not |
|---|---|---|
| — | Progressive delivery inside the commerce shelf | EXP-3: ceiling is the 1900 ms the fan-out is already bounded to, while a 5–7 s serial term sits upstream. `NO_MATERIAL_STRUCTURAL_GAIN`. |
| — | Removing the 1500 ms client display floor | EXP-1: cannot bind at any plausible operating point — the non-identification path alone is already ~1.14 s. Hypothesis **refuted**, constraint recorded for later. |
| — | `SimilarFindsShelf` renders pressable-but-dead cards for `http://`/private-host URLs (`SimilarFindsShelf.tsx:70` gates on truthiness, not `isSafeCommerceUrl`), and `ProductCard.tsx:116` announces `accessibilityRole="button"` on a non-pressable branch | Adjacent correctness/a11y defects found in passing. **Out of lane** (§E) — recorded, not repaired. |
| — | Running similarity concurrently with commerce (funnel OFF) | ≤300 ms, funnel-OFF only, and it is already timeout-bounded. Below the bar for one of three experiment slots. |
