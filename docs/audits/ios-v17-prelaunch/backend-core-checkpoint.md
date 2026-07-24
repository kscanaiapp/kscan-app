# iOS v17 Pre-Launch — Backend-Core Checkpoint

**Date:** 2026-07-24
**Branch:** `integration/ios-v17-prelaunch-complete` (worktree `C:\src\KScan-ios-v17-prelaunch-integration-20260723`)
**Base:** v15 `5b687b6` (tested). Scope so far: backend core + account lifecycle + client baseline + Node test reconciliation. Frontend feature integration deliberately NOT started.

## Checkpoint status

```
Backend core:                PASS
Client baseline:             PASS
Node suite:                  PASS
TypeScript:                  PASS
Deletion media coverage:     PASS
Open privacy questions:      NONE
Frontend feature integration: NOT STARTED
```

## Evidence

| Gate | Command | Result |
|---|---|---|
| TypeScript (client) | `npx tsc --noEmit` | **0 errors** (exit 0) |
| Node suite | `node --test __tests__/*.test.js` | **98 passed / 0 failed / 0 skipped** (1 obsolete file removed — see below) |
| Deno backend tests | `deno test supabase/functions/{scan-identify,stylechat-generate}/` | **134 passed / 0 failed** |
| Deno type-check | `deno check` (all 16 fn entrypoints) | 15/16 OK; 1 pre-existing/out-of-deploy-set (PRE-01) |
| Dependencies | `npm ci` | clean, 908 pkgs, exit 0 |

## Backend core delivered & verified
- **Frozen model map** — scan-identify + stylechat-generate route only through `modelRouting.ts` (`gemini-3.6-flash` / `gemini-3.5-flash-lite`); `gemini-1.5`/`2.0`/`2.5` defaults and generic `GEMINI_MODEL` precedence removed; allowlist-enforced. (LLM-01, LLM-02)
- **Account-active guard** — `assertAccountActive` wired into scan-identify; stylechat retains its tested lifecycle gate; `_shared/deletion/*` + `restore-account` + `resend-restoration-email` + 6-migration lifecycle chain integrated. (AAG-01)
- **Migration safety** — required backfill non-destructive, empty `search_path`, qualified `public.*`; purge worker stays config-gated/disabled. (MIG-01)

## Saved-scans privacy resolution (SS-01) — the checkpoint gate
`{userId}/saved-scans` media was **orphaned** after account deletion (real P0). Fixed by adding the prefix to both deletion registries; covered by the existing narrow, reference-checked, per-user-prefix processor. Proven by 6 regression tests (registry sync, single/multiple objects, cross-user isolation, idempotency, no-broad-delete). **Deletion media coverage: PASS.**

## Node test reconciliation (4 items closed)
- `scanCommerceRouter.test.js` — STALE/obsolete (fails on donor too) → removed; superseded by Deno `commerceRelevance.test.ts` (15/15).
- `outfitDecisionContract` / `stylistIdentity` / `styleChatAttachmentContract` — CONTRACT DRIFT (registry externalized to JSON) → assertions redirected to the JSON source of truth; coverage verified; `outfit_decision_options`/`option_items` proven via FK cascade. No assertions weakened.

## Not yet done (tracked, out of this checkpoint)
- Backend additives: scan-identify model-fallback retry, aiSecurity TextScan envelope, routing telemetry.
- Full migration-chain replay on a disposable DB.
- Frontend feature integration (next phase): secure sessions → Elise V2 client + attachments → DR2–DR4 → avatars/speech → icons/luxury home → app.json/eas.
- Overall charter pre-deploy gate + backend deployment + authenticated probes (owner-gated).

**This is a pre-integration checkpoint, not the final release candidate.** No backend deployment, no iOS build, no final-candidate commit.
