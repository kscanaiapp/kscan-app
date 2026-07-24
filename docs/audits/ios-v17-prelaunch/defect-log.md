# iOS v17 Pre-Launch — Defect & Repair Log

Status legend: OPEN / FIXED-IN-SOURCE (self-verified by local checks) / DESIGNED (resolution known, not yet applied)

---

## ⚙️ Reconciliation method note (important)
The initial 3-way `git merge-file` approach for `scan-identify` was **abandoned** — it silently dropped an entire scanner subsystem (project-access + anonymous-analysis auth, `AuthContext.hasProjectAccess`) where the modernization won an unmarked region. Silent feature loss is unacceptable for "the app works together." **Adopted approach:** pristine scanner `a414ad5` `index.ts` as base (deno-checks clean, feature-complete, has the project-access analysis path the charter requires) + **surgical frozen-map routing swap**. BR-01/02/03 below were artifacts of the abandoned merge and **do not exist** in the adopted file (`deno check` clean).

## LLM-01 — Backend routing violates frozen model map — **P0**
- **Description:** v15 base *and* deployed prod `scan-identify` v136 use `DEFAULT_MODEL='gemini-1.5-flash'` (scanner) / `'gemini-2.5-flash'` (stylechat) with generic `GEMINI_MODEL` precedence. Charter FAIL #12/#13.
- **Root cause:** LLM modernization (`d3293286`) never integrated into the tested v15 line.
- **Repair:** Reconciled `scan-identify/index.ts` now sources routing from `modelRouting.ts` (frozen map: scanner `gemini-3.6-flash`→`gemini-3.5-flash-lite`, TextScan `gemini-3.5-flash-lite`; `ALLOWED_MODELS` allowlist; generic `GEMINI_MODEL` removed).
- **Self-verification:** reconciled file greps **0** `gemini-1.5` literals, **0** `readTrimmedEnv('GEMINI_MODEL')`, `resolveWorkloadModels` wired.
- **Status:** **FIXED-IN-SOURCE + VERIFIED for `scan-identify`.** On pristine-scanner base: imported `modelRouting.ts` frozen map; `modelName = mode==='text' ? getConfiguredModel(readTrimmedEnv,'TEXTSCAN_GEMINI_MODEL',TEXTSCAN_PRIMARY_MODEL) : getConfiguredModel(readTrimmedEnv,'SCAN_GEMINI_MODEL',SCANNER_PRIMARY_MODEL)`; removed `DEFAULT_MODEL='gemini-1.5-flash'` and generic `GEMINI_MODEL` precedence; `fallbackModel` resolved (`SCAN_GEMINI_FALLBACK_MODEL`→`gemini-3.5-flash-lite`).
  - **Verification:** `deno check` **exit 0**; `deno test supabase/functions/scan-identify/` = **55 passed / 0 failed**; greps: 0 live retired-model literals, 0 generic `GEMINI_MODEL` reads.
  - **Remaining for full scan-identify frozen-map/security completeness (OPEN, additive):** (a) wire model-level fallback retry using `fallbackModel` (scanner primary→lite; TextScan same-model retry); (b) aiSecurity `assembleTypeChatPrompt` envelope for TextScan; (c) routing-telemetry ledger insertion. `stylechat-generate` equivalent still to do.

## BR-01 — scan-identify reconciliation: dropped scanner declarations — **P1 (integration)**
- **Symptoms (deno check):** `TS2304 Cannot find name 'isAnonymousImageAnalysis' | 'anonymousFingerprint' | 'getClientFingerprintMaterial' | 'checkAnonymousImageRateLimit'`; `TS2339 Property 'hasProjectAccess' does not exist on type 'AuthContext'`.
- **Root cause:** These are **scanner-side** (`a414ad5`, 17 refs; absent in `d3293286`). During the 15-hunk 3-way resolution, a few hunks resolved to "modern" dropped scanner *declarations* while scanner *uses* were retained in keep-scanner hunks.
- **Resolution (DESIGNED):** re-resolve the affected hunks to preserve scanner's anonymous-analysis declarations + `AuthContext.hasProjectAccess` (this is the project-authenticated analysis-only path the charter requires; `verify_jwt=false` on scan-identify).
- **Status:** OPEN.

## BR-02 — scan-identify reconciliation: duplicate const declarations — **P1 (integration)**
- **Symptoms:** `TS2451 Cannot redeclare block-scoped variable 'rawStatus' | 'detectedGarments' | 'rawGarmentCount' | 'primaryGarmentFields'`.
- **Root cause:** the 3-way merge duplicated the parse/garment block (kept-scanner hunk overlaps a modern-merged region).
- **Resolution (DESIGNED):** dedupe the parse block, keeping scanner's multi-item garment handling once.
- **Status:** OPEN.

