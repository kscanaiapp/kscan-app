# Build 42 Sprint 1 — Scanner Confidence Engine design

## Goal

Every offer the Scanner shows carries exactly one evidence-backed class, and the app never says
more than the evidence supports.

| Class | User meaning | Evidence required (all must hold) | Never produced from |
|---|---|---|---|
| `verified_exact` | "This is the item." | (a) listing-bound product identity verified by an **independent** signal (see *Identity producers*), (b) direct merchant destination, (c) no category conflict, (d) attribute agreement not below usable | a model hypothesis, a model confidence number, a title alone, an agreement score |
| `probable` | "Likely the same item." | (a) scanned brand verified (wordmark, or logo classified `high`), (b) listing brand agrees (provider field, else whole-phrase in title with no dupe/replica/inspired cue), (c) every distinctive token of the model's product hypothesis is in the listing title, (d) hypothesis confidence not `low`, (e) listing category compatible with the scan or absent, never a different canonical category or an ancillary product (socks, laces, straps, cases…) | attribute agreement alone |
| `similar` | "A similar alternative." | attribute agreement ≥ usable band, no category conflict | — |
| `unsupported` | not presented as a match | invalid destination, clear category conflict, ancillary listing, or agreement below usable without identity agreement | — |

Destination is reported **separately** from class (`direct | search_handoff | invalid`), so
"likely the same item, but this link goes to a search page" is representable and measurable.

## Rule order (implemented in PR-1, `scan-identify/matchConfidence.ts`)

1. invalid destination → `unsupported`
2. clear category conflict or ancillary listing → `unsupported`
3. verified product identity on a direct listing (band not weak) → `verified_exact`
4. brand agrees ∧ model agrees ∧ category not different → `probable`
5. weak band → `unsupported`
6. otherwise → `similar`

Identity (step 4) is evaluated **before** the attribute band (step 5) on purpose: the v122
attribute scorer gives identity-shaped titles near-zero credit (B42-SCAN-02), so the band must
never be the reason a same-product listing is called unsupported. Disqualifiers (steps 1–2) are
evaluated first so identity agreement can never rescue a conflicting or ancillary listing.

## Evidence sources

| Signal | Source today | Independence |
|---|---|---|
| Scanned brand | `brandEvidence.resolveScannerBrandEvidence` | vision-model report only (`independentlyVerified: false`) |
| Product hypothesis | `exact_item_hypothesis` (+ `exact_match_confidence`) — emitted only with v124 schema | vision-model report only |
| Listing brand | provider `brand` field, else title phrase | listing data |
| Listing model | title tokens | listing data |
| Attribute agreement | `scoreProductAgreement` (unchanged) | deterministic |
| Destination | `classifyDestination` | deterministic |
| Verified identity | `matchTier` `exact` (requires `verified_product_identity`) | **no producer exists** |

Consequence for the current Staging configuration (v124 OFF): the selected-item schema cannot
emit a product hypothesis, so `probable` is unreachable and every offer is `similar` or
`unsupported`. That is a truthful statement of what the pipeline knows, not a defect in the
classifier.

## Identity producers (required before `verified_exact` can exist)

Ordered by independence from the vision model:

1. **Structured listing identity** — style code / MPN / GTIN on the listing matched to a style
   code legible on the item (tongue label, care tag, box). Two independent sources must agree.
2. **Legible model identifier** — model name or reference printed on the item and read
   (`visible_model_text`, analogous to `visible_brand_text`: "STAN SMITH" tongue,
   "F-91W" dial, "SUBMARINER" dial, "MOON BOOT" wordmark), agreeing with the listing title.
   Initially vision-model OCR; an on-device OCR adapter (`scannerVisualEvidence` already
   reserves the slot) would make it independent.
3. **Canonical product catalogue** — Style → Variant → Offer resolution (Canonical Product
   Identity lab) so offers bind to a catalogue identity rather than a title.

Each producer ships behind its own flag and is admitted only after the benchmark shows its
false-exact rate on the holdout.

## Thresholds — how they become evidence-based

PR-1 reuses the existing v122 bands (strong ≥75, usable ≥50) and labels them **provisional**.
They are replaced by values derived from the benchmark, using this procedure:

1. Run the benchmark (development split) with `SCANNER_MATCH_CONFIDENCE_V1_ENABLED` on Staging.
2. For each class and each agreement-score bucket, compute title-judged precision with a 95%
   Wilson interval (exact-product judge for `verified_exact`/`probable`; alternative grade ≥2 for
   `similar`).
3. The **owner** sets the acceptable error per class (this document sets none). The usable/strong
   cut-points become the lowest bucket whose interval lower bound meets that choice.
4. Confirm once on the sealed holdout; report the holdout numbers, never retune on them.
5. Any class whose holdout false-claim interval cannot be bounded stays unrendered.

## Presentation contract (PR-5, mobile; not in Sprint 1)

| Class | Section / label | Notes |
|---|---|---|
| `verified_exact` | "Exact match" | only class allowed to say "exact" |
| `probable` | "Likely match" | never "exact"; shows "goes to search results" when destination is a handoff |
| `similar` | "Similar styles" | today's label |
| `unsupported` | hidden, or a separate "More to explore" row below the fold | never inside a match section |

`agreementScore` is diagnostic and must never be rendered as "% match" (the existing
`matchPercent` mapping reads only `similarityPercentage`/top-level `matchScore`; PR-1 nests the
score inside `matchConfidence` so it cannot be picked up by that path).

## Telemetry

PR-1 emits one counts-only line per shelf when enabled:
`match_confidence_v1 request_mode=… offers=N verified_exact=… probable=… similar=… unsupported=… direct=… search_handoff=… invalid=…`
— no titles, URLs, brands, queries, images or user identifiers. This gives continuous
merchant-link validity and class mix without a migration.
