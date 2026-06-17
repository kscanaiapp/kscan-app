# K Scan AI — Home Navigation V2 Report

## 1. Branch / Commits

Current branch: `feature/home-navigation-v2`
Base branch: `feature/dressing-rooms-hierarchy-v1`
Commits created: `462cf48 feat(ui): build home navigation v2`
Working tree: clean

## 2. Preflight Audit

Home route/file: `app/index.tsx`
Navigation architecture: Expo Router file-based routes (`app/` directory)
Global bottom tabs present: no
Shared navigation component present: no
Route names:
- Home: `/`
- Scan: `/scan`
- StyleChat: `/style-chat`
- Dressing Rooms: `/dressing-rooms`
- Library: `/library`
- Profile/Privacy: `/privacy` (no dedicated `/profile` route)
Feature flags: `constants/featureFlags.ts`
- Existing: `TEXTSCAN_UI_ENABLED`, `SCAN_RESULTS_V2_UI_ENABLED`, `SCAN_ROOM_V2_UI_ENABLED`, `ONBOARDING_FRAMEWORK_V1_ENABLED`
- New: `HOME_NAVIGATION_V2_ENABLED`
Home mockup references:
- `qa/mockups/home-v2/` exists but is **empty**
- Other mockups used: `scan-room-v2`, `library-v2`, `onboarding-v1` (for luxury direction reference)
Current loading state: no page-level spinner on Home; data loads via `useFocusEffect` in hooks
Current entry points: Scan, TextScan, Library, Dressing Rooms, StyleChat, Privacy
Back behavior: Expo Router default stack behavior; Home is root of authenticated stack
Safe-area behavior: `LuxuryScreen` handles safe-area insets
Accessibility issues found: none critical; labels preserved and expanded in V2

## 3. QA Mockup References

Home mockup folder found: yes (`qa/mockups/home-v2/`)
Mockup files found: none (directory is empty)
Mockup files missing: all home-v2 mockups
Visual references used: existing approved app luxury direction (ivory, plum, gold, pearl)
Mockup features intentionally deferred: none (no mockups to defer)

## 4. Files Changed

- `app/index.tsx` (rewritten as thin flag wrapper)
- `constants/featureFlags.ts` (`+HOME_NAVIGATION_V2_ENABLED`, preserved `ONBOARDING_FRAMEWORK_V1_ENABLED`)
- `components/home/HomeLegacy.tsx` (extracted old Home, exact copy)
- `components/home/HomeV2.tsx` (new Home V2)
- `components/home/index.ts` (barrel export)

## 5. Home V2 Coverage

Hero / Welcome: yes — personalized greeting with profile name from auth metadata
Primary Scan action: yes — "Start a Scan" primary CTA to `/scan`
Upload Inspiration entry: no — routes through `/scan`, direct sub-mode launch deferred
TextScan entry: yes — secondary CTA when `TEXTSCAN_UI_ENABLED` && feature flag
Continue / Recent section: yes — recent scans from `useLibrary`, up to 3 items
Core destination cards: yes — Scan, StyleChat, Dressing Rooms, Library, Privacy & Trust
Trust / Privacy footer: yes — "Private by design. K Scan is not designed for facial recognition or identifying people."
Empty states: yes — Continue section omitted if no scans; `EmptyStateCard` available
Disabled states: yes — reduced opacity + "Coming Soon" `StatusPill` on disabled cards
Loading / skeleton states: yes — `ActivityIndicator` placeholder in Continue section during scan load

## 6. Navigation Coverage

Home → Scan: `/scan`
Home → Upload: through `/scan` landing; direct mode params deferred
Home → TextScan: `/text-scan`
Home → StyleChat: `/style-chat`
Home → Dressing Rooms: `/dressing-rooms`
Home → Library: `/library`
Home → Profile: no dedicated profile route; Privacy & Trust card routes to `/privacy`
Home → Privacy: `/privacy`
Bottom navigation implemented/preserved/deferred: **deferred** — no existing bottom tabs; not safe to add without broader refactor
Duplicate stack risk: no duplicate routes created
Back behavior expected: Home → Destination → Back returns to Home (Expo Router stack default)

## 7. Feature Flags

Existing flags used: `TEXTSCAN_UI_ENABLED`, feature freeze via `useFeatureFreeze`
New flags added: `HOME_NAVIGATION_V2_ENABLED` (default `false`)
Feature-freeze behavior: cards respect `isFeatureEnabled` for `scan`, `styleChat`, `dressingRooms`, `closet`, `privacy`
Disabled destination behavior: card rendered with reduced opacity, "Coming Soon" pill, non-tappable

