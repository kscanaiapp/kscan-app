# K Scan AI — KS-REL-008A Core Backend Wiring Audit

**Date:** 2026-06-19  
**Auditor:** Backend Integration / Data Wiring Auditor  
**Scope:** Discovery, verification, and dependency-mapping only. No implementation.

---

## 1. Status

**PASS WITH NOTES**

Audit completed and report committed. No app/source code changed. Backend wiring slices clearly identified. **Critical targeting issue found:** `.env` and `eas.json` point to the protected Privacy project. Staging DB inspection unavailable. Render API unreachable. Branch name differs from expected target but backend foundations are present.

---

## 2. Branch / Commit

| Field | Value |
|---|---|
| Branch | `fix/frontend-polish-safe-v1` |
| HEAD | `fb6b937` — fix(ui): polish frontend warning and user-facing scan states |
| Working tree | Clean (no tracked modifications) |
| Untracked files | `qa/waitlist-project-consolidation-2026-06-18.md`, `qa/pre-backend-real-device-smoke-2026-06-19.md`, `qa/pre-backend-smoke-2026-06-19/`, `kscan-google-glasses/` |
| Remote alignment | `feature/ui-v2-integration-smoke` exists locally and on origin. Current branch is a descendant of it. |
| Branch baseline check | **Backend foundations present.** `legal_acceptances` (20260617000001), `saved_scans` (20260617215307), staging grants 202606180001–003 all present in `supabase/migrations/`. Commits `3d163c4` (staging RLS) and `5d3fbb9` (legal acceptance) are ancestors. **Not a branch baseline mismatch.** |

> **Note:** The expected branch is `feature/ui-v2-integration-smoke`. The current branch is a descendant with additional frontend polish (home action card routing, ScrollView auth fix, Home Hero V1). Backend foundations are intact. Recommend aligning on `feature/ui-v2-integration-smoke` before implementation begins, or fast-forwarding it to the current HEAD.

---

## 3. Runtime Backend Config

| Field | Value | Risk |
|---|---|---|
| Supabase CLI link | **Unavailable.** `supabase` command not found in PATH. | Medium — no live staging inspection possible |
| Supabase env var names | `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY` | — |
| API base URL env var | `EXPO_PUBLIC_API_URL` | — |
| Supabase project ref (`.env`) | `yzqjvdfgefveprobvvyw` — **PROTECTED Privacy project** | **CRITICAL** |
| Supabase project ref (`.env.local`) | `wyyuqfdxucjksghsmhry` — App staging project | — |
| Supabase project ref (`eas.json`) | `yzqjvdfgefveprobvvyw` — **PROTECTED Privacy project** | **CRITICAL** |
| Render/API URL | `https://kscan-app-1.onrender.com` | — |
| Service-role key in client | **None found.** | — |
| Edge functions observed | `handle-user-deletion`, `kickscrew-sneaker-description`, `nike-shoe-details`, `privacy-correction-request`, `privacy-data-export`, `product-search-deals`, `search-vinted-secondhand`, `stylechat-generate`, `tryon-clothes-pro` | — |
| Render/API endpoints | `/api/analyze` (POST), `/api/health` (GET) | — |
| Env targeting notes | `.env` and `eas.json` both target the **Privacy project**. `.env.local` is the only file targeting staging. Metro may pick up `.env` before `.env.local` depending on Expo env resolution order. **This is a release-blocking misconfiguration.** | **CRITICAL** |

> **Action required:** Before any EAS build or backend wiring work, update `.env` and `eas.json` to point to `wyyuqfdxucjksghsmhry`. Never commit the Privacy project ref to `eas.json`.

---

## 4. Frontend Route Map

