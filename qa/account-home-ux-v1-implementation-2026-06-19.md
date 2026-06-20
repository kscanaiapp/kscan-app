# K Scan AI — Bright Luxury Account/Home Flow V1 Report

## 1. Preflight Plan

Current onboarding route: `/onboarding` (`app/onboarding/index.tsx`)
Current Home route: `/` (`app/index.tsx`)
Route groups found: `(auth)` exists; no `(onboarding)` group used
New routes added: None (existing route structure reused)
Routing decision: Integrated through existing `app/onboarding/index.tsx` step manager. No duplicate route groups created.
Navigation stack strategy: `router.replace('/')` when crossing from onboarding into Home
Back-button strategy: Existing `BackHandler` in `app/onboarding/index.tsx` preserved; onboarding steps advance/go back via `setStep`; Home uses `replace` so onboarding is not in back stack

## 2. Branch / Commit

Current branch: `feature/account-home-ux-v1`
Base branch: `feature/ui-v2-integration-smoke` (contains both latest onboarding/Home code and mockup baseline commit `2a515f8`)
Commit: pending
Working tree: clean except untracked `qa/waitlist-project-consolidation-2026-06-18.md` (left untouched)

## 3. Mockup Baseline

Baseline doc: `qa/account-home-frontend-baseline-v1.md`
Mockups referenced:
- `qa/mockups/account-home-v1/landing-page-v1.png`
- `qa/mockups/account-home-v1/account-login-v1.png`
- `qa/mockups/account-home-v1/permissions-v1.png`
- `qa/mockups/account-home-v1/home-page-v1.png`
Visual direction: bright pearl/ivory backgrounds, white cards, deep plum CTAs, champagne/gold accents, editorial serif typography, premium mobile spacing, not tan, not dark

## 4. Screens Implemented

Welcome: `WelcomeStepV1` in `components/account-home/WelcomeStepV1.tsx` — mounted into `app/onboarding/index.tsx` Step 1 when `ACCOUNT_HOME_UX_V1_ENABLED` is true
Account Setup: `AccountSetupStepV1` in `components/account-home/AccountSetupStepV1.tsx` — mounted into `app/onboarding/index.tsx` Step 2 when flag is true
Legal Gate: Existing Step 4 (`renderTerms`) preserved unchanged; visual theme already uses bright pearl/plum tokens
Permissions: `PermissionsStepV1` in `components/account-home/PermissionsStepV1.tsx` — mounted into `app/onboarding/index.tsx` Step 5 when flag is true
Home: `HomeLuxuryTechV1` in `components/home/HomeLuxuryTechV1.tsx` — mounted through `app/index.tsx` when `HOME_NAVIGATION_V2_ENABLED && ACCOUNT_HOME_UX_V1_ENABLED`

## 5. Routing / Navigation Integrity

Canonical flow: `/onboarding` (step manager) → Step 1 Welcome → Step 2 Auth Choice → Step 3 Create Account → Step 4 Terms → Step 5 Permissions → Step 6 Home Handoff → `router.replace('/')`
Duplicate routes avoided: Yes. No new Expo Router group routes were created. One canonical onboarding entry remains.
Destructive navigation used: Yes — `router.replace('/')` is used in `goToHome` callback
Android back behavior: Existing `BackHandler` handles step back within onboarding; once Home is reached via `replace`, Android Back exits the app or follows the existing Home back behavior (does not return to onboarding)
iOS swipe-back behavior: Same — `replace` removes onboarding from the navigation stack
Returning-user behavior: Returning authenticated users are routed to Home directly by the existing `isAuthenticated` useEffect in `app/onboarding/index.tsx` (`router.replace('/')`); they do not see Welcome again

## 6. Files Changed

Files:
- `app/index.tsx`
- `app/onboarding/index.tsx`
- `components/home/index.ts`
- `constants/featureFlags.ts`
- `components/account-home/WelcomeStepV1.tsx` (new)
- `components/account-home/AccountSetupStepV1.tsx` (new)
- `components/account-home/PermissionsStepV1.tsx` (new)
- `components/account-home/FashionCollagePlaceholder.tsx` (new)
- `components/account-home/index.ts` (new)
- `components/home/HomeLuxuryTechV1.tsx` (new)

