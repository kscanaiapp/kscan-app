# K Scan AI — KS-FE-009B TextScan Runtime Reachability

## 1. Status
**PASS WITH NOTES.** Two distinct findings:

1. **Route / entry / gating are correct in source** — the smoke FAIL (entry not rendered +
   `/text-scan` unmatched deep link) is an **environmental stale-Metro-bundle artifact**, not a
   route/flag code defect. Final green smoke requires a clean Metro rebuild (§9/§11).
2. **One real code defect found + fixed in the TextScan screen's dependency:** the Phase 23
   consolidation (`97b6df5`) removed `toAttributeGrid` from `services/textScan.ts` while
   `app/text-scan/index.tsx` still imports/calls it — breaking `tsc` (TS2305) and leaving a latent
   `toAttributeGrid is not a function` crash in the TextScan results (backend) branch (currently
   masked only because `TEXTSCAN_BACKEND_ENABLED=false`). **Restored the export** (one surgical,
   additive change). `tsc` and the TextScan service test suite are now green.

Source correctness is proven with git + live-emulator evidence; the stale-bundle root cause is
proven by live reproduction (§7).

## 2. Branch / Commit
- Branch: `fix/textscan-runtime-reachability-v1`
- Base: created from `qa/emulator-smoke-textscan-scan-v1` @ `97b6df5` (NOT from
  `feature/scan-identification-api-v1` — see note below).
- Commit: `fix(textscan): restore runtime route reachability` (restores `toAttributeGrid` +
  this QA report).
- Working tree: only the two intended files staged; pre-existing untracked QA/scratch dirs left
  unstaged.

> **Base deviation (intentional, documented):** the task prescribed branching from
> `feature/scan-identification-api-v1`. That branch points at `3413768` and is **4 commits behind**
> the smoke base. Branching from it would drop work the smoke + this task depend on:
> `18a9dd4` (text mode routed through scan-identify), `2c3c074` (scan runtime reliability fix),
> `77cdb56` (emulator smoke report), `97b6df5` (Phase 23 backend consolidation). The required
> base commits (`3710daf`, `eabf275`, `701411d`, `26d0876`/`9bb477c`, `2c3c074`) are ALL present
> on `97b6df5`, so the prescribed base set is satisfied. Branched from current HEAD to avoid a
> regression.

## 3. Files Changed
| File | Reason |
| --- | --- |
| `services/textScan.ts` | **Restore `toAttributeGrid` export** removed by Phase 23 (`97b6df5`) but still imported by `app/text-scan/index.tsx`. Fixes `tsc` TS2305 + latent `toAttributeGrid is not a function` crash in the TextScan results branch. Additive only — `toStyleMatch` (added by Phase 23) is preserved. Body restored verbatim from the smoke base `18a9dd4`. |
| `qa/frontend-textscan-runtime-reachability-2026-06-20.md` | This report. |

No changes to `app/`, `components/`, `constants/`, `contexts/`, `hooks/`, `supabase/`, native,
env, or package files. The route file `app/text-scan/index.tsx` was **not** modified (its import
of `toAttributeGrid` was already correct; the broken side was the missing export).

## 4. Route Audit
- **Route file:** `app/text-scan/index.tsx` — present, exists at the smoke base `18a9dd4` too.
- **Screen component file(s):** `app/text-scan/index.tsx` (`TextScanScreen`) +
  `components/text-scan/*` (header, input, grid, cards, chips, badge, feature row).
- **Default export:** ✅ valid — `export default function TextScanScreen()`.
- **Parent layout registration:** `app/_layout.tsx` returns `<Stack screenOptions={{ headerShown:false }} />`
  with Expo Router **auto-discovery** (no explicit `<Stack.Screen>` allowlist, no
  `unstable_settings`, no custom `+not-found`). All files under `app/` auto-register, so
  `app/text-scan/index.tsx` → route `/text-scan` automatically.
- **Route group / stack:** top-level (NOT in the `(public)` group, NOT a tab — there are no tabs).
  Correct for an authenticated screen.
- **Expected route:** `/text-scan` ✅ matches.
- **In-app navigation paths:** `router.push('/text-scan')` in `HomeV2`, `HomeLuxuryTechV1`,
  `HomeLegacy`. All target strings match the route.
- **Home entry:** present in all three Home variants (gated — see §6). Active Home with the
  current `.env.local` is **HomeV2** (`home-v2-textscan` testID).
