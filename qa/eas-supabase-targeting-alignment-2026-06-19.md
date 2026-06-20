# K Scan AI — KS-REL-008B Supabase Targeting + EAS Env Alignment

## 1. Status

**PASS WITH NOTES**

The protected Privacy project ref has been removed from all active mobile build
config (`eas.json`) and from the local developer `.env`. Local Metro resolution,
the Expo resolved config, and all EAS build profiles now target App Staging.
Two items remain as documented notes (not blockers):

1. Live on-device runtime endpoint observation was not performed — this
   environment has no attached device/emulator. Targeting was instead verified
   deterministically at the env-resolution level and via the Expo resolved
   config (see §7).
2. The `production` profile is intentionally **staging-backed for internal
   testing only**. Public-production Supabase targeting is on **HOLD** until a
   true app-production Supabase project ref is provided (see §5).

---

## 2. Branch / Commit

- **Branch:** `fix/eas-supabase-targeting-v1`
- **Base:** `feature/ui-v2-integration-smoke` @ `1854e8c`
- **Commit:** (this fix) — see commit step; base HEAD `1854e8c`
- **Working tree:** clean except the two intended tracked edits (`eas.json`,
  `.gitignore`) plus pre-existing known untracked QA/workspace files. No app
  source files modified.

---

## 3. Problem Confirmed

**Protected Privacy ref (`yzqjvdfgefveprobvvyw`) found BEFORE fix:**

| File | Line | Notes |
|------|------|-------|
| `eas.json` | 15 | `preview` profile — `EXPO_PUBLIC_SUPABASE_URL` (Privacy) |
| `eas.json` | 16 | `preview` profile — `EXPO_PUBLIC_SUPABASE_ANON_KEY` (Privacy anon key) |
| `eas.json` | 36 | `production` profile — `EXPO_PUBLIC_SUPABASE_URL` (Privacy) |
| `eas.json` | 37 | `production` profile — `EXPO_PUBLIC_SUPABASE_ANON_KEY` (Privacy anon key) |
| `.env` (untracked, local) | 13–14 | local dev `EXPO_PUBLIC_SUPABASE_URL` + anon key (Privacy) |

**Staging ref (`wyyuqfdxucjksghsmhry`) found BEFORE fix:**

| File | Line | Notes |
|------|------|-------|
| `.env.local` (untracked, local) | 8–9 | correct App Staging URL + anon key |
| `supabase/.temp/linked-project.json` | 1 | local Supabase CLI link state (gitignored) |

**Tracked env files:** only `.env.example` (placeholders only). `.env` and
`.env.local` are untracked and gitignored. No tracked env file contained real
values, so no secret-hygiene stop condition was triggered.

**Files affected by the fix:** `eas.json`, `.gitignore` (tracked); local `.env`
(untracked, aligned for local runtime, not committed).

---

## 4. Changes Made

- **`eas.json`:**
  - `preview` profile: `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY`
    swapped from Privacy → **App Staging**.
  - `production` profile: same Privacy → **App Staging** swap.
  - `development` profile: **added** a staging `env` block
    (`EXPO_PUBLIC_API_URL`, `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`).
    Previously it had no env block at all, so an EAS development build would have
    resolved an empty Supabase URL/key (client crash). It now resolves staging.
  - All non-env build settings preserved verbatim: `distribution`,
    `android.buildType`, `applicationArchivePath`, `ios.buildConfiguration`,
    `developmentClient`, `cli`, `submit`.
  - Staging anon key was copied programmatically from the local `.env.local`
    (App Staging) — never typed, printed, or echoed. Its JWT `ref` claim was
    verified to equal `wyyuqfdxucjksghsmhry` before use.
- **`.gitignore`:** the broad `.env.*` pattern was left in place but two explicit
  un-ignore negations were added so template files stay tracked:
  `!.env.example` and `!.env.local.example`. `.env`, `.env.local`,
  `.env.*.local`, `.env.production`, `.env.preview` all remain ignored.
