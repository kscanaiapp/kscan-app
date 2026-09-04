# VTO Phase 4 — Gate E Economics (this session's evidence)

Generated: 2026-09-04T20:43:42.851Z

## Evidence class counts
```json
{
  "SYNTHETIC": 20,
  "AUTHORIZED_FIXTURE": 7
}
```

## Headline (N=27, across SYNTHETIC + AUTHORIZED_FIXTURE evidence only — not statistically sufficient for a production Gate E PASS; see docs/vto-phase4-corpus-request.md.)

- Fully automatic success rate: 33.3% (9/25)
- Rejection rate: 66.7%
- Variant-ambiguous (excluded from success/rejection rates above): 2
- Manual correction minutes/SKU: NOT_MEASURED (see evidence/vto-phase4-assets/corrections.jsonl for automated-agent correction latency, which is NOT human time)

## Rejection reason distribution
```json
{
  "EXTRACTION_UNRELIABLE": 5,
  "OCCLUSION_TOO_HIGH": 2,
  "MULTIPLE_GARMENTS": 1,
  "VARIANT_AMBIGUOUS": 2,
  "SOURCE_TOO_SMALL": 1,
  "UNSUPPORTED_CATEGORY": 7
}
```

## Success rate by shot class
```json
{
  "EASY": {
    "total": 15,
    "accepted": 9,
    "rejected": 6,
    "successRate": 0.6
  },
  "MEDIUM": {
    "total": 1,
    "accepted": 0,
    "rejected": 1,
    "successRate": 0
  },
  "HARD": {
    "total": 7,
    "accepted": 0,
    "rejected": 7,
    "successRate": 0
  },
  "UNSUPPORTED": {
    "total": 4,
    "accepted": 0,
    "rejected": 4,
    "successRate": 0
  }
}
```

## Success rate by garment family
```json
{
  "simple-top (only mapped family today)": {
    "total": 14,
    "accepted": 9
  },
  "n/a (rejected before geometry)": {
    "total": 13,
    "accepted": 0
  }
}
```

## Success/rejection by evidence class (never mixed into one distribution above)
```json
{
  "SYNTHETIC": {
    "total": 20,
    "accepted": 9,
    "rejected": 11
  },
  "AUTHORIZED_FIXTURE": {
    "total": 7,
    "accepted": 0,
    "rejected": 7
  }
}
```

## Product fidelity
```json
{
  "passRate": 1,
  "fillRatioDistribution": {
    "count": 14,
    "min": 0.5709359145215216,
    "median": 0.5961731140490213,
    "p95": 0.6936739726786555,
    "max": 0.6936739726786555,
    "mean": 0.5956896377006936
  },
  "compactnessDistribution": {
    "count": 14,
    "min": 1.3335854231336717,
    "median": 1.3446622499724994,
    "p95": 1.4821998259114608,
    "max": 1.4821998259114608,
    "mean": 1.3856118621024471
  },
  "metricsWithReferenceCount": 18,
  "metricsWithoutReferenceCount": 24
}
```

## Runtime distribution
```json
{
  "totalDurationMsDistribution": {
    "count": 27,
    "min": 1,
    "median": 56,
    "p95": 168,
    "max": 226,
    "mean": 66.11111111111111
  },
  "perStageDurationMsDistribution": {
    "classification": {
      "count": 24,
      "min": 0,
      "median": 6,
      "p95": 22,
      "max": 34,
      "mean": 6.5
    },
    "extraction": {
      "count": 16,
      "min": 0,
      "median": 0,
      "p95": 1,
      "max": 1,
      "mean": 0.0625
    },
    "canonicalization": {
      "count": 14,
      "min": 0,
      "median": 0,
      "p95": 0,
      "max": 0,
      "mean": 0
    },
    "anchor_generation": {
      "count": 14,
      "min": 0,
      "median": 0,
      "p95": 0,
      "max": 0,
      "mean": 0
    },
    "geometry_generation": {
      "count": 14,
      "min": 0,
      "median": 0,
      "p95": 0,
      "max": 0,
      "mean": 0
    },
    "qa": {
      "count": 14,
      "min": 0,
      "median": 0,
      "p95": 0,
      "max": 0,
      "mean": 0
    },
    "bundle_writing": {
      "count": 24,
      "min": 0,
      "median": 0,
      "p95": 0,
      "max": 0,
      "mean": 0
    }
  },
  "retryCountTotal": 0
}
```

