# iOS v17 Pre-Launch — Provenance & Topology Audit

**Status:** IN PROGRESS (Phase 1 complete; integration pending)
**Scope decision:** Stop at pre-deploy gate (no production deploy / no live probes performed by the agent).
**Date:** 2026-07-23
**Canonical workspace:** `C:\Users\jsmit\KScan` — repo `kscanaiapp/kscan-app` — **DIRTY (329 changed files)**, on `ios/full-submission-readiness-v2` @ `0c9086af`. Not modified.
**Integration worktree:** `C:\src\KScan-ios-v17-prelaunch-integration-20260723`
**Integration branch:** `integration/ios-v17-prelaunch-complete`

---

## 1. Environment (Phase 0, verified)

| Item | Value |
|---|---|
| Node | v24.14.0 |
| npm | 11.9.0 |
| Deno | 2.8.2 |
| Expo CLI | 54.0.25 |
| Supabase CLI | 2.109.1 |
| OS | Windows 11 (win32) |
| Prod Supabase | `wyyuqfdxucjksghsmhry` "KScan App Production" — ACTIVE_HEALTHY, pg 17.6 (read access verified) |
| Deployed `scan-identify` | version 136, `verify_jwt=false` (reviewer/analysis contract — consistent with charter) |
| Deployed `stylechat-generate` | version 77, `verify_jwt=true` |

---

## 2. Base selection

**Selected base: `integration/ios-v15-second-pass-test-ready` @ `5b687b68980b26ecfceb9f7868a237fa3ee6cb8f` (v15).**

### Why v15 and not v16
- **Owner directive (authoritative):** v16 (`integration/ios-v16-final-qa` @ `3bf8005`) *"was built by accident while trying to fix the image-upload issues; v15 is the version that had been tested."*
- The charter corroborates: lists `5b687b6` under "Known accepted base references" and explicitly says of v16: *"Treat this as a source donor and topology reference, not automatically as the complete next-build baseline."*
- v15's tip is the merge of the image-upload regression fix (**PR #38**, `fix/ios-v15-image-upload-regression`), so **workstream 19/"image-upload repair" is already in-base**. Ancestry confirms `b1ac92c` and `79f1106` are ancestral to v15.

### Base rejected
- **v16 `3bf8005`** — accidental/untested build (owner). Retained as a **donor** for avatar/icon/home surfaces (it contains them by content).
- **`0c9086af`** (current dirty submission branch) — stale line: only 8 commits past fork point `5dfd7fc`, **186 commits behind** v16; not a descendant of v15/v16. Rejected as base.

---

## 3. Resolved donor SHAs

| Workstream | Branch | Full SHA | In v15? | Method |
|---|---|---|---|---|
| v15 tested base | integration/ios-v15-second-pass-test-ready | `5b687b68980b26ecfceb9f7868a237fa3ee6cb8f` | (base) | base |
| Image-upload repair | fix/ios-v15-image-upload-regression | `b1ac92cafc1bcbfe2d1baef9d98a1010d731db8b` / `79f1106addb14537daa8db6119d726997e77085d` | **YES (ancestral)** | already in base |
| Avatar/icon/home donor (v16) | integration/ios-v16-final-qa | `3bf8005e4f9f8d0ff263e55bd13f76d487b82433` | no | donor (content) |
| Product icon system | feature/kscan-product-icon-system-v1 | `e38847fc165fc99a84c2fd4264e0f92cacacc64f` | no | integrate |
| Avatar integration | (commit) | `62b582c1d93f2d7c38a5d75adcee36225119d60e` | no | integrate |
| Elise welcome stabilization | (commit) | `4f68aabbec491424d9ce6b0dbcb53cae283c7436` (governing; parallel `f73d414`) | no | integrate |
| Elise E1–E3 | (commit) | `8852665da2ed054da39c19251b019eed244972d1` | no | integrate |
| Elise E4 | feature/elise-e4-closet-aware-styling | `8023820c1be995...` / `787f311...` (refs) | no | integrate |
| Elise visual attachments (E1–E4 + composer) | feature/elise-visual-attachment-composer | `9afe29b145000782afa765c182d8463cd78b1978` | no | integrate |
| Selected-candidate privacyProof | (commit) | `a98985c5901a07dad65ae6eb6b1fc3aa7e6eb41d` | no | integrate |
| LLM modernization | feature/ai-model-input-security | `d3293286eb894fe737cc404091b9fbc6551afe4f` (branch tip now `e5452861...` — see §6) | no | integrate |
| Audited LLM baseline | (commit) | `ffd25753a08e1e7077f3672446106c776b8c1fb2` | no | reference |
| **Account deletion (FINAL head)** | repair/account-deletion-hostile-audit-20260722 | **`835ec978ce30b9e22b1badac85abdb32875341c0`** | no | integrate |
| Account deletion (non-final ref) | feature/automatic-account-deletion | `13e9b6ae0ce5d13d028ab5d53a6b8ed50775e588` | no | superseded by 835ec97 |
| Scanner backend v120 | feature/scanner-backend-quality-tune-v120 | `18eaed8...` | no | integrate (chain) |
| Scanner backend v121 | feature/scanner-backend-intelligence-layer-v121 | `fac878f...` | no | integrate (chain) |
| Scanner backend v122 | feature/scanner-backend-commerce-relevance-v122 | `213031d...` | no | integrate (chain) |
| Scanner backend v123 | feature/scanner-backend-textscan-outcome-v123 | `a414ad5...` | no | integrate (chain tip) |
| Scanner cross-platform multi-item | integration/scanner-cross-platform-multi-item-final | `2824bbb...` | no | integrate |
| Dressing Rooms DR2 | integration/dr2-elise-dressingrooms | `f974262...` | no | integrate |
| Dressing Rooms DR3 | feature/dr3-collaborative-interactive-layer | `844f958...` | no | integrate |
| Dressing Rooms DR4 | feature/dr4-dressingrooms-production-hardening | `03a336b...` | no | integrate |

