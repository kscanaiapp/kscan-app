# vto-phase4-pipeline

K Scan AI Live VTO — Phase 4 (Asset Automation & Catalog Economics).

An isolated, local/batch Node.js tool that turns a product source image
into a `.ksgarment`-compatible garment asset (or a specific, explicit
rejection). **Not a runtime dependency of the `kscan-app` RN bundle** —
nothing under `services/`, `components/`, `hooks/`, or `app/` imports from
this package, and it is not listed in the root `package.json`'s
dependencies.

See `docs/vto-phase4-source-authority.md`, `docs/vto-phase4-corpus-discovery.md`,
and `docs/vto-phase4-defect-ledger.md` at the repo root for the full context,
citations, and known limitations.

## Layout

```
src/            pipeline stages (classification, extraction, canonicalization,
                anchors, QA, manifest/versioning, correction, batch runner)
__tests__/      node --test suite (build-then-test, matching this repo's
                and kscan-live-vto's own house convention)
fixtures-input/synthetic/   procedurally-generated, committed test source images
```

Pipeline output (generated `.ksgarment` bundles and evidence reports) is
written outside this package, per the task's storage convention:

```
fixtures/vto-phase4/generated/<asset-id>/    manifest.json (+ texture.png, alpha.png when accepted)
evidence/vto-phase4-assets/                  batch-run-report.json, gate-e-economics.{json,md}, corrections.jsonl
```

## Commands

```sh
npm install
npm test           # build + run the full test suite
npm run pipeline:run   # regenerate the synthetic/authorized-fixture corpus and evidence
```

## Scope

This package prepares assets; it does not serve them, and it does not
enable Live. See `docs/vto-phase4-source-authority.md` for the Commerce/VTO
contracts it is built against, and the narrow, additive
`garmentLiveAssetEligible` field added to `services/vto/vtoLiveCapability.ts`
for the only app-side integration point.
