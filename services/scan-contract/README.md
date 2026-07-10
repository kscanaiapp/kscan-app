# services/scan-contract

Logical, versioned shared contract for scan-analysis requests and responses.

## Scope

- TypeScript types for scan requests, responses, fashion attributes, and product matches.
- Dependency-free validators and type guards.
- Legacy adapters for migration and compatibility verification.
- Wearable summary formatter.
- Synthetic fixtures for tests.

## Non-goals

- Not a separate npm package, workspace, or separately resolved module.
- Does not perform network requests.
- Does not access camera, microphone, or real user images.
- Not imported by existing mobile screens or API clients in this phase.

## Contract version

`SCAN_CONTRACT_VERSION = '1.0.0'`

## Key exports

- `ScanRequest`, `ScanResponse`
- `FashionAttributes`, `ProductMatch`, `ScanError`
- `validateScanRequest`, `validateScanResponse`
- `toSharedScanRequest`, `normalizeLegacyAnalyzeResponse`, `toLegacyCompatibleResult`
- `formatWearableScanSummary`

## Test usage

Tests transpile these TypeScript modules with the project's `typescript` dev dependency.
