# Account Deletion — Final Acceptance Packet (pre-platform merge)

Date: 2026-07-22/23  
**Platform merges: HELD. Do not merge into iOS v15 or Android AAB 26 until this packet is accepted.**

## Feature verdict

**CONDITIONAL — DELETION FEATURE COMPLETE; EXTERNAL PRODUCTION GATE REMAINS**

Narrow external gates only:
1. Approved disposable production account for irreversible lifecycle
2. Website restore page deploy to Vercel (`/account/restore`) — PR pending merge/deploy
3. Payment-provider retention decision
4. Coordinated rotation of previously exposed email secrets

Kill switch remains OFF. Live purge scheduler remains disabled. Dry-run remains ON.

---

## Canonical source

| Item | Value |
|---|---|
| Workspace | `C:\Users\jsmit\KScan-account-deletion` |
| Branch | `feature/automatic-account-deletion` |
| Starting SHA | `0c9086af9257b8ef002b7d2c479bf3da43ca0b9b` |
| Final SHA | `5f35b57f67833b448060dcc32da895002258c5aa` |
| PR | https://github.com/kscanaiapp/kscan-app/pull/36 (base `ios/full-submission-readiness-v2`) — **OPEN, NOT MERGED** |
| Website restore | `C:\src\kscan-website-account-restore-20260722` branch `feature/account-restore-page` |

---

## Hostile audit → repair map

| ID | Severity | Finding | Repair |
|---|---|---|---|
| B1 | Blocker | Client INSERT RLS on `deletion_requests` | Dropped policy + revoked INSERT/UPDATE/DELETE |
| B2 | Blocker | Storage list errors swallowed | Worker throws → retry/fail |
| P1-1 | P1 | Storage pagination missing | Offset loop + referenced retention |
| P1-2 | P1 | Rotate-before-email on resend | Peek → send → rotate |
| P1-3 | P1 | Profile deactivation best-effort | Fail closed + compensating failed status |
| P1-4 | P1 | Session data-plane residual | Auth ban 720h + privacy Edge guards + device session revoke |
| P1-5 | P1 | Legacy pending idempotent lie | Upgrade path to deactivated |
| P1-6 | P1 | Missing restore client | App `/account/restore` + website page/API |
| P1-7 | P1 | Five-session / wearables | `user_device_sessions` + max-5 register + revoke on deletion |
| P2 | P2 | Trigger search_path / timing-safe worker / claim detail leak | Fixed |

Remaining P3 (non-blocking): nested metadata redaction depth; IP throttle on resend.

---

## Unit tests

Command:
```bash
node --test __tests__/accountDeletionLifecycle.test.js __tests__/deletionRegistryParity.test.js __tests__/handleUserDeletionEdge.test.js __tests__/sevenTableCoverage.test.js __tests__/processDeletionRequest.test.js
```
Environment: local Node, deletion worktree  
Result: **56 pass / 0 fail / 0 skip**  
Verdict: **PASS**

---

## Integration tests

Command:
```bash
node --test __tests__/accountDeletionIntegrationContracts.test.js __tests__/accountDeletion.test.js __tests__/routingGuard.test.js
```
Environment: local Node contract/integration suites  
Result: **29 pass / 0 fail / 0 skip**  
Verdict: **PASS**

Production dry-run (worker secret, kill OFF, dry-run ON):
- mode `dry_run`, eligibleCount 0, 6 plans all `skipped_future_grace`
- tree nodes 44 (includes `user_device_sessions`)
- no Auth/Storage deletes

Render restoration email live probe (prior pass): 200 SENT + idempotent duplicate 200.

---

## Proposed integration commits (after approval only)

Integrate **only** deletion commits from `feature/automatic-account-deletion` into new branches cut from accepted iOS v15 / Android AAB 26 sources. Do not merge PR #36 into those accepted lines directly without the Phase 6 integration branch process.

---

## Stop

Awaiting explicit approval before any iOS v15 or Android AAB 26 integration work.