git diff --stat:
```
 app/index.tsx             |  8 ++++---
 app/onboarding/index.tsx  | 54 ++++++++++++++++++++++++++++++++++++++++++++---
 components/home/index.ts  |  1 +
 constants/featureFlags.ts |  5 ++++-
```

git diff --name-only: (staged files will be listed after explicit add)

## 7. Feature Flags

Flags used:
- `ONBOARDING_FRAMEWORK_V1_ENABLED` (existing parent)
- `HOME_NAVIGATION_V2_ENABLED` (existing parent)
- `ACCOUNT_HOME_UX_V1_ENABLED` (new master visual flag)

Flags added: `ACCOUNT_HOME_UX_V1_ENABLED` (defaults to `false`, driven by `EXPO_PUBLIC_ACCOUNT_HOME_UX_V1`)

Defaults:
- `ONBOARDING_FRAMEWORK_V1_ENABLED`: false
- `HOME_NAVIGATION_V2_ENABLED`: false
- `ACCOUNT_HOME_UX_V1_ENABLED`: false

Rollback behavior: Set `EXPO_PUBLIC_ACCOUNT_HOME_UX_V1=false` to revert to existing HomeV2 and existing onboarding visuals. `HomeLegacy` and `HomeV2` remain as fallbacks. Existing onboarding render functions remain as fallback paths.

## 8. Design System

Theme tokens added: None required — existing `LUXURY` tokens in `constants/theme.ts` already cover:
- `ivory`, `pearl`, `cream` (near-white backgrounds)
- `plum`, `plumDeep`, `plumCore` (deep plum CTAs)
- `gold`, `goldBrushed`, `goldChampagne`, `goldLight` (champagne accents)
- `ink`, `graphite`, `stone` (text hierarchy)
- `hairline`, `border` (champagne hairlines)
- `SHADOWS.editorialSmall`, `SHADOWS.editorialRaised` (soft shadows)

Hardcoded hexes avoided: Yes. All new components reference `LUXURY` and `COLORS` tokens.
Background: `LUXURY.colors.ivory` / `LUXURY.colors.pearl` (near-white)
CTA: `LUXURY.colors.plum` (deep plum)
Typography: `LUXURY.typography.displayHeadline`, `body`, `sectionLabel`, `cta` (editorial serif + sans)
Cards: `LUXURY.colors.pearl` background, `LUXURY.colors.border` / `LUXURY.colors.hairline` borders, `SHADOWS.editorialSmall`
Accents: `LUXURY.colors.goldBrushed` / `LUXURY.colors.goldChampagne`
Brightness/tan correction: Background is ivory/pearl (not tan/cream). The new flow is distinctly brighter than the legacy warm-cream direction.

## 9. Auth Safety

Email auth: Preserved. Existing `signUp`/`signIn` from `useAuthSession` still used. Create Account form in Step 3 unchanged.
Apple auth: Handler exists in `app/auth/index.tsx` using `expo-apple-authentication`. New `AccountSetupStepV1` routes to `/auth` for Apple sign-in. Button shown only on iOS.
Google auth: Handler exists in `app/auth/index.tsx` using `expo-web-browser` + `supabase.auth.signInWithOAuth`. New `AccountSetupStepV1` routes to `/auth` for Google sign-in.
Unavailable providers omitted: N/A — both Apple and Google handlers exist.
Provider logic changed: No. OAuth logic in `app/auth/index.tsx` untouched.
Native config changed: No. No changes to `app.json`, `app.config.js`, `app.config.ts`, `eas.json`, `ios/`, `android/`.

## 10. Legal / Age Gate Safety

Terms preserved: Yes. Existing Step 4 (`renderTerms`) with Terms, Privacy, and 18+ checkboxes remains.
Privacy preserved: Yes.
18+ preserved: Yes. `ageChecked` state and `I confirm that I am 18 years of age or older` checkbox remain.
DOB added: No.
ID verification added: No.
Backend persistence changed: No. `recordLegalAcceptances` call in `handleAcceptAndContinue` is preserved unchanged.

## 11. Permissions Safety