## BR-03 — scan-identify reconciliation: ScanCommerceResult type mismatch — **P1 (integration)**
- **Symptoms:** `TS2339 Property 'qualityTune'|'query'|'provider'|'products'|'providersTried' does not exist on type 'void | ScanCommerceResult'`; `TS7006 param 'p' implicitly any`.
- **Root cause:** `scanCommerceRouter.ts` **differs** between scanner (`a414ad5`) and modern (`d3293286`); the reconciled index uses call sites expecting scanner's richer result while a `void |` union (modern signature) is in play.
- **Resolution (DESIGNED):** align on scanner's `scanCommerceRouter.ts` return contract (accepted v122/v123 commerce), and narrow the `void` case at call sites.
- **Status:** OPEN.

---

## AAG-01 — Account-active / pending-deletion guard — **P0**
- **Requirement:** authenticated pending-deletion / deactivated accounts must be denied on protected functions; restored accounts allowed.
- **Integration:** staged canonical `_shared/deletion/*` (`assertAccountActive`, `assertAccountActiveIfAuthenticated`, `userDataResources`) + `restore-account` + `resend-restoration-email` + the 6-migration account-deletion lifecycle chain from `835ec97`. Wired `assertAccountActive(userId)` (throws 403 `ACCOUNT_DEACTIVATED`) into **scan-identify** at the auth point; **stylechat-generate** already carries a tested inline lifecycle gate (403 `ACCOUNT_PENDING_DELETION`) from `9afe29b` — kept as-is.
- **Verification:** `deno check` OK for scan-identify (guard), `_shared/deletion/common.ts`, `restore-account`, `resend-restoration-email`; scan-identify **55/55** tests still pass.
- **Status:** FIXED-IN-SOURCE + VERIFIED (deno).

## MIG-01 — Migration safety (Phase 8, review-level) — informational
- Required `20260723070000_profiles_backfill_and_active_account_hardening.sql`: **non-destructive** (no DROP/DELETE/TRUNCATE), `security definer` + **empty `search_path`** + fully-qualified `public.handle_new_user()` / `public.is_active_account()`.
- Destructive purge worker `process-account-deletions`: kill-switch + dry-run are **app_config-gated** (not enabled in source); **not being deployed** (charter). Permanent purge remains disabled. ✅
- Full chain replay against a disposable DB still to be run for a full PASS.

## STYLECHAT LLM-02 — stylechat frozen map — **P0** → FIXED-IN-SOURCE + VERIFIED
- Base: feature-complete `9afe29b` (E1–E4 + V2 attachments + DR2 + Elise modules). Swapped `eliseConfig.ts` model resolution to frozen map via `modelRouting.ts` (`ELISE_PRIMARY_MODEL='gemini-3.6-flash'`, `ELISE_FALLBACK_MODEL='gemini-3.5-flash-lite'`, allowlist); removed `gemini-2.5-flash` default + generic `GEMINI_MODEL`; added `fallbackModelName`; updated `eliseConfig.test.ts` to assert allowlist rejection + accepted override.
- **Verification:** `deno check` exit 0; `deno test supabase/functions/stylechat-generate/` = **79/79**; 0 generic `GEMINI_MODEL` reads.

## PRE-01 — search-vinted-secondhand deno type errors — **P4 (pre-existing, out of scope)**
- **Symptoms:** `TS2322` / `TS2677` in `search-vinted-secondhand/index.ts` `normalizeItems` (mapped object `{price: string|undefined,…}` vs `SecondhandItem[]` + type predicate).
- **Provenance:** present **in the v15 tested base** (`5b687b6`) — NOT introduced by this integration; deployed in prod (v5) via `--no-check`.
- **Scope:** function is **not** in the deploy set (Phase 19 deploys scan-identify + stylechat-generate only), so it does not gate this release. Left as-is to avoid unrelated-surface risk.
- **Status:** OPEN / DEFERRED (pre-existing). Broad `deno check`: **15/16 backend functions clean**; this is the only failure and it is out-of-scope.

