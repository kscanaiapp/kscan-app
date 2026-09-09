# Repair 06 — release-authority convergence (2026-09-09)

**What this lane did:** brought the already-built, already-deployed, already-
certified Repair 06 backend onto the Build 34 release candidate line by
provenance-preserving cherry-pick, so the RC is backend source-complete for
terminal account deletion.

**What it deliberately did not do:** change this checkout's deployment role,
deploy anything, or touch production.

---

## 1. Authorities

| Item | Value |
|---|---|
| Release authority | `release/kscan-pre-freeze-v1` @ `d16834a4` (PRs #368, #369, #370, #371 all ancestry-verified) |
| Backend deployment authority | `rebuild/backend-authority-v2` @ `323a3c86` — unchanged, still exactly the SHA the client source cites |
| Build 35 contamination | none on either line — PR #327 head `7a8d0ccf` is not an ancestor of either |

---

## 2. Why the convergence needed three commits, not one

Repair 06's own source is small and purely additive: the `deletion-status`
function, `_shared/deletion/statusReceipt.ts`, migration
`20260908230000_deletion_status_receipt.sql` and config — **+427 lines across 5
files, zero deletions, zero conflicts**.

But Repair 06's *intake binding* lives in
`supabase/functions/handle-user-deletion/handler.ts`, and that file did not
exist on the release line. Cherry-picking the Repair 06 commit alone was tried
first and produced an incoherent tree: git reported
`DU handler.ts` ("deleted in HEAD"), leaving a 911-line handler that nothing
calls beside the retired 198-line monolithic `index.ts` that still did the
work and knew nothing about receipts — plus four other conflicts.

`handler.ts` was created by `5cd3f72b` (RP-06A). That commit is not
cosmetic and it is not unrelated drift: its own message records that the
release line's `handle-user-deletion` was **pre-Build-29 source** that wrote
`status: 'pending'` rows with no grace window, no restoration token and no
session/auth controls — matching **neither** deployed environment (staging v76,
production v84). Converging Repair 06 necessarily corrects that.

So the minimal provenance-safe chain is three commits, and the charter's
preferred end state (`REPAIR06_PRESENT_ON_RELEASE=YES` **and**
`UNRELATED_BACKEND_DIFF_IMPORTED=NO`) is not simultaneously reachable. The
owner chose to import the full chain in a dedicated PR so the intake change
stays reviewable on its own rather than buried inside a certification lane.

### Cherry-picked, provenance preserved (`git cherry-pick -x`)

| Order | Upstream | Subject |
|---|---|---|
| 1 | `5cd3f72b` | fix(deletion): reconcile canonical deletion lifecycle source (RP-06A) |
| 2 | `c0b01481` | fix(deletion): account for the restored production auth controls in the governed inventory |
| 3 | `63bd6ecd` | feat(deletion): add post-auth terminal status capability (**Repair 06**) |
| 4 | `a9d13699` | test(deletion): record deletion-status in the spelled-out parity gate |
| 5 | `b9fa469f` | docs(backend): finish the governed-count narrative for deletion-status |

Each commit retains its `(cherry picked from commit …)` line.

---

## 3. Conflict resolutions — both governance-critical

Only `config/backend-authority.json` and `config/edge-function-manifest.json`
conflicted. No source file conflicted.

**`config/backend-authority.json`.** The upstream side of the conflict carries
the *deployment authority* identity. Taking it verbatim would have flipped this
branch's `role` to `backend-deployment-authority` and rewritten
`canonicalBranchNote` to claim "this field is now self-referential —
rebuild/backend-authority-v2 is this branch". Both are false here and the
second is dangerous. Resolution:

- `role` — kept `integration-convergence-non-authoritative` (it sat outside the
  conflict region and was not touched);
- `canonicalBranchNote` — kept the release-line text, which correctly points at
  the authority as a *different* branch;
- `governedFunctionCount` — took `24`, because `deletion-status` source now
  exists in this tree and `verify-backend-authority.js` requires config to equal
  `GOVERNED_FUNCTIONS.length`;
- `governedFunctionCountSource` — took the upstream "Now 24 (Repair 06)"
  narrative but corrected one clause that has since become false: it said
  deletion-status "is deployed nowhere", which was true when written and stopped
  being true when Staging Promotion 01 deployed v1 to staging on
  2026-09-09T01:12Z. It remains deployed nowhere in production.

**`config/edge-function-manifest.json`.** Conflicts were provenance timestamps
and content hashes, which depend on this tree. Rather than hand-pick hashes the
manifest was regenerated with the governed generator
(`node scripts/generate-edge-function-manifest.js`), and
`--check` then reports it up to date.

---

## 4. Proof the converged source is the certified source

The point of converging rather than re-implementing is that staging's
certification transfers. It does, byte for byte:

| Artefact | Expected (Staging Promotion 01 record) | Converged tree |
|---|---|---|
| migration `20260908230000_deletion_status_receipt.sql` | `b8eda3f6f8258d9176fb0a965a211960d0c09a4d10d742a71273a6ccdb20c5e0` | **identical** |
| `deletion-status/index.ts` | `d1186f04…` | **identical** |
| `_shared/deletion/statusReceipt.ts` | `7d698484…` | **identical** |

Manifest bundle hashes against the canonical authority:

| Function | Result |
|---|---|
| `deletion-status` | **MATCH** (`03ba8050…`, 2 bundle / 3 tree files) |
| `handle-user-deletion` | **MATCH** (`077c13e7…`, 5 bundle / 6 tree files) |
| `process-account-deletions` | **MATCH** (`bcc17302…`) |

Six other functions (`stylechat-generate`, `privacy-correction-request`,
`privacy-data-export`, `product-search-deals`, `search-vinted-secondhand`,
`staging-health`) still differ from the authority. That is **pre-existing**
release-line drift: each was verified to differ at the release tip before this
convergence, and this convergence touched none of them.

---

## 5. Deployment posture is unchanged, and that was verified

```
$ node scripts/deploy-edge-functions.js
── Step 1/7  deployment authority ──────────────────────────────
FAIL  config/backend-authority.json declares role
      "integration-convergence-non-authoritative", not
      "backend-deployment-authority". This checkout is explicitly marked
      non-authoritative.

ABORTED  Nothing was deployed.        (exit 1)
```

`deletion-status` may still only be deployed from `rebuild/backend-authority-v2`.
Converging the source did not grant this line deployment authority, and
`deletion-status` remains deliberately absent from
`security/scripts/staging-deployment-allowlist.js`.

---

## 6. Terminal-purge authority — the ordering proof

The charter calls this the most important missing proof: can
`purgeAuthorized` become true before the governed server-side purge actually
finished? **No.** Proven from the worker and the RPC, which are byte-identical
on both branches.

`process-account-deletions` reaches the terminal mark only after, in order:

1. Apple credential revocation (throws if blocked);
2. `revokeAllSessions`;
3. `supabase.auth.admin.deleteUser(userId)` — the Auth identity is destroyed;
4. confirmation that the `deletion_requests` row survived, `user_id` forced NULL;
5. **post-delete residual verification** — one count query per registry resource
   (~44); any non-`survive_auth_delete` resource with a nonzero count **throws**
   (`purge_verification_failed`). This is deliberately *after* the auth delete,
   not before;
6. RevenueCat mirror retirement (throws if blocking);
7. only then `mark_deletion_request_purged`.

`mark_deletion_request_purged` sets `status='purged'` **and** `purged_at=now()`
in a **single UPDATE** gated on `status='purging'`, so there is no window in
which one is set without the other. Every failure before step 7 throws into
`schedule_deletion_retry_or_fail`, which writes `failed` (attempts exhausted) or
`deactivated` (retry scheduled) — never `purged_at`. Both map to
`purgeAuthorized: false`.

The invariant is enforced twice more: by
`deletion_requests_purged_at_status_check` in the database, and again by the
endpoint, which re-checks rather than trusting the constraint.

```
EARLY_PURGE_AUTHORIZATION_FOUND=NO
```

---

## 7. What is still not proven, and why

Live HTTP invocation of the staging endpoints remains impossible from an agent
session: every request to `yzqjvdfgefveprobvvyw.supabase.co` is refused by the
egress proxy with `CONNECT tunnel failed, response 403`, recorded proxy-side as
`connect_rejected — gateway answered 403 to CONNECT (policy denial)`. The proxy's
documentation classes that as an organisation policy denial to be reported, not
retried or routed around.

Staging Promotion 01 hit the identical block and closed as much of the gap as is
closable without the network hop: it pulled the **deployed bytes** back from
staging, confirmed they hash identically to canonical, executed them under a
capture harness against **real staging lifecycle rows**, and negative-controlled
the harness by mutating the deployed source and confirming the mutations were
caught. 18 checks, 0 failures, fixtures removed with the row-id digest identical
before and after.

Still outstanding, and outside what any sandboxed lane can do:

- **live HTTP** invocation of `deletion-status` and `handle-user-deletion`;
- a **live destructive intake test** — Staging Promotion 01 recorded
  `NO GOVERNED DISPOSABLE ACTOR`: intake revokes sessions, bans the Auth user for
  the full grace window and schedules irreversible purge, and staging has no
  governed disposable actor for that. Inventing one was outside that lane and is
  outside this one.

Both need an operator session with egress to the staging host and a governed
disposable staging actor.

---

## 8. Production

```
PRODUCTION_TOUCHED=NO
PRODUCTION_PROMOTION=PENDING_APPLE_CLEARANCE
```

No production function, migration, secret, EAS variable, flag or database was
read or written by this lane. Build 33 remains under Apple review. Production
still has no `deletion-status`, no `status_receipt_hash` column and no
`deletion_requests_status_receipt_hash_uidx`.