- **`.env.example` / `.env.local.example`:** no change. `.env.example` already
  contains placeholders only (`https://YOUR_PROJECT.supabase.co`, `your_anon_key`,
  all commented). No `.env.local.example` was created (redundant).
- **`app.config.*` / `app.json`:** no change. No `app.config.*` exists; `app.json`
  exposes no Supabase values (`extra.eas.projectId` is the EAS UUID, not a
  Supabase ref).
- **`babel/metro config`:** no change. No root `babel.config.js`;
  `metro.config.js` is the default Expo config. No
  `transform-inline-environment-variables` plugin in use — Expo handles
  `EXPO_PUBLIC_` inlining.
- **Local `.env` / `.env.local`:** local `.env` mobile vars
  (`EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`) aligned from
  Privacy → App Staging. `.env.local` already correct, left as-is. Neither is
  tracked or committed.
- **App source files:** none changed.

---

## 5. Final Targeting State

| Surface | Target | Anon key `ref` claim |
|---------|--------|----------------------|
| Local Metro (resolved from `.env` + `.env.local`) | App Staging | `wyyuqfdxucjksghsmhry` |
| Expo resolved config (`expo config --json`) | No Supabase ref exposed (by design) | n/a |
| EAS `development` | App Staging | `wyyuqfdxucjksghsmhry` |
| EAS `preview` | App Staging | `wyyuqfdxucjksghsmhry` |
| EAS internal testing (= `preview` / `production` AAB) | App Staging | `wyyuqfdxucjksghsmhry` |
| EAS `production` | App Staging (internal-testing-backed) | `wyyuqfdxucjksghsmhry` |

- **Protected Privacy ref remains in active mobile config:** NO (0 occurrences in
  `eas.json` and active source).
- **Staging ref appears only in approved config:** YES — `eas.json` (3 profiles),
  local `.env`/`.env.local` (untracked), `supabase/.temp/linked-project.json`
  (gitignored CLI state).
- **Public production release state:** **HOLD.** The `production` profile
  (`distribution: store`, `app-bundle`) is currently staging-backed so the
  internal-testing AAB is safe. Before a public GA release, `production` must be
  pointed at a dedicated app-production Supabase project — which has not been
  provided. Do not point `production` at the protected Privacy project under any
  circumstance.

---

## 6. EAS Dashboard / Env Verification

- **EAS CLI available:** YES — `eas-cli/18.13.0`.
- **Logged in:** YES — `justin.landes@gmail.com` (accounts: `ams2dad`, `k-scan`).
- **EAS dashboard checked:** YES — `eas env:list` run for all three environments.
- **development env:** No variables found.
- **preview env:** No variables found.
- **production env:** No variables found.
- **Conclusion:** the EAS project has **zero** dashboard environment variables.
  The direct `env` blocks in `eas.json` are therefore the sole, authoritative
  source of Supabase targeting for EAS builds. There are no hidden dashboard
  values that could re-introduce the Privacy ref. (This is verification, not a
  deferral.)
- **Manual work required:** none for dashboard env source. (See §11 for the
  app-production project decision, which is a separate ownership item.)

---

## 7. Runtime Verification

- **Metro command intended:** `npx expo start --clear`.
- **Device/runtime:** none attached in this automated environment — no
  device/emulator available to observe live Supabase network traffic.
- **Env-resolution verification (substitute):** a deterministic Node check
  replicated Expo's env precedence (`.env.local` over `.env`) and resolved:
  - `EXPO_PUBLIC_SUPABASE_URL` → `https://wyyuqfdxucjksghsmhry.supabase.co`
  - anon key `ref` claim → `wyyuqfdxucjksghsmhry`
  - `EXPO_PUBLIC_API_URL` → `https://kscan-app-1.onrender.com`
  - Targets protected Privacy project: **false**
  - Targets App Staging project: **true**
- **Expo resolved config:** `expo config --json` contained **0** occurrences of
  the Privacy ref, the Staging ref, or any `supabase.co` URL — confirming the
  resolved config does not expose the protected Privacy ref. (Supabase config is
  delivered purely via `EXPO_PUBLIC_*` bundle inlining, not via `extra`.)
