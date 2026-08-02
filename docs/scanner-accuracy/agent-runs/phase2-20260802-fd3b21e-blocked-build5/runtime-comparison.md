# Phase 2 runtime comparison

Status: **provider-payload-only equivalence; Phase 2 blocked before execution**.

The offline capture intercepted the provider request before network dispatch. It made zero external calls and compared immutable Git-object snapshots.

| Identity | Certified-v140 | Current product | Match |
| --- | --- | --- | --- |
| Source SHA | `f5f4ed2eda4984db0658c3209fece223acd33188` | Android `4d0ceb40655a7de7a2430bc4014ef0710aa8ca66`; iOS `5c761ba7df2cfc7b22efa3d3326dca46850e02f0` | No |
| Edge bundle SHA-256 | `28737e0c96047fa014c526886b32b3e5191283a9ed7441641da4d3b0ce632589` | `04e2c0786f3504e155c580fb816f71387ecf4c61be89da31eb705ad1fd6e0b68` | No |
| Provider request payload | `f330ebb18c0a5292cc9b32729bda79ce26cc9852b7e26da16a8cea9a7cc5a5f5` | Same | Yes |
| Rendered prompt | `6f2f4dd1c3c2e2d76dffb49fc24283ddfaf49a836f527c02ed2b82ef19b7dd1d` | Same | Yes |
| Model | `gemini-3.6-flash` | Same | Yes |
| Generation config | `b6862722990cdfd3b387eaaf2d6a0e9880036b1fedab17fefd07c7db56c2d22e` | Same | Yes |
| Response schema | `894722a6500756bd6eeae0e4beb4712a6b223c6ce4045d599f8d46682a5861a8` | Same | Yes |
| Provider parser | `332b713a7b7c516cf2d63fb4500c1a32a035464d862f783a9bc22f31b0ef8f79` | Same | Yes |
| Mobile request contract | `fashion-identification-v2` | `legacy-selected-item` | No |
| Edge response contract | `6548f8e9b4f3e24a806f0dcf7875eaf8a62b751f0f85568ac69dc8110563a08c` | `be3011c26bbb1cc799630ea7b9edc824a885b16847378567eec4de59711efbf0` | No |
| Mobile transport | Certified/iOS blob `fab646b…` | Android blob `4a55462…`; iOS blob `fab646b…` | Platform drift |
| Feature flag | V2 reference path | V2 unset/default false; backend true | No |

Meaningful source drift is narrow but real:

- `supabase/functions/scan-identify/index.ts`, `scanHelpers.ts`, the provider payload, prompt, schema, sampling configuration, model and provider parser are unchanged.
- `_shared/fashionIdentificationV2.ts` adds the `identify_for_closet` intent, Closet entry paths, non-commerce gating and Scanner-artifact suppression for that intent. Those additions change the Edge response-contract closure without changing the selected legacy provider request.
- `services/scannerScanRequest.ts` is byte-identical to certified-v140.
- Android `services/scanIdentification.ts` changed detection normalization and selected-item guards; iOS remains byte-identical to certified-v140 at that file.
- The current build-time selector leaves `EXPO_PUBLIC_SCANNER_IDENTIFICATION_V2_ENABLED` unset, so both platforms select `legacy-selected-item`. No client request field can activate the dormant candidate.
- Scanner UI projection is `hooks/useKScan.js` -> `mapScanIdentifyToAnalysis` -> `app.js::saveScan` -> `services/library.js`; Edge Scanner-domain persistence remains intent-gated by `shouldCaptureScanArtifacts`.

Historical control reuse decision: **NO**. Provider-payload equivalence alone is insufficient because the mobile request contract and response-contract closure differ. A fresh control would be required after an uncontaminated governing Builds 1–4 tip is supplied.

Execution did not proceed because both supplied governing release tips contain active Build 5 ancestry and Build 5 flags enabled in all EAS profiles. This is an explicit Phase 2 stop condition.