| Surface | File | Route | Component | State | Backend Dependency | Failure State |
|---|---|---|---|---|---|---|
| Welcome / Landing | `app/index.tsx` | `/` | `Home` (feature-flagged) | Wired | Auth session, profile metadata | Shows loading spinner |
| Sign in | `app/auth/index.tsx` | `/auth` | `AuthScreen` | Wired | Supabase Auth | Inline error banner |
| Create account | `app/auth/index.tsx` | `/auth` (mode switch) | `AuthScreen` | Wired | Supabase Auth | Inline error banner |
| Demo login | — | — | — | **Not present** | — | — |
| Password reset | `app/auth/reset.tsx` | `/auth/reset` | `ResetPasswordScreen` | Wired | Supabase Auth | Inline error |
| Update password | `app/auth/update-password.tsx` | `/auth/update-password` | `UpdatePasswordScreen` | Wired | Supabase Auth | Inline error |
| Onboarding | `app/onboarding/index.tsx` | `/onboarding` | `OnboardingScreen` | Wired | Auth, legal acceptance | Shows legal busy state |
| Legal acceptance | `app/onboarding/index.tsx` (step 4) | `/onboarding` | `OnboardingScreen` | Wired | `legal_acceptances` table | Inline error banner |
| Permission preferences | `app/onboarding/index.tsx` (step 5) | `/onboarding` | `OnboardingScreen` | **Partial** | `privacy_settings` / permission prefs table | Placeholder `backend_not_connected` |
| Home after login | `app/index.tsx` → `components/home/HomeV2.tsx` or `HomeLuxuryTechV1.tsx` | `/` | `HomeV2` / `HomeLuxuryTechV1` | Wired | Auth session, recent scans | Empty state if no scans |
| Account / profile | `app/privacy.tsx` | `/privacy` | `PrivacyScreen` | Wired | `profiles`, `privacy_settings` | Shows local-only fallback |
| Privacy / trust | `app/privacy.tsx` | `/privacy` | `PrivacyScreen` | Wired | `privacy_settings`, `profiles` | AsyncStorage local fallback |
| Delete account | `app/privacy.tsx` | `/privacy` | `PrivacyScreen` | Wired | `handle-user-deletion` Edge Function | Modal error |
| Scan | `app/scan/index.tsx` → `app.js` | `/scan` | `KScanApp` | Wired | `/api/analyze` (Render) | Camera/analyze error states |
| TextScan | `app/text-scan/index.tsx` | `/text-scan` | `TextScanScreen` | Wired | `/api/analyze` (Render) + demo fallback | Demo/fallback branch |
| Library | `app/library.tsx` | `/library` | `LibraryScreen` | Wired | Local `FileSystem` + cloud `saved_scans` (opt-in) | Empty state |
| StyleChat | `app/style-chat/index.tsx` | `/style-chat` | `StyleChatIndexScreen` | Wired | `style_chat_sessions`, `style_chat_messages`, `stylechat-generate` Edge Function | Error banner |
| Dressing Rooms | `app/dressing-rooms/index.tsx` | `/dressing-rooms` | `DressingRoomsScreen` | Wired | `dressing_rooms`, `dressing_room_items` | Empty state / error notice |
| Public Room Share | `app/(public)/rooms/[token].tsx` | `/rooms/[token]` | `SharedRoomScreen` | Wired | `room_shares` public preview API | Browser fallback |
| Looks | `app/looks/index.tsx` | `/looks` | `LooksScreen` | Wired | `dressing_rooms` / looks derived | Empty state |
| Look Detail | `app/looks/[id].tsx` | `/looks/[id]` | `LookDetailScreen` | Wired | `dressing_rooms` / looks | Error alert |

---

## 5. Auth / Session Wiring

| Component | Status | Details |
|---|---|---|
| **Session source** | Working | `AuthSessionContext.tsx` → `supabase.auth.getSession()` + `onAuthStateChange` |
| **Supabase initialization** | Working | `services/supabaseClient.ts` — `createClient(url, anonKey, { auth: { storage: AsyncStorage, persistSession: true } })` |
| **Demo login definition** | **Not present** | No fixed test credentials, no guest route, no mock session. The app requires real Supabase auth. |
| **Email sign-in** | Working | `supabase.auth.signInWithPassword({ email, password })` in `AuthSessionContext.tsx` |
| **Email signup** | Working | `supabase.auth.signUp({ email, password, options: { emailRedirectTo } })` in `AuthSessionContext.tsx` |
| **Password reset** | Working | `supabase.auth.resetPasswordForEmail()` in `app/auth/reset.tsx` |
| **Google OAuth** | Partial | Implemented in `app/auth/index.tsx` (`provider: 'google'`) and `app/onboarding/index.tsx`. Known symptom: "Unsupported provider: provider is not enabled." Dashboard status unknown. |
| **Apple OAuth** | Partial | Implemented in `app/auth/index.tsx` (`provider: 'apple'`). iOS only. Status unknown without physical device test. |
| **Sign out** | Working | `supabase.auth.signOut()` + `invalidateAllMemoryCache()` in `AuthSessionContext.tsx` |
| **Profile loading** | Working | `PrivacyPreferencesContext.tsx` fetches `profiles` row via `fetchProfile()` in `services/supabasePrivacy.js` |
| **Post-login routing** | Working | `AuthGate` in `app/_layout.tsx` uses `getRoutingGuardState()` → redirects to `/` after auth, to `/auth` when signed out. |
| **Auth callback** | Working | `app/auth/callback.tsx` handles OAuth deep-link callback with `exchangeCodeForSession` and `setSession`. |
| **Routing guard** | Working | `services/routingGuard.js` — public routes, limited-account routes, pending-deletion profile handling. |

---

## 6. Placeholder Inventory

| Placeholder | File | Current Behavior | Local State | Calls Supabase | Should Connect To | Migration Exists |
|---|---|---|---|---|---|---|
| **Permission preferences** | `hooks/usePermissionPreferences.ts` | In-memory only; returns `backend_not_connected` | No (useState only) | No | `privacy_settings` or dedicated permission table | Partial (`privacy_settings` has RLS) |
| **Legal acceptances** | `services/legalAcceptance.ts` | Upserts to `legal_acceptances` via Supabase | No | **Yes** | `legal_acceptances` | **Yes** (20260617000001) |
| **Style Picks** | `hooks/useStylePicks.ts` | Empty array; returns `backend_not_connected` | No | No | Recommendation engine / AI curated feed | No |
| **Home personalization** | `components/home/HomeV2.tsx` | Reads auth session, recent scans from `useLibrary` | Local `FileSystem` | Optional (`saved_scans` cloud opt-in) | `profiles`, `saved_scans` | Partial |
| **Scan** | `app.js` | Calls `/api/analyze` (Render) | `FileSystem` + local library | No direct table | `/api/analyze` | N/A (Render API) |
| **TextScan** | `app/text-scan/index.tsx` | Calls `analyzeText()` → `/api/analyze`; demo fallback when `TEXTSCAN_BACKEND_ENABLED=false` | Demo data in `data/textscan-demo.ts` | No direct table | `/api/analyze` | N/A (Render API) |
| **Library** | `app/library.tsx` | Local `FileSystem` first; optional cloud merge | `FileSystem` | Optional (`saved_scans` when `CLOUD_SAVED_SCANS_ENABLED=true`) | `saved_scans` | **Yes** (20260617215307) |
| **StyleChat** | `app/style-chat/index.tsx` | Full Supabase DB + Edge Function flow | `style_chat_sessions`, `style_chat_messages` | **Yes** | `style_chat_sessions`, `style_chat_messages`, `stylechat-generate` | **Yes** (202606070001–007) |
| **Dressing Rooms** | `app/dressing-rooms/index.tsx` | Full Supabase DB CRUD | `dressing_rooms`, `dressing_room_items` | **Yes** | `dressing_rooms`, `dressing_room_items`, `room_shares` | **Yes** (multiple) |
| **Account deletion** | `app/privacy.tsx` | Calls `handle-user-deletion` Edge Function | `AsyncStorage` clear | **Yes** (Edge Function) | `deletion_requests`, `profiles` | **Yes** (202605130003, 202605130004) |

