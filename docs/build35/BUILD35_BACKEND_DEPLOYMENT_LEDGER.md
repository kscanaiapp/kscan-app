# Build 35 backend deployment ledger (Staging)

Recorded 2026-10-08 ET. Public-safe: Staging only. Live-environment deployment identities are delivered to the owner in the private report. Source of truth for "what is deployed" is a **retrieved-source byte comparison** (LF-normalised SHA-256 per file) or the governed workflow's own deployment manifest; a function name or version number alone is not evidence of parity.

All deployments went through `staging-controlled-deploy.yml` (one function per dispatch, preflight → source validation → deploy → health → synthetic tests → artifact; rollback only on failure, never triggered). The Staging project is `yzqjvdfgefveprobvvyw`.

## Functions deployed to Staging this session

| Function | Before → after | Source commit | Source hash (manifest) | verify_jwt | Health | Governed run | Readback |
|---|---|---|---|---|---|---|---|
| `kplus-activate` | v25 → **v26** | `5f54104c` | `BA04CC0E…` | true | 200 | [37850873292](https://github.com/kscanaiapp/kscan-app/actions/runs/37850873292) | retrieved source contains the SEC-B35-KPLUS-001 hold; governed entrypoint path; live probe [37852548431](https://github.com/kscanaiapp/kscan-app/actions/runs/37852548431) |
| `commerce-watch-refresh` | v16 → **v17** | `5f54104c` | `F70F749E…` (index.ts) | false | 200 | [37851317660](https://github.com/kscanaiapp/kscan-app/actions/runs/37851317660) | **16/16 files byte-identical** to the merged authority (before: 14 of 15 identical, `index.ts` differed, `watchEntitlementGuard.ts` absent) |
| `kplus-revenuecat-webhook` | none → **v1** | `5f54104c` | `7D16EEEE…` | false | 405 on GET (expected) | [37857152668](https://github.com/kscanaiapp/kscan-app/actions/runs/37857152668) | unauthenticated POST → `503 not_configured` (fail-closed, no secrets set) |
| `kplus-offer-redeem` | none → **v1** | `5f54104c` | `E783A1F6…` | true | 200 | [37857510271](https://github.com/kscanaiapp/kscan-app/actions/runs/37857510271) | unauthenticated → 401 |
| `kplus-revenuecat-pull-reconcile` | none → **v1** | `cfe64d13` | `7DCAECB0…` | true | 200 | [37857807383](https://github.com/kscanaiapp/kscan-app/actions/runs/37857807383) | unauthenticated → 401 |
| `purchase-import-extract` | none → **v1** | `cfe64d13` | `873B1F70…` | true | 200 | [37858133743](https://github.com/kscanaiapp/kscan-app/actions/runs/37858133743) | unauthenticated → 401; feature flag off by default |

`5f54104c` and `cfe64d13` differ only in two test files and the manifest's tree hashes (PR #530); no function bundle changed between them.

## Functions verified unchanged (byte comparison against the merged authority)

| Function | Staging version | Files compared | Result |
|---|---|---|---|
| `vto-generate` | v19 | 18 | 18 identical |
| `stylechat-generate` | v133 | 52 | 52 identical |

## Honest limits
- The four newly deployed K+ functions are **unconfigured** on Staging (no webhook Authorization secret, offer-code HMAC secret, RevenueCat server keys or product classification). They fail closed. No purchase, webhook, offer-redemption or pull-reconcile lifecycle was exercised, so this is **parity, not certification**.
- The Premium runtime-proof harness (`security/scripts/build35-premium-runtime.js`) was deliberately not used: it reveals Staging service keys through the CLI and writes GitHub environment secrets.
- Migrations: the six October versions were present and identical in Staging and the live project when read earlier today; nothing was replayed or applied by this campaign.
- Test-only PRs on the authority: #530 merged (`cfe64d13`); #529 (the K+ hold live probe) is open and is intentionally **not merged while a live-environment deployment of `kplus-activate` is pending**, because that deployment workflow requires the then-current authority tip.

## Rollback
`rollback_strategy: redeploy_prior_source` is recorded in every deployment manifest; `scripts/rollback-staging-function.mjs` exists. The prior `kplus-activate` v25 and `commerce-watch-refresh` v16 sources are the authority base `a2d8d6bb`.