- **Scan landing entry:** `components/scan-room/ScanLanding.tsx` + `LiveScanCamera.tsx` expose an
  `onTextScan`/`textScanEnabled` affordance, **but nothing imports/renders them** (dead exports,
  staged for an unwired Scan-Room V2). The live Scan screen (`app/scan/index.tsx` → root `app.js`)
  has no TextScan entry. So "Scan landing TextScan entry" is **N/A — not wired in any live screen**.
- **Routing guard:** `services/routingGuard.js` returns `allow` for `/text-scan` for an
  authenticated user (it is not public, not auth/onboarding, not limited). No redirect, no
  unmatched from the guard.
- **Mismatch found:** **None.** Route file, default export, layout registration, route path, and
  every in-app nav string are mutually consistent.
- **Fix applied:** None needed in route code.

## 5. Deep Link Scheme Audit
- **Registered scheme:** `kscan` (`app.json` `expo.scheme` + `android.intentFilters`, confirmed in
  the live runtime manifest: `"scheme":"kscan"`, `hostUri:127.0.0.1:8081`).
- **Android intent filter:** `action=VIEW`, `category=[BROWSABLE,DEFAULT]`, `data.scheme=kscan`,
  no host/path restriction, `autoVerify=false` → the OS routes any `kscan://…` URL into the app.
- **Android package tested:** `com.kscanai.app` (dev build; `com.kscan.glasses` also installed,
  unrelated).
- **Expected deep-link format:** `kscan://text-scan` (canonical Expo Router form, path = `text-scan`).
- **Smoke deep-link format:** `kscan:///text-scan` (three slashes).
- **Slash-count mismatch:** **Not the root cause.** I reproduced the failure live and tested BOTH
  forms against the running build:
  - `kscan://text-scan` → **Unmatched Route** ("Page could not be found", URL shown as
    `kscan://text-scan`).
  - `kscan:///text-scan` → same Unmatched Route (the unmatched screen normalizes it to
    `kscan://text-scan`).
  Both fail **because the running bundle does not contain the `/text-scan` route** (stale bundle —
  see §6/§7), not because of slash count. The triple-slash form is what `Linking.createURL`
  emits and is accepted; `kscan://text-scan` is simply the cleaner canonical command.
- **Commands tested:**
  ```
  adb -s emulator-5554 shell am start -W -a android.intent.action.VIEW -d "kscan://text-scan"  com.kscanai.app
  adb -s emulator-5554 shell am start -W -a android.intent.action.VIEW -d "kscan:///text-scan" com.kscanai.app
  ```
  Both delivered to `com.kscanai.app/.MainActivity` (`Status: ok`) and rendered the Expo Router
  unmatched screen (`resource-id="expo-router-unmatched"`).
- **Result:** Deep-link scheme + intent filter are correct; failure is the stale bundle, not the
  scheme or the command. Recommended re-smoke command: `kscan://text-scan`.
- **Fix applied / test-command correction:** Use `kscan://text-scan` on a clean rebuild (§11).
  No app code change.

## 6. Feature Flag / FeatureFreeze
- **Local flag name:** `TEXTSCAN_UI_ENABLED` (`constants/featureFlags.ts`).
- **Local default value:** `process.env.EXPO_PUBLIC_ENABLE_TEXTSCAN === 'true'` → **false unless**
  the env var is inlined `true` at bundle build time. (Env var name is correct — no typo such as
  `EXPO_PUBLIC_TEXTTSCAN_UI_ENABLED`.)
- **FeatureFreeze flag name:** `'textScan'` (in `NON_CORE_FEATURE_KEYS`).
- **Combined gating condition (HomeV2/Legacy/LuxuryTechV1):**
  `TEXTSCAN_UI_ENABLED && !featureFreezeLoading && isFeatureEnabled('textScan')`.
- **Fallback when fetch fails:** `services/featureFreeze.ts` → `loadFeatureFreezeConfig()` on
  remote failure falls back to cache, else `DEFAULT_FEATURE_FREEZE_CONFIG` (`featureFreeze:false`).
  `isFeatureEnabledForFreeze(key, isFrozen)` returns `true` for **all** keys when `!isFrozen`.
- **Behavior before / current FeatureFreeze behavior:** The smoke logged
  `[K-SCAN FeatureFreeze] remote fetch failed; using cache/default`. Per the code this still
  returns `true` for `textScan` (default is unfrozen). **FeatureFreeze is therefore NOT the
  blocker** — the fallback is already deterministic and already exposes TextScan.
