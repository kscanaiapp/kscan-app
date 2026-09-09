# Post-auth deletion-status contract (Repair 06 → Repair 07)

Backend contract for the client capability that observes an account deletion's
terminal outcome. **Repair 06 implements the backend only.** No iOS or Android
change is part of it; this document is what Repair 07 will implement against.

---

## 1. Why authentication cannot be the status authority

Deletion intake deliberately destroys the caller's ability to authenticate:

- it revokes all sessions,
- it bans the Auth user for the full 30-day grace window,
- and `process-account-deletions` eventually deletes the Auth identity outright.

So by the time the interesting answer exists — *did my deletion actually
complete?* — there is no session, no Auth user, and no identity provider left to
authenticate against. A JWT-gated status endpoint would be answerable only
during the window when its answer is never yet terminal.

The capability is therefore the credential.

---

## 2. The receipt

| Property | Value |
|---|---|
| Format | `ksdel_v1_<43 base64url chars>` |
| Entropy | 32 random bytes = **256 bits** |
| Total length | exactly 52 characters |
| Server storage | `SHA-256(receipt)`, lowercase hex — **never the raw value** |
| Authority | read-only, one lifecycle; cannot restore, delete, or read account data |

It is **not** the restoration token and must never be conflated with one: the
restoration token can *reverse* a deletion, is single-use, and arrives by email.

### Client requirements

1. Generate with a cryptographically secure RNG — 32 bytes, base64url, unpadded,
   prefixed `ksdel_v1_`.
2. **Persist it locally BEFORE issuing the deletion request.** This is the whole
   point (§4).
3. Store it where the pending-deletion marker lives; keep it until the lifecycle
   resolves.
4. Never log it, never put it in a URL, never send it to analytics.

---

## 3. Intake — `POST /functions/v1/handle-user-deletion`

Authenticated, unchanged in every other respect. One **optional** new field:

```json
{ "statusReceipt": "ksdel_v1_..." }
```

Response gains:

```json
{
  "statusReceiptBound": true,
  "statusReceipt": "ksdel_v1_..."
}
```

- `statusReceiptBound` — always present when a receipt was involved. Reports
  truthfully whether the hash actually reached the database.
- `statusReceipt` — returned **only** when the server minted one (i.e. the client
  supplied none) *and* it was durably bound. A client-supplied receipt is never
  echoed back: the client already has it, and echoing a secret adds a copy to
  every log and proxy on the return path.

### Behaviour matrix

| Client | Result |
|---|---|
| Sends no body (released clients) | Unchanged. Server mints a receipt and returns it. |
| Sends an unparseable body | Treated as "no receipt". Never an error. |
| Sends a valid `statusReceipt` | Hash bound atomically with the lifecycle row; not echoed. |
| Sends a malformed `statusReceipt` | **400**, and no lifecycle is created — a client that believes it holds a capability is never told its deletion succeeded without one. |
| Retries with the same receipt on an existing lifecycle | Idempotent success. |
| Presents a different receipt for an already-bound lifecycle | `statusReceiptBound: false`. Never rotated, existing hash never disclosed. |
| Hits a project without the migration applied | Deletion still succeeds; `statusReceiptBound: false`. |

That last row matters: `status_receipt_hash` is introduced by a source-only
migration, so intake degrades rather than failing. Losing the capability costs a
status lookup; failing the insert would cost the user the ability to delete
their account at all.

---

## 4. Network-loss recovery (why the client pre-creates the receipt)

```
client generates receipt R
client persists R locally
        ↓
POST handle-user-deletion { statusReceipt: R }
        ↓
backend commits lifecycle + SHA-256(R), revokes session
        ↓
✗ response lost in transit
        ↓
client still holds R  →  can still resolve status later
```

Without a client-precreated capability this path strands the client
permanently: the session is gone and the only copy of the receipt died with the
lost response. This is covered by a mandatory executable test.

---

## 5. Status endpoint — `POST /functions/v1/deletion-status`

`verify_jwt = false`. **POST, not GET**: the capability is a secret, and query
strings reach access logs, proxy telemetry, browser history and caches. The
operation is read-only; the method choice is about where the secret ends up.

