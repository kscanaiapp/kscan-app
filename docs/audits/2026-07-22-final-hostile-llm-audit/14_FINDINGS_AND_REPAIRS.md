# Findings and repairs

## AUD-01 — deployed Step 1 lacked clean committed source

- Severity: P1
- Surface: Scanner/TextScan
- Root cause: deployment originated from a heavily dirty, eight-commit-ahead workspace.
- Repair: isolated the exact migration in a clean worktree; tested, committed, pushed, merged, and redeployed.
- Commit: `50a3038…`; canonical integration `300ea878…`
- Final status: CLOSED

## AUD-02 — public legacy Render paid-provider route

- Severity: P1
- Surface: legacy `/api/analyze`
- Root cause: obsolete public service retained unauthenticated OpenRouter/retired-model behavior.
- Repair: route is registered as a 410 tombstone before body parsing; provider route/env declarations removed; public callers removed/disabled.
- Commit/deployment source: `260219c…`; merge `d1bb36ec…`
- Validation: 15 anonymous probes over three rounds returned 410; malformed JSON also returned 410; health remained 200.
- Remaining: service retirement/suspension, exclusive secret removal, exact live deployment identity, and paid-provider log proof are unverified because Render is signed out.
- Final status: OPEN / CONTAINED

## AUD-03 — hidden Vercel caller to Render

- Severity: P1
- Surface: Meta public demo
- Repair: safe mock default, explicit private live gate, Render URL removed.
- Commit: `489bde…`; deployment `dpl_5Y7H5…`
- Final status: CLOSED

## AUD-04 — StyleChat quota RPC ambiguity

- Severity: P1
- Surface: Elise quota
- Root cause: unqualified `messages_used` collision in PL/pgSQL.
- Repair: forward-only replacement of consume/refund RPCs with qualified identifiers, empty search path, schema qualification, and narrow serialization.
- Commits: `8f249a2…`, `dea1326…`; merge `c8dc27a…`
- Final status: CLOSED

## AUD-05 — refund authorization/ownership exposure

- Severity: P1
- Surface: Elise quota refund
- Repair: server-authoritative request-linked refund, owner derivation, grants locked down.
- Commit: `54991fd…` plus forward migration line
- Final status: CLOSED

## AUD-06 — model attribution unavailable

- Severity: P2
- Surface: active LLM functions
- Repair: privacy-safe `llm_routing_events` ledger and bounded per-request insertion.
- Commit: `72a6fab…`
- Deployment: Scanner v131; StyleChat v72
- Final status: CLOSED

## AUD-07 — routing ledger mutable by service role

- Severity: P2
- Surface: telemetry integrity
- Repair: forward-only revocation of update/delete; metadata and role probes verified append-only behavior.
- Commit: `721e76c…`; migration `20260722031812`
- Final status: CLOSED

## AUD-08 — gallery upload globally disabled

- Severity: P1
- Surface: uploaded Scanner
- Root cause: availability function hardcoded false and preparation always failed.
- Repair: local-only bounded JPEG re-encode, metadata stripping, safe cleanup/error behavior.
- Commit: `fe14d94…`; PR 25 merge `2257c85…`
- Tests: focused 41/41; full suite 1336/1336 after subsequent repair.
- Final status: CLOSED

## AUD-09 — nonexistent pixel masker blocked every image

- Severity: P1
- Surface: camera/upload Scanner and StyleChat photo intake
- Root cause: audit gate required face/plate masking that the product does not ship.
- Repair: require truthful metadata-stripped derivative evidence; keep face/plate capability flags false; invalid preparation remains fail-closed.
- Commit: `ea01c71…`; PR 26 merge `ffd25753…`
- Tests: focused 140/140; full 1336/1336; authenticated emulator Scanner PASS.
- Final status: CLOSED

## AUD-B01 — required final evidence incomplete

- Severity: BLOCKER (audit completion, not a proven product outage)
- Surface: Render administration and full emulator/device matrix
- Evidence: Render dashboard remains at `/login`; hardware/full-navigation cases listed in report 13 were not run.
- Final status: OPEN

Tooling failures listed in report 13 made no source, deployment, quota, credential, or provider change and are not product findings.
