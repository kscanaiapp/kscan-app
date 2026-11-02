# Build 35 parallel-agent task board — November 2, 2026

Read the [current handoff](build35-owner-handoff-2026-11-02.md), checkpoint and retained evidence first. Audit remains incomplete. Device certification is excluded; deletion-cycle repairs are deferred. Prior completed source-work items are not to be restarted.

## Shared execution contract

Use isolated worktrees based on mobile `892f9ef08b29bbce68edffb96298b0a8bf65814a` or canonical backend `26d5fae291ffcdbb1a56e312524013c6939ab152`, after fetching and checking any newer authority. Read AGENTS/governance. One lead exclusively owns receipt handler/quota settlement, all migrations, manifests, promotion controls, central ledgers and matrix. Never reset or edit another agent's worktree.

Each testing agent writes to a unique outbox, e.g. `C:/b35parallel/<lane>/`, or a unique evidence subdirectory in its own branch. Return a patch/commit plus reproducible commands, raw stdout/stderr and structured results. The lead imports the evidence serially. Do not push multiple staging workflows into the shared concurrency group; the lead schedules authorized synthetic Staging batches.

Required record: stable probeID, endpoint/workflow, exact sourceSHA, environment, fixture actor/resource, input, expected, actual response/authoritative state/side effects, PASS/FAIL/NOTTESTED (explicit N/A reason), command/exit/test counts/raw evidence, defect ID if proven, limitations and cleanup record. Never log credentials/customer PII. A contract mock is not a live provider, gateway401 is not authenticated IDOR, and a missing failure is not success.

Prove suspected defects with a failing runnable case or exact code/contract argument. Submit proven findings to the lead before runtime-source editing; retain unsuccessful hypothesis attempts as UNCONFIRMED. No new feature/UX redesign. Normal green merges are owner-authorized, but no protection bypass or automatic runtime rollout.

## Agent 1 — integration lead: finish the authorized source queue

**Priority: highest; one owner.** Finish canonical681 post-merge7workflow verification, then exact mobile promotion and9workflow closure. Prepared script/worktree details are in the handoff. Review the promotion procedure, retain the original C023 provenance, and test all historical source/scope controls; do not simply change hashes until CI is green.

Then F025: trusted backend-only actor-scoped quota settlement; real SQL-role/handler regressions for own/foreign/tampered caller, in-flight completion/release, duplicate/replayed settlement and DB errors. Check every direct/helper caller and migration compatibility. Use Supabase CLI migration creation and governance declarations, without applying it. Preserve service-role isolation. Finish canonical/mobile CI and convergence before B004.

Then B004: owner-approved Scanner null-body validation, actual handler negative/positive routing controls, side-effect counts, canonical/mobile integration. Keep P4 severity unless demonstrated impact changes. Reconcile its original single failing matrix cell only after exact equivalent source proof passes.

**Exclusive files:** purchase-import-extract handler, quota helpers, every migration/authority declaration/Edge manifest, promotion helpers/tests, central evidence/matrix/ledgers. Other agents must send proposals for these files instead of editing them.

## Agent 2 — coverage reconciliation, without runtime edits

**Useful immediately.** Start with `mandatory-hostile-probes.json`, executed-hostile-probes, the newer standalone source records and raw integrity index. Take a bounded initial batch: receipt/purchase-import, StyleChat, Packing and Live source rows. Map already executed cases only when actor, boundary, expectation, outcome and source/code equivalence match.

Deliver a proposed per-cell patch with evidence links and a count reconciliation. Keep duplicate assertions, full-suite totals and original cells separate. Preserve N/A explicitly; reassign four device rows and the old signed-artifact requirement to excluded laterQA without hiding software gaps. Classify deferred deletion-cycle cells consistently with owner scope; account-isolation controls in other workflows remain in scope.

**Acceptance:** every proposedPASS has an attributable executed boundary; all remaining rows have a specific missing test/evidence reason. No blanketPASS from11,447green tests. Current exact original counts136PASS/1FAIL/2959NT must balance after any proposed changes. Do not directly edit the shared central matrix in the lead worktree.

## Agent 3 — Watchlist, notifications and actor isolation

**New tests/harness only, in disjoint files.** Inspect actual `commerce-watch-refresh` handler, `pushDelivery.ts`, `pushObservability.ts`, `receiptProcessing.ts`, entitlement guard, client watch/push-token services and relevant scheduling SQL. Enumerate existing retained cases before adding probes.

Exercise remaining source boundaries: token registration/removal on logout/account switch, stale completion after account change, A-versus-B token/resource access, duplicate alert delivery, removed watch items, expired entitlement, scheduler authority and provider500/429/timeout/empty/malformed/wrong-schema. Verify authoritative watch/notification state and bounded retry, not only UI text. Read scheduling metadata non-destructively; never trigger bulk Production notifications.

**Acceptance:** endpoint/workflow-specific evidence table and any failing regression; positive baseline plus cross-account/duplicate/failure controls. Existing gateway or mock unit tests alone do not prove remote RLS. Do not edit deletion-cycle code or shared function index/manifests; route a confirmed repair through the lead.

## Agent 4 — K+ remaining SQL/concurrency and webhook evidence

**Do not repeat the36closed composed UI/SDK cases.** Read the K+ source report and46retained Staging checks/six exact SQL identities. The known D009/D021 fixture/child-stdin repairs are merged in676/677; do not redo them.