---

## 7. Database / RLS / Storage Map

**Live staging inspection unavailable** (Supabase CLI not linked). The following is derived from local migration files and code references only.

### Tables Referenced by Frontend / Services / Edge Functions

| Table | Referenced In | Migration Found | Staging Verified | Notes |
|---|---|---|---|---|
| `profiles` | `services/supabasePrivacy.js`, `services/routingGuard.js`, `services/styleObjects.ts`, `services/style-chat/styleChatRepository.ts` | 202605122359 | No | Base profile row |
| `privacy_settings` | `services/supabasePrivacy.js`, `contexts/PrivacyPreferencesContext.tsx` | 202605130001, 202605130002 | No | RLS present in migrations |
| `deletion_requests` | `services/accountDeletion.js`, `supabase/functions/handle-user-deletion` | 202605130003, 202605130004, 202605160001 | No | Soft-delete pattern |
| `legal_acceptances` | `services/legalAcceptance.ts` | 20260617000001 | No | **New — verify staging applied** |
| `saved_scans` | `services/savedScansCloud.ts`, `hooks/useLibrary.js` | 20260617215307 | No | **New — verify staging applied** |
| `style_chat_sessions` | `services/style-chat/styleChatRepository.ts`, `supabase/functions/stylechat-generate` | 202606070001 | No | With RLS |
| `style_chat_messages` | `services/style-chat/styleChatRepository.ts`, `supabase/functions/stylechat-generate` | 202606070001 | No | With RLS |
| `style_chat_usage` | `services/style-chat/styleChatRepository.ts` | 202606070002, 202606070005, 202606070006 | No | Monthly usage cap |
| `style_chat_daily_usage` | `services/style-chat/styleChatRepository.ts`, `supabase/functions/stylechat-generate` | 202606070005, 202606070006 | No | Daily beta cap |
| `dressing_rooms` | `services/styleObjects.ts`, `app/dressing-rooms` | 202606030001 | No | Room notes added |
| `dressing_room_items` | `services/styleObjects.ts`, `app/dressing-rooms/[id].tsx` | 202605200001, 202606050001 | No | Items + reactions |
| `dressing_room_item_reactions` | `services/styleObjects.ts`, `app/dressing-rooms/[id].tsx` | 202606050001, 202606060001 | No | Thumbs up/down |
| `dressing_room_messages` | `services/roomMessages.ts` | 202606110001, 20260611223807 | No | Room chat messages |
| `room_shares` | `services/styleObjects.ts`, `app/(public)/rooms/[token].tsx` | 202605240001–004, 202606050002, 202606070007 | No | Public preview |
| `inspiration_uploads` | `services/styleObjects.ts`, `app/library.tsx` | 20260607222310 | No | Inspiration images |
| `app_config` | `services/featureFreeze.ts` | 202605230001 | No | Feature freeze config |

### Storage Buckets Referenced

| Bucket | Referenced In | Migration Found | Notes |
|---|---|---|---|
| `style-library-images` | `services/styleObjects.ts` (STYLE_LIBRARY_IMAGES_BUCKET) | 202605200002 | For inspiration uploads and scan images |
| `public-room-previews` | `services/styleObjects.ts`, `app/(public)/rooms/[token].tsx` | 202605240001–004 | Public room share preview images |

### RPCs / Functions Referenced

| RPC / Function | Referenced In | Migration Found | Notes |
|---|---|---|---|
| `ensure_privacy_settings` | `services/supabasePrivacy.js` | 202605130001 | Creates default privacy row |
| `increment_stylechat_daily_usage` | `supabase/functions/stylechat-generate` | 202606070005 | Daily quota enforcement |
| `check_and_increment_stylechat_burst` | `supabase/functions/stylechat-generate` | 202606090001 | Per-minute burst limit |
| `get_stylechat_daily_usage` | `services/style-chat/styleChatRepository.ts` | 202606070005 | Display-only usage |
| `increment_style_chat_usage` | `services/style-chat/styleChatRepository.ts` | 202606070002 | Legacy monthly cap |

---

## 8. Surface-to-Backend Map