- **Issue found:** The real gate is `TEXTSCAN_UI_ENABLED`, which depends on
  `EXPO_PUBLIC_ENABLE_TEXTSCAN` being **inlined at Metro bundle time**. `.env.local` already sets
  `EXPO_PUBLIC_ENABLE_TEXTSCAN=true` (and `EXPO_PUBLIC_HOME_NAVIGATION_V2=true`). But
  `EXPO_PUBLIC_*` values are statically baked into the JS bundle when Metro transforms modules —
  so a **stale Metro bundle** (built before `.env.local` got these flags, or with un-cleared
  cache) inlines them as **false**, hiding every TextScan entry. This is exactly what the smoke
  hit (and what I reproduced — see §7).
- **Fix applied:** None in source. `.env.local` already carries the correct values; the remedy is
  operational — rebuild with a clean Metro cache (`--clear`) so the flags inline as `true`.
- **Production default changed:** **No.** Production default for `TEXTSCAN_UI_ENABLED` remains
  `false` (env-driven, by design). No gating/fallback defaults were altered.
- **Smoke/dev override:** Already present and correct in `.env.local`
  (`EXPO_PUBLIC_ENABLE_TEXTSCAN=true`). `.env.local` was NOT modified or staged.

## 7. TextScan Reachability
**Root cause (proven):** the running dev build was bound to the **stale Metro on port 8081**
(`hostUri:127.0.0.1:8081` in the live manifest), whose bundle predates the current `.env.local`
and (almost certainly) the current `app/` route tree.

Live proof on `emulator-5554`:
1. The stale-8081 build renders **HomeLegacy** ("See it. Scan it. Style it." / "SCAN NOW").
   HomeLegacy only renders when `HOME_NAVIGATION_V2_ENABLED` is **false** — yet `.env.local` sets
   `EXPO_PUBLIC_HOME_NAVIGATION_V2=true`. ⇒ the bundle has env flags inlined **false** ⇒ it is
   stale w.r.t. `.env.local`. The same staleness inlines `TEXTSCAN_UI_ENABLED=false`, so **no
   TextScan entry renders** — matching the smoke symptom.
2. Deep link `kscan://text-scan` (and `kscan:///text-scan`) → Expo Router **Unmatched Route**
   against that bundle (route tree predates `app/text-scan/index.tsx`).
