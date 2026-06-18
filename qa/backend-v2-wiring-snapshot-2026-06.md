# K Scan AI — Backend-to-V2 Wiring Snapshot Report

**Branch:** `feature/backend-v2-wiring-snapshot-v1`
**Base:** `feature/backend-legal-acceptance-v1` (commit `5d3fbb9`)
**Date:** 2026-06-17
**Status:** Evidence-complete — implementation-ready for most surfaces; blocked by StyleChat health for context injection

---

## 1. Branch / Commit

**Current branch:** `feature/backend-v2-wiring-snapshot-v1`
**Base branch:** `feature/backend-legal-acceptance-v1`
**Commit:** `5d3fbb9 feat(backend): add legal acceptance persistence`
**Working tree:** clean

---

## 2. Files Changed

| File | Status |
|------|--------|
| `qa/backend-v2-wiring-snapshot-2026-06.md` | new (this report) |

**No code files modified.** This is a read-only audit.

---

## 3. Audit Mode

**Static/code snapshot:** ✅ Read-only inspection of 60+ files
**Live backend verification:** ❌ Not performed (documentation-only snapshot)
**Provider/API calls:** ❌ No live calls made
**Production data touched:** ❌ None

---

## 4. Executive Wiring Summary

### Ready to wire
- **Legal acceptance** — migration, service, onboarding wiring all complete (KS-BND-001)
- **Dressing Rooms CRUD** — full backend exists: list, create, update, delete, share, items, reactions, messages
- **Looks CRUD** — full backend exists: list, detail, update, delete, create from room items
- **Library inspiration uploads** — backend exists: `inspiration_items` table with storage, soft-delete, RLS
- **Privacy settings** — full backend exists: sync, merge, local+remote, deletion, export, correction
- **Auth** — full backend exists: email, Google, Apple, deep-link callbacks, routing guard
- **Public room preview** — full backend exists: `get_public_room_preview` RPC, public API fetch
- **StyleChat sessions/messages** — full backend exists: sessions, messages, usage tracking, RLS
- **Feature freeze** — full backend exists: remote config, caching, dev override
- **Product search deals** — Edge Function exists
- **Secondhand search** — Edge Function exists
- **Sneaker enrichment** — multiple provider backends exist

### Adapter needed
- **Scan result → V2 card** — `ScanResultV2` component already has `mapLegacyToV2()` adapter; backend returns consistent shape
- **SavedScan.products → Product[]** — already fixed in frontend readiness pass V1
- **Dressing room item → ProductShelf** — `ProductShelf` already accepts `Product[]` and can add to room via `services/styleObjects.ts`
- **Inspiration item → Dressing Room item** — `uploadAndSaveInspirationToDressingRoom` already exists in `services/styleObjects.ts`
- **Scan image → Dressing Room item** — `addScanImageToDressingRoom` already exists in `services/styleObjects.ts`

### Contract mismatch
- **TextScan** — no backend analysis endpoint; demo data only. Contract mismatch: frontend expects AI analysis but backend only has scan analysis (camera/upload), not text analysis
- **Library scan persistence** — `useLibrary` uses `services/library.js` which writes to local `FileSystem`. No Supabase table for `saved_scan` metadata exists. Contract mismatch: frontend shows saved scans but backend has no sync table.

### Local-only
- **Library scans** — `services/library.js` writes to `expo-file-system` local directory. No cloud sync.
- **StyleChat handoff context** — `services/style-chat/styleChatHandoffContext.ts` is in-memory only (no network).

### Placeholder-only
- **TextScan processing** — `setTimeout` simulation in `app/text-scan/index.tsx` line ~processing state. No real AI call.
- **TextScan results** — `TEXTSCAN_DEMO_RESULTS_ENABLED` gates demo data (`TEXTSCAN_DEMO_ATTRIBUTES`, `TEXTSCAN_DEMO_PRODUCTS`, `TEXTSCAN_DEMO_SUGGESTIONS`). No real backend.
- **Onboarding permissions** — camera/photos/notification toggles are visual-only in `app/onboarding/index.tsx` step 5. Not wired to device permissions.

### Blocked by RLS/storage verification
- **Legal acceptance** — migration exists but not applied to staging/production. RLS policies are designed but not verified live.
- **Inspiration uploads** — `style-library-images` bucket RLS policies exist in migration but not verified live.

### Blocked by StyleChat health
- **StyleChat context injection** — `RoomItemDetailModal` has "Ask StyleChat" button that calls `setStyleChatHandoffContext()`. But `EdgeStyleChatProvider` may have health issues if `GEMINI_API_KEY` is not configured or `STYLECHAT_AI_ENABLED` is false. The Edge Function `stylechat-generate` has extensive retry logic, but the prompt says "Do not repair StyleChat in this task."
- **StyleChat memory** — `buildStyleMemorySummary()` reads from `style_memory_events`, `dressing_room_items`, `dressing_room_item_reactions`. If the Edge Function fails, the memory context is still built but never sent.

### Missing backend
- **TextScan backend analysis** — no `POST /api/analyze` equivalent for text queries. The existing `/api/analyze` accepts `image: base64` only. No text-to-analysis endpoint.
- **Library scan cloud sync** — no `saved_scans` or `scan_assets` table in Supabase. Local-only persistence.
- **Policy version management** — onboarding uses placeholder `'1.0'` for terms/privacy/age versions. No backend table or RPC to manage policy versions.
- **App version metadata** — no `expo-constants` usage in the project. `app_version` in `legal_acceptances` is passed as `null`.

### Deferred intentionally
- **Product matching rebuild** — server.js has weighted heuristic matching against `catalog.json`. Working. No rebuild needed.
- **Checkout/purchase** — no checkout backend exists and none is required for this snapshot.
- **Apple OAuth** — exists in `app/auth/index.tsx` via `expo-apple-authentication`. Working.
- **Native PII masking** — `privacyImageSanitizer.js` is a passthrough stub. Deferred.

---

## 5. Backend Capability Inventory

