# Integration and activation matrix — PARTIAL

NOT AUDITED means no complete client-to-authority hostile audit. Regression suites do not confer lane completion. Device verification and customer-live evidence are NOT TESTED / NOT VERIFIED for every feature.

| Feature | Source evidence | Backend / flags | Client / tests | Final status |
|---|---|---|---|---|
| Authentication/onboarding | Inventoried: evidence/source-inventory.json; full trace pending | NOT AUDITED | NOT AUDITED | NOT AUDITED |
| Account/profile/privacy | Inventoried: evidence/source-inventory.json; full trace pending | NOT AUDITED | NOT AUDITED | NOT AUDITED |
| Scanner single/selected/multi-item | Inventoried: evidence/source-inventory.json; full trace pending | NOT AUDITED | NOT AUDITED | NOT AUDITED |
| TextScan | Inventoried: evidence/source-inventory.json; full trace pending | NOT AUDITED | NOT AUDITED | NOT AUDITED |
| VoiceScan | Inventoried: evidence/source-inventory.json; full trace pending | NOT AUDITED | NOT AUDITED | NOT AUDITED |
| Gemini image intelligence | Inventoried: evidence/source-inventory.json; full trace pending | NOT AUDITED | NOT AUDITED | NOT AUDITED |
| Primary commerce | Inventoried: evidence/source-inventory.json; full trace pending | NOT AUDITED | NOT AUDITED | NOT AUDITED |
| Black-owned discovery | Inventoried: evidence/source-inventory.json; full trace pending | NOT AUDITED | NOT AUDITED | NOT AUDITED |
| Partnership/ownership/sponsorship | Inventoried: evidence/source-inventory.json; full trace pending | NOT AUDITED | NOT AUDITED | NOT AUDITED |
| Elise/other stylists | Inventoried: evidence/source-inventory.json; full trace pending | NOT AUDITED | NOT AUDITED | NOT AUDITED |
| Speech/avatar animation | Inventoried: evidence/source-inventory.json; full trace pending | NOT AUDITED | NOT AUDITED | NOT AUDITED |
| Closet/cloud restore | Inventoried: evidence/source-inventory.json; full trace pending | NOT AUDITED | NOT AUDITED | NOT AUDITED |
| Private Dressing Room | Inventoried: evidence/source-inventory.json; full trace pending | NOT AUDITED | NOT AUDITED | NOT AUDITED |
| Shared Dressing Room | Inventoried: evidence/source-inventory.json; full trace pending | NOT AUDITED | NOT AUDITED | NOT AUDITED |
| Packing Intelligence | Inventoried: evidence/source-inventory.json; full trace pending | NOT AUDITED | NOT AUDITED | NOT AUDITED |
| Smart Watchlist/push | Inventoried: evidence/source-inventory.json; full trace pending | NOT AUDITED | NOT AUDITED | NOT AUDITED |
| Photo VTO | Inventoried: evidence/source-inventory.json; full trace pending | NOT AUDITED | NOT AUDITED | NOT AUDITED |
| Live Camera VTO | Inventoried: evidence/source-inventory.json; full trace pending | NOT AUDITED | NOT AUDITED | NOT AUDITED |
| K+ purchase/restore/entitlements | Inventoried: evidence/source-inventory.json; full trace pending | NOT AUDITED | NOT AUDITED | NOT AUDITED |
| Account deletion/restoration | Inventoried: evidence/source-inventory.json; full trace pending | NOT AUDITED | NOT AUDITED | NOT AUDITED |
| Notifications | Inventoried: evidence/source-inventory.json; full trace pending | NOT AUDITED | NOT AUDITED | NOT AUDITED |
| PostHog analytics | Inventoried: evidence/source-inventory.json; full trace pending | NOT AUDITED | NOT AUDITED | NOT AUDITED |
| Backend RLS/RPC/storage | Inventoried: evidence/source-inventory.json; full trace pending | NOT AUDITED | NOT AUDITED | NOT AUDITED |
| Release/native configuration | Inventoried: evidence/source-inventory.json; full trace pending | NOT AUDITED | NOT AUDITED | NOT AUDITED |
| Legal/store disclosures | Inventoried: evidence/source-inventory.json; full trace pending | NOT AUDITED | NOT AUDITED | NOT AUDITED |

## Bounded verified slices (not whole-feature PASS)

- Discovery pre-freeze mount VERIFIED: app/scan/index.tsx loads app.js; app.js:1218 selects ScanResultV2 under SCAN_RESULTS_V2_UI_ENABLED; ScanResultV2 invokes useBlackOwnedDiscovery and renders BlackOwnedDiscoveryShelf. Corrected earlier progress note: app/index.tsx is Home; app/scan/index.tsx is the Scanner route. Profile source enables Scan Results V2; effective signed-binary flags are unverified.
- Integration baseline lacks these discovery client additions. Final intended-feature integration: INTEGRATION INCOMPLETE.
- Production authenticated inventory: 28 functions, no black-owned-discovery. Backend deployed for discovery: FAIL. Staging: ACTIVE v5, verify_jwt=true, digest 0aa15215b90f44d0bf507be7bf51229eec683118c3f6fb04c02ea1166f51fc09. Deployed bytes not compared to approved source. Flags/invocations/catalog remain UNVERIFIED.
- Source discovery sponsorship flag always false; no claim of runtime flag readback.
- B35-G-001: malformed optional field fixture FAIL before / PASS after. Focused client/host 22 passed, 0 failed/skipped. Cancellation, ordering and supersession assertions in that suite pass with injected harness; not live-account proof.
- B35-C-001: legacy v1 marker and disclosure regression FAIL before / PASS after; 39 focused tests pass. Device and backend consent enforcement NOT TESTED.

## Required individual hostile probes

[evidence/mandatory-hostile-probes.json](evidence/mandatory-hostile-probes.json) enumerates every discovered backend entry point, processor candidate and stateful feature against all requested probe classes, with endpoint/probe/expected/actual/verdict/reason. These entries are NOT TESTED until individual target evidence is attributed. Existing suites have not been relabeled as exhaustive endpoint probes. Missing signed bundles prevent service-role *bundle* certification; unavailable synthetic A/B accounts prevent live IDOR claims.

Physical iOS/Android parity, revoked permissions, signed-URL expiry, real purchases/restore, push receipts, avatar timing and native VTO remain NOT TESTED.

Additional Lane F executed probe: all 18 Production endpoints marked verify_jwt=true returned HTTP 401 to an anonymous POST with an empty object. Evidence: evidence/anonymous-endpoint-probes.json. This verifies gateway rejection only, not authenticated IDOR, handler authorization, storage isolation or tampered-token rejection. Corresponding mandatory-probe cells updated individually. No authenticated/customer/provider operation requested.
