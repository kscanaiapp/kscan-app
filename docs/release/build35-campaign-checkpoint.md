# Build 35 campaign checkpoint

Verdict: BLOCKED pending explicit owner merge approval and outstanding verification. No release certification issued.

## Current operation and source

- Last completed: promoted governed backend SQL tests and dry-run invoker files; reconciled migration authority with current read-only Staging/Production ledgers. Focused 159/159 pass, zero skips.
- Candidate: integration/build35-hostile-convergence-20261029 at 72eee2fb (PR #648, pushed); target integration/build35-v1-convergence at 65a1e7cd. This is an unmerged candidate, not the authoritative release head.
- Backend authority: rebuild/backend-authority-v2 at 3efcb6cb. Pre-freeze 840ba88e remains Build 34 isolated by RP-108. Authority conflict resolved by existing scoped governance; no exception authorized.
- Sole lead edits shared files serially. Original worktrees and uncommitted evidence preserved.

## Lanes

- Fully completed lanes: none. Completed bounded work: source authority resolution; all 68 historical failure dispositions; six repairs prepared; real Staging identity/storage/share-removal fixtures; production deployment/flag/migration readback; source convergence preparation.
- In progress: F backend/security; B Scanner/commerce; C consent/speech/VTO; G discovery/analytics. D/E/H retain NOT AUDITED for any untraced/unexecuted surfaces. A final convergence/CI pending.

## Findings and repairs

- Confirmed P0 0, P1 3 (C-001 disclosure, F-002 lifecycle, C-002 backend receipt), P2 2 (G-001 secondary parsing, COST-003 paid-probe accounting), P3 1 (G-004 mounted badge expiry). Six repairs prepared, zero merged. Count is findings proved, not absence of other defects.
- PRs #644, #645, #647, #649, #650, #651 remain open; #648 contains serially promoted repairs for candidate verification. #646 is the existing evidence lane. No duplicate repair PRs.
- Owner explicitly requires approval before merging #644/#645; dependent convergence cannot merge them indirectly. No merge performed. Sensitive dependent changes remain subject to owner/governance gates.
- Separate P4 input-resilience failure: real Scanner handler throws on JSON null, zero provider/write effects. Preserved in standalone hostile harness; proposed guard touches excluded scan-identify subsystem, so safe lower-severity repair condition fails. No scope bypass or severity inflation.
- Durable Gemini withdrawal authority remains unresolved: immutable acceptance receipts alone cannot represent withdrawal. Do not claim universal consent completion.

## Tests and runtime

- Prior 68 failures: individually dispositioned; 336/336 corresponding integration checks; original writeguard 67/67 with isolated then restored CLI metadata. Final candidate rerun in progress.
- Running at 5175f01f: node scripts/run-all-tests.js, node scripts/run-backend-tests.js, npx tsc --noEmit. Logs candidate-node-final.log, candidate-backend-final.log, candidate-typecheck-final.log.
- Standalone hostile handler suite: 31 handlers, 186 invalid/anonymous cases, 185 bounded PASS, one FAIL (Scanner null); not authenticated IDOR proof.
- Real Staging isolation fixture: 19/19 including cleanup actor checks. Prior two harness-invalid runs retained and explicitly invalid, not product findings. Read-only cleanup readback confirms zero remaining tagged actors, rooms and storage objects.
- Production: discovery absent; organic discovery/badge flags false; all three sponsorship flags false; brand-voice/image-mission flags true. Both projects have all four promoted migrations. Metadata RLS readback found no client-granted public/storage table with RLS disabled. This does not establish every policy correct.
- No Production mutation, no paid purchase/provider probe, no EAS build or signed artifact. Native TestSprite patch remains undeployed/unverified; existing authenticated CLI is not evidence of this patch running.

## Exact next steps

1. Collect structured full Node test attribution at 72eee2fb; backend 1515/1515 at 72eee2fb, tsc exit 0 at 01d78197. Six source gates pass. Earlier 5175f01f Node run 11288 pass/0 fail/98 skip. VTO enforced CI scope repaired with exact canonical provenance at 72eee2fb; await refreshed CI.
2. Verify Staging synthetic cleanup with read-only tagged counts; retain probe rows with environment/SHA/expected/actual/evidence.
3. Refresh all PR CI; reconcile stacked repair branches with tested candidate without merging owner-gated changes.
4. Complete remaining source/provider/state probes and update feature matrix. Every unexecuted boundary gets NOT TESTED and a precise reason.
5. Refresh all evidence reports/claims/ledger; push existing #646. Await owner approval only at protected merge/deployment boundaries while independent work continues.

Live external readback: RevenueCat current U.S. 0.99/month and 9.99/year plus one-month trials verified on Apple and Google; Apple products READY_TO_SUBMIT, no purchases/price changes. PostHog project571577 has four event names seen in last30days; no full-taxonomy or artifact-binding claim. Project recording opt-in is true while client SDK replay is explicitly false; no capture configuration changed. Cron/pg_net extensions absent in both Supabase projects; GitHub protected Watchlist scheduling is the source authority, recent Production runs pending/cancelled, not delivery proof.