| Frontend Surface | Required Backend Table/RPC/Function | Found in Code | Found in Migrations | Found in Staging | RLS/Policy Found | Notes |
|---|---|---|---|---|---|---|
| **Auth** | Supabase Auth (built-in) | Yes | N/A | Unknown | N/A | OAuth providers need dashboard verification |
| **Legal acceptance** | `legal_acceptances` table | Yes | Yes | Unknown | Partial | Upsert with conflict ignore |
| **Permission preferences** | `privacy_settings` / dedicated table | Partial | Partial | Unknown | Partial | `usePermissionPreferences` is placeholder |
| **Home / Profile** | `profiles`, `saved_scans` | Yes | Yes | Unknown | Partial | Reads user_metadata for greeting |
| **Scan** | `/api/analyze` (Render) | Yes | N/A | N/A | N/A | Image → Render → Gemini |
| **TextScan** | `/api/analyze` (Render) | Yes | N/A | N/A | N/A | Text → Render → Gemini; demo fallback available |
| **Library** | Local `FileSystem` + `saved_scans` (opt-in) | Yes | Yes | Unknown | Partial | `CLOUD_SAVED_SCANS_ENABLED` flag off by default |
| **Inspiration uploads** | `inspiration_uploads` + `style-library-images` bucket | Yes | Yes | Unknown | Partial | Auth-gated in `services/styleObjects.ts` |
| **StyleChat** | `style_chat_sessions`, `style_chat_messages`, `stylechat-generate` Edge Function | Yes | Yes | Unknown | Yes | Full DB + Edge Function chain |
| **Dressing Rooms** | `dressing_rooms`, `dressing_room_items`, `dressing_room_item_reactions` | Yes | Yes | Unknown | Partial | CRUD complete; storage upload for room images |
| **Looks** | Derived from Dressing Room data | Yes | No | Unknown | N/A | Client-side composition, no separate table |
| **Public Room Share** | `room_shares` + public preview API | Yes | Yes | Unknown | Partial | Public route with token validation |
| **Account deletion** | `handle-user-deletion` Edge Function | Yes | Yes | Unknown | Partial | Sets `pending_deletion` status |
| **Data export** | `privacy-data-export` Edge Function | Yes | Yes | Unknown | Partial | Uses `serviceRest` with service-role key |
| **Correction request** | `privacy-correction-request` Edge Function | Yes | Yes | Unknown | Partial | Uses `serviceRest` with service-role key |
| **Product search / deals** | `product-search-deals` Edge Function | Yes | No | Unknown | N/A | Sneaker-specific RapidAPI proxy |
| **Secondhand search** | `search-vinted-secondhand` Edge Function | Yes | No | Unknown | N/A | Vinted search proxy |
| **Try-on** | `tryon-clothes-pro` Edge Function | Yes | No | Unknown | N/A | AI try-on proxy |
| **Nike shoe details** | `nike-shoe-details` Edge Function | Yes | No | Unknown | N/A | RapidAPI proxy |
| **Kickscrew sneaker** | `kickscrew-sneaker-description` Edge Function | Yes | No | Unknown | N/A | RapidAPI proxy |
| **Sneaks API** | External `EXPO_PUBLIC_SNEAKS_API_BASE_URL` | Yes | No | N/A | N/A | Optional external provider |
| **Hosea API** | External `EXPO_PUBLIC_HOSEA_API_BASE_URL` | Yes | No | N/A | N/A | Optional external provider |

---

## 9. Backend Endpoints / Ownership

| Endpoint/Function | Source | Deployed/Reachable | Auth Required | Used By Frontend | Status | Notes |
|---|---|---|---|---|---|---|
| `POST /api/analyze` | Render API | **Unreachable** (timeout) | No (client-side) | Scan, TextScan | **Blocked** | Render service may be down or URL changed |
| `GET /api/health` | Render API | **Unreachable** (timeout) | No | — | **Blocked** | Same host |
| `POST /api/style-chat/message` | Expo Route Handler (local) | N/A | Yes | — | Local only | Not a deployed endpoint |
| `POST /api/style-chat/session` | Expo Route Handler (local) | N/A | Yes | — | Local only | Not a deployed endpoint |
| `stylechat-generate` | Supabase Edge Function | Unknown (CLI unavailable) | Yes (JWT) | StyleChat | Unknown | Function file exists and is well-structured |
| `handle-user-deletion` | Supabase Edge Function | Unknown | Yes (JWT) | Account deletion | Unknown | Sets `pending_deletion` status |
| `privacy-data-export` | Supabase Edge Function | Unknown | Yes (JWT) | Privacy export | Unknown | Service-role key server-side only |
| `privacy-correction-request` | Supabase Edge Function | Unknown | Yes (JWT) | Privacy correction | Unknown | Service-role key server-side only |
| `product-search-deals` | Supabase Edge Function | Unknown | Yes (JWT) | Sneaker search | Unknown | RapidAPI key server-side only |
| `search-vinted-secondhand` | Supabase Edge Function | Unknown | Yes (JWT) | Secondhand search | Unknown | — |
| `tryon-clothes-pro` | Supabase Edge Function | Unknown | Yes (JWT) | Try-on | Unknown | — |
| `nike-shoe-details` | Supabase Edge Function | Unknown | Yes (JWT) | Sneaker details | Unknown | RapidAPI key server-side only |
| `kickscrew-sneaker-description` | Supabase Edge Function | Unknown | Yes (JWT) | Sneaker details | Unknown | RapidAPI key server-side only |
| `ensure_privacy_settings` | Supabase RPC | Unknown | Yes | Privacy context | Unknown | — |
| `increment_stylechat_daily_usage` | Supabase RPC | Unknown | Yes | StyleChat quota | Unknown | — |
| `check_and_increment_stylechat_burst` | Supabase RPC | Unknown | Yes | StyleChat burst limit | Unknown | — |
| `get_stylechat_daily_usage` | Supabase RPC | Unknown | Yes | StyleChat usage display | Unknown | — |
| `increment_style_chat_usage` | Supabase RPC | Unknown | Yes | Legacy StyleChat usage | Unknown | Deprecated? |

