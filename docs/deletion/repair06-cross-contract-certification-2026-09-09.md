# Repair 06 ↔ Repair 07/09 cross-contract certification (2026-09-09)

**Status: contract certified at source level. Live staging re-certification NOT
performed by this lane — blocked, see §7. No production access of any kind.**

This lane was chartered to *implement* the Repair 06 deletion-status backend and
certify it in staging. It found that both halves already exist: the backend is
implemented on the canonical backend deployment authority branch, and it is
already deployed to the governed staging project. What this lane therefore did
instead is the part that was genuinely still open — proving that the deployed
backend contract and the newly-merged iOS/Android clients actually agree — plus
recording the two governance/environment blockers that stop a live re-run.

---

## 1. Authority

| Field | Value |
|---|---|
| Release authority | `release/kscan-pre-freeze-v1` @ `d16834a49cbec78be84a15ada41bcd14a170f24c` |
| PR #368 (iOS Repair 07) | present, ancestry-verified |
| PR #369 (dependency remediation) | present, ancestry-verified |
| PR #370 (N-1 push activation gate) | present, ancestry-verified |
| PR #371 (Android Repair 09 parity) | present, ancestry-verified |
| Build 35 contamination | **NO** — PR #327 head `7a8d0ccf` is not an ancestor (`git merge-base --is-ancestor`, not a commit-message read) |
| Backend deployment authority | `rebuild/backend-authority-v2` @ `323a3c86738f57ac826859178ddb7b065c71e4d5` |

---

## 2. Repair 06 already exists, and is already deployed

Nothing in this section was created by this lane; all of it was found.

### Source — on the backend authority branch, not this one

| Artefact | Path (on `rebuild/backend-authority-v2`) |
|---|---|
| Status endpoint | `supabase/functions/deletion-status/index.ts` |
| Endpoint config (`verify_jwt = false`) | `supabase/functions/deletion-status/config.toml` |
| Receipt generation / hashing | `supabase/functions/_shared/deletion/statusReceipt.ts` |
| Intake binding | `supabase/functions/handle-user-deletion/handler.ts` |
| Schema | `supabase/migrations/20260908230000_deletion_status_receipt.sql` |
| Backend contract tests | `__tests__/deletionStatusContract.test.js` |
| Client-facing contract | `docs/deletion/terminal-status-client-contract.md` |

The merged client cites this exact provenance already:
`services/deletion/statusReceipt.ts` names
`rebuild/backend-authority-v2 @ 323a3c86` as the source of its format.

### Deployment — already live on staging (`yzqjvdfgefveprobvvyw`, "K Scan AI Staging")

| Item | State | Observed |
|---|---|---|
| `deletion-status` Edge Function | **ACTIVE**, version 1, `verify_jwt = false` | deployed 2026-09-09T01:12:01Z |
| `handle-user-deletion` | **ACTIVE**, version 76 | redeployed 2026-09-09T01:23:02Z, 11 min later |
| `20260908230000_deletion_status_receipt` | **applied** | present in the migration ledger |
| `deletion_requests.status_receipt_hash` | `text`, nullable | present |
| `deletion_requests_status_receipt_hash_uidx` | unique, partial | present |

---

## 3. Live staging security posture (read-only verification)

| Check | Result |
|---|---|
| RLS on `public.deletion_requests` | **enabled** |
| Grants to `anon` | **none** |
| Grants to `authenticated` | **none** |
| Grants to `service_role` | SELECT / INSERT / UPDATE / DELETE |
| Raw receipt column | **does not exist** — only `status_receipt_hash` |

The unauthenticated endpoint therefore reaches the row through a service-role
lookup inside the function, never through anonymous table access. This is the
architecture §14 of the charter asks for, already in place.

---

## 4. The certified contract

Derived from the deployed backend source and the merged client source, not from
any prior summary.