If a disposable local Docker/Postgres engine is available, execute the five optional concurrency cases using the corrected fixtures and runner. Confirm safe disposable target enforcement, native concurrent connections, actual period constraints, monotonic provider observation and idempotency. If unavailable, record that exact limitation; do not convert mock success into real concurrencyPASS.

Inspect retained actual RevenueCat webhook/reconciliation source coverage for duplicate event IDs, out-of-order renewal/expiration, provider500/429/timeout/malformed state, stale RevenueCat versus Supabase authority and account binding. Run only uncovered synthetic cases; no store charges, refunds, price/dashboard edits or native build.

**Acceptance:** runnable SQL/source probes with baseline/control outputs, exact canonical function hashes, source-versus-sandbox limits and no duplicate grants. Treat existing green payment source flows as preserved, not a new issue to rewrite. New subscription runtime edits or migrations go through the lead.

## Agent 5 — image transport/privacy source boundaries

**H003 source work; no physical detector certification.** Start with the ten routes in the privacy source assessment, `services/privacy/privacyBoundary.ts`, image preparation, crop/selected-item paths, retries/caches and storage/provider adapters. Reuse retained face/plate mock and payload tests.

Trace raw and transformed byte references through actual transport calls using synthetic non-personal image fixtures and intercepted request bodies. Test detector-unavailable/error refusal, sanitizer failure, retry/cancellation, crop replacement, cached input, account switch and alternate upload entry points. Confirm the outbound bytes come from the covered sanitized result; distinguish Scanner, Closet-derived identification, Elise attachments and separately consented PhotoVTO person processing.

**Acceptance:** path-by-path payload/orchestration evidence and precise source limits; no claim of face/plate detection accuracy from mocked detectors or prompts. Do not seek hardware, build an app, remove a feature or alter protected Scanner code. B004 remains lead-owned; supply disjoint tests/proposals.

## Agent 6 — analytics/provider factual metadata

**H001 investigation; legal wording stays with owner.** Reuse prior PostHog source repair and privacy assessment. Enumerate actual emitters/allowlisted properties, anonymous/login/logout/account-switch/reset, opt-out and persisted-queue handling. Check whether new receipt/live events change the inventory; do not rerun all unchanged assertions without a delta.

Inspect authorized provider configuration/aggregated ingestion metadata without querying/exporting private raw event payloads. Separate SDKinstalled/sourcewired/configured/emitted/provideringested/currentbinarybinding. Research primary provider evidence for retention/deletion commitments and list exact missing contractual/configuration decisions for the owner. Do not infer unlawful tracking or certify privacy from a small sample.

**Acceptance:** factual provider/data-category/trigger/consent/identity/retention table, exact evidence URLs/config authorities, uncertainty and recommended engineering work only if proven. No analytics flag/replay/autocapture activation, website/legal-copy rewrite or customer communications. New analytics core edits go through the lead.

## Agent 7 — Packing and non-receipt commerce failure-path remainder

**Verification, not reimplementation.** Packing674/675are source-closed. Reconcile the43Packing matrix rows:15specific sourcePASS,11explicitN/A and17distinct software scopes were last reported. Identify which of those17 are actually covered by retained UI/handler/provider records and execute only genuinely missing safe boundaries.

For commerce, inspect actual mounted primary results and secondary shelf contracts, existing isolation/expiry/source-mission repairs, URL/currency/image parsing, supersession/account-switch state and primary independence under a hung/malformed secondary provider. Use current actual adapters/hooks/components with controlled HTTP replies for500/429/timeout/empty/malformed/wrong-schema. Preserve retailer-neutral primary ranking and explicit user actions; no invented inventory/sponsorship/merchant verification.

**Acceptance:** demonstrable user-facing route-to-state-to-authoritative-result tests plus honest flags/deployment limits. Do not edit ProductCard, ScanResultV2, shared hooks, function indexes or manifests concurrently; send failing fixtures to the lead first. Do not repeat already closed brand voice/image prompt tests just to increase counts.

## Agent 8 — runtime readback and evidence/governance review

**Read-only; coordinate any Staging fixture runs with lead.** Refresh project identities, function inventory/version/digest/JWT, migration ledgers, non-sensitive boolean flags/secret-presence metadata, scheduler/webhook configuration and approved activation evidence. Specifically refresh Production discovery, Gemini permission, saved-scan active/restore migration state and receipt activation. DatedOct31/Nov2 facts must retain dates until new readback succeeds.

Review PR646 evidence provenance, source identities, archive hashes, misleading historical status paragraphs, sensitive-content risk and proper ownership of added test artifacts. It is a large draft/HOLD, not an automatic green merge. Reconcile source parity and final exact-head CI when the lead's repair queue advances.

**Acceptance:** source/deployed/enabled/integrated/customer-live remain distinct, no secrets/customer rows in reports, and a concrete list of missing protected rollout approvals. No migration application, function deploy, flag flip, pricing/store/binary action. Owner-approved public capability policyH014 is closed; do not classify its intended retention as a vulnerability.

## Recommended staffing and return order

Keep Agent1 as the only source integration writer. With three additional agents, prioritize Agent2 (coverage), Agent3 (Watchlist/notifications), and Agent5 (transport). Add Agent4 if a real disposable Docker/Postgres engine is available; Agent6 and Agent8 can use authorized connected read-only tools. Agent7 can proceed on independent harness files.

Each agent should return its first bounded evidence batch before expanding. Checkpoint after each batch. The lead reviews proven failures first, imports evidence/matrix changes serially, and schedules further authorized repairs only after the current in-progress queue closes. This maintains momentum without creating competing source changes or another collection of unfinished repairs.
