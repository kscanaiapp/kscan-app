# Issue #704 — bounded K+ checkpoint

Mobile `2c2c9da41121daa43f4f657ca1aaa2fcf7b7cb27`; canonical backend `2846fd147fc36b72404372919ee8d1e88421da75`, fetched November 3, 2026. Evidence checkpoint read: PR #646 head `49ab7fada3639587911849080ff33c6ad17fd9df`.

**30 controls:** 19 new actual-source endpoint/webhook cases PASS, six original cells reviewed from retained composed evidence (five proposed source PASS, one unresolved), and five optional real PostgreSQL cases PASS. Proposed original matrix mapping: **20 source PASS / five NOT TESTED across 25 unique original IDs**; five SQL controls are supplementary and earn zero duplicate matrix credit. Manager adjudication required; official matrix untouched. No confirmed application defect or runtime repair.

[Ledger](ledger.json), [raw handler results](raw.jsonl), [real SQL results](sql-concurrency.tap), [source identity](source-equivalence.json), [RevenueCat readback](revenuecat-config.json), [retained evidence inventory](prior-inventory.json), [hashes](hashes.json).

The endpoint harness captures the existing `Deno.serve` callback and substitutes only the shared Auth/account-status/RPC transport module. Provider HTTP replies are synthetic; the provider parser/reconciler, request validation, webhook normalization and authentication execute from source. Deno has **no network permission**. HMAC controls include valid, missing, tampered and stale signatures. An injected lease/deduplication response does not prove database concurrency. Those matrix cells remain open.

The five existing SQL tests ran unchanged through native concurrent Docker/psql sessions on PostgreSQL 17, using nine unchanged K+ migrations and minimal synthetic auth/profiles. Four tests assert actual transition/grant state; the fifth asserts actor lock-hash distinction only. This is neither deployed Supabase nor real RevenueCat delivery. [Database identities and cleanup](sql-cleanup-and-identities.json) show zero fixture users, grants and transitions. The isolated `kscan-issue704-disposable` container was stopped and removed after execution; no shared container was changed.

Excluded initial attempts are retained: the endpoint harness first incorrectly required `canonicalRefreshRequired` on error responses; the initial minimal SQL Auth fixture omitted `is_anonymous`. Both were harness errors, corrected without changing application code or tests. Final results supersede those attempts.

RevenueCat read-only inspection confirms `k_plus`, Apple/Google monthly+annual mappings, current `default` offering and both packages. Store credentials are marked configured, not validated by purchase. Only a production webhook is listed. Sandbox delivery, deployed authorization/signing secret presence, classification settings and native binary SDK configuration remain unverified. No customer records, transactions or dashboard settings were changed.

| Journey step | Status | Evidence / remaining requirement |
|---|---|---|
| User-facing paywall | PARTIAL | Retained mounted actual Sheet/Step/hosted/fallback source; capability availability was injected. Current build flags/runtime benefit availability unverified. |
| Product offering | PASS (configuration only) | Connector shows default monthly/annual packages and both stores. Native product retrieval unverified. |
| Purchase or restore | PARTIAL | Actual source SDK adapter/composed fixtures; platform agents must supply store sandbox purchase and cross-account restore proof. |
| SDK entitlement/account binding | PARTIAL | Retained identity binding and account-switch fences; no current binary/native identity migration test. |
| Backend authority | PASS (bounded source + local SQL) | Canonical-only client confirmation, webhook fail-closed controls and ordering/idempotency assertions. Deployed runtime not certified. |
| Premium feature unlock | PARTIAL | Canonical authority wiring reviewed; no fresh paywall-to-real-premium-operation proof. |
| Expiration/revocation | PARTIAL | Real SQL newer expiration/renewal ordering; full store revocation through device refresh remains unverified. |

**Release decision:** evidence supports continued internal candidate testing, not purchase certification or production release. No new demonstrated security blocker; activation and sandbox dependencies above remain open. Platform owners need to establish a sandbox event route and deployed configuration, then capture exact-binary purchases/restoration and premium unlock/revocation. Account isolation and real provider quota enforcement remain qualified as listed in the ledger.

Reproduce from repository root (PowerShell):

```powershell
deno run --no-check --allow-read --allow-env docs/release/evidence/issue704/run.ts
docker run --detach --name kscan-issue704-disposable --network none --tmpfs /var/lib/postgresql/data -e POSTGRES_PASSWORD=issue704-synthetic-local-only postgres:17
# Wait for pg_isready; bootstrap only a fresh disposable container.
node docs/release/evidence/issue704/bootstrap.cjs
$env:KSCAN_DISPOSABLE_SUPABASE_DB_CONTAINER='kscan-issue704-disposable'
node --test --test-reporter=tap __tests__/kplusProviderPullConcurrency.test.js
```

Test/evidence-only files changed. TestSprite was not run: no app feature/fix, and the shared task board records the owner's no-credit waiver. No broad suite, deployment, migration application to a shared environment, paid call, build, merge or pricing change.
