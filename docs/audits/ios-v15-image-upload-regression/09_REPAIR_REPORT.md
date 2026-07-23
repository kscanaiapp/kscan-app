# 09 — Repair Report

## Branch

`fix/ios-v15-image-upload-regression` (from v15 SHA `32addd5`)

## Localized repair

| File | Change |
|---|---|
| `services/privacyImageSanitizer.js` | Restore passthrough contract (`mode: 'passthrough'`, return input) |
| `services/privacyImageUpload.ts` | Re-enable availability; restore metadata-stripped JPEG re-encode |
| `services/scanIdentification.ts` | Remove unsatisfiable `privacyProof` gate; attest `localPrivacyFiltered` |
| `__tests__/eliseVisualContext.test.js` | Align assertions to restored contract |
| `__tests__/scanIdentification.test.js` | Remove fail-closed proof tests; keep abort/lifecycle coverage |
| `__tests__/imageUploadRegression.test.js` | New harness |
| `__tests__/fixtures/image-upload/*` | Required fixtures |
| `app.json` | `ios.buildNumber` 15 → **16** |

## Preserved

Scanner multi-image/multi-item/selected-item, Recent Scans, Save All, Dressing Rooms, Shared Rooms, Elise/StyleChat, Signature Style, image provenance/digest/session continuity, Gemini routing, Edge Functions, auth/quota/legal surfaces.

## Not changed

Backend Edge Function behavior, Supabase policies, Expo SDK upgrades, architecture refactors.

## Severity addressed

- **Blocker / P1:** Image upload & analysis blocked for gallery + camera + Elise attachments