| Capability | Existing File/Function | Backend Asset | Current Status | V2 Surface It Can Power | Risk |
|------------|----------------------|---------------|----------------|------------------------|------|
| **Legal acceptance** | `services/legalAcceptance.ts` `recordLegalAcceptances()` | `public.legal_acceptances` table + RLS | Static implemented, not verified live | Onboarding step 4 | Low — simple upsert, idempotent |
| **Scan analysis** | `services/api.js` `analyzeImage(base64)` | `POST /api/analyze` (server.js or `app/api/analyze+api.js`) | Working | Scan result V2, `useKScan` | Low — proven path |
| **Upload inspiration** | `services/styleObjects.ts` `uploadAndSaveInspiration()` | `public.inspiration_items` + `style-library-images` storage | Working | Library V2, Dressing Room item add | Low — storage RLS designed |
| **Library save/list** | `services/library.js` `saveScan()` / `loadLibrary()` | Local `expo-file-system` | Local-only | Library V2 | Medium — no cloud sync |
| **Dressing Rooms CRUD** | `services/styleObjects.ts` `listDressingRooms()` / `createDressingRoom()` / `updateDressingRoom()` / `deleteDressingRoom()` | `public.dressing_rooms` + `dressing_room_items` + RLS | Working | Dressing Rooms V2, Room detail | Low — full CRUD verified |
| **Dressing Room item add/remove** | `services/styleObjects.ts` `addProductToDressingRoom()` / `addScanImageToDressingRoom()` / `removeDressingRoomItem()` | `public.dressing_room_items` + storage | Working | Room detail, Scan result, Library | Low — existing paths |
| **Inspiration upload/storage** | `services/styleObjects.ts` `uploadAndSaveInspirationToDressingRoom()` / `listDressingRoomInspirationItems()` | `public.inspiration_items` + `public.dressing_room_inspiration_items` + `style-library-images` | Working | Dressing Room detail | Low — storage RLS designed |
| **Product add-to-room** | `components/ProductShelf.tsx` `AddToRoomModal` + `services/styleObjects.ts` `addProductToDressingRoom()` | `public.dressing_room_items` | Working | Scan result, ProductShelf | Low — existing adapter |
| **Privacy settings** | `services/supabasePrivacy.js` `updatePrivacySettings()` / `ensurePrivacySettings()` | `public.privacy_settings` + `profiles` + RLS | Working | Privacy screen | Low — mature merge logic |
| **Account deletion** | `services/accountDeletion.js` `submitAccountDeletionRequest()` | `handle-user-deletion` Edge Function + `public.deletion_requests` | Working | Privacy screen | Low — service_role server-side only |
| **Data export** | `services/supabasePrivacy.js` `requestDataExport()` | `privacy-data-export` Edge Function + `public.privacy_export_requests` | Working | Privacy screen | Low — service_role server-side only |
| **Data correction** | `services/supabasePrivacy.js` `requestCorrection()` | `privacy-correction-request` Edge Function + `public.privacy_correction_requests` | Working | Privacy screen | Low — service_role server-side only |
| **StyleChat sessions/messages** | `services/style-chat/styleChatRepository.ts` `listStyleChatSessions()` / `saveStyleChatMessage()` | `public.style_chat_sessions` + `public.style_chat_messages` + RLS | Working | StyleChat list, StyleChat detail | Low — RLS verified in tests |
| **StyleChat generation** | `services/style-chat/providers/edgeStyleChatProvider.ts` `EdgeStyleChatProvider.generateReply()` | `stylechat-generate` Edge Function + Gemini API | Conditional — depends on env | StyleChat detail | Medium — env-dependent, kill switch exists |
| **StyleChat usage/quota** | `services/style-chat/styleChatRepository.ts` `readStyleChatDailyUsage()` | `public.style_chat_usage` + `increment_style_chat_usage()` RPC | Working | StyleChat detail | Low — atomic increment |
| **StyleChat memory** | `services/style-chat/buildStyleMemorySummary.ts` `buildStyleMemorySummary()` | `public.style_memory_events` + `dressing_room_items` + `dressing_room_item_reactions` | Working | StyleChat context injection | Medium — depends on StyleChat generation health |
| **Public room preview** | `app/(public)/rooms/[token].tsx` `fetch` + `services/styleObjects.ts` `getItemReactionCounts()` | `get_public_room_preview` RPC + `public.room_shares` | Working | Public room preview | Low — public-safe RPC |
| **Feature freeze** | `services/featureFreeze.ts` `loadFeatureFreezeConfig()` | `public.app_config` + `AsyncStorage` cache | Working | All V2 surfaces | Low — remote config |
| **Product search deals** | `services/productSearchDeals.ts` `searchProductDeals()` | `product-search-deals` Edge Function + RapidAPI | Working | Scan result, ProductShelf | Low — external API |
| **Secondhand search** | `services/secondhand.js` `searchVintedSecondhand()` | `search-vinted-secondhand` Edge Function + Apify | Working | Scan result | Low — external API |
| **Sneaker enrichment** | `services/sneakers/index.ts` `searchSneakers()` | Multiple providers (Hosea, KicksCrew, SneakerDatabase, SneaksApi) | Working | Scan result | Low — external APIs |
| **Try-on clothes** | `services/tryOnClothesPro.ts` `requestTryOn()` | `tryon-clothes-pro` Edge Function + RapidAPI | Working | Outfit Remix (deferred) | Low — external API |
| **Nike shoe details** | `services/nikeShoeDetails.ts` `fetchNikeShoeDetails()` | `nike-shoe-details` Edge Function + RapidAPI | Working | Scan result (sneaker) | Low — external API, noted as 404 on tested URLs |
| **Room messages** | `services/roomMessages.ts` `listRoomMessages()` / `sendRoomMessage()` | `public.dressing_room_messages` + RLS | Working | Dressing Room detail | Low — RLS designed |
| **Item reactions** | `services/styleObjects.ts` `getItemReactionCounts()` / `setItemReaction()` / `removeItemReaction()` | `public.dressing_room_item_reactions` + `get_item_reaction_counts` RPC | Working | Dressing Room detail, Public room preview | Low — RLS verified in tests |
| **Look creation** | `services/styleObjects.ts` `createLookFromDressingRoomItems()` | `create_look_from_dressing_room_items` RPC | Working | Dressing Room detail | Low — SECURITY DEFINER RPC |
| **Room sharing** | `services/styleObjects.ts` `createOrGetRoomShare()` / `revokeRoomShare()` | `create_or_get_room_share` RPC / `revoke_room_share` RPC | Working | Dressing Room detail | Low — SECURITY DEFINER RPC |
| **Auth (email)** | `contexts/AuthSessionContext.tsx` `signIn()` / `signUp()` | `supabase.auth.signInWithPassword()` / `supabase.auth.signUp()` | Working | Auth, Onboarding | Low — standard Supabase Auth |
| **Auth (Google)** | `app/auth/index.tsx` | `supabase.auth.signInWithOAuth()` | Working | Auth, Onboarding | Low — standard Supabase Auth |
| **Auth (Apple)** | `app/auth/index.tsx` | `supabase.auth.signInWithIdToken()` | Working | Auth, Onboarding | Low — standard Supabase Auth |
| **Routing guard** | `services/routingGuard.js` `getRoutingGuardState()` | `public.profiles` + `public.deletion_requests` | Working | All routes | Low — client-side only |
| **Password reset** | `services/passwordReset.js` `verifySessionAfterPasswordUpdate()` | `supabase.auth.getUser()` | Working | Auth | Low — standard Supabase Auth |

---

## 6. V2 Frontend Surface Wiring Map