## Per-item detail
| productRef | variantId | evidenceClass | shotClass | eligible | rejection | durationMs |
|---|---|---|---|---|---|---|
| p4-easy-plain-light | - | SYNTHETIC | EASY | true | - | 134 |
| p4-easy-plain-dark | - | SYNTHETIC | EASY | true | - | 52 |
| p4-easy-logo | - | SYNTHETIC | EASY | true | - | 55 |
| p4-easy-patterned | - | SYNTHETIC | EASY | true | - | 64 |
| p4-easy-structured | - | SYNTHETIC | EASY | true | - | 62 |
| p4-easy-softknit | - | SYNTHETIC | EASY | true | - | 40 |
| p4-medium-plain | - | SYNTHETIC | EASY | false | EXTRACTION_UNRELIABLE | 96 |
| p4-medium-logo | - | SYNTHETIC | EASY | false | EXTRACTION_UNRELIABLE | 65 |
| p4-medium-patterned | - | SYNTHETIC | EASY | false | EXTRACTION_UNRELIABLE | 80 |
| p4-medium-dark | - | SYNTHETIC | EASY | false | EXTRACTION_UNRELIABLE | 56 |
| p4-medium-light | - | SYNTHETIC | EASY | false | EXTRACTION_UNRELIABLE | 56 |
| p4-hard-synthetic-worn | - | SYNTHETIC | HARD | false | OCCLUSION_TOO_HIGH | 16 |
| p4-unsupported-multi | - | SYNTHETIC | UNSUPPORTED | false | MULTIPLE_GARMENTS | 17 |
| p4-multi-image-product | - | SYNTHETIC | EASY | true | - | 55 |
| p4-variant-product | black | SYNTHETIC | UNSUPPORTED | false | VARIANT_AMBIGUOUS | 3 |
| p4-variant-product | white | SYNTHETIC | UNSUPPORTED | false | VARIANT_AMBIGUOUS | 3 |
| p4-variant-authoritative-product | black | SYNTHETIC | EASY | true | - | 38 |
| p4-variant-authoritative-product | white | SYNTHETIC | EASY | true | - | 38 |
| p4-too-small | - | SYNTHETIC | UNSUPPORTED | false | SOURCE_TOO_SMALL | 1 |
| p4-unsupported-category | - | SYNTHETIC | EASY | false | UNSUPPORTED_CATEGORY | 21 |
| qa-fixture-top | - | AUTHORIZED_FIXTURE | HARD | false | OCCLUSION_TOO_HIGH | 168 |
| qa-fixture-outerwear | - | AUTHORIZED_FIXTURE | HARD | false | UNSUPPORTED_CATEGORY | 226 |
| qa-fixture-dress | - | AUTHORIZED_FIXTURE | HARD | false | UNSUPPORTED_CATEGORY | 58 |
| qa-fixture-bottom-jeans | - | AUTHORIZED_FIXTURE | HARD | false | UNSUPPORTED_CATEGORY | 75 |
| qa-fixture-accessory | - | AUTHORIZED_FIXTURE | HARD | false | UNSUPPORTED_CATEGORY | 131 |
| qa-fixture-footwear | - | AUTHORIZED_FIXTURE | HARD | false | UNSUPPORTED_CATEGORY | 135 |
| qa-fixture-non-fashion | - | AUTHORIZED_FIXTURE | MEDIUM | false | UNSUPPORTED_CATEGORY | 40 |
