# Scanner Accuracy Evaluation Dataset (Build 4)

Isolated, offline evaluation foundation for **Scanner Accuracy & Trust V2**.

This tree is research-only. It must not be imported by:

- the mobile application
- `scan-identify`
- any deployed Edge Function
- production services or configuration

## Layout

| Path | Purpose |
|------|---------|
| `dataset-manifest.schema.json` | Case record contract |
| `dataset-version.json` | Current governed dataset version |
| `manifests/` | Case manifests (privacy-safe references) |
| `labels/` | Ground-truth labels |
| `expected-results/` | Expected result-type / abstention targets |
| `reports/` | Generated scoring and gate reports |
| `fixtures-inventory.json` | Approved vs unauthorized fixture inventory |

## Dataset version

See `dataset-version.json`. Results without a matching dataset version are invalid for production consideration.

## Privacy

Manifests may contain opaque case IDs, image hashes, governed fixture references, and normalized labels only.
Do not commit raw private user imagery, actor IDs, local filesystem paths, signed URLs, or EXIF location data.

## Paid baseline

Static harness validation does not call paid models.
Paid baseline runs require owner authorization after fixture inventory and cost estimate review.