### Backend Ownership Map

| Surface | Render API | Supabase Edge Function | Supabase Direct DB | RPC | Conflict? | Recommended Source of Truth |
|---|---|---|---|---|---|---|
| Scan | **Yes** | No | No | No | No | Render API (`/api/analyze`) |
| TextScan | **Yes** | No | No | No | No | Render API (`/api/analyze`) |
| StyleChat | No | **Yes** (`stylechat-generate`) | Yes (messages, sessions) | Yes (quota) | No | Edge Function for AI; DB for persistence |
| Dressing Rooms | No | No | **Yes** | No | No | Supabase DB direct |
| Looks | No | No | **Yes** (derived) | No | No | Supabase DB direct |
| Library | No | No | **Yes** (`saved_scans` opt-in) | No | No | Local first, cloud opt-in |
| Inspiration uploads | No | No | **Yes** + Storage | No | No | Supabase DB + Storage |
| Account deletion | No | **Yes** (`handle-user-deletion`) | Yes (profiles) | No | No | Edge Function for orchestration |
| Data export | No | **Yes** (`privacy-data-export`) | Yes (profiles, settings) | No | No | Edge Function for service-role access |
| Correction request | No | **Yes** (`privacy-correction-request`) | Yes | No | No | Edge Function for service-role access |
| Product search | No | **Yes** (`product-search-deals`) | No | No | No | Edge Function (RapidAPI proxy) |
| Room share public preview | No | No | **Yes** (`room_shares`) | No | No | Supabase DB direct + public API |

---

## 10. Account Deletion Scope

| Component | Status | Details |
|---|---|---|
| **UI exists** | Yes | `PrivacyScreen` (`app/privacy.tsx`) shows "Delete Account" button with confirmation modal |
| **Backend call exists** | Yes | `submitAccountDeletionRequest()` → `supabase.functions.invoke('handle-user-deletion')` |
| **Auth user deleted** | **No** | Edge Function does NOT call `auth.admin.deleteUser()`. It only inserts a `deletion_requests` row and sets `profiles.account_status = 'pending_deletion'`. |
| **Profile deleted** | Partial | Sets `account_status = 'pending_deletion'` and `deletion_requested_at`. Row remains. |
| **Preferences deleted** | **No** | `privacy_settings` row is not touched. |
| **Legal records handled** | **No** | `legal_acceptances` rows are not deleted. |
| **Scans deleted** | **No** | `saved_scans` rows are not deleted. Soft-delete column `deleted_at` exists but is not set by deletion function. |
| **Library items deleted** | **No** | `inspiration_uploads` rows are not deleted. Storage objects are not deleted. |
| **StyleChat deleted** | **No** | `style_chat_sessions` and `style_chat_messages` are not deleted. |
| **Dressing Rooms deleted** | **No** | `dressing_rooms`, `dressing_room_items`, `room_shares` are not deleted. |
| **Storage objects deleted** | **No** | No storage cleanup is performed. |
| **Gaps** | **Major** | The deletion function is an **intake request**, not an actual erasure. It records intent and updates profile status, but no data is actually deleted. For Apple/Google store compliance, a true cascade deletion (or documented retention policy) must be implemented before release. |

> **Recommendation:** Before store release, implement a true deletion cascade or a documented retention + periodic erasure workflow. The current `pending_deletion` status is a good intake mechanism but does not satisfy "actual deletion" store requirements by itself.

---

## 11. StyleChat Health

| Check | Status | Details |
|---|---|---|
| **Function file exists** | Yes | `supabase/functions/stylechat-generate/index.ts` — 1035 lines, well-structured |
| **Deno check** | Unknown | Deno CLI not available in this environment. Function uses standard Deno/Supabase patterns (`Deno.serve`, `Deno.env.get`, `npm:@supabase/supabase-js@2`). No obvious syntax errors. |
| **App invokes function** | Yes | `EdgeStyleChatProvider` in `services/style-chat/providers/edgeStyleChatProvider.ts` calls `supabase.functions.invoke('stylechat-generate')` |
| **Reaches provider call** | Yes | Function validates auth, checks kill switch, verifies session ownership, checks burst limit, checks daily quota, assembles context (memory + recent messages), builds Gemini payload, calls Gemini, handles retry logic, returns structured response. |
| **Short-circuit risk** | Low | Kill switch (`STYLECHAT_AI_ENABLED=false`) returns safe fallback. Missing `GEMINI_API_KEY` returns 500. Missing auth returns 401. Malformed RPC responses return error contract. No early return that would skip the provider call when conditions are met. |
| **Persistence** | Yes | Messages are persisted to `style_chat_messages` before and after the provider call. The Edge Function itself does NOT persist messages; the mobile app calls `saveStyleChatMessage()` after receiving the response. |
| **Blocker classification** | **None** | The function architecture is sound. The only potential blockers are: (1) `GEMINI_API_KEY` not configured server-side, (2) RPCs not deployed in staging, (3) `style_chat_messages` RLS not allowing inserts. These are deployment/configuration issues, not code issues. |

