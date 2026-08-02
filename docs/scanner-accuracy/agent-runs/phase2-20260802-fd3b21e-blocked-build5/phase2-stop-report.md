# Phase 2 current product baseline certification — blocked

Phase 2 stopped before provider execution because the supplied governing product tips contain active Build 5 ancestry. The benchmark branch itself contains no Build 5 commit, but the protected read-only release sources do.

## Opening proof

```text
EVALUATION-ONLY DEPENDENCY MANIFEST: YES
ROOT package.json MODIFIED: NO
ROOT LOCKFILE MODIFIED: NO
IOS / ANDROID NATIVE DEPENDENCIES MODIFIED: NO
EAS BUILD INPUT CHANGED: NO
EDGE FUNCTION CLOSURE CHANGED: NO
PRODUCTION BUNDLE CHANGED: NO

MANUAL NODE_MODULES JUNCTION REQUIRED: NO
CLEAN INSTALL FROM EVALUATION MANIFEST: PASS
FULL OFFLINE SCANNER SUITE: PASS
ROOT DEPENDENCY DIFF: NONE
PRODUCTION CLOSURE DIFF: NONE
```

The clean checkout discovered 526 tests: 525 passed, zero failed and one optional certified-source transcription test skipped because no full mobile-plus-Edge `KSCAN_CERT_V140_ROOT` was declared. The private Edge-only snapshot was not misrepresented as that full root. Sharp resolves only from `tools/scanner-evaluation/node_modules` at version `0.35.3`; the directory is not a junction and root resolution fails.

## Governing source evidence

| Platform | Protected branch | Tip | Clean / upstream | Active scanner |
| --- | --- | --- | --- | --- |
| Android | `validation/android-build25-prebuild-readiness` | `4d0ceb40655a7de7a2430bc4014ef0710aa8ca66` | Clean, `0/0` | `legacy-selected-item` |
| iOS | `validation/ios-build25-prebuild-readiness` | `5c761ba7df2cfc7b22efa3d3326dca46850e02f0` | Clean, `0/0` | `legacy-selected-item` |

Both scanner paths are single-dispatch and candidate-disabled:

`hooks/useKScan.js` → `runScannerIdentification` → `identifyScanImage` → `supabase.functions.invoke('scan-identify')`.

## Stop evidence

Android tip `4d0ceb…` has both of these ancestors:

- `a195788103bd8d9e47ef3c53dc5a95732cd159ac` — `feature/build5-android-today-with-elise-v1`
- `8370129cbe2ca5453a9b6c7e0b2c43044d9fad82` — `propagate/android-recent-scan-closet-separation-build5`

iOS tip `5c761b…` has both of these ancestors:

- `9dc3364fc3fe3091445395bb47b9ae3d269873d7` — `feature/build5-ios-today-with-elise-v1`
- `41c2c1d2435d3b90dd07f470e72eafa8273acd66` — `propagate/ios-recent-scan-closet-separation-build5`

This is active rather than merely dormant: all `preview`, `development` and `production` EAS profiles in both protected tips set the Today-with-Elise Build 5 parent, generated-greeting and weather flags to `"true"`.

The exact Build 2 post-audit tips and the Build 4 dormant scanner integration tip are not ancestors of the protected tips, while Build 5 tips are. Therefore these tips cannot honestly be certified as a clean Builds 1–4 line without owner clarification.

The Phase 2 charter names active Build 5 contamination and ambiguous Builds 1–4 lineage as stop conditions. No live smoke, token preflight or paid control run was started. No credential value was read or printed.

## Runtime comparison and reuse

Current product versus certified-v140 is **provider-payload-only** equivalent. Provider payload, prompt, model, generation config, schema and provider parser match. The mobile request contract is `legacy-selected-item` rather than V2, the Edge response-contract closure differs due to `identify_for_closet`, and Android mobile normalization differs from the certified/iOS transport.

Historical control results are therefore not reusable. A fresh governed 33-case development control would be required after the lineage stop is cleared.

## Dataset and contracts

- Private images: 115 total, 115 unique hashes
- Governed: 56 images / 40 cases
- Development: 33; holdout: 7; uncurated: 59
- Missing files, duplicate image hashes, duplicate case IDs, retired case IDs: 0
- Manifest SHA-256: `5b2db5b9c0edf6093dbd982c64297e61b3677b0bb54b0cdcf3e70be2eb7b13af`
- Frozen aggregate SHA-256: `77e90edfe33d013285616ab1fa591112254b119be13620b606bfb57f37924883`
- Scoring contract: `0.3.0`; source SHA-256 `c2c8a53233d8e35272e76bb7885cf5f388caeedf5a9bdda3adb514aefaf57f6a`
- Selection contract: `1.0.0`; contract SHA-256 `2a3b84e8af60dc2b43bcfb94b630ea2629e11933bbde69437ec0698f92d3a159`
- Taxonomy: `1.0.0`; SHA-256 `2417a9da3956860a11cd7016fad27ffa7cbeadd8765cc71efa3d124985e2a9d0`

This remains licensed-web-image pilot evidence, not evidence sufficient alone for production promotion.

## Required next action

The owner or physical-build manager must provide exact full iOS and Android Builds 1–4 governing SHAs with no Build 5 ancestry, or explicitly revise the Phase 2 boundary to authorize the current Build 5-inclusive protected tips. Until then:

- baseline locked: **NO**
- provider calls: **0**
- spend: **$0.00**
- candidate modified or activated: **NO**
- production or release branch modified: **NO**
- ready for Phase 3: **NO**