```http
POST /functions/v1/deletion-status
Content-Type: application/json

{ "receipt": "ksdel_v1_..." }
```

### Responses

```jsonc
// in progress
{ "state": "pending", "purgeAuthorized": false }

// deletion did not happen; account is usable
{ "state": "restored", "purgeAuthorized": false, "restoredAt": "..." }

// deletion failed
{ "state": "failed", "purgeAuthorized": false }

// TERMINAL
{ "state": "purged", "purgeAuthorized": true, "purgedAt": "..." }
```

| Condition | Status |
|---|---|
| Malformed receipt / missing field / wrong content type / oversized body | `400 {"error":"invalid_request"}` |
| Well-formed but unknown receipt | `404 {"error":"not_found"}` |
| `GET`, or any non-`POST` | `405` |
| Database unreachable | `503` — never a terminal answer |

`400` and `404` bodies are deliberately generic and interchangeable: they must
not reveal whether an account exists, was deleted, or never existed.

Every response carries `Cache-Control: no-store`.

The response contains **only** the fields above. Never `user_id`, `email`,
`subject_ref`, `restoration_token_hash`, `status_receipt_hash`, Auth id,
provider cleanup detail, worker leases, legal-hold reasons, or failure messages.

---

## 6. State mapping

Derived from the real vocabulary in `deletion_requests_status_check`, not an
assumed list.

| Internal status | Public state | `purgeAuthorized` |
|---|---|---|
| `pending`, `processing`, `deactivated`, `purging`, `legal_hold` | `pending` | false |
| `completed` | `pending` | false |
| `restored`, `cancelled`, `rejected` | `restored` | false |
| `failed` | `failed` | false |
| `purged` **and** `purged_at` present | `purged` | **true** |
| anything unrecognised | `pending` | false |

Two mappings deserve their reasoning:

- **`completed` → `pending`.** Canonical lists it in `BLOCKING_DELETION_STATES`
  (`_shared/deletion/common.ts`) meaning "being deleted, or left mid-deletion" —
  not "finished". Such rows carry no `purged_at` and must never authorise a purge.
- **`cancelled` / `rejected` → `restored`.** Canonical groups these with
  `restored` as the non-blocking terminal states in which the account remains
  usable. The client's action is identical in all three — clear the marker, keep
  the data.

---

## 7. The terminal rule

```
purgeAuthorized === true   if and only if
      status === 'purged'  AND  purged_at IS NOT NULL
```

Everything else is `false`, including:

| Case | Authorised? |
|---|---|
| `status='purged'`, `purged_at=NULL` | **NO** — claims terminal, cannot say when |
| `purged_at` present, `status≠'purged'` | **NO** — inconsistent, fail closed |
| `status='purging'` | **NO** — not finished |
| `legal_hold` | **NO** |
| `failed` | **NO** |
| `restored` | **NO** |
| lookup failed / `503` | **NO** |

The database's `deletion_requests_purged_at_status_check` constraint currently
makes the two inconsistent rows unreachable. The endpoint checks them anyway: a
constraint can be dropped by a later migration, and this boolean authorises
irreversible destruction of a user's data on their device.

---

## 8. What Repair 07 should implement

```
generate receipt
  → persist locally BEFORE the deletion request
  → POST handle-user-deletion { statusReceipt }
  → user is signed out
  ...
  → later: POST deletion-status { receipt }
        purged   + purgeAuthorized true  → execute owner-scoped local purge
        restored                          → clear the marker, RETAIN local data
        failed                            → retain, surface support path
        pending                           → retain, poll again later
        404 / 400 / 503                   → retain; never purge on an error
```

Polling cadence, local purge scope, and UI are Repair 07's decisions. Repair 06
defines only the contract above.

Two client-side rules that are not negotiable:

1. **Never purge on anything but `purgeAuthorized === true`.** Not on a 404, not
   on a timeout, not on `state: "purged"` alone — the boolean is the authority.
2. **Retain the receipt until the lifecycle resolves.** It is not invalidated by
   restoration or by purge, precisely so the outcome stays observable.
