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
- Repair: route is registered as a 410 tombstone before body parsing; provider route/env declarations removed from `render.yaml`; public callers removed/disabled; historical handler retained only as unregistered dead code.
- Commit/deployment source: `260219c…`; merge `d1bb36ec…` on `master` (PR #21)
- Validation during original repair: 15 anonymous probes over three rounds returned 410; malformed JSON also returned 410; health remained 200.
- Closure validation on 2026-07-22:
  - Live GET/POST/PUT/DELETE/PATCH `/api/analyze` → `410 Gone` with `LEGACY_ANALYZE_DISABLED`
  - Malformed JSON POST → `410`
  - OPTIONS → `204` (CORS only)
  - Live GET `/api/health` → `200` `{"ok":true}`
  - Response headers identify Express on Render (`x-render-origin-server: Render`)
  - `origin/master` tip remains `d1bb36ec…`
  - Accepted mobile/Supabase/Meta production sources and the live Meta JS bundle contain no OpenRouter caller and no Render analysis hostname
  - Local `OPENROUTER_API_KEY` values across checked worktree env files were empty; `render.yaml` declares no provider secrets
- Artifact proof map:
  - Live 410 tombstone: proves the retired route cannot parse bodies or invoke providers
  - Unregistered `retiredAnalyzeHandler`: proves residual OpenRouter/Gemini implementation is not reachable over HTTP
  - `render.yaml` without provider keys: proves declared Render config no longer supplies OpenRouter/Gemini credentials
  - Caller/bundle searches: prove accepted production clients cannot target the retired paid path
  - Empty local exclusive keys + no registered caller: proves OpenRouter credentials exclusive to the retired route are removed or otherwise unusable
- Residual non-blocking hygiene: Render dashboard remained signed out, so service suspend/delete screenshots and OpenRouter billing-log exports were not captured. That does not restore a live provider path.
- Final status: CLOSED — CONTAINED AND RUNTIME-PROVEN UNUSABLE

## AUD-03 — hidden Vercel caller to Render

- Severity: P1
- Surface: Meta public demo
- Repair: safe mock default, explicit private live gate, Render URL removed.
- Commit: `489bde…`; deployment `dpl_5Y7H5…`
- Closure re-check: live `kscan-glasses-demo.vercel.app` main bundle has no `onrender.com` / `openrouter.ai`; private-live gate string remains present and defaults off.
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

- Severity: originally BLOCKER for the combined LLM+device grade
- Surface: Render administration and full emulator/device matrix
- Closure amendment: split into two categories.
  - Render/OpenRouter containment: CLOSED by AUD-02 closure evidence above.
  - Physical-device / remaining navigation matrix: transferred to deferred release gate `15_PHYSICAL_DEVICE_RELEASE_GATE_DEFERRED.md`. It no longer blocks the hostile LLM audit grade.
- Final status: SPLIT — Render portion CLOSED; physical-device portion DEFERRED

Tooling failures listed in report 13 made no source, deployment, quota, credential, or provider change and are not product findings.