## 8. Data Handling

Real data used: `useLibrary()` for recent scans
Local placeholders used: `ActivityIndicator` placeholder during scan load
Fake data avoided: no fake counts, messages, rooms, prices, inventory
Summary metrics deferred: multi-source aggregation (dressing rooms, stylechat sessions) deferred
Backend changes: none

## 9. Continuity Fixes Applied

Issue: `app/index.tsx` was a single large Home component
Why it blocked continuity: needed clean legacy/v2 split behind flag
Files changed: `app/index.tsx`
Fix applied: extracted to `components/home/HomeLegacy.tsx`; `app/index.tsx` now a thin conditional wrapper
Backend/native/schema impact: none
Continuity fixes count: 1
Continuity fixes within limit: yes (1 file)

## 10. Accessibility / Layout

Safe-area handling: `LuxuryScreen` with `safeArea={true}`
Tap targets: all cards min 44dp; buttons use `LuxuryButton` min 44dp
Accessibility labels: all destination cards have labels and hints; recent scan cards labeled; primary actions labeled
Text contrast: uses existing `LUXURY` typography tokens on ivory/pearl surfaces
Keyboard impact: no text inputs on Home
Overlapping controls: none

## 11. Privacy / Safety Checks

No backend changes: yes
No Supabase changes: yes
No native changes: yes
No package changes: yes
No fake commerce: yes
No fake prices: yes
No fake inventory: yes
No fake messages: yes
No fake room activity: yes
No checkout: yes
No runtime smoke: yes (deferred)

## 12. Validation

`npx tsc --noEmit`: passed (via `node node_modules/typescript/bin/tsc --noEmit`)
`node --test __tests__/*.js`: 174 pass, 3 fail (known baseline failures)
`git diff --check`: passed (LF→CRLF warning only, normal on Windows)
Known baseline failures:
- `authPrivacy.test.js` — `mapAuthError` unknown error pass-through
- `useKScanDuplicateGuard.test.js` — duplicate invocation guard
- `verifyAppleReadiness.test.js` — iOS readiness on Android-focused branch
New failures: none

## 13. Deferred Work

Runtime smoke: deferred by instruction
Global bottom tabs: deferred — no existing bottom tabs; safe implementation not provable statically
Backend Home summaries: deferred — no new backend queries
Native blurring: deferred
Messaging expansion: deferred
Commerce: deferred
Push notifications: deferred
Multi-source recent aggregation: deferred — only recent scans shown; dressing rooms and stylechat sessions aggregation deferred
Upload/TextScan direct mode params: deferred — requires broader Scan refactor
Dedicated Profile route: deferred — only `/privacy` exists

## 14. Recommendation

Ready for review: yes
Needs follow-up: runtime smoke test on device/emulator; enable `EXPO_PUBLIC_HOME_NAVIGATION_V2=true` in env to activate

---

## Auth / Backend Placeholder Audit

Google OAuth: preserved (existing auth flow in `AuthSessionContext`)
Apple OAuth: deferred — no Sign in with Apple UI added
Email/password auth: preserved (existing auth flow)
Persistent Profile route: no dedicated profile route exists; Privacy & Trust card routes to `/privacy`
Persistent Privacy route: `/privacy` exists
Onboarding auth screens avoided: yes — Home does not route to onboarding
Apple OAuth UI added: no
Native config changed: no
Backend auth changes: no
Future auth/backend functions: documented as deferred (`getUserProfile`, `linkAppleOAuth`, etc.)

---

## Additional Report Fields

Home V2 feature flag added: yes
Flag name: `HOME_NAVIGATION_V2_ENABLED`
Default flag value: `false`
Old Home preserved: yes
Base branch verified: yes (`feature/dressing-rooms-hierarchy-v1`)
Route strings audited: yes
Profile route persistent / onboarding: `/privacy` (persistent); no onboarding routing from Home
Library route version: existing old Library route (`app/library.tsx`)
Upload/TextScan mode routing: routes to `/scan` and `/text-scan`; direct sub-mode params deferred
Mode params supported: no
Recent activity aggregation: scans only (via `useLibrary`)
Recent activity layout shift prevented: `ActivityIndicator` placeholder reserves space during load
Bottom navigation status: deferred
Disabled card behavior: reduced opacity + "Coming Soon" pill + non-tappable
Android root Back behavior: Home is root of authenticated stack; expected to background/exit app
Accessibility labels added: yes
Continuity fix impact documented: yes
Runtime QA required: yes
Runtime QA status: **NOT RUN — deferred**
