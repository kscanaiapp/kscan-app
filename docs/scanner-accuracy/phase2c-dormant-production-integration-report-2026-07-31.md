# Build 4 Phase 2C — Dormant Production Scanner Integration

> **DORMANT PRODUCTION SOURCE INTEGRATION**
> **NOT DEPLOYED · NOT ACTIVATED · NOT AUTHORIZED FOR PRODUCTION TRAFFIC**

**Date:** 2026-07-31
**Candidate:** `phase2a-v1.0.0` — **AVAILABLE BUT DISABLED**
**Production default:** `certified-v140`

---

## 1. Governing release baseline

| Item | Value |
|---|---|
| Governing branch | `origin/integration/build3-ios-final` |
| Governing SHA | `dcacfc64adb707c27b2c8c61d1ee50d5449f9ee7` |
| Governing worktree (read-only) | `KScan-build3-verdict-ios` — clean, untouched |
| Integration branch | `integration/scanner-phase2a-v1-dormant` |
| Integration worktree | `C:\src\KScan-scanner-phase2a-v1-dormant` |
| Upstream | none (local only, unpushed) |

### Why this baseline, and why it is not ambiguous

Project documentation (`docs/scanner-accuracy/production-handoff.md`) states Build 4
production branches "will later be cut from final certified Build 3 iOS and
Android tips." Both tips exist at the recorded SHAs (`dcacfc6`, `950de11`), as
does the backend audit branch (`fc132cf`, "PHASE 6 HOSTILE AUDIT PASSED —
PRODUCTION SOURCE DEPLOYMENT AUTHORIZED").

**For the scanner backend the baseline is converged, so the choice cannot change
deployable source.** All three Edge Function closures are byte-identical across
both platform finals:

| Function | bundleHash | iOS vs Android |
|---|---|---|
| scan-identify | `9d645f5e…` | identical |
| stylechat-generate | `b09177cf…` | identical |
| style-outfit-generate | `b7339f46…` | identical |

The four governing scanner files are identical blobs across `build3-ios-final`,
`build3-android-final` and `audit/phase6-elise-contract-v1`.

The two platform lines differ only in `_shared/aiSecurity/**` and
`_shared/deletion/userDataResources.ts`. Neither is in any deployable closure.
`aiSecurity/**` was **added on the iOS line** (12 files, commit `13e48fc`) and was
never present on Android — it was not removed from Android — so **iOS-final is a
strict superset** and cutting from it loses nothing.

The backend audit branch was rejected as a release baseline: it carries only 1
Saved Looks file against 17 on the platform finals, so it is backend-scoped
rather than a full release tip.

This also resolves the older project note that the Android line was canonical for
`scan-identify` while the iOS copy was stale. That divergence no longer exists —
the blobs are identical — and the note's operative rule ("edit the canonical copy
on a dedicated backend branch") is exactly what this phase does.

### Build 3 inclusion evidence

| Evidence | build3-ios-final |
|---|---|
| Dressing Room files | 74 |
| Saved Looks files | 17 |
| Elise files | 89 |
| `identify_for_closet` in the shared contract | 4 occurrences, preserved |
| Worktree state | clean, local == remote |

---

## 2. Pre-integration production hashes

Captured from the immutable starting SHA before any modification.

| Path | Git blob | sha256 (LF) |
|---|---|---|
| `scan-identify/index.ts` | `505fc41a` | `dcc7732abce278e7b90e000e388932b3041a32bb608d5b2cabeeddfc4808efc6` |
| `_shared/fashionIdentificationV2.ts` | `1e8acdd4` | `b041a899aea90bf091b337a486087fe58670fd27058d51b8a6a4b5f86b1d6699` |
| `scan-identify/v2Activation.ts` | `4fc30824` | `ac11ec3af8d726b09ccb41338a906c208e85923d481497bd3199bf6f35aa9062` |
| `_shared/llmModelRouting.ts` | `7a0c905c` | `4e39d7a549e1f6222e34ec7eddb89f8a6da8fffa4ba1509bf2495f7c1c6ef14c` |
| `config/edge-function-manifest.json` | `939c8105` | `a69161eb690df54c744bcab115b596b7cbb866c33c9b03add0f0e53d103a3ab7` |

Trees: `scan-identify` `a8e4b5d7…`, `_shared` `ccba6e96…`.

**After integration:** only `scan-identify/index.ts` changed, to
`8b80965d08c1b785a62c83ae96bf62d42c33db08cd8af9adfaae98d77c260a37`. The other
three governing files are byte-identical.

---

## 3. Manifest reconciliation

All seven Phase 2B integration anchors reconciled **UNCHANGED** — same file, same
line numbers, same content hash:

| Anchor | Phase 2B line | Actual | Status |
|---|---|---|---|
| IP-1/IP-2 handler entry | 1556 | 1556 | UNCHANGED |
| IP-3 prompt seam `withQualityAndRoute` | 2069 | 2069 | UNCHANGED |
| IP-4 response assembly | 3203 | 3203 | UNCHANGED |
| routePlan | 2021 | 2021 | UNCHANGED |
| attempt loop | 2153 | 2153 | UNCHANGED |
| nextAttemptModel | 2155 | 2155 | UNCHANGED |
| geminiBody | 2083 | 2083 | UNCHANGED |

### Legitimate production drift preserved

`fashionIdentificationV2.ts` differs from certified v140 because
`identify_for_closet` was added after certification. Phase 2B flagged this; Phase
2C **preserves it** — the file is untouched and all 4 occurrences remain. Certified
v140 is the behavioural control for candidate comparison, not the current
production tree, and nothing was rebuilt from the certified snapshot.

---

## 4. What changed

**Added (8)**

```
supabase/functions/_shared/scannerCandidateArtifact.ts        (generated, deployable)
supabase/functions/_shared/scannerVersionResolver.ts          (deployable)
supabase/functions/_shared/scannerVersionObservability.ts     (deployable)
supabase/functions/_shared/scannerVersionResolver.test.ts
supabase/functions/_shared/scannerVersionObservability.test.ts
supabase/functions/scan-identify/phase2cDormantIntegration.test.ts
scripts/generate-scanner-candidate-artifact.js
__tests__/scannerCandidateArtifactParity.test.js
tools/scanner-evaluation/adapter/phase2a-instruction-overlay.v1.json  (canonical source)
```

**Modified (3)**

```
supabase/functions/scan-identify/index.ts        +51 / ~3   the only production edit
config/edge-function-manifest.json               regenerated
config/cross-path-parity-manifest.json           regenerated
```

**Removed:** none. Protected surfaces (`app/`, `components/`, `android/`, `ios/`,
`supabase/migrations/`, deploy scripts, `eas.json`, `app.json`): **0 files changed**.

---

## 5. Candidate artifact parity

| Digest | Value | Status |
|---|---|---|
| Instruction sha256 | `93b67ad9de443dbb59b3d7aa502e4bb126fad7d8b8ed8e23560bb4802629e384` | matches Phase 2B |
| Artifact sha256 | `6cc51fbaecaca28b270f4df853dd8004b7360b7d67044f8f74f667ebd8de3a33` | matches Phase 2B |

The production module is **generated** from the canonical evaluation artifact by
`scripts/generate-scanner-candidate-artifact.js`, which supports `--check`. Both
digests are recomputed from the canonical descriptor rather than copied.

Parity tests prove drift is caught on **either** side, that exactly one production
file carries the instruction text, and that the generated module contains no
`require`, `node:` import, filesystem read, dynamic/remote import, `process`
access, `fetch` or `Deno.env` — safe for the Edge closure.

---

## 6. Trusted runtime boundary

| Property | Value |
|---|---|
| Variable | `BACKEND_SCANNER_VERSION` (server-owned) |
| Committed default | `certified-v140` |
| Pattern | matches `BACKEND_QUALITY_TUNE_ENABLED` / `BACKEND_SCANNER_INTELLIGENCE_ENABLED` |
| Public schema exposure | none |

| Input | Resolves | Reason |
|---|---|---|
| unset / empty | control | `no_trusted_configuration` |
| `phase2a-v1.0.0` | candidate | `explicit_candidate` |
| `certified-v140` | control | `explicit_control` |
| unknown / near-miss | control | `unknown_version` |
| non-string | control | `malformed_value` |
| reader throws | control | `configuration_unavailable` |

**Client control is impossible by signature.** The resolver's only input is an
environment reader — no parameter exists for a request, body, header, query,
user, session or device. A future edit adding one would have to change the
signature, which the tests pin.

Verified against the real entry point: body fields (including ones named exactly
like the server variable), two headers and a query parameter all fail to activate
the candidate.

---

## 7. Single dispatch and preserved behaviour

The candidate replaces the prompt **string** on the one path that was already
going to run. Verified by diff: **zero** added or removed lines touch the provider,
`routePlan`, the attempt loop, `nextAttemptModel`, timeouts, retries, the
generation config, any `responseSchema`, or the image part.

Certified request parity is asserted behaviourally: the certified prompt is a
strict **prefix** of the candidate prompt, and model, image part and
`generationConfig` are identical.

**Scoped to single-item image identification.** Applied to `IDENTIFY_PROMPT` and the
selected-item prompt only. Multi-item detection and TextScan stay on certified
behaviour under *both* versions — detection returns a candidate list rather than
the item fields the overlay governs, and TextScan has no image, so the overlay's
"in this image" evidence rules would be false. Applying it there would ship
unevaluated behaviour.

No shadow execution, no dual execution, no candidate-to-certified quality
fallback, no repair-model call, no additional provider call, no new external host.
Configuration is consulted **exactly once per request** (asserted by counting reads).

**Cache identity:** this function has no scanner result cache — the only cache is
`projectAccessCache`, keyed by API-key hash — so there is no cache for the two
versions to collide in.

---

## 8. Kill switch and rollback

Closed state is `certified-v140`, which is also the committed default.

**Rollback:** remove or reset `BACKEND_SCANNER_VERSION`. The next request is
certified again, with a prompt asserted **byte-identical** to a control request that
never saw the candidate. In-flight requests finish on the version they sealed.

Requires **none** of: mobile update, database migration, user-data cleanup,
request-schema change, shared-cache deletion, dual execution.

**Integration-branch rollback:** abandon the branch and return to `dcacfc6`. No
migration reversal, no data cleanup, no deployment reversal.

---

## 9. Sanitized observability

A `scanner_version_outcome` line on the success and provider-error terminals
carries: resolved version, reason, fallback flag, outcome category, provider
failure kind, attempt count, fallback-used and latency — all values the function
already had.

The helper accepts **named scalars and cannot spread**. Non-strings, non-finite
numbers and objects are dropped; rendering iterates a fixed key list, so a field
attached downstream cannot print. Tests pass hostile objects containing a
credential-shaped string, image bytes and a prompt, and assert none survives.
Absent measurements are omitted rather than emitted as zero.

Token usage is accepted but normally absent: the deployed path does not parse
`usageMetadata`, and this module must never cause an extra call or parse to
populate a metric.

**No raw prompt, instruction, image, response body, credential or PII is logged.**

**No alert thresholds are defined** — asserted by test.

---

## 10. Edge Function closure

Regenerated through the governed commands. No hash was hand-edited.

| Function | Before | After | Change |
|---|---|---|---|
| scan-identify | `9d645f5e…` 31/39 | `5da156af…` 34/43 | +3 deployable modules, +1 tree-only test |
| stylechat-generate | `b09177cf…` 34/49 | unchanged | none |
| style-outfit-generate | `b7339f46…` 6/8 | unchanged | none |

`approvedProjectRef` and `expectedFunctions` unchanged.

A **second** governed artifact, `config/cross-path-parity-manifest.json`, also pins
the scanner entry hash. It was found by the full-suite run, not by the closure
check, and regenerated through `scripts/generate-cross-path-parity-manifest.js`.
Exactly one hash changed — the scanner entry. This is recorded here rather than
folded silently into an earlier commit because it arrived after Commit 5.

---

## 11. Test evidence

| Check | Result |
|---|---|
| Repository Node suite | **3,844 / 3,844 passed** |
| Deno — new modules + entry-point integration + cross-path | **55 / 55 passed** |
| Deno — existing scanner suites | 67 / 67 passed (qualityTune 8, intelligence 19, multiItem 8, styleIntent 12, textScan 5, commerceRelevance 15) |
| Production entry-point integration | **14 / 14 passed** |
| Candidate artifact parity | 11 / 11 passed |
| Edge parity suite | 17 / 17 passed, incl. all deploy guards |
| `verify:edge-parity` | PASS |
| TypeScript `tsc --noEmit` | PASS |
| `deno check` (entry + 3 modules) | PASS |
| Certified snapshot | `f3eb6e60…` 39/39 |
| Dataset / scoring / selection / taxonomy / holdout | 0.3.1 / 0.3.0 / 1.0.0 `2a3b84e8…` / 1.0.0 `3c93e35a…` / 7 cases, 0 unresolved |
| Secret scan | clean |
| Private-path scan | clean |

**Tests added: 52** (14 entry-point, 15 resolver, 10 observability, 11 parity, +2).

**One flake observed and dismissed honestly.** The first full-suite run failed
`closetPromotionCoordinator` → "a deadline that elapses DURING the committed write
still recovers as success". It passes 37/37 standalone and passed on the second
full run; it is a load-sensitive timing test in Closet promotion, unrelated to the
scanner. It is reported rather than hidden.

**One environment fault fixed, not worked around.** The worktree initially used a
junctioned `node_modules` from a different branch line, which lacked `express` and
failed ~19 suites. Real dependencies were installed before certification.

---

## 12. Deployment prerequisites (NOT met — no deployment performed)

1. Owner authorization to deploy the Edge Function.
2. Deployment performed through the guarded wrapper, never `db push` or a raw deploy.
3. Certified snapshot parity re-verified against the deploy source.
4. Closure and parity gates re-run at the deploy SHA.
5. Rollback owner named.
6. `BACKEND_SCANNER_VERSION` confirmed **absent** in the target environment, so the
   deploy lands dormant.

Deploying this branch changes **no runtime behaviour** while the variable is unset:
the composed prompt is byte-identical to the certified build.

---

## 13. Activation prerequisites (NOT met — candidate DISABLED)

1. Explicit owner activation authorization.
2. Certified live measurements.
3. Candidate live measurements.
4. Reviewed comparison: accuracy, unsupported claims, schema failures, latency,
   provider failures, cost.
5. Canary scope defined.
6. Kill switch tested against the deployed integration.
7. Sanitized telemetry verified in the deployed environment.
8. Named rollback owner.

**Activation thresholds: TBD FROM MEASURED CERTIFIED AND CANDIDATE RESULTS.**
None invented. No accuracy measurement exists — the live provider baseline
remains deferred — and a threshold written now would later be mistaken for a
finding.

---

## 14. Known limitations

1. **No measured accuracy improvement.** Phase 2C is source integration. The
   candidate is structurally distinct and dormant; nothing here says it is better.
2. **The live provider baseline is still deferred.** Accepted residual risk for
   integration; remains a hard blocker for activation.
3. **Scoped to single-item image identification.** Multi-item detection and
   TextScan are deliberately excluded; extending would require separate evaluation.
4. **Kill switch tested in-process, not against a deployed function.** It cannot be
   tested against a deployment that has not happened.
5. **Token usage is not populated**, because the deployed path does not parse
   `usageMetadata` and Phase 2C must not add a parse.
6. **Platform propagation not performed.** The change lives on one integration
   branch. If the Android line must carry identical backend bytes, that
   propagation is a separate authorized step.

---

## 15. Recommended next step

**Do not deploy or activate yet.** The highest-value next step is the deferred
**live provider baseline**: certified and candidate measurements over the frozen
dataset. Without it there is no basis for an activation threshold, and the
integration — being dormant and byte-identical when unset — loses nothing by
waiting.

If a deploy is wanted sooner, it is safe on its own terms provided
`BACKEND_SCANNER_VERSION` is confirmed absent in the target environment, since the
composed prompt is then byte-identical to the certified build. That is a
deployment decision for the owner, not an activation decision.

---

## 16. Certification summary

- GOVERNING BASELINE: `integration/build3-ios-final` @ `dcacfc6` — proven, not ambiguous
- PRODUCTION DEFAULT: `certified-v140`
- CANDIDATE STATUS: AVAILABLE BUT DISABLED
- CLIENT CAN SELECT CANDIDATE: NO
- EXACTLY ONE DISPATCH: YES
- KILL SWITCH VERIFIED: YES
- ROLLBACK VERIFIED: YES — no mobile, migration, data or schema change
- CERTIFIED V140 CONTRACTS MODIFIED: NO
- PRODUCTION DRIFT PRESERVED: YES (`identify_for_closet` intact)
- PROVIDER REQUESTS: 0 · CONFIRMED COST: $0.00
- SUPABASE SCHEMA / COMMERCE / MOBILE / iOS / ANDROID IMPACT: NONE
- DEPLOYMENT PERFORMED: NO · ACTIVATION AUTHORIZED: NO
- COMMITS PUSHED: NONE
- SAFE FOR DEPLOYMENT PREPARATION: **YES**
