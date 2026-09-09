# Source-Authority Refresh — Build 35 accepted-source convergence

**INTERNAL ENGINEERING ANALYSIS ONLY. SIMULATED TTFAR IS NOT A MEASUREMENT OF
REAL-WORLD K SCAN SPEED.**

| | |
|---|---|
| PREVIOUS SOURCE SHA | `909df8646a690b55c5af6b7b8c80193df64a2ec8` |
| REFRESHED SOURCE SHA | `219f27aa0f2586d3bded1ca02f751a63d1960c48` |
| PREVIOUS BINDING HASH | `3aaa80038736b843ca6b346cf82871b497144e13985ee456c95c6139c94cc768` |
| REFRESHED BINDING HASH | `7f057e5611a3634d8fcf084e54285c693891705d84481d9b637c7fa2b2b71d5c` |
| BASELINE DERIVED AGAINST REFRESHED SHA | `baseline/baseline-v2.json` |
| SUPERSEDED BASELINE (retained, immutable) | `baseline/baseline-v1.json` |

## Why this refresh exists

Five bound production files legitimately changed after the bindings were taken.
Whole-file hashing is deliberately over-sensitive (`lib/sourceBinding.js`), so
the lab reported FAIL — which is the correct failure direction, and is what it
is supposed to do. The repair is to re-derive against accepted source, **not**
to relax the check.

What was explicitly NOT done: no failure was added to
`config/test-failure-baseline.json`, no test was skipped, no comparison rule was
weakened, no binding was deleted, no FAIL was downgraded to WARN, and no hash was
updated before the classification below was complete. No production Scanner or
Commerce source was altered by this repair — the lab adapts to accepted source
truth, never the reverse.

## Drift origin

Two accepted Build 35 commits, both already merged into the accepted base:

| Commit | Subject | Bound files it moved |
|---|---|---|
| `4188565e` | `fix(commerce): preserve truthful offer currency` (RP-110) | `shoppingProvider.ts`, `farfetch3Provider.ts`, `kicksCrewProvider.ts`, `poshmarkProvider.ts` |
| `76cc90c9` | `fix(scanner): fingerprint multi-item commerce content` (RP-111) | `app.js` |

Both are intentional, reviewed, accepted work. Neither is unauthorized drift.

## Per-file classification

Classes: **A** byte drift, model-relevant semantics unchanged · **B** semantics
changed, model assumption still valid · **C** model/report must be updated ·
**D** unexpected/unauthorized drift.

### `app.js` — **A**

The whole diff is one import, nine comment lines, and one changed expression:
the multi-item commerce attach key becomes a content fingerprint instead of
`count + status`. That effect is guarded by `status !== 'result'` and runs
**after** the result is already on screen — it is a persistence-freshness fix,
downstream of every terminal the lab models.

The lab binds `app.js` for four control-flow facts, all outside the diff and all
still byte-identical (verified by extracting both revisions and comparing the
cited regions):

| Fact | Was | Now |
|---|---|---|
| `capturePhoto(cameraRef)` capture entry | `947` | `957` |
| `onAnalyze={runAnalysis}` (t=0 wiring) | `1002-1011` | `1012-1021` |
| reveal held until `v2AnalyzingMinComplete` | `1024-1038` | `1034-1048` |
| `SCAN_RESULTS_V2_UI_ENABLED` selects `ScanResultV2` | `1134` | `1144` |

Pure `+10` shift. No timing constant, round-trip count or terminal moved.

### `shoppingProvider.ts` — **A**

Adds `offerCurrency` import, an optional `currency` field on
`RecommendedProduct`, and a second optional argument to `normalizePrice`. All of
it is response **mapping**. The one fact the lab binds from this file — Serper is
awaited first and Brave runs only if Serper returned zero, i.e. the sub-group is
internally **serial** — is unchanged code, shifted `528,541 → 548,561`.

The added `currency` field enlarges the commerce *response*. The model derives
`payload_bytes` from the scan **request** (base64 image + envelope, via
`lib/network.js` over real JPEG fixtures) and models no provider-response size,
so this cannot move a modelled number.

### `farfetch3Provider.ts` — **A**

`formatPrice` stops defaulting an undeclared currency to USD. The bound fact is
`PROVIDER_TIMEOUT_MS = 4_000`, unchanged, shifted `45 → 49`.

### `kicksCrewProvider.ts` — **A**

`lowestVariantPrice` seeds currency `null` instead of `'USD'`. The bound fact is
`PROVIDER_TIMEOUT_MS = 4_000`, unchanged, shifted `43 → 47`.

### `poshmarkProvider.ts` — **A**

Same currency-truthfulness mapping change; `PROVIDER_TIMEOUT_MS = 4_000` intact.
The lab's Poshmark timing facts (fan-out concurrency, the 1900 ms fast deadline,
the 4500 ms legacy deadline, the documented 13.9 s tail) are bound to
`scanCommerceRouter.ts` and `commerceFunnelConfig.ts` — neither of which drifted.

**Class B: none. Class C: none. Class D: none.**

## Independent validation of the classification

The classification claims these changes cannot move the model. That claim is
tested rather than asserted: the baseline was re-derived against the refreshed
source and compared to the pre-drift baseline.

- `structural_change`: `[]`
- every other field, excluding `baseline_id` / `source_sha` /
  `source_binding_hash`: **byte-identical**

Both properties are now pinned by
`__tests__/curiosityGapPerformance/labContract.test.js`, so a future source
change that *does* move the model fails the suite instead of being waved through
by a hash bump.

Also re-run clean: `runLab.js contract` (`bindings_ok: true`, zero network and
provider calls) and the independent `validateReport.js` over both baselines.

Evidence labelling is unchanged: modelled timing remains MODELED, and the
INTERNAL-ENGINEERING-ONLY disclaimer is intact on every artifact.

## Baseline versioning

`writeBaseline` refuses to overwrite an existing baseline — baselines are
immutable by design, and legitimate source movement produces a **new version**.
So `baseline-v1.json` is retained unedited, still valid, still declaring the SHA
it was derived against; `baseline-v2.json` is the current one. A test asserts a
superseded baseline is never edited in place to impersonate current authority.
