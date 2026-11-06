# Handoff claim verification

Point-in-time evidence supersedes historical handoff claims; source flags, deployed functions and signed clients remain separate.

| Claim | Verdict | Current evidence / limits |
|---|---|---|
| Backend3efcb6cb/mobile840ba88e/integration authority heads | VERIFIED | Authenticated fetch; final-source-state.json; RP-108 isolates Build34 |
| PR635-643 listed merges and targets | VERIFIED | Exact per-PR JSON records; no assumption that a merge mounts a feature |
| PR643 customer ScanResultV2 actually invokes discovery and renders shelf | VERIFIED on pre-freeze/prepared candidate; authoritative integration INCOMPLETE | app/scan route -> app.js -> ScanResultV2 hook383/shelf756; no published-binary claim |
| All intended sources converged into final release authority | CONTRADICTED | Candidate prepared, zero campaign repair merges;65a remains authority |
| Production discovery function deployed/activation complete | CONTRADICTED | Current inventory has28 functions, discovery absent; organic/badge flags false |
| Staging discovery v5/JWTtrue | VERIFIED metadata |40 functions, ACTIVEv5, digest0aa15215b90f44d0bf507be7bf51229eec683118c3f6fb04c02ea1166f51fc09; byte-to-source invocation parity unverified |
| Production migration20261029125521 applied | VERIFIED | Authenticated read-only Management API migration ledger; both projects hold it |
| Brand voice Production activation complete | VERIFIED flag/source presence only; output/customer activation UNVERIFIED | ELISE_BRAND_VOICE_V1_ENABLED=true; function inventory; no current output/artifact binding |
| Image mission flag/prompt attachment log proves all request modes | UNVERIFIED as universal claim | SCAN_IMAGE_PRODUCT_MISSION_V1_ENABLED=true; source contract tests; actual mode-specific log/output evidence not retrieved |
| Organic/badge flags true | CONTRADICTED | Both false in non-sensitive Production readback |
| All sponsorship flags remain false | VERIFIED flags | Placements, sandbox and shadow allfalse; no commercial program activated |
| Similarity75 /160examined /8returned | VERIFIED source/tests; runtime boundary UNVERIFIED | Canonical discovery engine/contracts/PGlite eligibility tests; no seeded merchant catalog or live request fabricated |
| Existing-user paywall fixed and purchases/restores operational | VERIFIED bounded source routes/fixtures; device/runtime UNVERIFIED | Shared acquisition/member sheet and hosted paywall platform tests; no real purchase/restore |
| US prices0.99monthly/9.99annual and one-month trials | VERIFIED current store state | Live connected get_product_store_state reads for all4 products,2026-10-29; Apple READY_TO_SUBMIT; existing price cohorts not asserted |
| Historical Gemini disclosure defect fully resolved | CONTRADICTED in authority/runtime | #645/#649/#653/#654 prepared; no merges/deployments; durable withdrawal source now tested, copy/rollout approval pending |
| Speech delay/missing animation fixed on device | UNVERIFIED | New cross-layer timing bug reproduced and repaired in source#652;85 focused tests; no physical-device sync claim |
| Interactive Packing calendar complete | VERIFIED source interaction fixtures; device UNVERIFIED | iOS/Android taps/cancel/back/leap/DST tests; plan cache is actor-bound local30days, not backend trip history |
| Watchlist monitoring and push operational | UNVERIFIED | Protected6-hour GitHub schedule exists; recent pending/cancelled runs, no delivery proof; Supabase cron/pg_net absent |
| PostHog inactive | CONTRADICTED as project-wide claim | Four event names seen in last30days in project571577; current binary/environment/full taxonomy still unverified |
| PostHog source replay/autocapture disabled, lifecycle conditional | VERIFIED reviewed source/tests | Project recording opt-in true is separate; no recording/session contents fetched or claims of absence |
| Universal on-device image masking | UNVERIFIED | Actual Scanner pipeline tested with injected native artifacts; detector pixels/hardware and all alternative flows not certified; PhotoVTO intentionally separate |
| All other historical customer-live/readiness claims | UNVERIFIED | Per-feature matrix retains exact untested scopes; no inherited PASS |
