# 08 — DR-1 Defect Repair Log

## F-1 — Scan Result Object saves mislabeled `catalog_product`, losing Scanner provenance

| Step | Record |
| ---- | ------ |
| 1. Evidence | `services/scanResultDressingRoom.ts::buildDressingRoomSaveSource` never forwarded `scanResultObject.id`; `services/styleObjects.ts::buildProductMatchSnapshot` hardcoded `kind: 'catalog_product'` for every caller, including the Scan Result Object path. |
| 2. Root cause | The canonical extension builder in `buildProductMatchSnapshot` was written generically for the (then only known) catalog-save case and was never updated when the Scan Result Object adapter was wired to share the same function. |
| 3. Smallest complete repair | Add optional `scanId`/`selectedItemId`/`kind` passthrough to `ProductMatchSnapshotSource`; have `scanResultDressingRoom.ts` set `scanId` + `kind: 'scanner_single'`; have `buildProductMatchSnapshot` honor `kind: 'scanner_single'` only when a real `scanId` also accompanies it (prevents spoofing), else always fall back to `'catalog_product'`. |
| 4. Regression tests added | `__tests__/dressingRoomSavePolicy.test.js`: "genuine catalog save stays catalog_product with no scanId," "Scan Result Object save is tagged scanner_single with scanId preserved," "a stray 'kind' without 'scanId' cannot spoof scanner_single." `__tests__/scanResultActivation.test.js`: "save bridge tags the source with the scan's own id and kind: scanner_single." |
| 5. Implementation | Commit `3f62e41` on `feature/dressingrooms-canonical-item-contract-v1`. Files: `types/styleObjects.ts`, `services/scanResultDressingRoom.ts`, `services/styleObjects.ts`, plus the two test files above. |
| 6. Focused validation | `node --test __tests__/dressingRoomSavePolicy.test.js __tests__/scanResultActivation.test.js` → 3 new + 1 new = 4 new tests pass; both files' pre-existing tests (28 + 12) also re-verified passing. |
| 7. Broad suite | 155/155 across all 11 test files that import any DR-1-touched module (baseline 31 DR-1-focused + 124 across the remaining 7 dependent files). |
| 8. Old-client compatibility | The change is additive-only on `ProductMatchSnapshotSource` (new optional fields); `ProductShelf.tsx`'s existing call sites pass no `scanId`/`kind`, so `kind` resolves to the original `'catalog_product'` default — verified by a dedicated regression test asserting exactly that. No column, no required field, no API shape change. |
| 9. Rollback | Revert commit `3f62e41` (or disable `DRESSING_ROOM_CANONICAL_ITEM_V1`/`DRESSING_ROOM_DEDUPE_V1`, which already made the entire canonical-extension code path a no-op before this repair and still does — the repair only changes what gets written *inside* that already-flagged extension, not whether it runs). |
| 10. Disposition | **REPAIRED AND VERIFIED.** |

## F-2 — Test-execution blocker (missing `typescript` module in sandboxed `node_modules`)

| Step | Record |
| ---- | ------ |
| 1. Evidence | `node --test` failed with `Cannot find module 'typescript'`; `npm install` failed in place with `EPERM: unlink node_modules` on the audit sandbox's FUSE-mounted worktree. |
| 2. Root cause | Sandbox/environment condition — mounted `node_modules` was unpopulated and the mount does not support the unlink `npm install` needs to rebuild it in place. Not a repository defect. |
| 3-5. | N/A — no source repair applicable or needed. |
| 6. Workaround | Installed `typescript@~5.9.2` to a scratch directory outside the mounted worktree and ran tests with `NODE_PATH` pointed at it. No repository file changed. |
| 10. Disposition | **EXTERNAL GATE — NOT SOURCE-REPAIRABLE** (sandbox limitation; does not affect a normal development machine). |

## F-3 — Public preview carries no commerce fields

| Step | Record |
| ---- | ------ |
| 1. Evidence | `get_public_room_preview` SQL function selects a fixed field list that excludes `snapshot_payload`/`purchaseOptions` entirely. |
| 2. Root cause | Pre-existing design, predates `f73d4147`; outside DR-1's changed-file footprint. |
| 3-9. | N/A — not a DR-1 regression; redesigning the public preview contract is outside this audit's authorization ("do not redesign Scanner, Closet, Dressing Rooms, or Elise"). |
| 10. Disposition | **FALSE POSITIVE (as a DR-1 defect) — WITH EVIDENCE**, documented as a pre-existing product gap for E-4 planning purposes only. |

## F-4 — Account-deletion cascade coverage

| Step | Record |
| ---- | ------ |
| 1. Evidence | `scripts/process-deletion-request.js::USER_DATA_RESOURCES` enumerates every Dressing-Room-adjacent table plus storage prefixes; DR-1's one new table (`scan_commerce_events`) has no `user_id` and needs no entry. |
| 2-9. | N/A — no gap found. |
| 10. Disposition | **NOT REPRODUCIBLE — WITH EVIDENCE** (the addendum's hypothetical "incomplete deletion cascade" P1 does not apply; verified complete for everything DR-1 touches). |

## F-5 — `shared_room_item` Elise evidence kind reachability

| Step | Record |
| ---- | ------ |
| 1. Evidence | `attachments.ts::isOwnedSourceType` rejects `'shared_room_item'` at parse time (`ATTACHMENT_INVALID`), before `eliseRoomItemEvidence.ts`'s kind-mapping helper is ever consulted for it. |
| 2-9. | N/A — fails closed as designed; matches the documented client-activation gate. |
| 10. Disposition | **NOT REPRODUCIBLE — WITH EVIDENCE.** |

## Summary

| Finding | Severity | Disposition |
| ------- | -------- | ----------- |
| F-1 | P1 | REPAIRED AND VERIFIED |
| F-2 | — (execution blocker) | EXTERNAL GATE — NOT SOURCE-REPAIRABLE |
| F-3 | — (informational) | FALSE POSITIVE (as DR-1 defect) — WITH EVIDENCE |
| F-4 | — (informational) | NOT REPRODUCIBLE — WITH EVIDENCE |
| F-5 | — (informational) | NOT REPRODUCIBLE — WITH EVIDENCE |

No confirmed P0 was found. No confirmed, source-repairable P2 within DR-1's
changed-file footprint was found during the areas this audit was able to
exercise (see `01_DR1_HOSTILE_AUDIT_OVERVIEW.md` for the explicit list of
what could and could not be executed in this sandbox). Migration replay and
Deno test execution remain EXTERNAL GATE — NOT SOURCE-REPAIRABLE for the same
reason as F-2 (no Docker/Postgres/Deno runtime available here); the live
production migration-ledger and security-advisor checks that *were* possible
without those tools were performed and found no DR-1-introduced issue.
