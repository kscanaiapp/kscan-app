# RP-108 — staging Edge Function parity against BASELINE_5

**As of 2026-09-07.** Read-only observation of K Scan AI Staging
(`yzqjvdfgefveprobvvyw`) compared against
`888cdef4a826712c17e554765560c08010e20342` (BUILD34_REPAIR_BASELINE_5).

This is a **point-in-time record, not an authority.** It goes stale the moment
anything is deployed. Its purpose is that the outstanding redeploy list is
explainable from source instead of remembered — the method below re-derives it
in full, and the method, not this table, is the thing to trust.

## Method

For each governed function, the deployed file set was read from the Supabase
Management API (`get_edge_function`, read-only), each deployed file's path was
mapped back to its repository path, and each file was SHA-256'd and compared to
the working-tree copy at BASELINE_5. Parity is byte equality across the whole
mapped set; a file that fails to map or is absent locally makes the result
**inconclusive, never a pass**.

No function was deployed, invoked, redeployed or deleted. Nothing was written
to staging or production by the lane that produced this file.

## Result

| Function | Staging version | Deployed (UTC) | Parity | Differing files |
|---|---|---|---|---|
| `scan-identify` | 61 | 2026-08-31T14:50 | **NO** | 8 of 40 |
| `commerce-watch-refresh` | 6 | 2026-09-03T11:59 | **NO** | 6 of 12 |
| `kplus-activate` | 15 | 2026-09-01T00:50 | **NO** | 1 of 3 |
| `kplus-reconcile-revenuecat` | 15 | 2026-08-31T14:22 | **NO** | 1 of 3 |
| `stylechat-generate` | 122 | 2026-09-04T00:31 | YES | 0 of 52 |
| `vto-generate` | 9 | 2026-09-04T01:00 | YES | 0 of 16 |
| `apple-credential-link` | 54 | 2026-08-12T18:18 | YES | see note |
| `apple-revoke-credential` | 52 | 2026-08-12T18:28 | YES | see note |

The remaining 15 governed functions were triaged by comparing each deploy
timestamp against the newest commit touching that function's manifest-declared
bundle set; none had source newer than its deployment. That triage is weaker
evidence than a byte comparison and is recorded as such — the two functions it
flagged and the two it cleared were both checked directly, and it agreed with
the byte comparison in every case.

**Apple pair note.** Both were deployed on 2026-08-12 from a GitHub Actions
checkout of this repository, before their source was brought under governance by
`c1ce1e8c` (a port of the already-deployed source, +365 lines, no deletions,
unmodified since). Their four shared `_shared/appleAuth/*` bundle files were
verified against staging: `config.ts` byte-for-byte identical, the other three
confirmed by distinguishing markers. `apple-credential-link/index.ts` alone was
not byte-compared in this lane.

## What the drift is

`scan-identify` is behind by four accepted Build 34 commits, all of them
commerce/multi-item correctness work:

- `83283128` defer commerce on multi-item detection responses
- `eef959a9` stop garment 1's identity leaking onto later garments
- `c4cbf8ca` widen the weak-query garment vocabulary to the real taxonomy
- `4188565e` preserve truthful offer currency (Lane E, in BASELINE_5)

`commerce-watch-refresh` shares the Lane E commerce files above and is
additionally behind on `pushDelivery.ts` (Lane A device-delivery revocation).

Both `kplus-*` functions bundle `_shared/revenuecat/revenueCatClient.ts` and are
behind `b8914b51`, which added the `retireMirroredEntitlement` cleanup path
(+103 lines). Neither function calls it — the addition serves the deletion/purge
path — so the behavioural delta for these two slugs specifically is nil; the
source delta is not.

> Lane G's earlier finding that the latency-critical model/prompt path was
> effectively equivalent remains true and is **not** evidence of deploy parity.
> The drift above is in commerce routing, garment identity, currency
> truthfulness and push delivery, none of which that finding covered.

## Status

**Not deployed by RP-108.** The governed deployment path
(`scripts/deploy-staging-function.mjs`) requires the Supabase CLI, Deno, and
`SUPABASE_ACCESS_TOKEN` / `SUPABASE_STAGING_URL` / `SUPABASE_STAGING_ANON_KEY`.
None was present in the environment RP-108 ran in, so a governed redeploy could
not be performed. Deploying by any other route — for instance a Management API
call — would have skipped the preflight, the manifest parity check, the
`deno check`, the deployment provenance artifact and the rollback path, which is
exactly the unattributable deployment the governed path exists to prevent.

Four functions therefore still require a governed staging redeploy from
BASELINE_5 or later before staging can be said to run the accepted Build 34
source: `scan-identify`, `commerce-watch-refresh`, `kplus-activate`,
`kplus-reconcile-revenuecat`.

Production was read only. No production deployment is proposed here.
