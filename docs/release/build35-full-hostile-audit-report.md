> FINAL STOP-STATE: Latest complete full Node validation:751e3815,11336 passed/0failed/98skipped,total11434; log candidate-node-permission-matrix-final.log and exit0 captured. Runtime source is unchanged froma376f2f7 (TypeScript and six source gates0), backend unchanged from53b93724 (1531/0failed). No combined-SHA runtime claim.

> OWNER-REQUESTED STOP: prepared candidate 751e381565a70f34fdf14edee43fffab232b8030, unmerged. Latest test-only commit751e3815 adds12 permission failure cases; focused29/29 pass. Last completed full suitea376f2f7:11324 pass/0fail/98skip; TypeScript/six source gates0. Latest full rerun exit0. Backend1531 at53b93724, unchanged runtime source. Exact654 wording owner-approved; merge/deployment remain gated. See current checkpoint for resumption.

# Build 35 hostile audit and repair evidence

Verdict: **BLOCKED - REQUIRED EXTERNAL EVIDENCE OR AUTHORIZATION UNAVAILABLE**. This is an executable continuation checkpoint, not a completed application-wide certification. Nine confirmed P0-P3 defects have source repairs prepared; none has merged or been deployed. Reachable interfaces still lack complete mandatory hostile coverage. No platform-candidate readiness PASS is issued.

## Source and scope

Authoritative Build35 source is integration/build35-v1-convergence at65a1e7cd6c2bea790e87c009a41de999d6cf2fa8. Backend authority remains rebuild/backend-authority-v2 at3efcb6cbf29eb10c1bc1510f05e9a3365755bd74. RP-108 preserves pre-freeze840ba88ee41e97de8d9d63ad5f3d3dd03fd457a2 as isolated Build34; it is not the Build35 target. Existing release documents resolve this, without an owner override. Prepared PR648 candidate is a376f2f7fc6694b30e5623998a56522eccf20280; source repairs and canonical backend promotion are serial commits with exact-path provenance controls. This is not an authoritative merge SHA.

Recovered all prior worktrees, logs and PR644/645/646. Verified PR635-643 from current GitHub/source evidence. Source inventories cover all three authorities; the 26-row [integration matrix](build35-integration-activation-matrix.md) covers auth/onboarding, privacy, all Scanner modes, commerce, discovery/merchants, all stylists/speech, K+, Closet/Rooms/Packing/Watchlist, Photo/Live VTO, deletion, analytics, backend and native/release configuration. Coverage is bounded source/contracts and the specific runtime fixtures below. End-to-end/device/provider surfaces that were not executed remain NOT AUDITED/NOT TESTED; no lane is called fully complete.

## Confirmed defects and source repairs

| Priority | Count | Findings / PRs |
|---|---|---|
| P0 | 0 confirmed | No claim of absence outside tested scope |
| P1 | 4 | C-001 Gemini disclosure/version645; F-002 outfit account lifecycle647; C-002 server consent649; C-005 durable withdrawal653/654 |
| P2 | 3 | G-001 malformed secondary display644; COST-003 ambiguous paid-probe accounting650; F-006 navigation URI decoder655 |
| P3 | 2 | G-004 mounted badge expiry651; C-004 missing-timing speech652 |
| P4 | 1 | B-004 Scanner JSON-null resilience; safe-repair rule excludes this owner-gated subsystem |
| P5-P10 | 0 confirmed | Two UNCONFIRMED investigations retained with missing evidence, not counted as defects |

[Repair ledger](build35-p0-p3-repair-ledger.md) contains reproduction, exact source, root cause, regression evidence, PR/commit, candidate promotion and remaining gates. Source preparation is not merged or operational repair. No known P0-P3 issue was downgraded to defer it. URI decoder source uses upstream0.5.1 with pinned algorithm provenance and CommonJS compatibility; no advisory exception or framework upgrade. Withdrawal preserves immutable receipts and adds actor/revision-fenced permission state; the migration is explicitly pending, not applied. Owner approved the exact Privacy-control wording; merge and deployment remain gated.

## Tests, kept separate by SHA

| Source | Executed validation | Result / scope |
|---|---|---|
| integration65a1e7cd | Full Node / Deno baseline | 11179 passed,0 failed,98 skipped /1422 passed |
| original pre-freeze+644bd2827e7 | Full Node baseline | 9332 passed,68 failed,67 skipped; retained FAIL |
| corresponding integration suites | All68 failure dispositions,11 suites | 336/336; separate pre-freeze writeguard67/67 after ignored link metadata isolation/restoration |
| candidate72eee2fb | Full structured Node / backend | 11289 passed,0 failed,98 skipped /1515 passed |
| candidate50088fd0 | Full Node / TypeScript | 11293 passed,0 failed,98 skipped /exit0 |
| candidate53b93724 | Full Node / TypeScript / backend | 11321 passed,0 failed,98 skipped /exit0 /1531 passed,0 failed |
| decoder branch37a519bc+b4ba29c8 | Clean npm ci; actual consumer/provenance; dependency gate | install0;3/3; gatePASS. 7171-byte fixture:1031 replacements before,5 after; local after about4ms, not mobile performance certification |
| candidatea376f2f7 | Clean npm ci; full Node/TypeScript/dependency rerun | Install exit0;11324 passed,0 failed,98 skipped;TypeScript0; dependency gatePASS; all six source gates0, logs candidate-*-decoder-* |

