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

### 7.3 Terminal-purge sequencing is NOT yet independently re-verified

§12 of the charter requires proving that `process-account-deletions` writes
`status='purged'` + `purged_at` only *after* the governed server-side purge
completes. The endpoint's half of that is certified above (it authorises on
nothing but those two fields). The worker's half — that it never sets them
early — is the responsibility of the backend authority lane that built it, and
re-proving it end-to-end needs the live invocation path that §7.2 blocks.

---

## 8. Production

```
PRODUCTION_TOUCHED=NO
PRODUCTION_PROMOTION=PENDING_APPLE_CLEARANCE
```

No production function, migration, secret, EAS variable, feature flag or
database was read or written. Build 33 remains under Apple review.
