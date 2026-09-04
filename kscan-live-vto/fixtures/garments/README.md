# Garment fixtures

No real retailer product imagery exists in this directory. Section 8.4
("no automatic production calls... any real provider test must follow the
bounded-test rules") and Section 31 (no unlicensed scraping) both counsel
against pulling real retailer images into an unreviewed sandbox without a
deliberate, human-approved sourcing decision — which has not happened in
this session.

`fixture-shirt-001.ksgarment.json` is a **manifest-only** fixture: a
hand-written example that satisfies
`@kscan-live-vto/garment-contract`'s `validateKsgarmentManifest` (see
`packages/garment-contract/src/__tests__/ksgarment.test.ts`, which uses
the same shape). It has no accompanying `texture.png`/`alpha.png` — those
would come from a real Class A (flat-lay) or Class B (ghost-mannequin)
source image run through the P1-D3 asset pipeline, which has no real
segmentation/normalization model wired up yet (see
`packages/asset-pipeline/src/shotClass.ts`'s stub classifier and
`docs/vto-phase1-status.md`).

Use this fixture for wiring/schema/QC-composition tests
(`@kscan-live-vto/asset-pipeline`'s `composeQcRecord`, the deformation
math's control-point inputs) — not as evidence of real asset-pipeline
output quality.