| Field | Value |
|---|---|
| `DELETION_REQUEST_ENDPOINT` | `POST /functions/v1/handle-user-deletion` (authenticated) |
| `REQUEST_RECEIPT_FIELD` | `statusReceipt` (optional) |
| `RECEIPT_FORMAT` | `ksdel_v1_` + 43 unpadded base64url chars = 52 chars, 32 CSPRNG bytes |
| `BINDING_ACK_FIELD` | `statusReceiptBound: boolean` (truthful, including `false`; absent ⇒ backend predates Repair 06) |
| `STATUS_ENDPOINT` | `POST /functions/v1/deletion-status`, `verify_jwt = false` |
| `STATUS_REQUEST_FIELD` | `receipt` — and nothing else; no owner, user id, email or request id is accepted |
| `ALLOWED_STATUS_VALUES` | `pending` \| `restored` \| `failed` \| `purged` |
| `PURGE_AUTH_FIELD` | `purgeAuthorized: boolean` — true **iff** `status='purged'` AND `purged_at IS NOT NULL` |
| `TERMINAL_TIMESTAMPS` | `purgedAt` (on purged), `restoredAt` (on restored) |
| `JWT_REQUIRED_AFTER_DELETION` | **No** — the capability is the credential |
| `NOT_FOUND_SEMANTICS` | `404 {"error":"not_found"}` — retain, never purge |
| `UNSUPPORTED_SEMANTICS` | gateway `404` without the `not_found` code ⇒ `endpoint_unavailable`; `405` likewise |
| `MALFORMED_RESPONSE_SEMANTICS` | client fails closed to `malformed` ⇒ retain |

Server storage is the SHA-256 digest only. The raw receipt exists on the device
and in the body of two requests, and nowhere else.

---

## 5. Cross-contract certification result — 16/16

The real backend handler (authority branch source, unmodified) was driven into
the real merged client modules (`deletionStatusClient.ts`,
`terminalDeletionDecision.ts`, unmodified), across the **real** 11-value status
vocabulary read live from staging's `deletion_requests_status_check`.

| Internal status | Public state | `purgeAuthorized` | Client action |
|---|---|---|---|
| `pending` | pending | false | retain |
| `processing` | pending | false | retain |
| `completed` | pending | false | retain |
| `deactivated` | pending | false | retain |
| `purging` | pending | false | retain |
| `legal_hold` | pending | false | retain |
| `failed` | failed | false | retain |
| `restored` | restored | false | release (marker cleared, **data kept**) |
| `cancelled` | restored | false | release |
| `rejected` | restored | false | release |
| **`purged`** (with `purged_at`) | **purged** | **true** | **purge** |
| inconsistent: `purged`, no `purged_at` | purged | false | retain |
| inconsistent: `purged_at` under `purging` | pending | false | retain |
| unknown future status | pending | false | retain |
| unknown receipt (404) | — | — | retain |
| lookup failure (503) | — | — | retain |

- **Exactly one** row in the entire matrix authorises irreversible local
  destruction. The double lock holds end to end.
- **Zero** response-shape violations: every response carried only
  `state` / `purgeAuthorized` / `purgedAt` / `restoredAt`, and every response
  carried `Cache-Control: no-store`.
- `400 {"error":"invalid_request"}` and `404 {"error":"not_found"}` are generic
  and interchangeable — no account-existence oracle.

Because Repair 09 proved iOS and Android execute the *same* client modules with
no platform branch, this single certification covers both platforms.

`IOS_REPAIR07_COMPATIBLE=YES` · `ANDROID_REPAIR09_COMPATIBLE=YES`

The matrix is locked against future drift by
`__tests__/deletionStatusClientContract.test.js` on this branch.

---

## 6. Database-enforced invariants (staging, verified live)

```
deletion_requests_purged_at_status_check
    (purged_at IS NULL AND status IS DISTINCT FROM 'purged')
 OR (purged_at IS NOT NULL AND status = 'purged')

deletion_requests_restored_at_status_check
    (restored_at IS NULL AND status IS DISTINCT FROM 'restored')
 OR (restored_at IS NOT NULL AND status = 'restored')

deletion_requests_restored_purged_mutex_check
    NOT (restored_at IS NOT NULL AND purged_at IS NOT NULL)
```

The terminal half of the double lock is thus enforced twice: by the database
constraint, and again by the endpoint, which does not rely on it.

---

## 7. What this lane did NOT do, and why

### 7.1 It did not deploy — this branch is structurally forbidden from deploying

`config/backend-authority.json` on `release/kscan-pre-freeze-v1` declares:

```json
{ "role": "integration-convergence-non-authoritative",
  "canonicalBranch": "rebuild/backend-authority-v2" }
```

and `scripts/deploy-edge-functions.js` refuses at Step 1/7 unless the checkout
declares `role: "backend-deployment-authority"`. The authority branch's own
manifest records the rule explicitly: *"release/kscan-pre-freeze-v1 remains
integration-convergence-non-authoritative and its own deploy tooling continues
to refuse deployment; this branch is now the sole checkout that may deploy."*

Any Repair 06 deployment or redeployment must therefore be run from
`rebuild/backend-authority-v2`, not from this lane. This is a correct control
and was not worked around.