| V2 Surface | Current Placeholder / Need | Existing Backend Source | Adapter Needed | Status | Notes |
|------------|---------------------------|----------------------|----------------|--------|-------|
| **Home V2 recent activity** | `app/index.tsx` renders `HomeV2` or `HomeLegacy` from `components/home` | No direct backend call in route; components may load data | Unknown — inspect `components/home` | Evidence incomplete | `HOME_NAVIGATION_V2_ENABLED` env flag toggles V2 |
| **Scan result screen** | `components/scan-results/ScanResultV2.tsx` renders `ScanResultHero`, `StyleMatchPanel`, `StyleAnalysisSection`, `SimilarFindsShelf`, `PurchaseOptionsPanel` | `services/api.js` `analyzeImage()` returns `{ type, result, metadata, products }` | `mapLegacyToV2()` already exists | Ready to wire | `ScanResultV2` already has adapter. `SCAN_RESULTS_V2_UI_ENABLED` env flag. |
| **Upload inspiration** | `app/library.tsx` has `InspirationUploadModal` + `ImagePicker` | `services/styleObjects.ts` `uploadAndSaveInspiration()` | None — direct call | Ready to wire | Already working in Library V2 |
| **TextScan result screen** | `app/text-scan/index.tsx` has `TEXTSCAN_DEMO_ATTRIBUTES`, `TEXTSCAN_DEMO_PRODUCTS`, `TEXTSCAN_DEMO_SUGGESTIONS` | No backend source for text analysis | New backend required | Missing backend | No `POST /api/analyze` for text. Only image base64. |
| **Library V2** | `app/library.tsx` uses `useLibrary` + `listInspirationItems()` + `deleteInspirationItem()` | `services/library.js` (local) + `services/styleObjects.ts` (cloud) | Mixed: local scans + cloud inspiration | Partially ready | Local scans have no cloud sync. Inspiration uploads are cloud-backed. |
| **Dressing Rooms V2** | `app/dressing-rooms/index.tsx` uses `useDressingRooms` + `createDressingRoom()` | `services/styleObjects.ts` `listDressingRooms()` / `createDressingRoom()` | None | Ready to wire | Full CRUD working |
| **Dressing Room detail** | `app/dressing-rooms/[id].tsx` — 20+ service calls | `services/styleObjects.ts` + `services/roomMessages.ts` | None | Ready to wire | Heavy CRUD: edit, delete, share, items, reactions, messages, looks, inspiration |
| **Add scan/upload/product to room** | `components/ProductShelf.tsx` has `AddToRoomModal` | `services/styleObjects.ts` `addProductToDressingRoom()` | None | Ready to wire | Already working |
| **Privacy screen** | `app/privacy.tsx` uses `usePrivacyPreferences` + `requestDeletion()` + `requestDataExport()` + `requestCorrection()` | `services/supabasePrivacy.js` + `services/accountDeletion.js` | None | Ready to wire | Full privacy management working |
| **Onboarding legal** | `app/onboarding/index.tsx` step 4 calls `recordLegalAcceptances()` | `services/legalAcceptance.ts` | None | Ready to wire | KS-BND-001 implemented |
| **StyleChat entry/context handoff** | `app/style-chat/index.tsx` lists sessions; `app/style-chat/[sessionId].tsx` chats; `RoomItemDetailModal` has "Ask StyleChat" | `services/style-chat/styleChatRepository.ts` + `EdgeStyleChatProvider` | `setStyleChatHandoffContext()` (in-memory) | Conditional | Sessions/messages work. Generation depends on env. Context injection is in-memory only. |
| **Public room preview** | `app/(public)/rooms/[token].tsx` fetches `https://www.kscan.app/api/rooms/{token}` | `get_public_room_preview` RPC + `public.room_shares` | None | Ready to wire | Public API fetch already working |
| **Looks V2** | `app/looks/index.tsx` uses `useLooks`; `app/looks/[id].tsx` uses `getLookDetail()` | `services/styleObjects.ts` | None | Ready to wire | Full CRUD working |

---

## 7. Adapter / Mapper Opportunities

| Frontend Need | Existing Backend Shape | Required Adapter | Files Likely Touched | Risk |
|---------------|----------------------|------------------|---------------------|------|
| **Scan result → V2 card** | `services/api.js` returns `{ type, result, metadata, products, secondhand, sneakerReference }` | `mapLegacyToV2()` in `components/scan-results/ScanResultV2.tsx` | `components/scan-results/ScanResultV2.tsx` | Low — already implemented |
| **SavedScan.products → Product[]** | `types/scan.ts` `Product` vs `SavedScan.products` | Import `Product` from `ProductShelf` | `app/library.tsx` | Low — already fixed in V1 readiness |
| **Product add-to-room → Dressing Room item** | `Product` has `id, title, name, retailer, price, imageUrl, productUrl` | `buildProductMatchSnapshot()` in `services/styleObjects.ts` | `services/styleObjects.ts`, `components/ProductShelf.tsx` | Low — already implemented |
| **Scan image → Dressing Room item** | `scanImageUri` (local) + `analysis` (AI result) | `addScanImageToDressingRoom()` in `services/styleObjects.ts` | `services/styleObjects.ts`, `app/scan/results/` | Low — already implemented |
| **Inspiration upload → Dressing Room item** | `InspirationItem` has `storageBucket, storagePath, imageUrl` | `uploadAndSaveInspirationToDressingRoom()` in `services/styleObjects.ts` | `services/styleObjects.ts`, `app/dressing-rooms/[id].tsx` | Low — already implemented |
| **Room preview → Public API** | `get_public_room_preview` RPC returns `{ token, title, note, itemCount, sharedAt, coverImageUrl, items[] }` | Direct fetch in `app/(public)/rooms/[token].tsx` | `app/(public)/rooms/[token].tsx` | Low — already implemented |
| **StyleChat handoff → Context** | `StyleChatHandoffContext` has `imageUri, query, category, color, silhouette, material, descriptors, analysisText` | `setStyleChatHandoffContext()` in `services/style-chat/styleChatHandoffContext.ts` | `services/style-chat/styleChatHandoffContext.ts`, `app/style-chat/[sessionId].tsx` | Medium — in-memory only, no persistence |
| **Privacy local → Remote** | `services/privacyLocalStore.js` has `{ opt_out_of_sale, limit_sensitive_processing }` | `mergePrivacyPreferences()` in `services/privacyPolicy.js` | `services/privacyPolicy.js`, `contexts/PrivacyPreferencesContext.tsx` | Low — already implemented |

---

## 8. True Backend Gaps

