# CI-V2 — Option C Expansion Contract (design only)

| Field | Value |
|---|---|
| Work package | CI-05 (specification) |
| Status | **DRAFT. No executor, no live proposal workflow, no tool loop.** Option C needs an independently reviewed contract version and deployment authorization. |
| Artifacts | `supabase/functions/_shared/corporateIntelligence/actionProposal.ts` (offline), fixtures `ap-01…ap-10` |

## 1. Option B runtime restrictions (enforced)

* `corporate-task-v1.capabilities.executable` and `.proposable` are `readonly never[]` and runtime-empty; `actionContractRef` must be `null`. Tests: `tc-04`, `tc-05`, `tc-06`, plus an `@ts-expect-error` compile-time check.
* `actionProposal.ts` is imported only by tests (asserted). No Edge Function imports `corporateIntelligence` (asserted).
* No purchase, save, account edit or inventory change initiated by the model; no client UI may present an unexecuted proposal as completed; unauthorized capability details are never disclosed to the model or the client.
* The existing `FORBIDDEN_ACTION_TYPES` / `ALLOWED_ACTION_TYPES` (tap-only navigation actions) are untouched and are **not** Option C actions.

## 2. State machine

`PROPOSED → VALIDATED → AUTHORIZED → EXECUTED → CONFIRMED`, plus `DENIED`, `CANCELLED`, `FAILED`, `EXPIRED`.

| From | Legal next states |
|---|---|
| proposed | validated, denied, cancelled, expired |
| validated | authorized, denied, cancelled, expired |
| authorized | executed, cancelled, expired, failed |
| executed | confirmed, failed |
| confirmed / denied / cancelled / failed / expired | none (terminal) |

`EXECUTED` is reachable only from `AUTHORIZED`; a model-originated record can only ever be created as `proposed` (`ap-02`, `ap-03`, `ap-09`, `ap-10`).

## 3. `action-proposal-v1-draft`

| Field | Rule |
|---|---|
| `proposalId` | Opaque 16–80 char id (server-generated in the future) |
| `contractVersion` | `action-proposal-v1-draft` |
| `capabilityId` | One of a closed draft list; listing grants nothing (`ap-04`) |
| `arguments` | Flat typed scalars only; forbidden executable shapes (reuse `rejectForbiddenModelShape`) rejected (`ap-05`, `ap-08`) |
| `sourceRefs` | Non-sensitive opaque references |
| `confirmationPolicy` | `explicit_user_tap` \| `explicit_user_tap_plus_reauth` |
| `expiresAt` | Required; expired proposals rejected (`ap-06`) |
| `status` | Exactly `"proposed"` on parse (`ap-02`, `ap-03`); unknown fields rejected (`ap-07`) |

**A proposal never confers permission.** The future executor must independently enforce actor identity, permissions, entitlements, input validation, idempotency, cost limits and user confirmation, re-checking each at execution time rather than trusting any value copied from the proposal.

## 4. Threat model (brief)

| Threat | Risk | Required control (future) |
|---|---|---|
| Proposal replay | A captured/approved proposal is reused or a duplicate is submitted | Server-generated single-use ids, idempotency keys bound to actor + capability + arguments hash, expiry, terminal states |
| Stale permissions | Entitlement/consent revoked between proposal and execution | Re-evaluate consent, entitlement, account state and eligibility at `AUTHORIZED→EXECUTED`; never cache the proposal-time answer |
| Unauthorized capability disclosure | The model learns or reveals capabilities a user lacks | Capability list filtered server-side per actor before the Task Brief; Option B exposes none |
| Confirmation bypass | Model text or a crafted argument is treated as consent | Confirmation only via an authenticated, app-controlled tap event; model output and user chat text can never satisfy it |
| Schema confusion (proposing vs executing) | A field such as `status: executed` or an `execute` flag is honored | Parse-time rejection of any non-`proposed` status and unknown fields; separate types for proposal and execution record; executor input is rebuilt server-side |
| Prompt-injected proposals | Merchant/user text steers arguments | Arguments validated against authoritative records (ownership of referenced item, merchant eligibility), not against model text |
| Cost abuse | Looping proposals drive spend | Existing daily/burst quotas count proposals; executor adds per-capability cost caps |

## 5. Preconditions for Option C

Independent review of a new contract version; executor design with its own tests; client UI that distinguishes proposed from completed; Product/Trust sign-off; deployment authorization. None is granted by this directive.
