# Build 42 Sprint 1 — Scanner baselines

No targets are set in this document. Every number states its source, sample size and the code
it describes. "Not measured" means not measured.

## A. Live baseline on the Build 42 benchmark — NOT MEASURED

The benchmark (section D) is built and reproducible, but measuring it requires live Gemini and
commerce-provider calls on Staging through the governed synthetic account. That spend, the
quota plan and the Staging flag state for the run (`SCANNER_MATCH_CONFIDENCE_V1_ENABLED` on,
v124 identity on/off arms) are owner decisions. `scripts/plan-live-run.mjs` prints the request,
quota-day and cost envelope for any split.

## B. Structural baseline (current deployed code, `e58125a2`, Staging v108)

| Metric | Value | Basis |
|---|---|---|
| Exact-match precision | **undefined — 0 exact claims possible** | `matchTier` grants `exact` only with verified product identity; no caller supplies it (B42-SCAN-04) |
| False exact-match rate | **0 by construction** | same |
| "Probable" claims | none (class does not exist before PR-1) | — |
| Per-offer confidence returned | none | agreement score not in the response (B42-SCAN-03) |

## C. Archived Staging live evidence, rescored with the Build 42 metrics

Source: `docs/build35/scanner/evidence/P1-report.json` (workflow run 37944817914, 2026-10-09,
Staging, code before #541/#759/VRI-03). Cases: 12 labelled garments from the 8 legacy QA
fixtures (provenance pending — descriptive only). Scored by
`tools/scanner-benchmark/scripts/score-archived.mjs`; judge is title-only.

| Metric | P1 (first attempt) |
|---|---|
| Exact-match precision | undefined (0 claims) |
| False exact-match rate | 0 / 12 |
| Alternative relevance, hit@3 (grade ≥2) | 8 / 9 garments with offers (0.89) |
| Alternative relevance, mean grade top-3 (0–3) | 1.89 (grades 0:4, 1:3, 2:12, 3:8) |
| Merchant-link validity (direct merchant page) | **0 / 55 offers** (55 search-handoff) |
| First actionable result, machine time (detection + selected + commerce) | p50 17.3 s, p95 19.6 s (n = 9; user selection time excluded; two single-garment photos had no recorded detection time, so their totals are understated) |
| No actionable result on first attempt | 3 / 12 (commerce timeouts at the then 1.9 s fast deadline, repaired by #541) |
| Identification category accuracy | 12 / 12 |
| Brand claims | 0 (none made) |

P2 (same date, two garments): 5/13 offers direct — all Poshmark (Staging-only provider);
P1+P2+R1 combined: 95/110 offers were Google `/search` handoffs.

## D. Staging telemetry (read-only, `scan_commerce_events`, 2026-10-04 → 2026-11-18)

| Request mode | n | p50 | p95 | Empty shelf |
|---|---|---|---|---|
| `multi_item_detection` | 13 | 7.7 s | 9.5 s | n/a (deferred) |
| `selected_item` | 20 | 6.4 s | 8.4 s | n/a (deferred) |
| `legacy_single_item` | 9 | 9.7 s | 10.8 s | n/a (deferred) |
| `commerce_only` | 30 | 1.6 s | 3.1 s | 6 / 30 (4 timeouts on 10-09 pre-#541, 2 provider errors on 11-04) |

Top agreement band of non-empty `commerce_only` shelves: strong 8, usable 13, weak 3 (all-weak
shelves). Since VRI-03 activation (2026-11-03): 5 of 8 non-empty shelves trimmed from 8
candidates to exactly 3; 2 of 8 weak-topped.

Provider cost: **not measured** — token counts are logged only for VRI-03-cohort requests and
function logs were not readable from this session; commerce calls are counted, not priced.

## E. Benchmark composition (`tools/scanner-benchmark/manifest/cases.v1.json`, v1)

**139 cases** = 123 licensed Wikimedia Commons photographs + 16 deterministic adverse-condition
variants. 227 candidates were collected (licence-filtered); 217 fetched; 94 rejected during
visual curation (reasons recorded per candidate in `curation.v1.json`).

| Stratum | Development | Holdout | Notes |
|---|---|---|---|
| `exact_known` | 34 | 8 | 13 model families (Stan Smith, Superstar, Samba, Gazelle, Chuck Taylor, Air Jordan 1, Air Max BW, Air Max 90, Crocs Classic Clog, Casio F-91W, Rolex Submariner, Ray-Ban Aviator, Kånken); holdout = whole families (Gazelle, Submariner, Aviator) |
| `logo_visible` | 17 | 2 | legible wordmark/logo (adidas, Nike, Oakley, Vans, Reebok, ECCO, Deuter, Moon Boot, Champion, Supreme…) incl. sponsor-text and dual-wordmark traps |
| `unknown_generic` | 21 | 2 | no identifiable product; includes trade-dress traps (Vans side stripe, Champion jersey with illegible logo) |
| `texture_pattern` | 7 | 1 | check, fair isle, Nordic knit, polka dot, sequin embroidery, stripes, reptile skin |
| `multi_item` | 15 | 1 | mannequins, shop windows, flood-damaged racks; 2–4 labelled garments each |
| `non_fashion` | 10 | 5 | incl. adversarial controls: logo artwork, shop sign "JEANS CLUB", patterned car/upholstery/tablecloth, brand text on coffee jars, unclothed mannequins |
| `difficult` (derived) | 13 | 3 | low light, motion blur, occlusion, rotation, heavy JPEG compression, overexposure — labels inherited; brand legibility marked unknown |

Other: 50 cases have a knowable exact product; 101 carry at least one difficulty tag (natural or
derived); 20 show part of a person (no identifiable face by policy); licences: CC BY / CC BY-SA
2.0–4.0 (incl. two jurisdiction ports), CC0, public domain. Reproduction verified: 3 of 3 sampled
files re-fetched from manifest URLs matched their SHA-256; derived variants are byte-identical on
re-generation with Pillow 12.3.0.

### Known biases and limits (state these next to any result)

* Footwear dominates (52 of 139); accessories 25; tops 16; few pants, skirts or dresses.
* Licensed web photographs, not phone captures: framing, resolution and lighting differ from the
  in-app camera; the 896 px client width was not simulated (960/500 px thumbnails are sent as-is).
* Identifiable faces were excluded, so "garment worn by a visible person" is under-represented.
* Exact-product identity comes from Commons categories/titles (independent); colour, subtype,
  brand legibility and multi-item garment lists are **agent-annotated** and need a human pass
  before any holdout claim.
* Offer judging is title-only (see `lib/judge.mjs`).

### Live-run envelope (`scripts/plan-live-run.mjs`; nothing executed)

| Split | Cases | Detection | Selected item | commerce_only | Image-mode total | Quota-days at 30/actor/day |
|---|---|---|---|---|---|---|
| development | 117 | 117 | 127 | 127 | 244 | 9 (one actor) |
| holdout | 22 | 22 | 18 | 18 | 40 | 2 |

Gemini upper bound for the development split, using the Build 4 pricing record (2026-07-29 —
must be re-retrieved before any paid run): **≤ $10.45** (input envelope 4 032 tokens and the
2 048-token output cap per call, doubled for the retry ceiling). Commerce provider calls are not
priced (no dated price record exists in the repo). The binding constraint is the durable quota;
options are more synthetic actors or a temporary Staging `SCAN_IDENTIFY_IMAGE_DAILY_LIMIT`
override — both owner decisions.