| Gap | Evidence | Frontend Surface Blocked | Required Backend Work | Priority |
|-----|----------|------------------------|----------------------|----------|
| **TextScan backend analysis** | `app/text-scan/index.tsx` line ~182: `if (!TEXTSCAN_DEMO_RESULTS_ENABLED) { ... }` — no real API call. `services/api.js` only has `analyzeImage(base64)` which accepts image, not text. | TextScan result screen | New endpoint: `POST /api/analyze-text` or extend `analyzeImage` to accept text query | Medium |
| **Library scan cloud sync** | `services/library.js` uses `expo-file-system` local directory. No `saved_scans` or `scan_assets` table in Supabase migrations. | Library V2, Home V2 recent activity | Create `public.saved_scans` table + RLS + storage policies for scan images | Medium |
| **StyleChat generation health** | `services/style-chat/providers/edgeStyleChatProvider.ts` calls `supabase.functions.invoke('stylechat-generate')`. Edge Function has `STYLECHAT_AI_ENABLED` kill switch. `GEMINI_API_KEY` may not be configured. | StyleChat detail, StyleChat context injection | Verify env config + Edge Function deployment. Not a backend gap but a deployment/health gap. | Medium |
| **Policy version management** | `app/onboarding/index.tsx` uses `const [termsVersion] = useState<string | null>(null)` with fallback `'1.0'` in `handleAcceptAndContinue`. No backend table for policy versions. | Onboarding legal acceptance | Create `public.policy_versions` table or use app config for version tracking | Low |
| **App version metadata** | No `expo-constants` import in project. `app_version` passed as `null` to `recordLegalAcceptances`. | Legal acceptance audit trail | Add `expo-constants` import + pass `Constants.expoConfig?.version` | Low |
| **Generated Supabase types** | No `database.types.ts` or `types/supabase.ts` exists in project. | Type safety across all services | Run `supabase gen types typescript` after migrations applied | Low |
| **Scan persistence table** | No table for storing scan metadata (result, products, attributes) beyond local file system. | Scan result history, Home V2 recent activity | Create `public.scans` or `public.scan_results` table + RLS | Medium |
| **Image retention policy** | No explicit retention policy documented in migrations. `style-library-images` bucket has no retention rules. | Storage cost, privacy compliance | Document retention: raw scan 24h, saved scan 30d, inspiration indefinite | Low |

---

## 9. Legal Acceptance Follow-up

| Item | Status |
|------|--------|
| **Migration exists** | ✅ `supabase/migrations/20260617000001_create_legal_acceptances.sql` |
| **Service exists** | ✅ `services/legalAcceptance.ts` |
| **Onboarding wired** | ✅ `app/onboarding/index.tsx` calls `recordLegalAcceptances()` in `handleAcceptAndContinue` |
| **Tests exist** | ✅ `__tests__/legalAcceptance.test.js` (15 tests, all passing) |
| **Staging migration verified** | ❌ Not yet — Supabase CLI unavailable, static SQL only |
| **Generated types updated** | ❌ No `database.types.ts` exists; types not generated |
| **Policy version management** | ❌ Placeholder `'1.0'` used; no version management system |
| **App version management** | ❌ `app_version` passed as `null`; no `expo-constants` usage |
| **Production deploy readiness** | ⚠️ Blocked until staging migration verified |

**Overall:** Static implemented. Dashboard/staging verification required before production migration.

---

## 10. StyleChat Health Hold

### Current StyleChat Files
- `services/style-chat/types.ts` — type contracts
- `services/style-chat/providers/edgeStyleChatProvider.ts` — Edge Function proxy
- `services/style-chat/styleChatRepository.ts` — Supabase CRUD for sessions/messages/usage
- `services/style-chat/styleMemoryRepository.ts` — memory event read/write
- `services/style-chat/buildStyleMemorySummary.ts` — context assembly
- `services/style-chat/styleChatHandoffContext.ts` — in-memory handoff
- `services/style-chat/styleMemoryCache.ts` — in-memory cache
- `services/style-chat/MockStyleChatProvider.ts` — mock for testing
- `app/style-chat/index.tsx` — session list
- `app/style-chat/[sessionId].tsx` — session detail/chat
- `components/style-chat/StyleChatBubble.tsx` — message bubble
- `components/style-chat/StyleChatInput.tsx` — input field
- `supabase/functions/stylechat-generate/index.ts` — Edge Function (Gemini proxy)

### Current Backend Function/Provider
- `EdgeStyleChatProvider` calls `supabase.functions.invoke('stylechat-generate', { body: { sessionId, message }, signal })`
- Edge Function validates JWT, checks daily quota (`increment_stylechat_daily_usage`), checks burst limit (`check_and_increment_stylechat_burst`), assembles context (style memory + last 6 messages), calls Gemini, returns `{ status, message, usage }`

### Current Known Failure Evidence
- `GEMINI_API_KEY` may not be configured in environment (evidence: `__tests__/*.js` test runner shows `has GEMINI_API_KEY: false` in startup config)
- `STYLECHAT_AI_ENABLED` kill switch exists — if false, Edge Function returns early error
- Edge Function has extensive retry logic but depends on external Gemini API availability
- `app/api/style-chat/session+api.ts` and `app/api/style-chat/message+api.ts` are **deprecated** — not called by mobile app

### StyleChat UI Accessibility
- **Yes, UI remains accessible** — session list and message history load from Supabase tables regardless of generation health. Users can view past conversations.
- Sending new messages requires the Edge Function to work.

### StyleChat Context Injection Deferral
- **Should remain deferred** until StyleChat generation health is confirmed. The `RoomItemDetailModal` "Ask StyleChat" button sets in-memory handoff context, but the actual generation is blocked by Edge Function health.
- **Minimum future repair ticket:** "Verify StyleChat Edge Function deployment: check `GEMINI_API_KEY` env, test `stylechat-generate` endpoint, verify daily/burst quota RPCs, confirm memory context assembly."

### Classification
**StyleChat usable enough for context injection later** — sessions/messages/usage CRUD work. Generation is the conditional piece. Do not block other wiring on StyleChat health.

---

## 11. Implementation Priority Recommendation

### 1. Staging Verification for Legal Acceptance (KS-BND-001 follow-up)
**Title:** Apply `legal_acceptances` migration to staging and verify RLS
**Objective:** Validate the KS-BND-001 migration works in a real Supabase environment
**Existing backend used:** `20260617000001_create_legal_acceptances.sql`
**Files likely touched:** None (dashboard/CLI operation only)
**Frontend surface unblocked:** Onboarding legal acceptance
**RLS/storage impact:** None new — validates existing migration
**Validation required:** `SELECT`/`INSERT` with authenticated user, anon rejection
**Risk:** Low — static SQL reviewed, no new code changes