> **Note:** The StyleChat function is one of the most complete backend surfaces in the codebase. It does NOT require a separate "function restoration" prompt before context wiring. The next slice for StyleChat should be **deployment verification** (RPCs, env vars, RLS) rather than function rewriting.

---

## 12. Home / Fake Commerce / Feature Flag Audit

### Home Components

| Component | File | Reads Auth | Reads Profile | Reads Scans | Fake Commerce | Notes |
|---|---|---|---|---|---|---|
| `HomeV2` | `components/home/HomeV2.tsx` | Yes | Yes (`user.user_metadata`) | Yes (`useLibrary`) | **No** | Shows destination cards, recent scans, action buttons. No product cards. |
| `HomeLuxuryTechV1` | `components/home/HomeLuxuryTechV1.tsx` | Yes | Yes | Yes | **No** | Comment explicitly states: "Matches the home-page-v1 mockup direction without fake commerce" |
| `HomeLegacy` | `components/home/HomeLegacy.tsx` | Yes | Yes | Yes | **No** | Legacy home with sign-out button |

### Scan Results Components

| Component | File | Fake Data | Notes |
|---|---|---|---|
| `ScanResultV2` | `components/scan-results/ScanResultV2.tsx` | **Demo data available** | `getDemoScanResultV2()` gated by `SCAN_RESULTS_DEMO_UI_ENABLED` env flag. Defaults to off. |
| `PurchaseOptionsPanel` | `components/scan-results/PurchaseOptionsPanel.tsx` | **No** | Explicit comment: "No hardcoded retailer rows, no fake prices, no fake inventory." |
| `SimilarFindsShelf` | `components/scan-results/SimilarFindsShelf.tsx` | **No** | Shows price only if real (`product.priceLabel`). |

### TextScan Components

| Component | File | Demo Data | Notes |
|---|---|---|---|
| `TextScanScreen` | `app/text-scan/index.tsx` | **Demo data available** | `TEXTSCAN_DEMO_RESULTS_ENABLED` flag. Demo products from `data/textscan-demo.ts`. Backend branch gated by `TEXTSCAN_BACKEND_ENABLED`. |

### Feature Flags

| Flag | Env Var | Default | Used By |
|---|---|---|---|
| `TEXTSCAN_UI_ENABLED` | `EXPO_PUBLIC_ENABLE_TEXTSCAN` | `false` | Home, Scan landing |
| `TEXTSCAN_BACKEND_ENABLED` | `EXPO_PUBLIC_TEXTSCAN_BACKEND_ENABLED` | `false` | TextScan screen |
| `TEXTSCAN_DEMO_RESULTS_ENABLED` | `EXPO_PUBLIC_TEXTSCAN_DEMO_RESULTS` | `false` | TextScan screen |
| `SCAN_RESULTS_V2_UI_ENABLED` | `EXPO_PUBLIC_SCAN_RESULTS_V2_UI` | `false` | Scan flow |
| `SCAN_RESULTS_DEMO_UI_ENABLED` | `EXPO_PUBLIC_SCAN_RESULTS_DEMO_UI` | `false` | ScanResultV2 |
| `CLOUD_SAVED_SCANS_ENABLED` | `EXPO_PUBLIC_CLOUD_SAVED_SCANS_ENABLED` | `false` | Library hook |
| `ONBOARDING_FRAMEWORK_V1_ENABLED` | `EXPO_PUBLIC_ONBOARDING_FRAMEWORK_V1` | `false` | Auth gate, onboarding route |
| `ACCOUNT_HOME_UX_V1_ENABLED` | `EXPO_PUBLIC_ACCOUNT_HOME_UX_V1` | `false` | Home selector, onboarding |
| `HOME_NAVIGATION_V2_ENABLED` | `EXPO_PUBLIC_HOME_NAVIGATION_V2` | `false` | Home selector |
| `SCAN_ROOM_V2_UI_ENABLED` | `EXPO_PUBLIC_SCAN_ROOM_V2_UI` | `false` | Scan landing |
| `DEV_FEATURE_FREEZE_OVERRIDE` | None | `null` | Feature freeze provider |

> **Assessment:** All fake/demo data is gated by env flags that default to `false`. Home does not show fake product cards. This is compliant with the "no fake commerce" rule.

---

## 13. Core Surface Readiness Audit

### Scan
- **Frontend state:** Complete — camera, capture, review, analyze, results V1/V2
- **Backend call:** `POST /api/analyze` to Render API with base64 image
- **Persistence:** Local `FileSystem` via `services/library.js`
- **Placeholder:** None
- **Required dependency:** Render API must be reachable and return valid JSON
- **Known blockers:** Render API currently unreachable. Need to verify Render service status or hosting URL.
- **Recommended slice:** 008D — Audit Render API endpoint, verify `/api/analyze` contract, test scan e2e

### TextScan
- **Frontend state:** Complete — input, processing, results with attribute grid, filter tabs
- **Backend call:** `POST /api/analyze` with `mode: 'text'` to Render API
- **Persistence:** None (not saved to library yet — "Save to Style Library" button is disabled)
- **Placeholder:** Demo results available when flag enabled
- **Required dependency:** Render API must be reachable
- **Known blockers:** Same as Scan — Render API unreachable. Also "Save to Library" and "Add to Dressing Room" buttons are disabled.
- **Recommended slice:** 008E — Verify TextScan API contract, enable library persistence wiring