### Account-deletion final head — resolution
- Branch tip `13e9b6a` (`feature/automatic-account-deletion`) is, per the charter's own text, the **"earlier non-final reference."**
- `13e9b6a` is an **ancestor** of `repair/account-deletion-hostile-audit-20260722` @ **`835ec97`** (24 commits ahead; message *"round-4 PR#5 merged + production website P2-8 verification passed"*).
- Corroborated by a dedicated on-disk worktree `C:\src\KScan-account-deletion-repair-20260722` @ `835ec97`.
- **Adopted final head: `835ec97`.** ⚠️ Owner offered the exact SHA — pending explicit confirmation, but strongly justified.

---

## 4. Topology note — squash-merge lineage

Ancestry checks alone are **misleading** here. The current submission branch `0c9086af` shows *none* of the cited donor commits as ancestors — the signature of squash-merge / rewritten history where **changes are present by content while original commits are not ancestors**. All "in v15?" determinations in §3 and §5 were therefore made by **content inspection** (`git cat-file`/path presence), not ancestry alone — consistent with the charter's warning not to infer completeness from ancestry/version numbers.

---

## 5. v15 base — content gap (what must be integrated)

**Present in v15 (verified by content):** `components/home/HomeLuxuryTechV1.tsx` (and `app/index.tsx` routes to it), Elise visual *context* store/builder (`buildEliseVisualContext.ts`, `eliseVisualContextStore.ts`), scan-identify + stylechat-generate base functions, `handle-user-deletion/index.ts`, `constants/featureFlags.ts`.

**Missing from v15 (must integrate):**
| Missing path / capability | Source workstream |
|---|---|
| `components/icons/kscan/*` | Product icons (`e38847f` / v16 donor) |
| `assets/avatars/*` (four portraits) | Avatar integration (`62b582c` / v16 donor) |
| `services/secureSessionStorage.ts` | Secure sessions / token refresh |
| `services/style-chat/eliseDirectImageAttachment.ts` + V2 composer | Elise visual attachments (`9afe29b`) |
| `supabase/functions/scan-identify/modelRouting.ts` | LLM modernization |
| `supabase/functions/stylechat-generate/modelRouting.ts` | LLM modernization |
| `supabase/functions/_shared/aiSecurity/*` | Shared AI input security (`d329328`) |
| `supabase/functions/_shared/deletion/common.ts` | Account-active guard (`835ec97`) |
| `supabase/functions/restore-account/*` | Account restoration (`835ec97`) |
| `supabase/migrations/20260723070000_profiles_backfill_and_active_account_hardening.sql` | Legacy profile backfill (`835ec97`) |
| `deno.json` / `deno.lock` | Deno config |

### 🔴 P0 finding in the base itself (pre-integration)
v15's backend routing **violates the frozen model map** and must be corrected by the LLM-modernization integration:
- `supabase/functions/scan-identify/index.ts:87` → `DEFAULT_MODEL = 'gemini-1.5-flash'`
- `supabase/functions/scan-identify/index.ts:1716` → precedence `SCAN_GEMINI_MODEL || GEMINI_MODEL || DEFAULT_MODEL`
- `supabase/functions/stylechat-generate/index.ts:72` → `DEFAULT_MODEL = 'gemini-2.5-flash'`
- `supabase/functions/stylechat-generate/index.ts:833` → precedence `STYLECHAT_GEMINI_MODEL || GEMINI_MODEL || ...`

Hits charter FAIL conditions **#12** (routing resolvable to Gemini 1.5/2.5) and **#13** (generic `GEMINI_MODEL` controls Scanner/TextScan). Tracked as defect **`LLM-01`**.