### 2. Backend-to-V2 Adapter Wiring for Existing Working Services
**Title:** Wire existing backend services into V2 frontend surfaces
**Objective:** Connect proven backend paths to V2 UI without new schema
**Existing backend used:** `services/styleObjects.ts`, `services/style-chat/styleChatRepository.ts`, `services/api.js`, `services/roomMessages.ts`
**Files likely touched:** `components/scan-results/ScanResultV2.tsx`, `components/home/`, `app/index.tsx`, `app/library.tsx`
**Frontend surface unblocked:** Home V2 recent activity, Scan result V2, Library V2, Dressing Room V2
**Adapter pattern:** `mapLegacyToV2()`, direct service calls, minor prop changes
**RLS/storage impact:** None — uses existing RLS
**Validation required:** Smoke tests on each V2 surface
**Risk:** Low — all backend services are proven

### 3. Library Scan Cloud Sync (if prioritized)
**Title:** Add cloud persistence for saved scans
**Objective:** Move `services/library.js` local-only storage to Supabase table + storage
**Existing backend used:** `style-library-images` bucket (already exists)
**Files likely touched:** New `services/scanPersistence.ts`, `supabase/migrations/YYYYMMDD_saved_scans.sql`, `app/library.tsx`
**Frontend surface unblocked:** Library V2, Home V2 recent activity, multi-device sync
**RLS/storage impact:** New table `public.saved_scans` + RLS + storage policies
**Validation required:** Upload, list, delete, signed URL display
**Risk:** Medium — new table, storage paths, RLS design required

### 4. TextScan Backend
**Title:** Add text query analysis endpoint
**Objective:** Enable real TextScan analysis by adding a text-input path to the AI pipeline
**Existing backend used:** `server.js` analysis pipeline (can be extended), `app/api/analyze+api.js`
**Files likely touched:** `server.js` (new route), `app/api/analyze+api.js` (new handler), `services/api.js` (new function), `app/text-scan/index.tsx`
**Frontend surface unblocked:** TextScan result screen
**RLS/storage impact:** None — server-side change
**Validation required:** End-to-end text query → analysis result → display
**Risk:** Medium — new API contract, prompt engineering for text vs image

### 5. StyleChat Generation Repair + Context Injection
**Title:** Verify and repair StyleChat generation pipeline
**Objective:** Ensure StyleChat Edge Function works, then wire context injection
**Existing backend used:** `supabase/functions/stylechat-generate/index.ts`, `services/style-chat/providers/edgeStyleChatProvider.ts`
**Files likely touched:** `supabase/functions/stylechat-generate/index.ts` (env/debug), `services/style-chat/providers/edgeStyleChatProvider.ts`, `app/style-chat/[sessionId].tsx`
**Frontend surface unblocked:** StyleChat detail, context injection from scan/room items
**RLS/storage impact:** None — env/deployment fix
**Validation required:** Edge Function health check, message generation, memory context, quota enforcement
**Risk:** Medium — external dependency (Gemini API), env configuration

---

## 12. No-Rebuild Systems

| System | Existing Evidence | Why Not Rebuild | Safe Next Step |
|--------|-------------------|-----------------|----------------|
| **Dressing Rooms** | `services/styleObjects.ts` has 20+ functions. `public.dressing_rooms`, `dressing_room_items`, `dressing_room_inspiration_items`, `dressing_room_messages`, `dressing_room_item_reactions` all exist with RLS. Full CRUD working. | Rebuilding would destroy proven RLS, RPCs, storage policies, and room share logic. | Wire V2 UI to existing service calls. |
| **Privacy settings** | `services/supabasePrivacy.js` + `services/privacyPolicy.js` + `contexts/PrivacyPreferencesContext.tsx` have mature local↔remote merge, minor enforcement, sync status. `public.privacy_settings` has triggers for defaults. | Rebuilding would destroy proven merge logic and minor-user safety. | No changes needed. |
| **Account deletion** | `services/accountDeletion.js` + `handle-user-deletion` Edge Function + `public.deletion_requests` with status tracking. | Rebuilding would risk data loss and compliance failure. | No changes needed. |
| **Inspiration upload** | `services/styleObjects.ts` `uploadAndSaveInspiration()` + `public.inspiration_items` + `style-library-images` bucket with RLS. | Rebuilding would break existing upload flow and storage paths. | Wire to V2 surfaces directly. |
| **Product add-to-room** | `components/ProductShelf.tsx` + `services/styleObjects.ts` `addProductToDressingRoom()` already work. | Rebuilding would break existing ProductShelf integration. | No changes needed. |
| **Legal acceptance** | `services/legalAcceptance.ts` + `public.legal_acceptances` + onboarding wiring. | Rebuilding would be redundant — KS-BND-001 is fresh. | Apply migration to staging, verify, then deploy. |
| **Public room preview** | `get_public_room_preview` RPC + `public.room_shares` + `app/(public)/rooms/[token].tsx` fetch. | Rebuilding would break public URL sharing. | No changes needed. |
| **Auth (all providers)** | `contexts/AuthSessionContext.tsx` + `app/auth/index.tsx` + `services/authDeepLink.js` + `services/authValidation.js`. | Rebuilding would break OAuth flows and deep-link handling. | No changes needed. |
| **Feature freeze** | `services/featureFreeze.ts` + `public.app_config` + `contexts/FeatureFreezeContext.tsx`. | Rebuilding would lose remote feature gating. | No changes needed. |
| **Catalog/product matching** | `server.js` has weighted heuristic matching against `catalog.json`. | Rebuilding would require retraining the matching engine. | No changes needed — server-side only. |
| **StyleChat sessions/messages** | `services/style-chat/styleChatRepository.ts` + `public.style_chat_sessions` + `public.style_chat_messages`. | Rebuilding would lose conversation history. | No changes needed. |
| **Room messages** | `services/roomMessages.ts` + `public.dressing_room_messages`. | Rebuilding would lose message history. | No changes needed. |
| **Looks** | `services/styleObjects.ts` + `public.looks` + `public.look_items` + `create_look_from_dressing_room_items` RPC. | Rebuilding would break look creation from rooms. | No changes needed. |
| **Item reactions** | `services/styleObjects.ts` + `public.dressing_room_item_reactions` + `get_item_reaction_counts` RPC. | Rebuilding would lose reaction data. | No changes needed. |
| **Usage/quota tracking** | `public.style_chat_usage`, `public.style_chat_daily_usage`, `public.style_chat_burst_usage` + RPCs. | Rebuilding would lose quota enforcement. | No changes needed. |
| **Style memory** | `public.style_memory_events` + `upsert_style_memory_event` RPC + `buildStyleMemorySummary()`. | Rebuilding would lose user preference learning. | No changes needed. |

---

## 13. Validation

### `git diff --check`
✅ Passed — no code changes, only new report file.

### `git diff --stat`
```
qa/backend-v2-wiring-snapshot-2026-06.md | 500+ lines
```

### `git diff --name-only`
```
qa/backend-v2-wiring-snapshot-2026-06.md
```

### `git status --short`
```
?? qa/backend-v2-wiring-snapshot-2026-06.md
```