The 98 skips are explicit declarations, not passing assertions; individual titles/source are retained in structured Node evidence. Tests at different SHAs are not combined into a final green claim. Standalone hostile handler suite is intentionally still red on B-004 and is not hidden by a green unit suite. Source-level native parity, migration/authority/edge manifests and release profiles passed at recorded earlier SHAs; final candidate CI remains pending. No standalone lint/E2E/device/paid-provider success is invented. TestSprite CLI/auth/project available, but these native patches are undeployed and no reachable target/MCP carries them: UNVERIFIED-BECAUSE-UNDEPLOYED.

## Hostile probes

Original mandatory inventory:3096 cells,54 PASS,1 FAIL,3041 NOT TESTED at this checkpoint. Not all cells are applicable: explicit coverage reasons retain non-applicable external-recipient JWT/RPC/storage classes. These numbers are separate from886 individually indexed bounded executions:873 PASS,1 FAIL,12 declared skips. Unit-contract counts do not automatically close complete-boundary cells.

- Production18 anonymous and36 malformed/tampered JWT requests:401 at authenticated gateways. No valid customer/paid/destructive operation; not IDOR or correctly signed expired-token proof.
- Actual31 Edge handlers in offline Deno harness:186 invalid/auth cases,185 controlled no-provider/no-privileged-write results, one Scanner null TypeError. Fake Auth/backend response contracts do not certify JWT cryptography.
- Real authorized Staging synthetic actors:19 passing profile/storage/share-removal/expiry/cleanup checks. Own profile baseline succeeds; foreign profile read/update, cross-user storage read/sign/write, removed-member message access fail. Signed URL initially200 then explicitly denied400 after expiry. Two earlier harness-invalid runs retained/excluded. Read-only cleanup proves zero tagged actors/rooms/objects.
- Additional321 Node and263 Deno bounded contract records are attributed to exact tests, with12 declared skips retained. Current permission/speech/decoder subset adds43 records and revalidates12 existing records; the12 newer permission HTTP/schema failure cases have a passing focused log and await individual indexing; no inflated duplicate totals.

[Individual mandatory matrix](evidence/mandatory-hostile-probes.json), [executed records](evidence/executed-hostile-probes.json), [68 dispositions](build35-prefreeze-68-failure-disposition.md). Complete per-function/provider authenticated failure/concurrency/field probes remain executable work, not a reason to mark PASS by default.

## Runtime evidence and claim discipline

Read-only Supabase inventories:Production28 functions,Staging40. Discovery absent in Production; StagingACTIVEv5/JWTtrue with digest retained. Production organic-discovery and ownership-badge flags are false; sponsorship enabled/sandbox/shadow all false. Brand voice and image mission flags true, without a mode-specific invocation or client-artifact claim. Both ledgers contain the four promoted migrations; counts156/183. New withdrawal migration not applied. Current deployed bundle/source parity is not universally attested.

PR643 customer-facing mount is VERIFIED on pre-freeze and prepared candidate: app/scan -> actor/epoch-keyed app.js -> ScanResultV2 -> useBlackOwnedDiscovery and BlackOwnedDiscoveryShelf. It is absent on authoritative65a, so authoritative source integration remains INCOMPLETE until approved convergence. Primary commerce source-order/neutrality proof remains intact; no sponsorship or merchant inventory fabricated.

RevenueCat connected authority verifies current US0.99 monthly/9.99 annual and one-month trials on both stores; Apple READY_TO_SUBMIT, Google active plans/offers. No purchase or pricing change. PostHog project571577 has four ingested event names in30days; full intended taxonomy/current binary binding not verified. SDK replay/autocapture/errors explicitly disabled, project capture opt-ins differ; no recording fetched or setting changed. Watchlist source scheduling is protected GitHub six-hour workflow, not Supabase cron; recent pending/cancelled runs do not prove delivery. [Claim ledger](build35-handoff-claim-verification.md) distinguishes VERIFIED/CONTRADICTED/UNVERIFIED.

## Remaining gates and handoff

Owner approval required before merging644/645 or dependent convergence. Withdrawal source authorized; copy and merge require separate review. New durable state requires governed migration then matching backend/client rollout; deploying server v2 receipt enforcement before affected clients can acknowledge it can deny old clients. No rollout performed. Current PR CI snapshots and failures remain in evidence, not waived.647 promotion initially lacked required contract artifact after workflow cancellation; rerun/CI clearance remains a real gate.646 original documentation terminology failure is repaired with narrow historical classifications; the new decoder failure is separately being fixed.

No EAS build,IPA/AAB/APK,version increment,store submission,Production deploy/migration/secret/table mutation,paid provider call,purchase/refund,or sponsorship activation occurred. Tagged ephemeral Staging fixtures were the only remote test writes and were cleaned. Physical devices/signed artifacts, all-provider retention/deletion contracts, legal-copy approval and complete remaining hostile probes are required before a readiness decision. Source Apple preflight exit0 has three documented metadata/signing warnings, not submission certification.

[Checkpoint/resume commands](build35-campaign-checkpoint.md), [source convergence](build35-source-convergence-ledger.md), [platform handoff](build35-ios-android-candidate-audit-handoff.md), [third-party17-dimension inventory](build35-third-party-data-flow-evidence.md), [deferred/hypothesis evidence](build35-hostile-audit-p4-p10-backlog.md), [UX Wave2 plan](build35-ux-pass-plan.md). Zero confirmed ClassC UX items are scheduled; unexecuted hardware checks are not invented UX defects.

Owner update: exact PR654 Gemini control wording APPROVED; this does not authorize merging or deployment. Broader Terms/Privacy/store disclosure reconciliation remains a separate legal handoff.
