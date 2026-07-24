# Backend Quality Tune Fixtures (v120)

Deterministic, text-based fashion fixtures for regression comparison between
v119-equivalent behavior (quality tune OFF) and tuned behavior (ON).

This is **not** a statistical accuracy study. Do not claim production accuracy
from these results.

## Files

- `fixtures.json` — neutral garment cases + hostile edge cases
- `baseline-v119.json` — metrics captured with quality tune disabled
- `comparison.json` — before/after comparison output
- `README.md` — this file

## Categories covered

black moto jacket, navy blazer, wide-leg trousers, pleated skirt, white sneakers,
ankle boots, structured handbag, knit sweater, patterned dress, ambiguous outerwear

## Hostile cases

generic provider label, missing subtype, conflicting category/subtype, duplicate
descriptors, color synonyms, malformed arrays, empty strings, speculative brand,
verbose descriptors, duplicate URLs/SKUs, category mismatch products, missing
image/URL, malformed price

## Privacy

Fixtures contain only synthetic fashion text. No real tester images or user data.