### Optional TypeScript/tests
Not run — documentation-only snapshot. No code changes.

### Known baseline failures
Not applicable — no code changes, no new tests.

---

## 14. Final Recommendation

### Proceed to wiring: **Yes** — for existing backend surfaces

**First implementation prompt:** `KS-BND-002 — Backend-to-V2 Adapter Wiring`
- Wire existing `services/styleObjects.ts` into V2 Dressing Room/Looks surfaces
- Wire existing `services/style-chat/styleChatRepository.ts` into V2 StyleChat surfaces
- Wire existing `services/api.js` into V2 Scan Result surfaces
- Verify `components/scan-results/ScanResultV2.tsx` adapter completeness
- Add `expo-constants` for `app_version` in legal acceptance

**Second implementation prompt:** `KS-BND-003 — Library Scan Cloud Persistence`
- Create `public.saved_scans` table + RLS + storage policies
- Migrate `services/library.js` from local-only to hybrid (local + cloud)
- Enable Home V2 recent activity feed

**Third implementation prompt:** `KS-BND-004 — TextScan Backend`
- Extend `server.js` / `app/api/analyze+api.js` to accept text queries
- Add `services/api.js` `analyzeText(query)` function
- Wire `app/text-scan/index.tsx` to real backend instead of demo data

**Deferred:**
- StyleChat generation repair (separate ticket after env verification)
- Policy version management (low priority)
- Generated Supabase types (follow-up after all migrations applied)
- Image retention policy (documentation task)
- Checkout/purchase (no backend exists, not required)
- Native PII masking (stub exists, deferred)
- Apple OAuth (already working, no changes needed)
- Product matching rebuild (server.js works, no changes needed)

### Blockers
- **StyleChat generation health** — verify `GEMINI_API_KEY` and `STYLECHAT_AI_ENABLED` before investing in context injection
- **Legal acceptance staging migration** — apply `20260617000001_create_legal_acceptances.sql` to staging before production deploy
- **TextScan backend** — no analysis path exists for text queries; this is a true gap

### Follow-ups
1. Apply KS-BND-001 migration to staging and verify RLS
2. Run `supabase gen types typescript` after all migrations applied to staging
3. Verify `stylechat-generate` Edge Function deployment and env config
4. Document image retention policy for `style-library-images` bucket
5. Add `expo-constants` dependency for `app_version` metadata
6. Review `components/home/` for Home V2 backend wiring needs (evidence incomplete in this snapshot)

---

## Appendix A: Cross-Surface Data Flow Map

### Flow: Camera Scan → Analysis Result → Save to Library → Add to Dressing Room → StyleChat Context

| Step | Source File | Data Format | Backend Call | Image Reference | State Management | Flow Status | Adapter Needed |
|------|------------|-------------|-------------|----------------|------------------|-------------|---------------|
| 1. Capture | `components/scan-room/LiveScanCamera.tsx` | JPEG URI from `expo-camera` | None (local) | `photo.uri` | Local state | ✅ Working | None |
| 2. Compress | `services/imageUtils.js` `compressForUpload()` | Base64 JPEG | None | `data:image/jpeg;base64,...` | In-memory | ✅ Working | None |
| 3. Sanitize | `services/privacyImageSanitizer.js` `sanitizeImageBeforeUpload()` | Passthrough (stub) | None | Same base64 | In-memory | ⚠️ Stub — no real face blur | Deferred |
| 4. Analyze | `services/api.js` `analyzeImage(base64)` | Base64 POST | `POST /api/analyze` → `server.js` or `app/api/analyze+api.js` → Gemini/OpenRouter | Base64 in request body | `useKScan` hook | ✅ Working | None |
| 5. Result | `hooks/useKScan.js` | `{ type, result, metadata, products, secondhand, sneakerReference }` | Response from server | `products[].imageUrl` (HTTPS) | `useKScan` state | ✅ Working | `mapLegacyToV2()` in `ScanResultV2` |
| 6. Save to Library | `services/library.js` `saveScan()` | `SavedScan` object | Local `FileSystem.writeAsStringAsync()` + `ImageManipulator` | `imageUri` (local file), `thumbnailUri` (local) | `useLibrary` hook | ⚠️ Local-only — no cloud sync | **Gap: needs cloud sync** |
| 7. Add to Dressing Room | `services/styleObjects.ts` `addScanImageToDressingRoom()` | `ScanImageSnapshotSource` | `supabase.from('dressing_room_items').insert()` + `supabase.storage.upload()` | `storage_path` in `style-library-images` bucket | `app/dressing-rooms/[id].tsx` state | ✅ Working | None |
| 8. Add Product to Room | `services/styleObjects.ts` `addProductToDressingRoom()` | `ProductMatchSnapshotSource` | `supabase.from('dressing_room_items').insert()` | `imageUrl` (HTTPS from catalog) | `components/ProductShelf.tsx` | ✅ Working | `buildProductMatchSnapshot()` |
| 9. Add Inspiration to Room | `services/styleObjects.ts` `uploadAndSaveInspirationToDressingRoom()` | `InspirationItem` | `supabase.storage.upload()` + `supabase.from('inspiration_items').insert()` + `supabase.from('dressing_room_inspiration_items').insert()` | `storage_path` in `style-library-images` | `app/dressing-rooms/[id].tsx` | ✅ Working | None |
| 10. Ask StyleChat (from item) | `components/dressing-rooms/RoomItemDetailModal.tsx` | `StyleChatHandoffContext` | None (in-memory) | `item.imageUrl` | `services/style-chat/styleChatHandoffContext.ts` | ⚠️ In-memory only — no persistence | **Gap: needs persistence or verification** |
| 11. StyleChat generation | `services/style-chat/providers/edgeStyleChatProvider.ts` | `{ sessionId, message }` | `supabase.functions.invoke('stylechat-generate')` → Edge Function → Gemini | N/A (text only) | `hooks/useStyleChat.ts` | ⚠️ Conditional — depends on env | **Gap: needs env verification** |
| 12. StyleChat memory | `services/style-chat/buildStyleMemorySummary.ts` | `StyleMemorySummary` | `supabase.rpc('upsert_style_memory_event')` + reads from `style_memory_events`, `dressing_room_items`, `dressing_room_item_reactions` | N/A | In-memory cache + Supabase | ✅ Working | None |

### Flow: TextScan → Analysis → Result

| Step | Source File | Data Format | Backend Call | Status |
|------|------------|-------------|-------------|--------|
| 1. Input | `app/text-scan/index.tsx` | Text string | None | ✅ Working |
| 2. Processing | `app/text-scan/index.tsx` | `setTimeout` simulation | None | ❌ Placeholder |
| 3. Analysis | `app/text-scan/index.tsx` | `TEXTSCAN_DEMO_ATTRIBUTES` / `TEXTSCAN_DEMO_PRODUCTS` | None | ❌ No backend |
| 4. Result | `app/text-scan/index.tsx` | Demo data | None | ❌ No backend |
| 5. Handoff to StyleChat | `app/text-scan/index.tsx` | `setStyleChatHandoffContext()` | In-memory | ⚠️ Works but no real analysis |

