# K Scan AI — Shared Backend + Meta Hybrid Hostile Audit

Independent hostile audit of the shared K Scan wearable backend and the Meta Ray-Ban
client. Conducted 2026-08-22 → 2026-08-23. No prior report was taken at face value;
every claim below is re-derived from source, from the live staging deployment, or from
a built artifact, and each is labelled with the evidence that supports it.

---

## Executive Verdict

**FAIL — HYBRID HOSTILE AUDIT FOUND UNRESOLVED P0–P3 SOFTWARE BLOCKERS**

| | |
|---|---|
| **P0** | 0 |
| **P1** | 2 — both FIXED |
| **P2** | 7 — 4 FIXED, 3 OPEN |
| **P3** | 4 — 3 FIXED, 1 OPEN |
| **P4–P10** | 15 recorded, 3 fixed incidentally |
| **P0–P3 FIXED** | 9 |
| **P0–P3 OPEN** | 4 |
| **SHARED BACKEND** | Source/deploy reproducibility PROVEN byte-for-byte. Cross-client isolation holds. One live correctness defect fixed in source but **not deployed**. Schema is **not** reproducible from the committed migration. |
| **META CLIENT** | Was **completely non-functional** — two independent faults stopped pairing before it began. Both fixed and live-verified. Structural, lifecycle and privacy paths otherwise sound. |
| **DAT RUNTIME** | BLOCKED (#191). No DAT symbol exercised; artifact-verified absent from the build. |
| **AUTH E2E** | BLOCKED (#192). Nothing past `pair.approve` was exercised. |
| **EMULATOR** | Not used — no runtime path reachable past the auth wall. |
| **PHYSICAL HARDWARE** | Not attempted. |

### Top 3 risks

1. **Staging still discards every live commerce listing for wearable scans.** `wearable-scan` v6 selects its product array by testing whether the `similarityMatches` *key* exists — and `scan-identify` emits that key on every image response, empty or not. So `retail` is unreachable and `recommendedProducts` is dropped entirely: a scan with an empty catalog shelf shows the wearer nothing at all, even when real buyable listings came back. Fixed in source; **deploying is an owner action this audit deliberately did not take.**
2. **The committed schema cannot rebuild the deployed one.** The migration declares 3 CHECK constraints; staging has ~18, one of which *contradicts* the migration. This is not theoretical — it directly produced a release blocker (P1-02) that no source-built environment could have reproduced.
3. **A release-critical guard test is red on the frozen checkpoint** (#193), so the candidate cannot pass its own suite regardless of the repairs above.

### Next action

Owner decisions, in order: (a) deploy `wearable-scan` from `81f6b69`; (b) author the
wearable schema reconciliation migration; (c) resolve #193's packaging conflict;
(d) unblock #191/#192 so the DAT and authenticated halves can finally be tested.

---

## Frozen Checkpoints

| Repo | PR | Branch | Frozen SHA | State |
|---|---|---|---|---|
| `kscan-glasses-webapp` | [#2](https://github.com/kscanaiapp/kscan-glasses-webapp/pull/2) | `feature/meta-physical-device-candidate-v1` | `8b67161` | DRAFT / DO NOT MERGE |
| `kscan-app` | [#190](https://github.com/kscanaiapp/kscan-app/pull/190) | `feature/meta-physical-device-candidate-v1-mobile` | `5092f55` | DRAFT / DO NOT MERGE |

Both PRs remain **Draft / Do Not Merge**, verified after push.

## Starting SHAs

- `kscan-glasses-webapp` — `8b67161`
- `kscan-app` — `5092f55`

## Final SHAs

- `kscan-glasses-webapp` — **`81f6b69`** (2 commits)
- `kscan-app` — **`8ed5152`** (3 commits)

---

## Environment Under Test

| | |
|---|---|
| **Environment** | K Scan AI Staging (the designated hostile-test environment) |
| **Supabase project ref** | `yzqjvdfgefveprobvvyw` (us-west-1) |
| **Production (never attacked)** | `wyyuqfdxucjksghsmhry` — read-only schema check only, to establish that the wearable tables do not exist there |
| **Function endpoints** | `https://yzqjvdfgefveprobvvyw.supabase.co/functions/v1/{wearable-bridge,wearable-scan,wearable-save,wearable-open-on-phone,scan-identify}` |
| **Deployed versions at audit time** | `wearable-bridge` v4 · `wearable-scan` v6 · `wearable-save` v4 · `wearable-open-on-phone` v3 · `scan-identify` v42 |
| **Auth mode** | anon/publishable key only. **No user JWT was ever held** — no account was created (#192). |
| **Client build** | `com.kscanai.app` 1.0.1 / versionCode 29, minSdk 24, targetSdk 36, DAT off, `meta-physical-candidate` env |

> Note on the brief: it names `wearable-scan v4` as the deployed grouping fix. Live is
> **v6**. The deployed content matches committed source byte-for-byte regardless; the
> version number simply moved. It was hostile-tested, not redeployed.

---

# Part A — Shared Backend

## Source / Deploy Authority

**Evidence: LIVE STAGING VERIFIED (byte-for-byte hash comparison).**

Deployed bundles were pulled with `supabase functions download` and hashed against the
**raw git blobs** (`git cat-file blob`), so no `core.autocrlf` filtering could flatter
the result.

| File | Deployed SHA-256 (16) | Blob @ `8b67161` | Result |
|---|---|---|---|
| `wearable-scan/index.ts` | `41b3ae23aa436c58` | `41b3ae23aa436c58` | **identical** |
| `wearable-scan/normalize.ts` | `7bfa816b2b86c665` | `7bfa816b2b86c665` | **identical** |
| `wearable-save/index.ts` | `2852231369e26ea0` | `2852231369e26ea0` | **identical** |
| `wearable-open-on-phone/index.ts` | `47f622e07ef9d16c` | `47f622e07ef9d16c` | **identical** |
| `wearable-bridge/index.ts` | `cc4bd00d7a76b46c` | `2282e0b31c8b2f04` | differs — header only |

`wearable-bridge` differs **only** by a 25-line provenance comment at the top of the
committed file: `diff <(sed -n '26,$p' committed) deployed` is empty. The executable
body is identical.

`scan-identify` v42 is reproducible from `kscan-app` commit **`4250bae`**
(`feature/build32-multi-item-commerce-refinement-android`): every file in the deployed
bundle is byte-identical. The git tree carries three extra modules
(`fashionDetectionProvider.ts`, `selectedItemBoundary.ts`, `similarClothesProvider.ts`)
that the CLI's dependency walk did not bundle.

**Would redeploying current source regress live behaviour?** No — for the four wearable
functions it would add a comment and change nothing. This closes the function-source
half of **XR-DRIFT-01 (#189)**, which was written when these three functions had no
committed source at all.

**Live staging was not mutated to resolve drift.** No function was redeployed.

### But the schema is a different story — P2-05, OPEN

**Evidence: LIVE STAGING VERIFIED (`pg_constraint` / `information_schema`).**

`supabase/migrations/20260819000001_add_wearable_pairing_session.sql` declares **3**
CHECK constraints across the wearable tables. Live staging has **~18**. Missing entirely
from the committed migration:

```
wearable_pairings_device_model_check        char_length >= 1 AND <= 80
wearable_pairings_device_app_version_check  char_length >= 1 AND <= 40
wearable_pairings_check                     expires_at > created_at
wearable_pairings_check1                    status='pending' implies user_id IS NULL
wearable_pairings_protocol_version_check    protocol_version = 1
wearable_sessions_check                     expires_at > created_at
wearable_sessions_check1                    revoked_at and revoke_reason set together
wearable_sessions_protocol_version_check    protocol_version = 1
wearable_sessions_revoke_reason_check       user_revoked|expired|replaced|sign_out|error
wearable_messages_check                     expires_at > created_at
wearable_messages_frame_check               octet_length(frame::text) <= 65536
wearable_messages_message_type_check        char_length 3..48
wearable_results_payload_check              octet_length(payload::text) <= 49152
wearable_results_revision_check             revision 1..1000
wearable_results_status_check               completed|partial|failed
wearable_actions_status_check               pending|completed|failed|cancelled
wearable_actions_safe_error_code_check      NULL or char_length <= 48
```

And one that **disagrees**: live `wearable_actions_action_type_check` allows
`cancel` and `retry`; the migration allows only `save` and `open_on_phone`.

Column-level divergence as well:

| Column | Migration | Live |
|---|---|---|
| `wearable_sessions.last_seen_at` | nullable, no default | `NOT NULL DEFAULT now()` |
| `wearable_actions.result_id` | `NOT NULL REFERENCES` | nullable |
| `wearable_actions.status` default | `'completed'` | `'pending'` |
| `wearable_pairings.device_model` / `device_app_version` | `DEFAULT ''` | no default — and `''` violates the live CHECK |
| `wearable_pairings.protocol_version`, `wearable_sessions.protocol_version` | `DEFAULT 1` | no default |

**Why this matters concretely.** It caused P1-02. The Meta client sent `appVersion: ''`;
staging rejected it on `wearable_pairings_device_app_version_check`; no environment built
from the committed migration would have rejected it, because that constraint does not
exist there. A fresh environment gets a materially weaker schema — no frame cap, no
payload cap, no revision bounds, no revoke-reason enum.

**Not repaired here, deliberately.** The reconciliation migration cannot be executed or
validated in this environment (no local Postgres; Docker daemon not running), and
applying DDL to staging to resolve drift is out of scope by the brief's own rule. An
unexecuted DDL file asserted as "reconciled" would be false assurance. The full verified
inventory above is the deliverable; authoring and applying the migration is an owner
action. Recorded on #189.

## Cross-Client Isolation

Meta and Google were treated as separate wearable clients sharing one backend.

**Evidence: SOURCE VERIFIED + SCHEMA VERIFIED, with the live rejection paths LIVE STAGING VERIFIED.**
The positive half — two legitimately coexisting sessions for one user — is **BLOCKED by
#192** and is *not* claimed.

### Sessions — §13

| Attack | Result | Mechanism |
|---|---|---|
| Session token swap | No cross-authorization primitive exists | `wearable_sessions.token_hash` is UNIQUE; a token resolves to exactly one session. Using another client's token *is* being that session, not escalating from yours. |
| Frame `sessionId` swap | `WRONG_SESSION` | `session.send` requires `frame.sessionId === session.id && frame.deviceId === session.device_id` |
| Device ID swap | Rejected | same check |
| User ID mismatch | Invisible, not just refused | every `phone.*` operation filters `.eq("id", sessionId).eq("user_id", userId)` |
| Platform string | **Cannot be used at all** | the bridge has no platform/client concept — see P4-08 |
| Junk / short / absent token | `403 SESSION_INVALID` (live) | |

**Verified live:** every `phone.*` operation without a user JWT → `401 AUTH_REQUIRED`;
a body-supplied `userId` authenticates nothing; a forged bearer authenticates nothing.

### Results — §14

`phone.send` (`result.show` / `result.update`) rejects with `INVALID_RESULT` when
`existingResult.user_id !== userId || existingResult.session_id !== session.id`.
`phone.action` looks up the result with `.eq("id",…).eq("user_id",…).eq("session_id",…)`.

A Google result cannot be rendered into or actioned from a Meta session **even for the
same user**. A valid UUID is not sufficient — session ownership is checked on every path.

### Actions — §15

`wearable_actions.id` is the PRIMARY KEY (globally unique), with `UNIQUE (session_id, id)`
on top. Same-session reuse with a different result or action type → `ACTION_CONFLICT`.
Cross-session reuse → the lookup (session-scoped) misses, the insert violates the PK, the
raced re-lookup misses too → **`ACTION_FAILED`**. Deterministically rejected; the code is
misleading (P4-05).

### Device-ID collision

`wearable_pairings_one_pending_device` and `wearable_sessions_one_active_device` are keyed
on `device_id`. Both clients mint UUIDs, so accidental collision is not a practical risk —
but note that a shared or guessable device id would let one client's `pair.poll` revoke
another's session ("replaced"). Worth stating as a standing constraint on any future client.

## Pairing — §18

**Evidence: LIVE STAGING VERIFIED.**

| Attack | Result |
|---|---|
| Wrong pairing secret | `400 PAIR_NOT_FOUND` |
| Wrong pairing handle | `400 PAIR_NOT_FOUND` |
| `pair.approve` without user JWT | `401 AUTH_REQUIRED` |
| `pair.deny` without user JWT | `401 AUTH_REQUIRED` |
| Poll before approval | `200` with `frames: []`, **no `wearableToken`** |
| Replayed `pair.request` frame (same `requestId`) | rejected — `UNIQUE (request_id)` violation → `PAIR_CREATE_FAILED` |
| Re-pair with a stable device id | first pairing moves to `status='expired'` (**database row verified**) |
| Wrong protocol version / non-UUID ids / non-empty `sessionId` / wrong `messageType` / stale or future timestamp / already-expired frame | all rejected |

Expired-challenge, duplicate-approve, poll-after-denial and approval-after-session-replacement
require a user JWT — **BLOCKED (#192)**, not claimed.

One finding: a pairing expired *by replacement* polls as `frames: []` — indistinguishable
from "still pending" — instead of emitting `pair.expired`, because `pair.poll` only checks
the TTL clock for pending rows (P4-04).

## Session TTL — §17

`SESSION_TTL_MS = 15 * 60_000` in the deployed bridge — **confirms the Google audit's
~15-minute observation** (SOURCE VERIFIED against the deployed bundle).

Enforcement is authoritative and layered: `activeSessionForToken` marks an expired session
revoked with reason `expired` and throws; `session.poll` returns a `session.revoked` frame
carrying `EXPIRED`; every companion function re-checks `expires_at` independently.

Behaviour *at* and *after* expiry on a real session is **BLOCKED (#192)**. The client-side
half is now fixed and unit-verified (P2-04).

## Revocation — §16

**Evidence: SOURCE VERIFIED.**

The contract, stated explicitly rather than assumed:

- `phone.revoke` is **per-session** — `.eq("id", sessionId).eq("user_id", userId)`. Meta
  revoking its own session does not touch a Google session. Isolated. ✅
- `phone.revoke_all` is **all-sessions-for-the-user** — no device, platform or client
  filter. The Meta client calls exactly this on sign-out
  (`AuthSessionContext.signOut` → `revokeAllMetaWearableSessions`).

**So: a Meta sign-out revokes a coexisting Google wearable session, by design of
`phone.revoke_all`.** This is recorded as the intended contract, not a defect — a phone
sign-out leaving any wearable credential alive would be worse. It is asymmetric with
explicit unpair, and that asymmetry is correct.

The sign-out revoke is deliberately non-blocking: a failed revoke logs and lets sign-out
complete. Sound — a phone that cannot sign out because a cleanup call failed is the worse
outcome, and the session still dies on its own within 15 minutes.

## Result Revisions — §23

**Evidence: SOURCE VERIFIED.**

`phone.send` enforces an ownership + monotonic-revision guard: revision must be an integer
in 1..1000; a stale revision → `STALE_REVISION`; an equal revision is an idempotent resend
forwarded without a write; a higher revision updates under a compare-and-set
(`.eq("revision", existingRevision)`). A result id owned by another user or another session
→ `INVALID_RESULT`. A non-UUID result id → `INVALID_RESULT`.

Live-result-after-cancel and late-result-after-retry need a session — **BLOCKED (#192)**.

One oddity: `phone.action` returns `revision: stored + 1` without incrementing the stored
value, so a client that trusts the returned revision runs one ahead of the database (P4-11).

## Grouping — §11, §12, §45

**This is the audit's most consequential backend finding.**

### The defect — P2-01

**Evidence: SOURCE VERIFIED (deployed bundle) + UNIT TEST VERIFIED.**

`normalize.ts` selected its product array by *key presence*:

```ts
const hasSimilarityField = Object.prototype.hasOwnProperty.call(raw, 'similarityMatches');
const products = hasSimilarityField ? similarityMatches : recommendedProducts;
const commerceGroup = hasSimilarityField ? 'suggested' : 'retail';
```

But `scan-identify`'s `normalized()` and `withSafeImageArrays()` helpers emit
`similarityMatches` on **every** image response, empty or not. `hasSimilarityField` is
therefore **always true**, which means:

- **`retail` is unreachable.** Every wearable product is labelled `suggested`, whatever
  it is — the exact inverse of the bug commit `8b67161` set out to fix.
- **Every live commerce listing is silently discarded.** With an empty catalog shelf and
  five real, buyable listings, the wearer is shown **nothing at all**.

### The test suite pinned the defect as correct

This is also the §56 finding. Two of the sixteen tests encoded the bug:

```ts
Deno.test('an empty similarity shelf does not fall through and mislabel live commerce', () => {
  const raw = realisticScanIdentifyResponse({ similarityMatches: [], recommendedProducts: SAMPLE_PRODUCTS });
  const result = normalizeWearableResult(raw, 'req-group-3');
  assertEquals(result.primaryMatch, null);        // ← asserts live commerce is DROPPED
  assertEquals(result.alternatives.length, 0);
});
```

and the *only* test that produced a `retail` item did so from a response shape the deployed
function can never emit (`delete raw.similarityMatches`). 16/16 green over a normalizer that
discards all live commerce.

### Repaired

Both arrays are now kept, each item carrying its own provenance; the catalog shelf leads
(it answers "what is this?"), live listings follow as retail alternatives, and with an
empty shelf the listings lead. Two tests rewritten against the real envelope; three
regressions added.

- **18/18 pass.** Negative control: reintroducing key-presence selection fails **5** tests, exit 1.
- Committed `83aa69f`, pushed. **NOT DEPLOYED** — staging `wearable-scan` v6 still carries
  the defect. Deployment is an owner action, per the brief's instruction not to redeploy.

### Retail / suggested / resale — §12

Canonical provenance flows: `scan-identify` array → backend group → client normalization →
HUD/mobile presentation. All four hops now carry it (the client half was P2-02).

**`resale` is honestly unavailable.** `scan-identify` carries no resale provenance for any
product, so `wearable-scan` produces none — inferring it from a merchant name would be a
guess presented as fact. A test pins that no item is ever labelled `resale`. Reported as
an upstream gap, not worked around.

## Idempotency

### Save — §24, P3-04 OPEN

**Evidence: SOURCE VERIFIED + SCHEMA VERIFIED.**

The two Save routes use **different idempotency keys and different `source` values**:

| Route | Dedupe key | `source` | `local_id` |
|---|---|---|---|
| `wearable-bridge` `phone.action` | `metadata->>'wearableResultId'` | `'wearable'` | not set |
| `wearable-save` `save` / `save_as_phone` | `(user_id, local_id)` | `'meta_wearable'` | `resultId` |

Neither sees the other's key, so one wearable result saved through both routes produces
**two `saved_scans` rows**.

Reachability today is **zero**: the Meta client uses only `wearable-save`, the Google
companion only `phone.action`. Hence P3, not P2.

**Not blind-patched, and here is why.** `saved_scans` carries a partial unique index
`saved_scans_user_local_id_unique_idx ON (user_id, local_id) WHERE local_id IS NOT NULL`.
Making the bridge set `local_id` would newly collide with a `wearable-save` row for the
same result, and `phone.action` has no `23505` handler — it would `throw SAVE_FAILED`. The
correct fix is three parts (dedupe lookup checks `local_id` too; insert sets it; a `23505`
fallback returns idempotent success), in a shared function this audit cannot deploy or
integration-test, whose only live consumer is another team's client. Turning a
zero-reachability duplicate-row nuisance into a hard Save failure for that client is a bad
trade. Reported with the exact fix instead.

Within each route, idempotency is correct: `wearable-save` returns the existing row and
handles the `23505` race; `phone.action` has an idempotency ledger with a race re-lookup.

Also noted: **the bridge's Save path stores `products: []` for every wearable result**
(`Array.isArray(payload.products) ? payload.products : []`), and a wearable result has
`primaryMatch`/`alternatives`, never `products`. Saves made through `phone.action` land in
the library with no commerce at all (P4-12).

### Open-on-phone — §25

`wearable-open-on-phone` validates the session, then builds a deep link from a
caller-supplied `resultId` and a caller-supplied `result` payload. **It performs no
ownership check on `resultId`** and reads nothing from the database.

There is no disclosure: the caller learns only what it already supplied, and the phone
resolves the link from a process-local cache. It is also not idempotent and has no action
ledger — unlike `phone.action`, which does. Recorded as **P4-06**: no exploitable hole
today, but the check must exist before this endpoint ever returns stored result data.

## verify_jwt:false — §20

All five audited functions run with `verify_jwt: false`. What actually authenticates them:

| Function | Platform key required? | Application-layer authority |
|---|---|---|
| `wearable-bridge` | **Yes** — `apikey` must be the publishable key (`withSupabase`) | wearable session token, or user JWT for `phone.*` |
| `wearable-scan` | **No** — reachable with no credentials | wearable session token, checked after image validation |
| `wearable-save` | **No** | wearable session token, or user JWT for `save_as_phone` |
| `wearable-open-on-phone` | **No** | wearable session token |
| `scan-identify` | **Yes** — 401 without a key | user JWT (anonymous access is closed) |

**Can they be invoked without wearable-session authority?** Yes for the three unkeyed
functions — but every one of them reaches only a bounded rejection:
`INVALID_SESSION` / `MISSING_TOKEN` / `INVALID_IMAGE` / `INVALID_RESULT`, all live-verified.

**Can a malformed or sessionless request trigger expensive work?** No provider cost.
`wearable-scan` validates the image *before* the session, so an anonymous 4 MB payload
costs a JSON parse and two indexed DB reads (674 ms measured), and `scan-identify` is only
called after the session validates. That is a bounded DoS surface, not denial-of-wallet.

`pair.create` is unauthenticated by design and unthrottled — anyone holding the publishable
key can create unbounded pending pairing rows, and nothing reaps them (P4-10). The
`wearable_auth_attempts` throttle covers only `pair.approve`/`pair.deny`.

### P2-06 — a request body over ~½ MB kills two of the five functions, OPEN

**Evidence: LIVE STAGING VERIFIED.**

| Body | `wearable-bridge` | `scan-identify` | `wearable-scan/save/open` |
|---|---|---|---|
| 100 KB – 500 KB | `401` in ~250 ms | `401` in ~400 ms | fine |
| **600 KB+** | **no response → 160 s → 503** | **no response → 160 s → 503** | fine |
| 9 MB | 160 s → 503 | 160 s → 503 | answers in < 1.5 s |

Not a cold start: the function answered a small request immediately before *and* after.
The threshold sits between 500 KB and 600 KB, reproducibly, on exactly these two functions.

Consequences:

- A single ~600 KB POST from anyone holding the public key pins a worker for 160 seconds.
- `wearable-bridge`'s own `content-length` → `413` guard **never fires** — not even with an
  explicit `Content-Length` header — proving the handler is never entered.
- The mobile client caps images at **2 MB** (`MAX_IMAGE_BASE64_BYTES`, mirroring the server's
  own constant), while the effective ceiling is ~½ MB. A large photo would hang for the
  client's 20 s timeout while the server burns 160 s.

**Not repairable in application code** — the handler demonstrably never runs. The
empirical threshold is also not a safe constant to hard-code into the client. Owner/infra
action: a platform request-size limit, or a function memory/bundle investigation.

## Anonymous Access — §21

**Evidence: LIVE STAGING VERIFIED. Anonymous scan access is CLOSED on staging.**

Every anonymous `scan-identify` call — valid tiny JPEG included — returns
`401 {"error":"Authentication required"}` in ~300 ms. No quota, rate-limit, feature or
provider-cost difference to measure, because no anonymous request reaches any provider.
No production cost exhaustion was attempted, and none was possible.

## Privacy / Payload Controls — §22

**Evidence: LIVE STAGING VERIFIED.**

The `wearable-bridge` frame relay was attacked with `image`, `imageBase64`, `image_base64`,
nested `image`, array-nested `image`, `data:image/jpeg` and `data:image/png` strings,
`accessToken`, `refresh_token`, `authorization`, a hyphenated `image-base64`, and a 70 KB
string. All rejected. `containsForbiddenContent` lowercases and strips underscores from
keys, blocks any `data:image` string value, and blocks any string over 64 KB — and the whole
frame is capped at 65,536 bytes, so no meaningful raw image can transit regardless of key
naming. Staging additionally enforces `wearable_messages_frame_check` at the same bound.

`wearable-scan` accepts **only** `data:image/jpeg;base64,` up to 5 MB. Live-rejected:
`https://` URLs, `file:///etc/passwd`, `http://169.254.169.254/…` (SSRF/metadata), PNG data
URLs, empty base64. No route intended for sanitized references accepts raw imagery.

## Backend Error Quality — §26

**Evidence: LIVE STAGING VERIFIED across ~80 hostile requests.**

Every response was deterministic, bounded and machine-readable
(`{"ok":false,"code":"…"}` or `{"message":"…","code":"…"}`). No stack trace, no secret, no
internal identifier, no SQL text leaked — notably, the `PAIR_CREATE_FAILED` that hid a CHECK
violation exposed nothing about the constraint, which is correct for a client and is why the
Postgres log was needed to diagnose it. `wearable-bridge` additionally filters its own error
codes through `/^[A-Z0-9_]{3,48}$/` before returning them.

Two codes are actionable-but-wrong rather than unsafe: `ACTION_FAILED` for a cross-session
action-id collision (P4-05), and `PAIR_CREATE_FAILED` covering both replay and constraint
violation.

---

# Part B — Meta Client

## The two faults that made the client non-functional

Both were invisible to the source-only test suite and both fail **before** authentication
matters — so neither would have been found by an authenticated E2E run either.

### P1-01 — wearable-bridge rejected the app's credential outright

**Evidence: LIVE STAGING VERIFIED + SOURCE VERIFIED. FIXED.**

`wearable-bridge` is served through `withSupabase({ auth: ['publishable','secret'] })`.
Reading the shipped `@supabase/server@1.4.1`: `tryMode('publishable')` compares the
**`apikey` header** against `SUPABASE_PUBLISHABLE_KEY` and ignores the Authorization header
entirely. supabase-js sets `apikey` to whatever key `createClient` was given.

**Every EAS profile** — `meta-physical-candidate`, `preview`, `development`, `staging`,
`production` — ships the legacy `eyJ…` anon key.

```
apikey=<legacy anon>    -> 401 {"message":"Invalid credentials","code":"INVALID_CREDENTIALS"}
apikey=sb_publishable_… -> 200 {"ticket":{…}}
```

So `pair.create`, `pair.approve`, `pair.poll`, `phone.sessions`, `phone.revoke` and
`phone.revoke_all` **all 401'd before any operation ran**. No wearable session could ever
be issued by any build.

**Fix:** a separately configured publishable key applied only as the `apikey` header on the
four wearable calls, rather than repointing the whole app's key (a change that would alter
how every other Supabase call authenticates, on a path this build cannot exercise
end-to-end). The Authorization header is untouched, so supabase-js keeps supplying the
signed-in user's JWT for the operations that need one. A missing or wrong-shaped key now
fails loudly on the device with a named code instead of arriving as an opaque 401.

### P1-02 — `appVersion: ''` violated a live CHECK constraint

**Evidence: LIVE STAGING VERIFIED (Postgres log + `pg_constraint`). FIXED.**

`createMetaPairingChallenge` hard-coded `appVersion: ''`. `pair.create` copies it into
`wearable_pairings.device_app_version`, and staging enforces
`char_length(device_app_version) >= 1`. Postgres:

```
new row for relation "wearable_pairings" violates check constraint
"wearable_pairings_device_app_version_check"
```

surfaced to the client as a generic `PAIR_CREATE_FAILED`. Neither this constraint nor the
matching `device_model` one is in the committed migration (P2-05), so **no environment
built from source could reproduce this failure**.

**Fix:** both fields clamped into the deployed bounds, app version sourced from
`Constants.expoConfig?.version`.

### Live verification, with both controls

```
legacy apikey                         -> 401 INVALID_CREDENTIALS
publishable apikey + appVersion=''    -> 400 PAIR_CREATE_FAILED
publishable apikey + real app version -> 200, ticket issued
```

and the pairing hostile matrix then passes on the repaired path (see §18 above).

## DAT-Off Behavior — §28, §30

**Evidence: BUILD VERIFIED + APK VERIFIED.**

Invariant holds. With `kscan.mwdat.enabled=false` (the default), the built APK contains:

```
classes14.dex:MWDAT_ENABLED       (BuildConfig field)
classes14.dex:KScanMetaWearable   (module name)
classes14.dex:DatEngine           (reflection lookup string only)
assets/index.android.bundle:KScanMetaWearable
```

**No `com.meta.wearable` class, no MockDeviceKit, no DAT artifact** anywhere in 22 dex
files. No fake device, no fake session, no fake capture, no fake success.

### UnavailableEngine — §29

Every capability query answers "no"; every action throws `ADAPTER_UNAVAILABLE`.
`initialize()` returns `initState: UNINITIALIZED`, which the JS layer requires to be
`READY` — so a flag-off build reports no glasses and falls through to the phone camera.
`disconnect()` returns `{ok:true, noop:true}`, which fabricates nothing. No method returns
success for unavailable hardware. **PASS.**

## Feature Gate — §30, §31

**Evidence: BUILD VERIFIED.**

Fail-loud path re-tested: `KSCAN_MWDAT_ENABLED=true` with no token fails **once**, clearly —

```
kscan.mwdat.enabled=true but no GitHub Packages credential was found. Set GITHUB_TOKEN
(or github_token in local.properties) to a token with the read:packages scope.
```

— with no misleading `compileSdk not specified` secondary error. The ordering fix from
`81d9122` regression-tests clean.

### P2-03 — but the flag was not gating the manifest, FIXED

**Evidence: MERGED-MANIFEST VERIFIED + APK VERIFIED.**

`modules/kscan-meta-wearable` is an Expo local module, so autolinking puts it in **every**
Android build — the flag gates the DAT source set and dependencies, not whether the library
ships. Its manifest declared `BLUETOOTH` and `BLUETOOTH_CONNECT`, and the merged manifest of
a flag-OFF build confirmed it: the app requested Nearby-devices access on Android 12+ for
hardware it has no code to talk to. Neither permission is declared anywhere else in K Scan —
both came solely from this module, and both would have reached Play as a new sensitive
permission on a feature users cannot even reach.

**Fix:** the DAT permissions and DAM metadata moved to `src/mwdat/AndroidManifest.xml`,
selected by `sourceSets.main.manifest.srcFile` inside the same `if (mwdatEnabled)` block as
the source set. Verified **both directions**:

- flag off → no `BLUETOOTH` in the merged app manifest; `:app:assembleDebug` still succeeds;
  the shipped candidate APK's `aapt2 dump badging` shows no Bluetooth permission
- flag on → the module's merged manifest carries `BLUETOOTH`, `BLUETOOTH_CONNECT`, `CAMERA`,
  `INTERNET` and `com.meta.wearable.mwdat.DAM_ENABLED` again

## Prebuild — §32

**Evidence: BUILD VERIFIED (controlled, reverted).**

`npx expo prebuild --platform android --no-install` ran and the tree was restored with
`git checkout -- android/ && git clean -fd android/` (verified clean). Findings:

- The module survives: `expo-modules-autolinking search -p android` resolves
  `kscan-meta-wearable` from `modules/`, and `settings.gradle` names no module explicitly —
  autolinking is dynamic.
- **No manual `android/` edits are required**: the Meta commits touch zero files under
  `android/`, and the full app builds.
- Unrelated pre-existing hazard: prebuild flips `android:allowBackup` from `false` to
  **`true`** (P5-01). Not Meta-introduced, but anyone running prebuild on this branch
  silently re-enables Android backup of app data.

## MinSDK — §33

**Evidence: BUILD VERIFIED.**

Re-tested at the **whole-app** level, not module assembly: `:app:assembleDebug` →
**BUILD SUCCESSFUL** (1m 15s, 371 tasks). The APK reports `minSdkVersion:'24'`, so the
module's `minSdk safeExtGet(project,'minSdkVersion',24)` correctly defers to the host app
and the artificial `minSdk 29` floor is gone. No regression.

## Bridge Lifecycle — §34

**Evidence: SOURCE VERIFIED + KOTLIN COMPILE VERIFIED.**

- **Listener lifetime is correct.** Exactly one native observer, attached in `OnCreate` and
  closed in `OnDestroy`, per module instance. One event channel with a discriminator, so JS
  cannot end up partially subscribed after a reconnect. No duplicate-listener analogue of
  the Google P2 finding.
- **Promise completion / cancellation.** `CancellationException` is re-thrown untouched, so
  a cancelled capture settles as a cancellation rather than a spurious device fault.
- **P3-03 — `requireReady()` ran OUTSIDE `guarded()`** in seven coroutine functions
  (`createSession`, `startSession`, `attachCamera`, `startCamera`, `capturePhoto`,
  `attachDisplay`, `renderResult`). It throws a plain `MetaWearableException`, not a
  `CodedException`, so a not-ready adapter crossed the bridge as an unmapped native
  exception (`ERR_UNEXPECTED`) instead of the stable `META_NOT_INITIALIZED` the module's own
  docstring promises. Narrowly reachable in DAT-off (the JS capability layer short-circuits
  first), reachable in DAT-on after an activity recreation. **FIXED.**
- **P4-01 — every unexpected throwable was reported as `META_INITIALIZATION_FAILED`**, so a
  capture that failed on working, initialized hardware sent the caller to diagnose the wrong
  subsystem. Fallback codes are now per-call-site. **FIXED.**

## UI / System State Consistency — §36, §37

| Claimed state | Reality | Verdict |
|---|---|---|
| UI says CONNECTED, bridge unavailable | `glassesStatus` is derived from `getMetaCapabilities().reason`; DAT-off reports `NOT_LINKED` | correct |
| UI says CAPTURING, capture already failed | single `busy` flag around one linear async flow; failure sets a status and clears busy in `finally` | correct |
| UI says PROCESSING, request cancelled | picker cancel returns early with "Capture cancelled." | correct |
| UI says SUCCESS, privacy blocked | privacy errors throw; status becomes "Privacy check failed. Nothing was uploaded." | correct |
| **UI says READY, wearable session expired** | **was broken** — see P2-04 | **FIXED** |

### P2-04 — READY outlived the session, FIXED

**Evidence: SOURCE VERIFIED + UNIT TEST VERIFIED.**

The screen read `sessionExpiresAt` once, at pair time, and never consulted it again. After
the bridge's 15-minute TTL the UI still said "Paired." and kept Capture live. Pressing it
opened the camera, **took a real photograph**, ran the full on-device privacy pipeline and
compressed the image — and only then learned from the server that the session was gone. A
protected capability was offered, and a real photo taken, on authority the app no longer had.

**Fix:** expiry is evaluated against the authoritative instant on a 10-second interval
(polled, not a scheduled timer — a background timer is not guaranteed to fire, and waking to
find the app still claiming READY is the exact failure being fixed); Capture, Save and Open
all go dead; the card says why and offers "Pair Again"; the remaining seconds are shown. An
unknown `sessionExpiresAt` falls back to the protocol's own 15-minute TTL rather than being
treated as "never". The client uses `>=` to match the bridge's `expires_at <= now`, so it
does not offer one last capture the server is already refusing.

## Phone Fallback — §38

**Evidence: SOURCE VERIFIED.** Safe and explicit.

`startMetaGlassesCapture()` returns `null` whenever the adapter is absent, unregistered, has
no connected device, or lacks camera permission — and only then does the phone camera open.
The UI text states the rule plainly ("Capture comes from your Meta glasses when they are
connected and permitted, and from this phone otherwise"), and the status line differs per
path ("Capturing from your Meta glasses…" vs "Opening phone camera…"). **The app never
presents the phone camera as the glasses camera.**

## Privacy — §40

**Evidence: SOURCE VERIFIED + UNIT TEST VERIFIED (12 geometry tests).**

Genuinely fail-closed. Every one of these throws rather than falling back to the raw URI:
decode failure (`PRIVACY_DECODE_FAILED`), dimension mismatch
(`PRIVACY_DIMENSIONS_INVALID`), no offscreen surface (`PRIVACY_RENDER_UNAVAILABLE`),
detector exception (`PRIVACY_DETECTOR_FAILED`), malformed detector output
(`PRIVACY_DETECTOR_OUTPUT_INVALID`), encode failure (`PRIVACY_ENCODE_FAILED`), missing or
wrong-sized output (`PRIVACY_OUTPUT_INVALID`), non-local input URI
(`PRIVACY_INPUT_INVALID`), oversized reconstruction (`PRIVACY_RECONSTRUCTION_FAILED`).

The output is re-decoded and re-measured after writing, and the caller deletes the raw,
sanitized and compressed assets in `finally` regardless of outcome. Masks are solid black,
anti-aliasing off, clamped to image bounds, never zero-area.

Negative control confirms the coverage is real: widening `isLocalUri` to accept `https://`
fails 2 tests with exit 1.

## Provenance — §39

**Evidence: SOURCE VERIFIED.**

No regression: `capture()` passes `source: 'meta_glasses'` for a glasses capture and
`'phone_camera'` for a phone capture, and `sanitizeMetaWearableCapture` records exactly what
it is given. The previously-fixed false `phone_camera` record for glasses images stays fixed.

**But the attestation has no consumer** (P4-09). `capture()` destructures only
`privacy.sanitizedUri` and discards the `policy` object; `submitMetaWearableScan` sends only
the image. So the provenance is computed correctly and then thrown away — nothing persisted
anywhere distinguishes a glasses capture from a phone capture, while the type's docstring
says it is "recorded in the privacy policy attached to a scan". Left open: threading it
through would change a shared backend contract this audit cannot deploy.

Separately, `wearable-scan`, `wearable-save` (both actions) and `wearable-open-on-phone` all
**hard-code `source: 'meta_wearable'`** (P4-08). Latent today — no other client calls them —
but the moment a second wearable client does, its scans and saves are attributed to Meta.
The correct fix is a session-level client/platform column, which is a schema decision.

## Capability Negotiation — §42

**Evidence: SOURCE VERIFIED + UNIT TEST VERIFIED.**

`negotiateCapabilities` walks adapter → registered → device CONNECTED → permission →
display, degrading with a named reason at each step (`MWDAT_NOT_LINKED`, `NOT_INITIALIZED`,
`NOT_REGISTERED`, `NO_DEVICE`, `DEVICE_NOT_CONNECTED`, `CAMERA_PERMISSION_DENIED`). Every
native read is wrapped so a throwing adapter degrades rather than crashes.

**Display is never inferred from a model name** — it comes from `native.displayAvailable()`
and nothing else. Camera comes from a real permission check, not from device presence. A
device that is paired but not CONNECTED yields no capabilities.

Injected structural states — camera only, display only, both, neither, unknown, capability
disappears mid-flight — are covered by the existing suite (25 tests), and the negative
control proves it: making `negotiateCapabilities` fabricate a connected device when the
adapter is absent fails a test with exit 1.

## Displayless — §43

`selectExperience` returns `PHONE_RESULT` when the device is camera-capable but reports no
display. `renderMetaResultOnGlasses` returns `false` immediately unless
`getMetaCapabilities().display` is true — so no HUD is fabricated on camera-first hardware,
and the phone remains the result surface. **No fake HUD.** SOURCE VERIFIED.

## Display Structural Path — §44

`toDisplayPayload` produces the intended minimal glance: one identity line, one supporting
line, a price, and only the actions the result actually supports (`Save` / `Open on phone`
gated on `result.actions`, plus `Dismiss`). Everything hard-truncated (48/48/24 chars).
Returns `null` rather than an empty card when there is no title.

**This is a structural/client test only.** No DAT Display verification is claimed — #191
remains blocked.

## Result Mapping — §45

Hostile fixtures (retail, suggested, mixed, zero, malformed provenance) were run through
backend normalization → client formatter. **No silent `suggested` → `retail` collapse**, in
either direction, at any hop.

### P2-02 — the collapse had simply moved to the client, FIXED

**Evidence: SOURCE VERIFIED + UNIT TEST VERIFIED.**

`commerceGroup` appeared **nowhere** in the mobile app. The glasses glance, the companion
result card and the deep-link handoff screen each rendered a suggestion exactly like a
listing — title, brand, retailer, price. The backend grouping fix stopped one step short of
the wearer.

**Fix:** all three surfaces state the provenance; the alternatives count distinguishes
"in stock" from "similar" instead of one undifferentiated number; an unrecognised group says
nothing rather than guessing; the glance stays inside its 48-character budget.

Also fixed: the handoff screen read `primary.resaleSource` (P4-02), a field `wearable-scan`
has never produced and deliberately never will — always undefined, always filtered away.

## Save / Open — §49, §50

Meta-specific matrix, as far as it is reachable without a session:

| Case | Status |
|---|---|
| Duplicate Save | Idempotent on `result.resultId` → `local_id`; returns the existing row. SOURCE VERIFIED |
| Stale / oversized result id | `400 INVALID_RESULT`. LIVE VERIFIED |
| Expired or revoked session | `401 INVALID_SESSION`. LIVE VERIFIED (junk token) |
| `save_as_phone` without a user JWT | `401 AUTH_REQUIRED`. LIVE VERIFIED |
| Save/Open after client-side expiry | now refused before the request. UNIT VERIFIED |
| Open targets the exact result | client passes the exact `resultId`; **backend performs no ownership check** (P4-06) |
| Disconnect during Save, late Save ack, action-id collision | **BLOCKED (#192)** |

One structural note: `saveMetaWearableResultAsPhone` is exported but never called, and can
never succeed for a Meta result — it requires the result to exist in `wearable_results`,
which this client never writes (it does not use `phone.send`). Dead affordance (P4-07),
left in place as documented future-topology intent.

## Cancel / Retry — §47, §48

**Evidence: SOURCE VERIFIED + UNIT TEST VERIFIED.**

- **Duplicate capture is impossible**: `capture()` returns early while `busy`.
- **A late glasses capture cannot resurrect a cancelled flow**: `captureFromGlasses` checks
  `cancelled` after `capturePhoto` resolves, hands the photo to `onDiscardLateCapture`
  (which deletes the file from app-private storage) and rejects with
  `META_CAPTURE_CANCELLED`. Negative control: deleting that check fails a test with exit 1.
- **The camera is always released**: `stopCamera`/`stopSession` in `finally`, each
  individually catch-guarded.
- Late privacy completion, late Save ack and late Open ack all require a real session —
  **BLOCKED (#192)**.

## Reconnect — §51

**Evidence: SOURCE VERIFIED (structural). No physical reconnect evidence is claimed.**

Injectable bridge/device-state transitions and their recovery decisions:

| Disconnect during | Behaviour |
|---|---|
| capture | `negotiateCapabilities` re-reads link state; `selectExperience` → `UNAVAILABLE`; capture throws its reason code; camera and session released in `finally` |
| privacy | purely on-device; unaffected by link state |
| analysis | server-side; the wearable session, not the BLE link, is what matters |
| after result | result already cached on the phone; glance render is best-effort and returns `false` |
| Save / Open | session-token calls, independent of the glasses link; fail with a bounded code |

Thermal refusal is enforced before the camera starts (`CRITICAL`/`EMERGENCY` →
`META_THERMAL_BLOCKED`) rather than retried into shutdown.

## Session Expiry — §46

Covered under **P2-04** above. `READY → EXPIRED` now removes the protected capability and
is visible to the user. **No false READY state remains.**

---

# Part C — Harness Integrity

## Negative Controls — §56

Each fault was introduced deliberately, the suite re-run, then reverted and re-run.

| # | Fault introduced | Expected test | Result | After revert |
|---|---|---|---|---|
| NC-A | `negotiateCapabilities` fabricates a connected device with no adapter | capability suite | **1 fail, exit 1** | 26/26 pass |
| NC-B | Deliver a late capture after cancel | cancellation suite | **1 fail, exit 1** | pass |
| NC-C | `isLocalUri` accepts `https://` (raw upload) | privacy geometry | **2 fail, exit 1** | 11/11 pass |
| NC-D | Collapse `suggested` → `retail` | wearable-scan deno suite | **1 fail, exit 1** | 16/16 pass |
| NC-D2 | Re-introduce selection-by-key-presence (the real defect) | wearable-scan deno suite | **5 fail, exit 1** | 18/18 pass |
| NC-E | Planted failing test in the aggregate runner | `run-all-tests.js` | **exit 1** | — |
| NC-F | Remove the session-expiry guard from capture | session clock suite | **1 fail, exit 1** | 85/85 pass |
| NC-G | Restore `BLUETOOTH_CONNECT` to the always-merged manifest | manifest suite | **1 fail, exit 1** | pass |
| NC-H | Remove the route flag gate | presentation suite | **1 fail, exit 1** | 10/10 pass |
| NC-I | Drop `commerceGroup` from the glasses glance | presentation suite | **1 fail, exit 1** | pass |

Every intended test failed, and every suite returned to green after revert.

**One control did not need introducing.** NC-D2 revealed that the pre-existing suite had
already encoded the P2-01 defect as correct behaviour — 16/16 green over a normalizer that
discarded every live commerce listing. That is the strongest harness finding in this audit:
the tests were not weak, they were *wrong*, and confidently so.

## Exit-Code Verification — §58

**Evidence: VERIFIED.** The previously-reported "failing tests with exit 0" condition does
**not** reproduce on these suites.

- `node --test <files>` returns **1** on any assertion failure (confirmed 10×).
- `deno test --no-check` returns **1** on failure (confirmed 2×).
- `scripts/run-all-tests.js` propagates the child status
  (`process.exit(result.status == null ? 1 : result.status)`) and additionally **refuses to
  report a pass when zero test files are discovered** — a genuinely good property.
  Empirically confirmed with a planted failing test: **exit 1**.

No release-critical command was found reporting success while assertions failed. No harness
fix was needed.

## Wrong-Build Detection — §57

**Evidence: VERIFIED.**

- The Meta suites transpile the **real** `services/*.ts` files from disk inside a `vm`
  sandbox whose `require` throws on any module load. So they exercise the intended source,
  and adding a runtime import fails loudly rather than quietly making a layer device-only.
  Proven, not assumed: edits to those exact files (NC-A, NC-B, NC-F, NC-I) produced failures.
- The wearable-scan deno suite imports `./normalize.ts` directly, not a fixture.
- Manifest and wiring assertions read the actual files on disk, and comments are stripped
  before defect-pattern checks so the files' own prose cannot be mistaken for the defect.

**One honest caveat.** The first APK built was a bare `assembleDebug` with **no EAS env**, so
it carried no Supabase config and no Meta flag — it proves compilation, manifest and
DAT-absence but is *not* the candidate runtime configuration. A second APK was therefore
built with the merged `meta-physical-candidate` env, and the candidate config was confirmed
baked in (staging URL, `sb_publishable_…`, `META_WEARABLE_CANDIDATE` present). All
candidate-specific claims below rest on that second build.

---

# Part D — Build / Artifact

## Android Build — §59

**Evidence: BUILD VERIFIED.**

| | |
|---|---|
| Command | `./gradlew :app:assembleDebug` (DAT off) |
| Result | **BUILD SUCCESSFUL** — 371 tasks |
| APK | `android/app/build/outputs/apk/debug/app-debug.apk` (~334 MB debug) |
| Package | `com.kscanai.app`, versionCode `29`, versionName `1.0.1` |
| SDK | minSdk 24 · targetSdk 36 · compileSdk 36 |
| Source SHA | `8ed5152` (`kscan-app`) |
| Config | merged `meta-physical-candidate` env — staging URL, publishable key, Meta flag on |

`:kscan-meta-wearable:compileDebugKotlin` also succeeds after the lifecycle repair.

## APK Inspection — §60

**Evidence: APK VERIFIED (all 22 dex files + assets, binary-safe scan).**

| Looked for | Found |
|---|---|
| GitHub token (`gh*_`, `github_pat_`) | **none** |
| Meta package credential / `maven.pkg.github.com` | **none** |
| Supabase secret (`sb_secret_`, `service_role`) | **none** |
| Provider keys (`RAPIDAPI`, `ELEVENLABS`, `GEMINI_API`) | **none** |
| MockDeviceKit / `com.meta.wearable` / `mwdat-core` | **none** |
| Debug bypass / fake devices / staging-only dev controls | **none** |
| `BLUETOOTH` / `BLUETOOTH_CONNECT` in the shipped manifest | **none** (P2-03 verified at artifact level) |

Present and expected: the staging URL and the two **publishable** keys
(`EXPO_PUBLIC_SUPABASE_ANON_KEY`, `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`). Both are public
by design and belong in a client. **No build credential ships.**

## PR Checkpoint Integrity — §61

Neither PR was merged. Both remain **Draft / Do Not Merge**, verified after push:

- `kscan-glasses-webapp` #2 — `isDraft: true`, head `81f6b69`
- `kscan-app` #190 — `isDraft: true`, head `8ed5152`

---

## P0 Findings

**None.**

## P1 Findings

| ID | Repo / File | Defect | Status |
|---|---|---|---|
| **P1-01** | `kscan-app` `services/metaWearableCompanion.ts`, `eas.json` | `wearable-bridge` accepts only a modern publishable key as `apikey`; every EAS profile ships the legacy anon key → **401 INVALID_CREDENTIALS on every bridge operation**. Pairing impossible in any build. | **FIXED** `dd49bf3` |
| **P1-02** | `kscan-app` `services/metaWearableCompanion.ts` | Hard-coded `appVersion: ''` violates live `wearable_pairings_device_app_version_check` → `PAIR_CREATE_FAILED` on every `pair.create`. | **FIXED** `dd49bf3` |

## P2 Findings

| ID | Repo / File | Defect | Status |
|---|---|---|---|
| **P2-01** | `kscan-glasses-webapp` `supabase/functions/wearable-scan/normalize.ts` | Selection by `similarityMatches` key presence — always true — makes `retail` unreachable and **discards every live commerce listing**. | **FIXED IN SOURCE** `83aa69f` — **NOT DEPLOYED** |
| **P2-02** | `kscan-app` `metaWearableDevice.ts`, `app/wearables/*` | `commerceGroup` consumed by no client surface; a suggestion is shown as a buyable listing. | **FIXED** `2c644a6` |
| **P2-03** | `kscan-app` `modules/kscan-meta-wearable/android/**` | `BLUETOOTH`/`BLUETOOTH_CONNECT` merged into every build regardless of the DAT flag. | **FIXED** `2c644a6` |
| **P2-04** | `kscan-app` `app/wearables/meta.tsx` | UI stays READY after wearable-session expiry; capture takes a real photo on dead authority. | **FIXED** `2c644a6` |
| **P2-05** | `kscan-glasses-webapp` `supabase/migrations/20260819000001_*.sql` | Committed migration cannot reproduce live staging: ~15 missing constraints, one contradicting, plus column divergence. | **OPEN** — owner action |
| **P2-06** | staging `wearable-bridge`, `scan-identify` | Request body ≳600 KB → 160 s hang → 503; the handler never runs, so the `413` guard is dead. | **OPEN** — not repairable in app code |
| **P2-07** | `kscan-app` `package.json`, `__tests__/mirrorExtractionContainment.test.js` | Release-critical guard test **RED on the frozen checkpoint** (#193). | **OPEN** — architectural |

## P3 Findings

| ID | Repo / File | Defect | Status |
|---|---|---|---|
| **P3-01** | `kscan-app` `services/metaWearableCompanion.ts` | Wearable device id minted per pairing, defeating one-live-session-per-device; N pairings → N live tokens. | **FIXED** `8ed5152` |
| **P3-02** | `kscan-app` `app/wearables/**` | Internal-only routes deep-link reachable in any build; the flag only hid the entry button. | **FIXED** `2c644a6` |
| **P3-03** | `kscan-app` `MetaWearableModule.kt` | `requireReady()` outside `guarded()` in 7 coroutine functions → unmapped native exception crosses the bridge. | **FIXED** `2c644a6` |
| **P3-04** | `kscan-glasses-webapp` `wearable-bridge/index.ts` vs `wearable-save/index.ts` | The two Save routes use different idempotency keys → duplicate `saved_scans` rows. Zero reachability today. | **OPEN** — see Save §24 for why it was not blind-patched |

## P4–P10 Backlog

| ID | Pri | Repo / File | Defect | Trigger | Impact | Suggested fix | Scope |
|---|---|---|---|---|---|---|---|
| P4-01 | P4 | `kscan-app` `MetaWearableModule.kt:guarded` | Every unexpected throwable reported as `META_INITIALIZATION_FAILED` | Any non-typed native failure | Caller diagnoses the wrong subsystem | Per-call-site fallback codes | **FIXED** in `2c644a6` |
| P4-02 | P4 | `kscan-app` `app/wearables/result/[resultId].tsx` | Dead read of `primary.resaleSource` | Every render | Line silently always empty | Read `commerceGroup` | **FIXED** in `2c644a6` |
| P4-03 | P4 | `kscan-glasses-webapp` (repo root) | No `.gitattributes` + `core.autocrlf=true` | Fresh Windows clone → `functions deploy` | Ships CRLF bytes that no longer match the blob; defeats the drift check | Pin `eol=lf` | **FIXED** in `81f6b69` |
| P4-04 | P4 | `wearable-bridge` `pair.poll` | A pairing expired *by replacement* returns `frames: []`, not `pair.expired` | Poll a superseded handle | Client shows "pending" forever | Emit `pair.expired` for `status='expired'`, not only for an elapsed TTL | 1 line |
| P4-05 | P4 | `wearable-bridge` `phone.action` | Cross-session `actionId` reuse → `ACTION_FAILED` (PK violation) not `ACTION_CONFLICT` | Two sessions reuse one action id | Correct rejection, misleading code | Widen the raced re-lookup to detect a cross-session PK hit | ~5 lines |
| P4-06 | P4 | `wearable-open-on-phone` | No ownership check on `resultId` | Any valid session | No disclosure today (nothing is read from the DB); a hole the moment it returns stored data | Add the ownership check before any DB read is introduced | ~10 lines + contract decision |
| P4-07 | P4 | `kscan-app` `metaWearableCompanion.ts` | `saveMetaWearableResultAsPhone` is dead and can never succeed for Meta results | Never called | False affordance in the API surface | Remove, or wire `phone.send` so results exist in `wearable_results` | Product decision |
| P4-08 | P4 | 3 shared functions | `source: 'meta_wearable'` hard-coded | Any non-Meta wearable client | Google scans/saves attributed to Meta | Session-level client/platform column | Schema change |
| P4-09 | P4 | `kscan-app` `app/wearables/meta.tsx` | Capture provenance computed then discarded | Every capture | No stored record distinguishes glasses from phone, despite the docstring | Thread the attestation into `wearable-save` metadata | Cross-repo |
| P4-10 | P5 | `wearable_pairings` | Pending rows never reaped (16 present, oldest 2026-08-19) | Every `pair.create` | Unbounded growth; unauthenticated with the public key | Scheduled reaper or TTL delete | Small |
| P4-11 | P5 | `wearable-bridge` `phone.action` | Returns `revision + 1` without incrementing the stored revision | Every action | Client runs one revision ahead of the DB | Return the stored revision, or actually increment | 1 line |
| P4-12 | P4 | `wearable-bridge` `phone.action` save | `products: payload.products` — a wearable result has `primaryMatch`/`alternatives`, never `products` | Save via `phone.action` | Saved scan lands in the library with no commerce | Build from `primaryMatch` + `alternatives`, as `wearable-save` does | ~3 lines |
| P5-01 | P5 | `kscan-app` `android/app/src/main/AndroidManifest.xml` | `expo prebuild` flips `android:allowBackup` false → true | Anyone running prebuild | Silently re-enables Android backup of app data | Config plugin, or assert it in a release test | Small |
| P6-01 | P6 | `kscan-app` `tsconfig.json` | No `strict`, so `strictNullChecks` is off | Any discriminated-union safety shape | Narrowing silently unavailable; a safety type that does not narrow is worse than none | Enable `strict` incrementally | Large |
| P6-02 | P6 | `kscan-app` (repo root) | No ESLint config — `npx eslint` cannot run | Any lint attempt | No lint gate; the Rules-of-Hooks violation this audit introduced-and-caught by hand would have been caught automatically | Add `eslint.config.js` with `react-hooks` | Small |
| P7-01 | P7 | `wearable-scan` | Rate limit is a per-instance in-memory `Map` | Multiple isolates | Effective limit is 10 × instance count | Shared store (mirrors existing issue #48) | Medium |

---

## Defects Repaired

| Commit | Repo | Contents |
|---|---|---|
| `83aa69f` | webapp | P2-01 — grouping: keep both arrays, per-item provenance; 2 defect-pinning tests rewritten, 3 regressions added |
| `81f6b69` | webapp | P4-03 — `.gitattributes` pinning `eol=lf` for deploy fidelity |
| `dd49bf3` | mobile | P1-01, P1-02 — publishable `apikey` for wearable calls; clamped pairing fields |
| `2c644a6` | mobile | P2-02, P2-03, P2-04, P3-02, P3-03, P4-01, P4-02 |
| `8ed5152` | mobile | P3-01 — persisted stand-in wearable device identity |

## Commits / Push Confirmation

```
kscan-glasses-webapp   feature/meta-physical-device-candidate-v1
  8b67161 -> 81f6b69   (2 commits, pushed)
    81f6b69 chore(deploy): pin LF so a Windows clone cannot deploy CRLF function sources
    83aa69f fix(meta): stop discarding live commerce and make the retail bucket reachable

kscan-app              feature/meta-physical-device-candidate-v1-mobile
  5092f55 -> 8ed5152   (3 commits, pushed)
    8ed5152 fix(meta): keep one stand-in wearable identity, so re-pairing replaces
    2c644a6 fix(meta): stop the candidate lying to the wearer, and to every other build
    dd49bf3 fix(meta): make pairing actually reach the bridge — right key, non-empty version
```

Both Draft PRs updated in place and confirmed still Draft.

**Nothing was deployed.** No Edge Function was redeployed, no migration applied, no live
staging schema or configuration mutated. The staging rows created are pairing tickets from
hostile probes, which expire on their own.

## DAT Package Gate #191

**STILL BLOCKED.** No `read:packages` token became available. No DAT dependency was resolved,
no DAT source set compiled, no `PhotoData` contract verified, no MockDeviceKit run. Phase B
was not entered and no DAT runtime evidence is claimed anywhere in this report.

Strengthened evidence posted to the issue: the flag-off path is now verified by **artifact**
rather than by reading the gradle file, and the manifest leak (P2-03) — something the flag
was *not* gating — was found and fixed.

## QA Account Gate #192

**STILL BLOCKED. AUTHENTICATED META E2E — BLOCKED.**

No account was created; creating one is outside the auditor's remit. Auth was not bypassed,
and no other user's session was borrowed. Everything from `pair.approve` onward is unverified:
session issuance, TTL behaviour at/after expiry, renewal, `phone.sessions`/`revoke`/`revoke_all`,
two-session cross-client isolation, the three companion functions past their session gate, and
the save idempotency matrix against real rows.

Both release blockers were nonetheless found, because both fail *before* authentication matters.
That is worth recording: this gate was masking a state in which no amount of QA-account access
would have produced a working pairing.

## ML Kit Issue #193

**LEFT OPEN, with materially strengthened evidence** — and reclassified as **P2**, because the
guard test is not merely in conflict, it is **red on the frozen checkpoint**:

```
✖ no new runtime dependency was added to package.json
ℹ tests 20  ℹ pass 18  ℹ fail 1   (exit 1)
```

`package.json` is untouched by every audit commit, so this was already failing at `5092f55`.
Any `npm run test:all` fails.

Three findings that narrow the decision:

1. **The native artifact is already authorized and already ships.**
   `modules/kscan-pii-native/android/build.gradle` on the mainline Android lines declares
   `com.google.mlkit:face-detection:16.1.7`, and the guard test itself blesses it
   ("The already-shipped face artifact is untouched"). The conflict is about **packaging
   shape**, not about ML Kit.
2. **`kscan-pii-native` is iOS-only on this branch** — no `android/` directory — which is why
   the Android guard test is *skipped* here and only one of the pair fails. The Android half
   exists; this branch's merge-base (`a601adf`) simply predates it.
3. **Option A is therefore smaller than described**: bring the existing, already-authorized
   Android half onto this line, rather than build and audit a detector from scratch.

Not resolved here because both routes are still architectural: Option B weakens an invariant
another feature deliberately encoded, and Option A depends on a branch-topology decision that
is not the auditor's to make. The dependency is genuinely load-bearing — it fail-closes every
capture on both paths — so no partial removal was attempted.

---

## Evidence Classification

| Level | Applies to |
|---|---|
| **LIVE STAGING VERIFIED** | Source/deploy hash equality (5 functions); credential gate A/B; `appVersion` CHECK violation (Postgres log + `pg_constraint`); repaired pairing path with both controls; pairing hostile matrix; device-id replacement (DB row); anonymous `scan-identify` closure; privacy/raw-image rejection; SSRF guards; payload-size ceiling; error-response quality across ~80 requests |
| **SOURCE VERIFIED** | Cross-client session/result/action isolation; revocation contract; 15-minute TTL; result-revision guard; grouping defect mechanism; save-route key divergence; `wearable-open-on-phone` ownership gap; capability negotiation; displayless routing; phone-fallback safety; reconnect structural matrix; `@supabase/server` auth mechanics |
| **UNIT TEST VERIFIED** | 18/18 wearable-scan deno; 85/85 Meta mobile; 10 negative controls |
| **INTEGRATION TEST VERIFIED** | Repaired client wire shape replayed end-to-end against live staging |
| **BUILD VERIFIED** | `:app:assembleDebug`; Kotlin compile; merged manifests both flag directions; DAT fail-loud path; controlled prebuild; minSdk regression |
| **APK VERIFIED** | Credential scan; DAT-artifact absence; shipped permission set; candidate config baked in |
| **EMULATOR VERIFIED** | *Not claimed.* |
| **MOCKDEVICEKIT VERIFIED** | *Not claimed* — blocked by #191 |
| **PHYSICAL HARDWARE VERIFIED** | *Not claimed.* |
| **BLOCKED** | Everything past `pair.approve` (#192); everything DAT-dependent (#191) |

No stronger level is inferred from a weaker one anywhere in this report.

## Remaining Hardware Gates

1. **#191** — `read:packages` PAT → DAT dependency resolution, typed compile, `PhotoData`,
   `DeviceSession`, `addCamera`, capture, capability APIs, Display, MockDeviceKit.
2. **#192** — approved staging QA account → the entire authenticated half.
3. **Physical Ray-Ban Meta hardware** → real capture, real link-state transitions, real
   reconnect, thermal behaviour, Display where supported.

## Recommendation

Do **not** treat this candidate as hardware-ready or release-ready. The correct statement is:

> **Structural / DAT-off client audited + shared backend audited + real DAT runtime blocked +
> authenticated E2E blocked.**

Before the next checkpoint:

1. **Deploy `wearable-scan` from `81f6b69`.** Staging currently returns zero products to a
   wearer whenever the catalog shelf is empty. This is the single highest-value action and it
   is a one-command owner decision.
2. **Author the wearable schema reconciliation migration** (P2-05). Until then the committed
   schema is not the deployed schema, and defects of the P1-02 class stay invisible to every
   source-built environment.
3. **Resolve #193.** The branch cannot pass its own suite while the guard is red.
4. **Take the P2-06 payload ceiling to infrastructure.** It is not fixable in function code.
5. **Unblock #191 and #192**, then run the DAT delta audit and the authenticated E2E matrix.
6. Consider the P4 backlog's cheap items (P4-04, P4-05, P4-11, P4-12) alongside the P2-01
   deploy, since they touch the same two functions.

## Final Verdict

**FAIL — HYBRID HOSTILE AUDIT FOUND UNRESOLVED P0–P3 SOFTWARE BLOCKERS**

Read precisely: no P0 exists, both P1s are fixed and live-verified, and nine of the thirteen
P0–P3 findings are repaired, tested and pushed. The verdict is FAIL because four remain open —
including one whose fix is written but **undeployed**, so the defect is still live on the
shared backend both clients depend on; one where the committed schema cannot rebuild the
deployed one; and one release-critical gate that is currently red.

The Meta client and the shared backend both survived the structural, lifecycle, isolation and
privacy attacks in this audit's reachable scope. What they did not survive was the assumption
that they had ever worked at all: before this audit, the Meta companion could not complete a
single pairing against staging, and the wearable backend was discarding every live commerce
result it was asked to return.

---

## Audit Repair Pass — 2026-08-23

This addendum addresses exactly the four findings left **OPEN** in the final remediation
ledger. It does not reclassify an external/platform condition as an application fix.

| Finding | Repair outcome | Evidence / remaining condition |
|---|---|---|
| **P2-05** schema reconciliation | Migration authored and committed in the shared backend repo. | `20260823141131_reconcile_wearable_schema_with_staging.sql` reconciles the documented wearable constraints. It has not been applied: staging database source authority / database credentials were unavailable, so DDL was not guessed or pushed. **BLOCKED — STAGING DB AUTHORITY.** |
| **P2-06** large request ingress failure | No function-code change is capable of repairing a pre-handler hosted ingress failure. | The documented 160s/503 behavior exceeds the hosted function idle-time limit; retain as **BLOCKED — HOSTED INGRESS / INFRASTRUCTURE** pending platform-owner investigation. |
| **P2-07** ML Kit packaging-policy guard | Repaired. | The direct JS ML Kit wrapper was removed. The existing audited Android half of `kscan-pii-native` now supplies the native ML Kit detector, and the privacy path fails closed on missing/invalid native output. Full Android build and the full mobile suite pass. |
| **P3-04** cross-client Save idempotency | Repaired and deployed. | `wearable-bridge` now checks `saved_scans.local_id` first, retains legacy metadata lookup, and re-reads on a uniqueness race. Staging `wearable-bridge` is ACTIVE v7. Authenticated multi-client execution remains blocked by **#192**; no synthetic identity was used. |

### Direct staging follow-up

The previously repaired P2-01 commerce-grouping logic had regressed in staging `wearable-scan`
v8 while source still contained the correct normalization. It was redeployed from committed
source as staging `wearable-scan` v9 and downloaded back for source equality verification.
This is a deployment correction, not an additional audit finding.

Detailed evidence and the stop conditions are recorded in
`META_HYBRID_HOSTILE_AUDIT_4_FIX_REPAIR_REPORT.md`.
