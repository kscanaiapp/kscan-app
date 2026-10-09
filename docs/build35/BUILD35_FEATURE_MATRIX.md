# Build 35 feature matrix

Recorded 2026-10-08 ET. Authority: mobile `integration/build35-v1-convergence` @ `b791ce0f`; backend `rebuild/backend-authority-v2` @ `5f54104c`.

**Reading this table.** Each cell is `true`, `false`, `partial`, `n/a` or `unverified`. `true` means evidence exists *for the evidence class named in the cell*. `unverified` means this campaign did not re-run the check — it is not a pass. Classes are never mixed: source, Linux CI, local tests, Staging runtime, provider-backed runtime, physical device, signed artifact, store purchase. **No physical-device, signed-artifact or store-purchase evidence exists, so every `IOS`, `ANDROID` and `COMMERCIAL` cell is `false`.** `RELEASE_ENABLED` is what the store build profiles turn on, not a certification claim.

Store profiles are verified on every push by `scripts/check-build35-release-profile.js`: `production` (the mandated `eas build --profile production`) ships held features dark by absence with the Today parent explicitly `false`; `build35-release` sets every hold explicitly `false`. EAS remote `production` environment variables contain only `GOOGLE_SERVICES_JSON`, so no remote override can enable a hold.

| Capability | SOURCE | BACKEND | STAGING | IOS | ANDROID | COMMERCIAL | RELEASE_ENABLED |
|---|---|---|---|---|---|---|---|
| Core Scanner V2 | true (CI) | true (`scan-identify` bundle identical on Staging and the live project) | unverified | false | false | n/a | **true** (existing) |
| Text Scan | true | unverified | unverified | false | false | n/a | **true** |
| Elise text + visual | true | partial (see VTO) | unverified | false | false | n/a | **true** |
| Signature Style | true | unverified | unverified | false | false | n/a | **true** |
| Local Closet | true | n/a | n/a | false | false | n/a | **true** |
| Dressing Rooms | true | unverified | unverified | false | false | n/a | **true** |
| Multi-image Scanner | true (#519, #526 merged; 640 focused tests; 4 defects fixed) | unverified (server flag not readable) | false | false | false | n/a | **false (hold)** |
| Packing Intelligence | true (#520 merged) | partial | **false**: contextual VTO moves the governed `stylechat-generate` source (fingerprint `7131b140…` → `c4c643b5…`), so the earlier Staging proof no longer authorizes; re-proof needs the single remaining owner-gated invocation | false | false | n/a | **false (hold)** |
| Smart Watchlist, manual tracking | true (#520 merged) | true: provider-dispatch entitlement guard deployed, Staging v17 byte-identical (16/16) | partial: unentitled actor not claimed by the live worker (`claimed: 0`); active-K+ dispatch intentionally not run (would spend the held allowance) | false | false | n/a | **false (hold)** |
| Autonomous Watchlist worker + push | partial | partial | false | false | false | n/a | **false in the client**; the server-side hold is tracked in the private owner report |
| Contextual generative VTO | true (#521 merged) | true (Staging v19 18/18, v133 52/52 byte-identical; hostile review found no P0–P3) | partial: 22 zero-spend controls + 12 log-audit controls PASS (earlier session); **paid generation 0 of 1, never run** | false | false | n/a | **false (hold)** |
| Cloud Closet cross-device sync | partial (gated) | unverified | false | false | false | n/a | **false (hold)** |
| Stylist Speech | true (client hold enforced, #525) | partial (the function is callable by already-shipped clients) | false | false | false | n/a | **false (hold)** |
| Voice Scan | partial | unverified | false | false | false | n/a | **false (hold)** |
| Today With Elise | true (dormant) | n/a | n/a | false | false | n/a | **false — HARD HOLD** |
| Complimentary K+ Early Access | true: closed by default on the server (#528); Staging runtime-proven | true on Staging (v26) | true: probe run 37852548431 | false | false | n/a | **false** (client flag `false`, server controls unset) |
| K+ subscription (monthly / annual) | partial | partial: the webhook / offer-redeem / pull-reconcile / purchase-import functions are being brought to Staging parity (see the deployment ledger) but are **not configured or exercised** | false | false | false | **false**: store products lacked required metadata and review information, Play credentials were not connected (earlier-session read-only snapshots, not re-read) | not part of this evidence |
| K+ lifetime | partial | n/a | n/a | false | false | false (no native lifetime product) | **must not be presented as purchasable** |

## Cross-lane facts
1. **Packing proof invalidation** is the repository's designed tripwire working: proofs bind to a fingerprint of governed source, and contextual VTO changed that source. The merged branch pins `packing = false` with no new evidence.
2. **#520's governance registry vs #525 and #521**: neither PR is wrong alone, but combined they failed `premiumValueGovernance`; resolved by a 10-line targeted refresh (see the integration ledger).
3. **Production store profile** is verified semantically rather than rewritten: six suites pin production-by-absence and one pins the Today children as owner-authorized dormant config.