---

## Appendix B: Type Safety Baseline

| Item | Status |
|------|--------|
| `database.types.ts` exists | ❌ No |
| `types/supabase.ts` exists | ❌ No |
| `legal_acceptances` included in generated types | ❌ N/A (no generated types) |
| Manual local types used | ✅ Yes — `services/legalAcceptance.ts`, `services/styleObjects.ts`, `services/style-chat/types.ts`, `types/styleObjects.ts`, `types/scan.ts` |
| Type drift risk | Medium — manual types may drift from actual schema as migrations accumulate |
| Generated types follow-up | Required after all migrations applied to staging/local |

---

## Appendix C: Feature Flag Wiring Map

| Flag | Surface | Backend Call Gated | Default | Safe To Enable | Risk |
|------|---------|-------------------|---------|---------------|------|
| `HOME_NAVIGATION_V2_ENABLED` | Home | No backend call gated | `false` (env-driven) | Yes — UI-only toggle | Low — just switches component |
| `TEXTSCAN_UI_ENABLED` | TextScan route | No backend call gated | `false` | Yes — UI entry point only | Low — no real backend |
| `TEXTSCAN_DEMO_RESULTS_ENABLED` | TextScan results | No backend call gated | `false` | Yes — demo data only | Low — no real backend |
| `TEXTSCAN_VOICE_PLACEHOLDER_ENABLED` | TextScan voice | No backend call gated | `false` | Yes — placeholder only | Low — non-interactive |
| `SCAN_RESULTS_V2_UI_ENABLED` | Scan results | No backend call gated | `false` | Yes — UI adapter exists | Low — `mapLegacyToV2()` ready |
| `SCAN_RESULTS_DEMO_UI_ENABLED` | Scan results demo | No backend call gated | `false` | Yes — demo data only | Low |
| `SCAN_ROOM_V2_UI_ENABLED` | Scan room | No backend call gated | `false` | Yes — UI-only | Low |
| `ONBOARDING_FRAMEWORK_V1_ENABLED` | Onboarding route | No backend call gated | `false` | Yes — redirects unauth users | Low — legal acceptance wired |
| `dressingRooms` (feature freeze) | Dressing Rooms | `useFeatureFreeze('dressingRooms')` gates UI | Remote config | Yes — backend exists | Low — remote kill switch |
| `shareRooms` (feature freeze) | Room sharing | `useFeatureFreeze('shareRooms')` gates UI | Remote config | Yes — backend exists | Low — remote kill switch |
| `outfitRemixLooks` (feature freeze) | Looks | `useFeatureFreeze('outfitRemixLooks')` gates UI | Remote config | Yes — backend exists | Low — remote kill switch |
| `styleChat` (feature freeze) | StyleChat | `useFeatureFreeze('styleChat')` gates UI | Remote config | Yes — backend exists | Medium — generation health |
| `textScan` (feature freeze) | TextScan | `useFeatureFreeze('textScan')` gates UI | Remote config | Yes — but no real backend | Medium — no analysis endpoint |
| `ENABLE_IN_APP_SHARED_ROOMS` | Public room preview | Hardcoded `true` | `true` | Yes — backend exists | Low — public API works |

**Note:** No feature flag/backend call mismatch found. All V2 surfaces that have backend calls use existing services regardless of flag state. Flags only gate UI affordance, not backend capability.

---

## Appendix D: Error / Loading / Empty-State Map

| Surface | Existing Backend Error Shape | V2 Expected Error Behavior | Loading State | Empty State | Retry Behavior | Adapter Needed |
|---------|------------------------------|---------------------------|---------------|-------------|---------------|-------------|
| **Scan result** | `services/api.js` throws on network/parse error | `InlineNotice` or `EmptyStateCard` with retry | `ActivityIndicator` in `ScanResultV2` | `EmptyStateCard` | Button retry | None — existing |
| **Library** | `useLibrary` local error; `listInspirationItems` Supabase error | `InlineNotice` + `EmptyStateCard` | `ActivityIndicator` | `EmptyStateCard` | Pull-to-refresh | None — existing |
| **Dressing Rooms** | `useDressingRooms` Supabase error | `InlineNotice` | `ActivityIndicator` | `EmptyStateCard` | Pull-to-refresh | None — existing |
| **Dressing Room detail** | 20+ service calls, each returns safe error | `InlineNotice` | `ActivityIndicator` | `EmptyState` | Pull-to-refresh | None — existing |
| **StyleChat** | `EdgeStyleChatProvider` returns `burst_limit`, `limit_reached`, `error` | `InlineNotice` with friendly error copy | `ActivityIndicator` in bubble | `EmptyState` | Retry per message | None — existing |
| **TextScan** | No backend — demo data only | N/A | `ActivityIndicator` (simulated) | `EmptyStateCard` | N/A | **Needs backend first** |
| **Privacy** | `services/supabasePrivacy.js` throws on network | `InlineNotice` | `ActivityIndicator` | N/A | Button retry | None — existing |
| **Onboarding legal** | `recordLegalAcceptances` returns `{ ok: false, error: 'Unable to save...' }` | Error banner below checkboxes | `PrimaryButton` loading spinner | N/A | Button retry | None — existing |
| **Public room preview** | `fetch` network error | `InlineNotice` + `EmptyStateCard` | `RefreshControl` | `EmptyStateCard` | Pull-to-refresh | None — existing |

---

## Appendix E: Image Pipeline Map

| Flow | Input Format | Processing | Storage Bucket/Path | Database Reference | Signed URL | Display Source | PII Masking | Retention |
|------|-------------|-----------|---------------------|-------------------|------------|----------------|-------------|-----------|
| **Camera scan** | JPEG (expo-camera) | `compressForUpload()` → base64 | None — sent inline in POST | None | N/A | Local URI (`photo.uri`) | Passthrough stub (`privacyImageSanitizer.js`) | Not documented |
| **Upload inspiration** | JPEG/PNG (image-picker) | `ImageManipulator` → upload | `style-library-images` / `users/{user_id}/{uuid}.jpg` | `public.inspiration_items` (`storage_bucket`, `storage_path`) | `createSignedUrl()` | Signed URL | Passthrough stub | Not documented |
| **Scan save to library** | JPEG (local file) | `ImageManipulator` thumbnail | Local `FileSystem` directory | `services/library.js` local JSON | N/A | Local URI | Passthrough stub | Local device only |
| **Dressing room item (scan)** | JPEG (from scan) | `ImageManipulator` → upload | `style-library-images` / `users/{user_id}/{uuid}.jpg` | `public.dressing_room_items` (`storage_bucket`, `storage_path`) | `createSignedUrl()` | Signed URL or `imageUrl` | Passthrough stub | Not documented |
| **Dressing room item (product)** | HTTPS URL (catalog) | None | None (external) | `public.dressing_room_items` (`image_url`) | N/A | Direct HTTPS | N/A | External |
| **Catalog products** | HTTPS URL | Sanitized in `server.js` | External or `CATALOG_IMAGE_BASE_URL` | None | N/A | Direct HTTPS | N/A | External |
| **Public room preview** | HTTPS URL or signed URL | None | `style-library-images` (if private) | `public.room_shares` + RPC | `createSignedUrl()` | Direct HTTPS or signed URL | N/A | Not documented |
| **Looks cover** | HTTPS URL or signed URL | None | `style-library-images` (if private) | `public.looks` (`cover_image_url`) | `createSignedUrl()` | Direct HTTPS or signed URL | N/A | Not documented |

