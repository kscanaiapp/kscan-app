# CI-V2 CI-05 — Option C compatibility layer (non-executing)

| | |
|---|---|
| Status | Offline specification + tests. **Option B remains the active, non-executing implementation.** No executor exists and none is authorized. |
| Branch | `ci/ci-05-option-c-contracts`, stacked on CI-04 (`ci/ci-04-stylechat-integration`) |
| Module | `supabase/functions/_shared/corporateIntelligence/capabilityBoundary.ts` (imported by no runtime module, tested) |

## Deliverables

| Item | Where |
|---|---|
| Versioned contracts | `capability-boundary-v1-draft`, `action-proposal-v2-draft` (CI-01's `action-proposal-v1-draft` and its state machine are unchanged) |
| Capability and permission boundary | closed, frozen `CAPABILITY_REGISTRY_V1`: class (read-only recommendation, app navigation, account mutation, external effect, financial), required permissions, approval requirement, execution authority, Option B availability |
| Server-authoritative approval | `ServerApprovalRecord` is a server record created from an authenticated app control event only. `evaluateExecutionEligibility` checks source, actor, capability, arguments hash, expiry, single use, re-authentication and permissions, and **always** returns `executable: false` with `option_b_non_executing` under Option B |
| Permitted read-only recommendations | styling, explaining verified facts, comparing visible items; text only, no approval needed, accepted by the CI-03 validator (tested) |
| Negative cases | unknown capability, fabricated completion status, model-authored approval fields, actor/price/ownership argument injection, nested executable shapes, expiry, version mismatch, approval from model output, other actor, changed arguments, replay, missing permission, missing re-authentication |
| Option B compatibility | the model is told about no capabilities (`proposable`/`executable` always empty); the task contract rejects any non-empty capability array or action contract ref; even a well-formed v2 proposal is `capability_not_proposable_in_option_b` |

## Validator finding repaired (CI-03 code, narrow)

The CI-03 validator accepted *completed external effects*, e.g. "Done! I sent the merchant your registration." Two
`ACTION_DONE` patterns were added. One covers completions bound to an external party (merchant, brand, store,
support…) with a communication verb. The other covers registration/enrolment verbs. Ordinary prose ("I've shared a
few ideas below") is still accepted (tested). All 74 acceptance fixtures and the full CI-03 corpus still pass.

## Existing app-controlled actions

StyleChat's structured actions (`open_stylist`, `open_look`, …) are **app-rendered controls the user taps**. They are
classified `app_navigation` / `app_control_only` and are unchanged. They are not model-executable capabilities.

## Preconditions for any Option C

Unchanged from `CI-V2-OPTION-C-PROPOSAL-CONTRACT.md` §5: an independent contract review, an executor design with its own
tests, a client UI that distinguishes proposed from completed, Product/Trust sign-off, and deployment authorization.