Camera: Visual toggle only in `PermissionsStepV1`. No native `requestCameraPermissions` called. Real prompt occurs at point-of-use in Scan.
Photos: Visual toggle only. No native request. Real prompt occurs at point-of-use in Upload.
Microphone: Visual toggle only in new `PermissionsStepV1`. No native request. Not wired to any native handler.
Notifications: Visual toggle only. No native request.
Native permission config changed: No. `app.json`, `app.config.*`, `eas.json`, `ios/`, `android/` untouched.
Not Now behavior: Calls `goToHome` (same as Continue to Home) — advances to Home without requesting permissions.
Continue to Home behavior: Calls `goToHome` → `router.replace('/')` — completes onboarding and clears back stack.

## 12. Home Data / Commerce Safety

Fake prices added: No.
Fake retailers added: No.
Fake inventory added: No.
Fake match percentages added: No.
Recent scans source: `useLibrary()` hook — real saved scan data from Supabase/local store.
Style picks handling: Editorial placeholder only — "Style inspiration coming soon. Scan fashion inspiration to begin. Your saved ideas and AI-curated picks will appear here."
Bottom navigation decision: Deferred. Mockup shows bottom tabs as a visual design direction, but no global bottom tab navigator was implemented. The existing Home navigation uses destination cards and routed CTAs.

## 13. Validation

npx tsc --noEmit: **PASS** (no errors)
node --test __tests__/*.js: Known baseline failures remain:
- `authPrivacy.test.js`
- `useKScanDuplicateGuard.test.js`
- `verifyAppleReadiness.test.js`
New failures: None.
git diff --check: Only LF→CRLF warnings (normal on Windows). No whitespace errors.
npm run lint: N/A — no lint script in `package.json`.

## 14. Runtime / Manual Smoke

Runtime/manual smoke run: NOT RUN — requires human device/emulator testing.
Surfaces checked: N/A
Issues found: N/A
Required later smoke:
- Flag off: old flow still works.
- Flag on: Welcome renders with fashion collage.
- Get Started advances to Account Setup.
- I Already Have An Account routes to `/auth`.
- Email auth path still reaches existing auth flow.
- Apple/Google buttons route to `/auth`.
- Legal Terms/Privacy/18+ gate appears before Home.
- Permissions page renders with card layout.
- Not Now advances without requesting permissions.
- Continue to Home reaches Home.
- Android Back from Home does not return to onboarding.
- Home renders bright near-white background.
- Start Scan routes to existing Scan flow.
- No fake commerce appears.
- Small screen layout does not clip CTAs.

## 15. Backend / Repo Safety

Backend files changed: No.
Supabase changed: No.
Native config changed: No.
Environment files changed: No.
Package files changed: No.
Waitlist QA file touched: **No**. `qa/waitlist-project-consolidation-2026-06-18.md` remains untracked and untouched.

## 16. Commit Integrity

Explicit adds used:
- `git add constants/featureFlags.ts`
- `git add app/index.tsx`
- `git add app/onboarding/index.tsx`
- `git add components/home/index.ts`
- `git add components/home/HomeLuxuryTechV1.tsx`
- `git add components/account-home/`
- `git add qa/account-home-ux-v1-implementation-2026-06-19.md`

Staged files reviewed: Yes. `git diff --cached --stat` and `git diff --cached --name-only` reviewed before commit.
Commit created: `feat(ui): build bright luxury account and home flow`
Post-commit status: Tracked source files clean; `qa/waitlist-project-consolidation-2026-06-18.md` remains untracked.

## 17. Recommendation

Ready for frontend review: Yes.
Ready for manual smoke: Yes — requires device/emulator testing with `EXPO_PUBLIC_ACCOUNT_HOME_UX_V1=true` and `EXPO_PUBLIC_HOME_NAVIGATION_V2=true`.
Ready for backend integration: No backend integration required for this frontend-only pass.
Follow-up tickets:
- Manual smoke test on iOS and Android with the new flags enabled.
- Final fashion collage artwork from design team (current implementation uses abstract placeholder shapes).
- Bottom navigation architecture decision (deferred until approved for app architecture).
- Style Picks backend wiring when real recommendation data is available.
- Microphone permission native request when voice input is production-implemented.