**PII masking status:** `services/privacyImageSanitizer.js` is a passthrough stub — returns input unchanged. No real face detection or blur is applied. Deferred.

**Retention assumption:** Not explicitly documented in any migration or policy file. Recommended follow-up: define retention for `style-library-images` bucket (raw scan 24h, saved scan 30d, inspiration indefinite).

---

## Appendix F: Evidence-Backed File/Function Reference

Every capability claim in this report is backed by the following direct file evidence:

| Claim | Evidence File | Function/Line | Evidence |
|-------|--------------|-------------|----------|
| Legal acceptance migration | `supabase/migrations/20260617000001_create_legal_acceptances.sql` | Full file | Table, constraints, RLS, indexes, grants |
| Legal acceptance service | `services/legalAcceptance.ts` | `recordLegalAcceptances()` | Session-derived user_id, upsert with ignoreDuplicates |
| Onboarding wiring | `app/onboarding/index.tsx` | `handleAcceptAndContinue()` | Calls `recordLegalAcceptances()` before `goToNext()` |
| Scan analysis | `services/api.js` | `analyzeImage(base64)` | `POST /api/analyze` with base64 body |
| Scan result V2 adapter | `components/scan-results/ScanResultV2.tsx` | `mapLegacyToV2()` | Maps legacy analysis to V2 card shape |
| Dressing rooms CRUD | `services/styleObjects.ts` | `listDressingRooms()`, `createDressingRoom()`, `updateDressingRoom()`, `deleteDressingRoom()` | Supabase `.from('dressing_rooms')` calls |
| Dressing room items | `services/styleObjects.ts` | `addProductToDressingRoom()`, `addScanImageToDressingRoom()`, `removeDressingRoomItem()` | Supabase `.from('dressing_room_items')` calls |
| Inspiration uploads | `services/styleObjects.ts` | `uploadAndSaveInspiration()`, `uploadAndSaveInspirationToDressingRoom()` | Storage upload + DB insert |
| Looks CRUD | `services/styleObjects.ts` | `listLooks()`, `getLookDetail()`, `updateLook()`, `deleteLook()`, `createLookFromDressingRoomItems()` | Supabase `.from('looks')` + RPC |
| Room sharing | `services/styleObjects.ts` | `createOrGetRoomShare()`, `revokeRoomShare()` | `supabase.rpc('create_or_get_room_share')` |
| Public room preview | `app/(public)/rooms/[token].tsx` | `fetch()` | `GET https://www.kscan.app/api/rooms/{token}` |
| StyleChat sessions | `services/style-chat/styleChatRepository.ts` | `listStyleChatSessions()`, `createStyleChatSession()`, `deleteStyleChatSession()` | Supabase `.from('style_chat_sessions')` |
| StyleChat messages | `services/style-chat/styleChatRepository.ts` | `listStyleChatMessages()`, `saveStyleChatMessage()` | Supabase `.from('style_chat_messages')` |
| StyleChat generation | `services/style-chat/providers/edgeStyleChatProvider.ts` | `EdgeStyleChatProvider.generateReply()` | `supabase.functions.invoke('stylechat-generate')` |
| StyleChat usage | `services/style-chat/styleChatRepository.ts` | `readStyleChatDailyUsage()` | `supabase.rpc('get_stylechat_daily_usage')` |
| Style memory | `services/style-chat/styleMemoryRepository.ts` | `readMemoryEvents()`, `upsertStyleMemoryEvent()` | `supabase.from('style_memory_events')` + `supabase.rpc('upsert_style_memory_event')` |
| Privacy settings | `services/supabasePrivacy.js` | `ensurePrivacySettings()`, `fetchProfile()`, `updatePrivacySettings()` | REST wrapper to `privacy_settings` + `profiles` |
| Account deletion | `services/accountDeletion.js` | `submitAccountDeletionRequest()` | `supabase.functions.invoke('handle-user-deletion')` |
| Data export | `services/supabasePrivacy.js` | `requestDataExport()` | `supabase.functions.invoke('privacy-data-export')` |
| Data correction | `services/supabasePrivacy.js` | `requestCorrection()` | `supabase.functions.invoke('privacy-correction-request')` |
| Feature freeze | `services/featureFreeze.ts` | `loadFeatureFreezeConfig()` | `supabase.from('app_config').select('value').eq('key', 'mobile_feature_freeze').maybeSingle()` |
| Auth session | `contexts/AuthSessionContext.tsx` | `AuthSessionProvider` | `supabase.auth.getSession()`, `supabase.auth.onAuthStateChange()` |
| Routing guard | `services/routingGuard.js` | `getRoutingGuardState()` | Checks `profiles.account_status`, `deletion_requests` |
| Product search | `services/productSearchDeals.ts` | `searchProductDeals()` | `supabase.functions.invoke('product-search-deals')` |
| Secondhand search | `services/secondhand.js` | `searchVintedSecondhand()` | `supabase.functions.invoke('search-vinted-secondhand')` |
| Sneaker enrichment | `services/sneakers/index.ts` | `searchSneakers()` | Multiple provider fetch + Edge Function |
| TextScan placeholder | `app/text-scan/index.tsx` | Processing state | `setTimeout` simulation, `TEXTSCAN_DEMO_RESULTS_ENABLED` |
| Library local-only | `services/library.js` | `saveScan()`, `loadLibrary()` | `expo-file-system` local directory, no Supabase |
| No generated types | `types/` directory | No `supabase.ts` or `database.types.ts` | Confirmed via file listing |
| No expo-constants | `services/` directory | No `import Constants` from `expo-constants` | Confirmed via grep |
| Privacy sanitizer stub | `services/privacyImageSanitizer.js` | `sanitizeImageBeforeUpload()` | Returns input unchanged |

---

*End of Backend-to-V2 Wiring Snapshot Report*