---

## 6. LLM modernization ref authority — RESOLVED

- Branch `feature/ai-model-input-security` tip = `e5452861`, which is **3 commits above** the charter-cited `d3293286`.
- Diff `d3293286 → e5452861` is a **teardown** (net −4618 lines): it *deletes* `scan-identify/modelRouting.ts`, `stylechat-generate/modelRouting.ts`, `scan-identify/multiItemGarments.ts`, and the stylechat quota / llm-routing-events migrations. → `e5452861` is a **superseded regression; DO NOT MERGE the branch tip.**
- The failed fetch (`e545286 → d329328`) was the remote being force-moved **back** to `d329328` (= `d3293286`), i.e. undoing the teardown.
- **Authoritative LLM-modernization source = `d3293286`.** Verified frozen map: `SCANNER_PRIMARY_MODEL='gemini-3.6-flash'`, `SCANNER_FALLBACK_MODEL='gemini-3.5-flash-lite'`, `TEXTSCAN_PRIMARY_MODEL='gemini-3.5-flash-lite'`, `ELISE_PRIMARY_MODEL='gemini-3.6-flash'`, `ELISE_FALLBACK_MODEL='gemini-3.5-flash-lite'`; explicit workload vars `SCAN_GEMINI_MODEL` / `SCAN_GEMINI_FALLBACK_MODEL` / `TEXTSCAN_GEMINI_MODEL` / `STYLECHAT_GEMINI_MODEL` / `STYLECHAT_GEMINI_FALLBACK_MODEL`; `ALLOWED_MODELS` allowlist; generic `GEMINI_MODEL` removed from `scan-identify/index.ts`. Full `_shared/aiSecurity/*` module suite present.

### Deployed production reality (read-only, informational for the production decision)
Deployed `scan-identify` **v136** still contains `gemini-1.5-flash` + generic `GEMINI_MODEL` precedence and **no** `SCAN_GEMINI_FALLBACK_MODEL` → **production code is NOT frozen-map-compliant**; it *does* already carry the account-active guard (`is_active`, `pending_deletion`, `allowlist`). Effective served model depends on prod env vars (not read). The v17 candidate carries the modernized frozen-map source (`d3293286`) for the owner to deploy.

---

## 7. Integration order (planned)
1. LLM modernization + frozen model map + `modelRouting.ts` (fixes LLM-01) — **P0**
2. Shared AI input security (`_shared/aiSecurity`)
3. Scanner backend chain v120→v123 (`a414ad5`) + cross-platform multi-item (`2824bbb`)
4. Selected-candidate privacyProof (`a98985c`)
5. Secure sessions / token refresh
6. Elise E1–E4 + welcome stabilization
7. Elise visual attachments V2 (`9afe29b`)
8. Attachment provenance / ownership repairs
9. Dressing Rooms DR2–DR4
10. Account lifecycle: deletion guard + restore-account + backfill migration (`835ec97`)
11. Avatar portraits + voice mapping; product icons; confirm HomeLuxuryTechV1 active
12. app.json / eas.json / package(-lock).json / deno.json reconciliation
13. Tests + audit evidence

### Conflict surface (previewed via `git merge-tree`, informational)
- Account deletion (`835ec97`): ~24 conflicted files incl. `contexts/AuthSessionContext.tsx`, `hooks/useKScan.js`, `scan-identify/index.ts`, `stylechat-generate/index.ts`.
- AI security (`d329328`): ~15 conflicted files incl. `scan-identify/index.ts`, `AuthSessionContext.tsx`, `useKScan.js`, `useStyleChat.ts`.
- Elise visual attachments (`9afe29b`): ~6 conflicts (privacy image sanitizer/upload, scanIdentification).
- Scanner v121 (`fac878f`): ~11 conflicts incl. `scan-identify/index.ts`, `app.json`, `package.json`.

Overlaps concentrate on `scan-identify/index.ts`, `stylechat-generate/index.ts`, `AuthSessionContext.tsx`, `hooks/useKScan.js`, `services/scanIdentification.ts` — integrations touching these must be sequenced and resolved path-by-path, not blanket-merged.

---

## 8. Open provenance items
- **P-1 (OPEN):** Scanner "121–129" per-ID enumeration not cleanly mapped to the v120–v123 branch chain; resolved to branch lineage only (`a414ad5` tip + `2824bbb` cross-platform). Needs confirmation against deployment history for a full PASS.
- **P-2 (RESOLVED):** Account-deletion final head = `835ec97` (ancestry over non-final `13e9b6a` + dedicated worktree). Owner offered exact SHA; pending only a courtesy confirmation.
- **P-3 (RESOLVED):** LLM-modernization authoritative source = `d3293286`; branch tip `e5452861` is a superseded teardown (§6).