### Library
- **Frontend state:** Complete — local scans grid, inspiration uploads, cloud sync background merge
- **Backend call:** `listCloudSavedScans()` when `CLOUD_SAVED_SCANS_ENABLED` and authenticated
- **Persistence:** Local `FileSystem` + optional `saved_scans` table
- **Placeholder:** None
- **Required dependency:** `saved_scans` table must be deployed in staging with correct RLS
- **Known blockers:** Cloud sync flag is off by default. `saved_scans` migration exists but staging deployment unverified.
- **Recommended slice:** 008F — Enable `CLOUD_SAVED_SCANS_ENABLED` in staging, verify RLS, test merge logic

### StyleChat
- **Frontend state:** Complete — session list, session detail, messages, optimistic UI, daily usage display
- **Backend call:** `stylechat-generate` Edge Function + direct DB reads/writes for messages/sessions
- **Persistence:** `style_chat_sessions`, `style_chat_messages` via `styleChatRepository.ts`
- **Placeholder:** None
- **Required dependency:** Edge Function deployed, `GEMINI_API_KEY` set, RPCs deployed, RLS allows inserts
- **Known blockers:** Deployment status unknown. Function code is complete and robust.
- **Recommended slice:** 008G — Deploy/verify StyleChat Edge Function, RPCs, and RLS in staging

### Dressing Rooms
- **Frontend state:** Complete — list, detail, create, add items, reactions, notes, upload inspiration
- **Backend call:** Direct Supabase DB (`dressing_rooms`, `dressing_room_items`, `dressing_room_item_reactions`, `dressing_room_messages`)
- **Persistence:** Full DB + storage bucket (`style-library-images`)
- **Placeholder:** None
- **Required dependency:** Tables deployed with RLS, storage bucket configured
- **Known blockers:** None identified in code. Staging deployment unverified.
- **Recommended slice:** 008H — Verify Dressing Room tables, RLS, and storage in staging

### Public Room Share
- **Frontend state:** Complete — public room preview with items, reactions, browser fallback
- **Backend call:** `https://www.kscan.app/api/rooms` (public API) + `room_shares` table
- **Persistence:** `room_shares`, `dressing_room_items`
- **Placeholder:** None
- **Required dependency:** Public API endpoint must be live
- **Known blockers:** Public API endpoint depends on marketing site/backend being deployed.
- **Recommended slice:** Defer until after Dressing Rooms are stable

---

## 14. Risks / Blockers

| Risk | Severity | Details | Proposed Fix |
|---|---|---|---|
| **Supabase targeting (Privacy project)** | **CRITICAL** | `.env` and `eas.json` point to `yzqjvdfgefveprobvvyw` (Privacy project). `.env.local` is the only file pointing to staging. | Update `.env` and `eas.json` to `wyyuqfdxucjksghsmhry`. Never build EAS with Privacy project ref. |
| **Render API unreachable** | **CRITICAL** | `https://kscan-app-1.onrender.com` returns timeout/connection failure. Scan and TextScan depend on it. | Verify Render service status. Check if URL changed or service is suspended. |
| **Google OAuth provider status** | Medium | "Unsupported provider" error observed. Dashboard status unknown. | Verify Authentication → Providers → Google in Supabase staging dashboard. |
| **Branch name mismatch** | Low | Current branch is `fix/frontend-polish-safe-v1`, not `feature/ui-v2-integration-smoke`. | Fast-forward `feature/ui-v2-integration-smoke` to current HEAD, or continue on current branch. |
| **Account deletion incomplete** | Medium | Deletion only records request; no actual data erasure. | Implement cascade deletion or documented retention + erasure workflow before store release. |
| **No live staging DB verification** | Medium | Supabase CLI unavailable. Cannot verify RLS, tables, or function deployment. | Install/link Supabase CLI to staging. Run read-only verification. |
| **AI provider key dependency** | Low | `GEMINI_API_KEY` must be set server-side for StyleChat and Scan. | Verify env vars in Supabase staging dashboard. |
| **RapidAPI key dependency** | Low | Multiple sneaker functions need `RAPIDAPI_KEY`. | Verify env vars in Supabase staging dashboard. |
| **No demo login** | Low | No fixed test credentials or guest mode. QA must use real accounts. | Document QA test account creation process. Consider adding a staging-only demo flag if needed. |
| **Permission preferences placeholder** | Low | `usePermissionPreferences` does not persist to backend. | Wire to `privacy_settings` or create dedicated table. |
| **Style Picks placeholder** | Low | `useStylePicks` returns empty array with no backend. | Defer until recommendation engine is ready. Keep empty state. |

---

## 15. Recommended Implementation Slices

Limit to 7 focused slices. Each slice should be independently testable.

### 008B: Foundation — Fix Supabase targeting and env alignment
- Update `.env` default Supabase URL to staging (`wyyuqfdxucjksghsmhry`)
- Update `eas.json` build profiles to staging URL
- Verify `EXPO_PUBLIC_SUPABASE_ANON_KEY` matches staging
- Add `.env` to `.gitignore` if not already present (check if `.env` is tracked)
- **Acceptance:** `echo $EXPO_PUBLIC_SUPABASE_URL` from Metro shows staging ref

