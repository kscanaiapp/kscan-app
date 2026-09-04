# Evidence

Generated artifacts. Everything here is reproducible from source — nothing is
hand-edited, and nothing should be.

```
static-preview/   Section 19 five-case review package (PNG + JSON sidecars)
garment-qc/       Section 21 garment asset QC sheets and records
device/           Device evidence — EMPTY. See docs/vto-native-device-handoff.md
                  for the required directory shape and return protocol.
```

## Regenerating

```sh
cd kscan-live-vto
npm run build
node tools/render-static-review.js     # static-preview/
node tools/garment-qc.js --fixture logo
node tools/garment-qc.js --fixture plain
```

Renders are deterministic: the same commit produces byte-identical PNGs
(pinned by a test in `packages/static-renderer/src/__tests__/renderer.test.ts`).

## What this evidence does and does not support

**Supports:** rendering mechanics — semantic anchoring, rigid placement and
its stop gate, affine-MLS deformation, mesh integrity, compositing layer
order, occlusion *semantics*, lighting guardrails, mirroring convention.

**Does not support:** any claim about human pose perception, body diversity,
automatic segmentation quality, real retailer-asset viability, native
rasterization, or on-device performance. All person and garment fixtures are
synthetic; all masks are precomputed; no pose model, no segmentation model,
and no device were involved.

`device/` is empty because this program has never run on a device. That is a
statement of fact, not a gap in the file listing.
