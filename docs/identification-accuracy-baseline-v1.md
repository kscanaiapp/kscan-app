# Identification Accuracy — Baseline (v1)

Sprint: identification-accuracy-v1 (text-proxy measurement; real visual accuracy
must be confirmed by a human running equivalent image scans on-device).

## Model configuration (observed, not changed)

- Source default model (`DEFAULT_MODEL`, `supabase/functions/scan-identify/index.ts`): **gemini-1.5-flash**
- Model precedence: `SCAN_GEMINI_MODEL` → `GEMINI_MODEL` → `DEFAULT_MODEL`
- `SCAN_GEMINI_MODEL` secret present: **NOT_CHECKED** — no secrets-list tool was
  available in this session and secret values are never printed. Verify by name only with:
  `supabase secrets list --project-ref wyyuqfdxucjksghsmhry`
- Model changed: **NO** (out of scope; owner approval required)
- Model risk: if `SCAN_GEMINI_MODEL` is unset, the function runs on gemini-1.5-flash.
  Prompt-level accuracy gains are bounded by that model's vision quality. A newer
  flash model would likely improve dominant-item selection further.

## Catalog categories (verified via Supabase MCP, App Staging `public.product_catalog`)

| canonical_category | rows |
|---|---|
| outerwear | 4 |
| bag | 2 |
| dress | 2 |
| blazer | 2 |
| footwear | 2 |
| accessory | 2 |

There is **no `pants` or `top`** category, so jeans/shirt scans correctly return
an empty product shelf today. `blazer` **is** a real category, so `blazer → blazer`
is kept (not collapsed to outerwear).

## Baseline measurement (offline matrix — `node scripts/accuracy-matrix.js`)

Category normalization is the deterministic lever that decides which catalog
category is queried. Running representative `item_type` strings (what the model
emits) through the committed (HEAD) `normalizeCategory`:

- 27 representative item types tested
- **13 misclassified** before the change (all because the regex was not plural-tolerant
  and missed common synonyms)

Misclassified at baseline (returned the raw string → zero catalog matches):
`puffer`, `raincoat`, `overcoat`, `bomber`, `windbreaker`,
`sneakers`, `white sneakers`, `boots`, `ankle boots`, `loafers`, `heels`, `sandals`, `pumps`.

Confidence calibration issues at baseline (`buildDisplayResult`):
- Thresholds were High ≥ 0.85 / Medium ≥ 0.70, so a 0.65 score read **Low** and a
  0.80 score read **Medium** — both miscalibrated vs the sprint spec (0.80 / 0.60).
- No downgrade when a `scan_quality_note` was present or when the item type was
  `unknown` / non-fashion, so blurry/uncertain scans could read **High**.

Wrong-category ProductShelf risk at baseline: structurally low — catalog retrieval
already hard-filters `WHERE canonical_category = <normalized>` and `recommendedProducts`
is otherwise `[]`. The real risk was the *wrong* canonical category being computed
(e.g. a sneaker scan → `sneakers` → no rows → empty shelf), not foreign-category leakage.

## Authenticated staging smoke

`AUTHENTICATED_SMOKE_NOT_RUN_NO_JWT` — no `STAGING_USER_JWT` was provided. Offline
matrix + golden unit tests were used to measure instead.