### 008C: Foundation — Render API recovery and contract verification
- Verify `kscan-app-1.onrender.com` status (check Render dashboard, restart if needed)
- Test `POST /api/analyze` with a sample image payload
- Test `POST /api/analyze` with `mode: 'text'` and a fashion query
- Document response contract and error codes
- **Acceptance:** Scan and TextScan return real backend responses in staging

### 008D: Capture — Scan/TextScan backend wiring validation
- Enable `SCAN_RESULTS_V2_UI_ENABLED` and `TEXTSCAN_BACKEND_ENABLED` in staging env
- Run end-to-end scan flow: camera → analyze → results
- Run end-to-end TextScan flow: query → analyze → results
- Verify non-fashion rejection handling
- Verify timeout and error states
- **Acceptance:** Both flows produce real backend data without crashing

### 008E: Memory — Library cloud sync enablement
- Enable `CLOUD_SAVED_SCANS_ENABLED` in staging env
- Verify `saved_scans` table exists in staging with correct RLS
- Test local → cloud scan merge logic
- Verify soft-delete (`deleted_at`) behavior
- Test unauthenticated fallback (local-only)
- **Acceptance:** Authenticated users see scans synced across sessions; unauthenticated users stay local-only

### 008F: Conversation — StyleChat deployment verification
- Verify `stylechat-generate` Edge Function is deployed in staging
- Verify `GEMINI_API_KEY` is set in staging function secrets
- Verify RPCs (`increment_stylechat_daily_usage`, `check_and_increment_stylechat_burst`) exist
- Test StyleChat message flow: create session → send message → receive response → persist messages
- Verify daily quota enforcement
- **Acceptance:** StyleChat produces Gemini responses and persists messages correctly

### 008G: Organization — Dressing Rooms staging verification
- Verify `dressing_rooms`, `dressing_room_items`, `dressing_room_item_reactions`, `dressing_room_messages` tables in staging
- Verify `style-library-images` storage bucket exists with correct policies
- Test create room → add item → add reaction → add note → upload inspiration
- Test public room share token generation
- **Acceptance:** All Dressing Room CRUD operations work in staging

### 008H: Account — Account deletion cascade audit
- Audit `handle-user-deletion` Edge Function for complete erasure coverage
- Determine if hard-delete or soft-delete + periodic erasure is the correct strategy
- Add cascade deletion for: `saved_scans`, `style_chat_sessions`/`messages`, `dressing_rooms`/`items`, `inspiration_uploads`, storage objects, `legal_acceptances`, `privacy_settings`
- OR document retention policy and implement periodic erasure worker
- Update privacy screen copy to reflect actual deletion behavior
- **Acceptance:** Account deletion removes or documents erasure of all user data within stated timeframe

---

## 16. Validation

| Check | Status | Details |
|---|---|---|
| **Commands run** | Completed | `git branch`, `git status`, `git log`, `grep` (multiple), `find`, `ls`, `curl` (Render health), `cat` (env files, redacted) |
| **TypeScript run** | **Deferred** | No app code changed. `npx tsc --noEmit` not run to avoid generating cache artifacts. |
| **Tests run** | **Deferred** | No app code changed. No test runner invoked. |
| **Deno checks** | **Deferred** | `deno` CLI not available. Function files reviewed manually for obvious syntax issues. |
| **Supabase read-only checks** | **Blocked** | Supabase CLI not available. No live staging inspection performed. |
| **Render reachability** | **Failed** | `curl` to `kscan-app-1.onrender.com` returned `000` / unreachable. |
| **Reason if deferred** | — | This is an audit-only task. No app code was modified. TypeScript checks and tests would be run in the implementation slices, not during discovery. |

---

## 17. Final Recommendation

1. **Do not begin backend wiring until the Supabase targeting issue is fixed.** `.env` and `eas.json` must point to the staging project (`wyyuqfdxucjksghsmhry`), not the Privacy project.

2. **Do not begin backend wiring until Render API reachability is restored.** Scan and TextScan are entirely dependent on `/api/analyze`. Verify the Render service status first.

3. **The branch baseline is acceptable.** `fix/frontend-polish-safe-v1` contains all expected backend foundation migrations (`legal_acceptances`, `saved_scans`, staging grants). No merge or rebase is strictly required before implementation, though aligning branch names would reduce confusion.

4. **StyleChat does not need a "restoration" prompt.** The `stylechat-generate` Edge Function is well-architected and complete. The next step is deployment verification, not rewriting.

5. **Account deletion is an intake mechanism, not an erasure.** Before store release, implement true cascade deletion or a documented retention + erasure workflow. The current implementation will not satisfy Apple/Google deletion requirements.

6. **All demo/fake commerce data is properly gated.** Home shows no fake product cards. Scan results and TextScan demo data are behind env flags that default to `off`. This is compliant with the product moat.

7. **No service-role keys or secrets were found in client code.** The codebase follows the security rule: `SUPABASE_SERVICE_ROLE_KEY` only appears in Edge Functions.

8. **The audit should be classified as `PASS WITH NOTES`.** The critical issues are configuration/operational (env targeting, Render downtime), not code architecture issues. The frontend is well-prepared for backend integration.

---

*Report generated by KS-REL-008A Backend Integration Auditor.*  
*No app code was modified during this audit.*