Consistently, this branch's `config/edge-function-manifest.json` governs 23
functions and deliberately does **not** include `deletion-status`; the authority
branch governs 24 and does.

### 7.2 It did not run the live staging scenario matrix — egress policy

Scenarios A–G in the charter all require HTTP-invoking the staging Edge
Functions. Every request from this session to
`yzqjvdfgefveprobvvyw.supabase.co` is refused by the session's egress proxy:

```
403  Host not in allowlist: yzqjvdfgefveprobvvyw.supabase.co
```

The proxy's own documentation classes this as an organisation egress-policy
denial and instructs that it be reported rather than retried or routed around.
Supabase **Management/database** access (used for every read in §2, §3 and §6)
travels a different, permitted channel — which is why the schema, grants,
constraints, migration ledger and function inventory could all be verified
while the endpoints themselves could not be called.

No synthetic accounts were created, so there is no synthetic residue to clean
up: **zero synthetic users, zero synthetic deletion rows, zero synthetic
receipt bindings** were introduced by this lane.

### 7.3 Terminal-purge sequencing — RESOLVED 2026-09-09 (was open in the first revision)

This section originally recorded the worker's half of the terminal rule as
unproven. It has since been proven from source, and the answer is clean:

```
EARLY_PURGE_AUTHORIZATION_FOUND=NO
```

`process-account-deletions` reaches the terminal mark only after, in order:
Apple credential revocation (throws if blocked) → `revokeAllSessions` →
`supabase.auth.admin.deleteUser(userId)` → confirmation the `deletion_requests`
row survived with `user_id` forced NULL → a **post-delete residual sweep** that
issues one count query per registry resource (~44) and **throws**
(`purge_verification_failed`) if any non-`survive_auth_delete` resource still
has rows → RevenueCat mirror retirement (throws if blocking) → **only then**
`mark_deletion_request_purged`.

That sweep runs deliberately *after* `auth.admin.deleteUser`, not before, so a
cascade FK that silently failed is caught rather than reported as success.

`mark_deletion_request_purged` writes `status='purged'` **and**
`purged_at=now()` in a **single UPDATE gated on `status='purging'`**, so neither
can exist without the other. Every failure before the mark routes into
`schedule_deletion_retry_or_fail`, which writes `failed` (attempts exhausted) or
`deactivated` (retry scheduled) — never `purged_at`. Both map to
`purgeAuthorized: false`.

The invariant is enforced three times over: by the worker's ordering, by
`deletion_requests_purged_at_status_check` in the database, and again by the
endpoint, which re-checks rather than trusting the constraint.

The worker and RPC are byte-identical on the release line and the backend
authority, so this proof holds for both.

### 7.4 Staging Promotion 01 already certified the deployed bytes

Found after the first revision of this record: the backend authority carries
`docs/certification/staging-promotion-01-2026-09-09.md`, which deployed Repair
06 to staging and certified it. It hit the **identical** egress block described
in §7.2 and closed as much of the gap as is closable without the network hop —
it pulled the **deployed payload back** from staging, confirmed both files hash
identically to canonical (`index.ts` `d1186f04…`, `statusReceipt.ts`
`7d698484…`), executed those deployed bytes under a capture harness against
**real staging lifecycle rows** (captured with `to_jsonb` over the same
projection the function selects), and negative-controlled the harness by
mutating the deployed source and confirming the mutations were caught.

**18 checks, 0 failures**, including an INVARIANT sweep over all 24 combinations
of the full status vocabulary × (`purged_at` null / present): `purgeAuthorized`
is true for exactly one. Six synthetic fixtures were used and removed, with the
`md5` digest of all row ids identical before and after.

What that record explicitly does **not** claim, and this lane cannot supply
either: live HTTP invocation (§7.2), and a live destructive intake test — it
recorded `NO GOVERNED DISPOSABLE ACTOR`, since intake revokes sessions, bans the
Auth user for the full grace window and schedules irreversible purge.

### 7.5 Source convergence

The gap this record identified in §7.1 — Repair 06 source absent from the
release line — has been closed by a separate, provenance-preserving PR. See
`docs/deletion/repair06-release-convergence-2026-09-09.md`.

---

## 8. Production

```
PRODUCTION_TOUCHED=NO
PRODUCTION_PROMOTION=PENDING_APPLE_CLEARANCE
```

No production function, migration, secret, EAS variable, feature flag or
database was read or written. Build 33 remains under Apple review.