- **Endpoint observed:** App Staging (`wyyuqfdxucjksghsmhry.supabase.co`) at the
  config/env-resolution level.
- **Privacy project endpoint observed:** none.
- **Auth/session check:** not performed (no device, no real account created per
  rules).
- **Result:** PASS at config/env-resolution level. **Live on-device endpoint +
  auth/session observation deferred to manual verification before AAB upload.**

---

## 8. Secret Handling

- **.env committed:** NO (untracked, gitignored).
- **.env.local committed:** NO (untracked, gitignored).
- **Anon key printed:** NO — never printed in terminal summaries or this report;
  all key handling was programmatic (file → file). Diffs were shown with the key
  redacted.
- **Service-role key found:** NO service-role/private key in client/frontend
  code. `services/supabaseClient.ts` and `services/supabasePrivacy.js` use only
  `EXPO_PUBLIC_SUPABASE_ANON_KEY` (public client identifier) and the
  authenticated session token.
- **Real keys in example files:** NO — `.env.example` uses placeholders only.
- **Temp config files committed:** NO — `qa/expo-config-redacted-2026-06-19.tmp.json`
  and the local resolution test script were created, inspected, and deleted.

---

## 9. Validation

- **git status:** only `eas.json` and `.gitignore` modified (tracked); known
  untracked QA/workspace files untouched.
- **git diff --check:** clean (no whitespace/conflict errors).
- **eas.json JSON parse:** valid JSON (`ConvertFrom-Json` OK).
- **EAS CLI/schema check:** CLI available and authenticated; `eas whoami` and
  `eas env:list` resolve the project successfully. `eas build:configure` was NOT
  run (would mutate config / prompt). No build started.
- **Expo config check:** `expo config --json` succeeds; 0 Privacy refs.
- **Protected ref search (post-fix):** 0 occurrences in active mobile
  source/config.
- **Staging ref search (post-fix):** present only in approved `eas.json` +
  untracked local env + gitignored CLI temp state.
- **TypeScript:** not run — change is limited to `eas.json` + `.gitignore`; no
  TypeScript/JS source files were modified. `services/supabaseClient.ts` was
  inspected and confirms env-driven resolution with no hardcoded fallback.
- **Tests:** not run (config-only change; no source touched).
- **AAB build:** NOT run (out of scope / prohibited by task rules).

---

## 10. Remaining Work

- **EAS dashboard/env variables:** none required — project uses direct `eas.json`
  env blocks (verified zero dashboard vars).
- **App production Supabase project:** a true app-production Supabase project ref
  must be provided before public GA. Until then `production` stays staging-backed
  for internal testing only; never point it at the protected Privacy project.
- **Live device runtime check:** before the internal-testing AAB upload, run the
  app on a device/emulator and confirm Supabase requests hit
  `wyyuqfdxucjksghsmhry.supabase.co` (and never `yzqjvdfgefveprobvvyw`).
- **Render API:** `EXPO_PUBLIC_API_URL` preserved as
  `https://kscan-app-1.onrender.com` across all profiles; no change requested.
- **Google OAuth / website / Privacy project:** untouched (out of scope).
- **Historical note (non-blocking):** `qa/internal-testing-readiness-audit-2026-06-14.md`
  still contains a Privacy URL as documentation of the prior state. It is a QA
  doc, not active config; left as historical record.

---

## 11. Recommendation

Proceed. The mobile app can no longer accidentally target the protected Privacy
project: the Privacy ref is gone from all active EAS build profiles, the local
developer env, the Expo resolved config, and local Metro resolution — all now
resolve App Staging. Merge `fix/eas-supabase-targeting-v1` once reviewed.

Before any public production (non-internal-testing) release, obtain and wire a
dedicated app-production Supabase project for the `production` profile; this is
the only remaining HOLD. Before the internal-testing AAB upload, do the one-time
live on-device endpoint confirmation noted in §7/§10.
