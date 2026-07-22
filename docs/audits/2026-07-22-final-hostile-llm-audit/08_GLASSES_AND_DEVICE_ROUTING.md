# Glasses and device routing

## Intended canonical routing

```text
glasses image → authenticated phone/bridge → scan-identify image mode → Gemini 3.6 Flash
glasses text  → authenticated phone/bridge → scan-identify TextScan mode → Gemini 3.5 Flash-Lite
Elise request → authenticated phone/bridge → stylechat-generate → Gemini 3.6 Flash
```

Meta and Google XR source were inspected as evidence-only workspaces because both contained user changes. Their accepted contracts route through canonical mobile/Supabase paths rather than maintaining an approved independent provider implementation.

## Hidden public demo caller

A deployed Vercel Meta demo still contained a hidden caller to the legacy Render analysis service. It was repaired so:

- mock behavior is the default;
- live mode requires an explicit private gate;
- the Render hostname is absent from the production bundle;
- source commit `489bde…` is deployed in `dpl_5Y7H5…` and merged at `32a63a…`.

## Hardware limitation

No physical Meta or Google XR hardware run was available. The Android emulator camera cannot provide meaningful live-fashion imagery, so the final image proof used the system photo picker and a non-sensitive fixture. Device contract/source tests passed, but hardware authentication, image masking, timeout, and navigation remain unverified.

Status: source and simulator/contract routing repaired; hardware evidence incomplete.