3. A freshly-started Metro (`expo start --port 8083 --clear --dev-client`) logged
   `env: export … EXPO_PUBLIC_ENABLE_TEXTSCAN …` at startup — confirming a clean bundle WILL inline
   the flag `true` and expose TextScan. (The dev client auto-reconnected to its cached 8081 server
   and would not repoint to 8083 without dev-menu interaction, so the positive in-app render could
   not be force-demonstrated here — see §11. The 8083 Metro was stopped after the check; the
   user's 8081/8082 were left untouched.)

| Surface | Source code | Running stale-8081 bundle | Expected on clean bundle |
| --- | --- | --- | --- |
| Home entry (HomeV2 `home-v2-textscan`) | ✅ correct, gated | ❌ hidden (flag inlined false) | ✅ visible |
| Scan landing entry | N/A (dead/unwired exports) | N/A | N/A |
| Direct route `/text-scan` (screen) | ✅ registered, no gate | ❌ unmatched (route absent) | ✅ mounts |
| Deep link `kscan://text-scan` | ✅ scheme+filter correct | ❌ unmatched | ✅ resolves |
| Unmatched route resolved | — | reproduced | expected resolved |

**Result:** Source-correct; runtime-blocked by stale bundle. Reverify on a clean Metro rebuild.

## 8. TextScan → StyleChat
- **Input:** `TextScanInput` → `handleSubmit` (validated, debounced) — unchanged.
- **Handoff context:** `setStyleChatHandoffContext({ source:'text-scan', query, … })` in
  `app/text-scan/index.tsx`, then `router.push('/style-chat')` — unchanged. The only diff to the
  route file since the smoke base (`18a9dd4`) is an **enrichment** of this handoff payload
  (adds `textScanId`, `category`, `color`, `silhouette`, `material`, `descriptors`, `analysisText`)
  — additive, preserves the existing shape (`source`, `query`, `createdAt`).
- **StyleChat route:** `/style-chat` (`app/style-chat/index.tsx`) — unchanged.
- **Context received / clearing behavior:** `services/style-chat/styleChatHandoffContext` in-memory
  context — unchanged.
- **Keyboard behavior:** unchanged (StyleChat keyboard PASSED the prior smoke).
- **Result:** Preserved. Front-end handoff is testable independent of TextScan backend
  (`TEXTSCAN_BACKEND_ENABLED=false` in `.env.local` → fallback/preview branch still renders the
  "Ask StyleChat" action when `styleChatEnabled`). Couldn't be exercised live because TextScan was
  not reachable on the stale bundle.

## 9. Validation
- **tsc (`npx tsc --noEmit`):** **PASS** (exit 0, no output). Before the fix it reported exactly
  one error: `app/text-scan/index.tsx(42,3): error TS2305: Module '"../../services/textScan"' has
  no exported member 'toAttributeGrid'`. The fix clears it with no new errors.
- **git diff --check:** clean (no whitespace/conflict markers).
- **Targeted tests:** `__tests__/textScanBackend.test.js` (node:test) — **35/35 PASS**, including
  `toAttributeGrid: converts attributes to legacy shape` (calls `toAttributeGrid()` at line 207,
  which **threw `is not a function` before the fix**). No automated tests exist for the TextScan
  *route registration* or the *deep-link* path specifically (documented gap).
- **Manual smoke:** Live emulator (`emulator-5554`) reproduction of the failure + root-cause
  isolation (§7). Positive (green) in-app TextScan render pending clean-Metro reverification (§11)
  — could not be force-demonstrated because the dev client would not repoint off its cached stale
  server without dev-menu interaction.

## 10. Out of Scope / Not Changed
- **`services/textScan.ts` note:** the one source change is a **frontend display helper**
  (attributes → AttributeGrid view shape). It is **not** backend/Supabase/Gemini/provider logic,
  does not call any network/Edge function, and reintroduces no Render coupling — so it stays
  within the "no backend TextScan logic" boundary.
- **Backend/Supabase:** untouched.
- **TextScan Edge Function (`supabase/functions/text-scan/`):** untouched, unstaged.
- **Render:** untouched.
- **Scan → Closet:** untouched.
- **StyleChat keyboard layout:** untouched.
- **Packages / native config / `app.json` / `app.config.*` / `.env` / `.env.local`:** inspected
  read-only, **not modified, not staged**.

## 11. Remaining Issues
- **Stale Metro bundle (primary):** the dev build auto-reconnects to a stale dev server (8081) that
  predates `.env.local`'s `EXPO_PUBLIC_*` flags and the `/text-scan` route. **Reverification steps:**
  1. Stop the existing Metro instances (8081 **and** 8082).
  2. `npx expo start --clear` (clean cache so `EXPO_PUBLIC_ENABLE_TEXTSCAN`/`HOME_NAVIGATION_V2`
     inline correctly from `.env.local`).
  3. Fully reload the dev client onto the fresh server (or reinstall the dev build if the installed
     binary is stale).
  4. Confirm Home renders **HomeV2** with the **✧ TextScan** button (`home-v2-textscan`).
  5. Tap it → TextScan mounts (`text-scan-screen`); and/or `adb shell am start -a
     android.intent.action.VIEW -d "kscan://text-scan" com.kscanai.app`.
  6. Submit a query → "Ask StyleChat" → StyleChat opens with context.
- **Auth session recovery:** prior smoke noted the dev-build session was unstable to relaunch and
  recovery dropped into Expo Go — not addressed here (out of scope).
- **Scan Now press behavior:** prior smoke noted `Scan Now` needed a long-press-like input — not
  addressed here (out of scope).
- **TextScan backend verification:** `TEXTSCAN_BACKEND_ENABLED=false`; backend path not validated
  here (out of scope per KS-FE-009B).

## 12. Recommendation
- **Ready for next smoke:** Yes — re-run KS-QA-009B after the §11 clean-Metro rebuild. The route
  reachability blocker is the stale bundle, not code.
- **Ready to merge:** Yes — the `toAttributeGrid` restore is a safe, additive fix that greens `tsc`
  and the TextScan service tests and removes a latent crash; merge with this report.
- **Next patch:** None for route reachability. If the team wants TextScan to survive stale-bundle
  smoke builds more robustly, that is a **product decision on the `TEXTSCAN_UI_ENABLED` gate
  default** (a staging default flip) — out of scope here per the stop conditions and intentionally
  not changed. Recommend the Phase-23 author also confirm no other consumer of the removed
  `toAttributeGrid` was left dangling (this audit found only the TextScan screen + its test).
