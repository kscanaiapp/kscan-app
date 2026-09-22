# Receipt & Purchase Intelligence V1 — owner quality gate (spec §41–42)

**Status: NOT YET RUN.** The build environment has no deployed
`purchase-import-extract`, no owner receipt samples, and no device. This gate
has to pass before the feature can be called ready, and before the product is
positioned as receipt import rather than order-confirmation import.

Nothing in this repository is real receipt data. The committed test fixtures
are synthetic.

## Preconditions (staging only)

1. Apply `supabase/migrations/20260922190000_closet_purchase_import_origin.sql`
   to **staging** (`yzqjvdfgefveprobvvyw`) through the governed migration path.
2. Deploy `purchase-import-extract` to staging through the governed deploy
   workflow. It is deliberately **not** in the automatic staging allowlist.
3. Set `PURCHASE_IMPORT_EXTRACT_ENABLED=true` on staging only.
4. Confirm the `GEMINI_API_KEY` secret on staging belongs to the billed
   (prepaid) Cloud project.
5. Build a staging dev client with `EXPO_PUBLIC_RECEIPT_INTELLIGENCE_V1=true`.

## Corpus (§41)

Use 20 owner-controlled or consented samples, stratified:

| Tier | Target | Examples |
|---|---|---|
| Order-confirmation screenshots | 8 | email or app order confirmations |
| Digital receipts | 6 | e-receipts, in-app receipts |
| Paper receipt photographs | 6 | include at least 2 abbreviated lines, 1 glare, 1 long receipt |

Also include at least one sample each of:
- merchant ≠ brand;
- a return or exchange;
- a non-USD or symbol-only currency;
- a mixed fashion and non-fashion receipt;
- a printed return-by date.

Keep raw samples **outside** the repository. Record only the labels below.

For each sample, hand-label: the expected fashion items, and per item the
brand, category, colour, printed size, unit price, currency, and whether a
SKU/GTIN is printed.

## Metrics per tier

- **fashion-item recall** = candidates matching a labelled fashion item ÷ labelled fashion items
- **attribute precision** = correct non-null fields ÷ non-null fields shown, per attribute
- **false-positive non-fashion rate** = non-fashion lines shown as candidates ÷ candidates
- **correction burden** = fields edited per confirmed item (the `purchase_import_reviewed` correction counts give this without content)
- **unreadable rate** = imports ending `unreadable_document` ÷ imports
- **CONFIRMED_ITEM_ATTRIBUTE_COVERAGE** = `computeAttributeCoverage()` (`services/purchaseImport/purchaseImportCoverage.ts`) over the test account's Closet after the run, comparing `purchase_import` with `direct_intake`

**Known structural baseline for manual intake**, from the source and asserted by
`__tests__/purchaseImportCoverage.test.js`: the Add Item draft carries
**title and category only**. Brand, subtype, colour, material, size, price,
date and identifiers therefore start at 0% on manually added items unless the
owner edits them later. There is no manual-path telemetry and no staging Closet
data, so empirical manual coverage is **not measured**, and no numeric
comparison is claimed.

## End-to-end owner runs (§42)

Run at least 5 representative samples end to end and classify each
`USEFUL` / `PARTIALLY_USEFUL` / `NOT_USEFUL`, with the reason.

Journeys to exercise on device:
- H: switch account mid-review;
- F: airplane mode during Add;
- G: cancel at each step;
- R: an extremely long screenshot;
- J: a crop that deliberately includes an address;
- I: a sample with printed "ignore previous instructions" text.

## Calibration to revisit with evidence

- `PURCHASE_IMPORT_DOCUMENT_CONFIDENCE_FLOOR = 0.5` is a starting calibration.
  Move it only with corpus evidence, and in both the client and server
  constants; the parity test enforces that.
- If paper receipts perform poorly while order confirmations are reliable,
  position V1 as **Import Order Confirmation** (spec §42).