## SS-01 — Saved-scan media not deleted on account deletion — **P0 PRIVACY (FIXED + VERIFIED)**
- **Defect:** `services/savedScanMedia.ts` (in the v15 base) uploads to `style-library-images/{userId}/saved-scans/{id}.jpg`, but the account-deletion registry's storage `prefixTemplates` listed only `{userId}/scans` + `{userId}/inspirations`. The purge processor deletes storage **by registered prefix only** (`prefixesForUser`→`listStoragePrefix`→`bucket.remove`), and `{userId}/scans` does not match the `{userId}/saved-scans/` folder → **saved-scan images orphaned in storage after account deletion** (table row cascades; the image file survived).
- **Trace (source-verified):** upload (`savedScanMedia.ts:47`) → bucket `style-library-images` → key `{userId}/saved-scans/{id}.jpg` → DB `saved_scans.storage_path` → registry storage templates (missing) → `processorCore.mjs` prefix-based delete → not covered.
- **Repair (narrow, no bucket-wide delete):** added `{userId}/saved-scans` to `prefixTemplates` in **both** registries — edge `_shared/deletion/userDataResources.ts` and worker `lib/account-deletion/user-data-resources.json`. Processor covers it via the existing generic per-user-prefix mechanism (reference-checked, idempotent).
- **Regression tests (processDeletionRequest.test.js):** registry sync (.ts+.json); single + multiple objects removed; **cross-user isolation** (another user's saved-scans untouched); **idempotent** re-run no-op; **no broad/bucket-wide delete** (all remove paths user-scoped, no wildcard). Restoration-period + purge-disabled covered by existing `assertCliPurgeEligible` tests.
- **Purge posture:** unchanged — storage deletion runs only in the (config-gated, disabled) purge worker; reversible-deactivation restoration unaffected.

## TEST-RECON — the 4 Node-test failures, classified & resolved
- **`scanCommerceRouter.test.js` — STALE (obsolete):** fails on pristine a414ad5 too; commerce router rewritten with the relevance layer. **Removed**; superseded by Deno `commerceRelevance.test.ts` (**15/15**). (Also fixed its loader to recurse before deciding — moot after removal.)
- **`outfitDecisionContract` / `stylistIdentity` / `styleChatAttachmentContract` — CONTRACT DRIFT:** all regexed the CLI (`process-deletion-request.js`) for the **inlined** registry, but 835ec97 externalized it to `lib/account-deletion/user-data-resources.json` (loaded via `loadRegistry.cjs`). Redirected each assertion to the JSON source of truth. Coverage **verified** first: `user_stylist_preferences`→`auth_delete_cascade` ✓, `saved-scans` prefix ✓ (SS-01), `outfit_decision_groups`(set_null)/`outfit_decision_votes`(cascade) ✓. **`outfit_decision_options`/`option_items`** proven covered by **FK ON DELETE CASCADE** (group→options→option_items) — group-owned, not user-owned; test now asserts the cascade path in the migration rather than a (wrong) registry entry. No assertions weakened.

## Client baseline + Node test suite (this session)
- **tsc:** `npx tsc --noEmit` → **exit 0, 0 errors** (client code fully type-clean after adding `qa/**` to tsconfig exclude — Deno tooling, validated by `deno check`). Backend integration did not break client types.
- **`npm ci`:** clean, 908 packages, exit 0.
- **Node `__tests__` suite:** **95 / 99 test files pass.** Fixed this session: `scanIdentifyEdgeContract` (updated to assert frozen map — regression coverage for LLM-01), `processDeletionRequest` (brought `lib/account-deletion/*` + CLI from 835ec97).

### TEST-RECON — 4 remaining Node-test failures (understood; underlying behavior verified intact, NOT functional regressions)
- **TR-01 `scanCommerceRouter.test.js`:** obsolete v15 vm-sandbox test; **fails on pristine a414ad5 too** (the commerce router was rewritten with the relevance layer). Superseded by the Deno suite `commerceRelevance.test.ts` (**15/15 pass** in-tree). Action: remove Node test (Deno covers it).
- **TR-02/03/04 `outfitDecisionContract` / `stylistIdentity` / `styleChatAttachmentContract`:** assert account-deletion coverage via **old-format regex** (`table: 'x'`) on the deletion registry, which **835ec97 restructured to JSON** (`lib/account-deletion/user-data-resources.json`). Coverage **verified intact** — `outfit_decision_groups`, `user_stylist_preferences` present in the JSON registry. Action: update these tests' assertions to read the new JSON registry format. (`saved-scans` prefix: not in 835ec97 registry — flagged for owner: confirm whether saved-scans media is intentionally covered by a different path or is a real deletion-coverage gap.)

## Integration completion state (honest)
- **Provenance/topology:** COMPLETE (see provenance-and-topology.md).
- **Backend modules staged into worktree:** scanner intelligence suite (`a414ad5`), `modelRouting.ts` + `_shared/aiSecurity/*` (`d3293286`). DONE.
- **scan-identify:** ✅ frozen-map routing + account-active guard; `deno check` clean; **55/55** tests. Additive-remaining: model-fallback retry wiring, aiSecurity TextScan envelope, routing telemetry.
- **stylechat-generate:** ✅ frozen-map routing (feature-complete `9afe29b` base); inline lifecycle gate; `deno check` clean; **79/79** tests.
- **Account-active guard + restore-account + resend + 6 migrations (`835ec97`):** ✅ staged + wired + `deno check` clean; migration non-destructive w/ empty search_path; purge stays disabled.
- **Backend additive-remaining:** scan-identify fallback retry / aiSecurity envelope / routing telemetry; full migration-chain replay on a disposable DB; `deno check` across *all* functions; Deno test suite for the whole backend.
- **Frontend workstreams** (icons, avatars, Elise E1–E4 client + V2 attachments UI, DR2–4, secure sessions): NOT STARTED (deferred by owner).
- **Dependency/config reconciliation, full local test matrix, app/eas reconciliation:** NOT STARTED.

## Pre-deploy gate status: **FAIL (integration in progress)**
Backend P0s (frozen model map for both LLM functions; account-active guard) are **FIXED-IN-SOURCE + deno-verified**. Remaining backend additives + frontend half + full test matrix keep the gate at FAIL until complete. No fabricated PASS. Work preserved on branch `integration/ios-v17-prelaunch-complete`.
