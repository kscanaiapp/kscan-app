# Free Tier Utility Expansion — Map

**Branch (intended):** `feature/free-tier-utility-expansion-v1`
**Built:** 2026-07-04 · fast-build prototype layer · local-first, flag-gated OFF by default

> Git note: branch creation and commit are delegated to the release owner in
> PowerShell (sandbox git writes are unreliable on this machine). All work here
> is new files plus two small guarded edits, so isolation is preserved by
> staging only the paths listed below on the new branch.

## What this is

A free-tier utility layer that makes K Scan feel like a wardrobe companion,
not just a scanner: outfit ideas, a daily style prompt, wardrobe stats,
sharing, collections, cost-per-wear, duplicate hints, brand sizing memory,
ratings, care notes, wishlist intent, activity log, wear-again suggestions,
challenges, seasonal nudges, and closet filters. Everything is local-first
and renders **nothing** unless `FREE_TIER_UTILITY_ENABLED` is explicitly set.

## Feature flags (constants/freeTierUtilityFlags.ts)

All default **false**; enabled only via `EXPO_PUBLIC_*` env values (`'true'`).
No committed .env files were edited.

- `FREE_TIER_UTILITY_ENABLED` (master — everything requires it)
- `FREE_TIER_OUTFIT_GENERATOR_ENABLED` (also gates Complete the Look)
- `FREE_TIER_DAILY_STYLE_PROMPT_ENABLED`
- `FREE_TIER_WARDROBE_STATS_ENABLED`
- `FREE_TIER_SHARE_CARD_ENABLED`
- `FREE_TIER_COLLECTIONS_ENABLED`
- `FREE_TIER_DUPLICATE_HINTS_ENABLED`
- `FREE_TIER_BRAND_SIZING_ENABLED`
- `FREE_TIER_OUTFIT_RATING_ENABLED`
- `FREE_TIER_CARE_NOTES_ENABLED`
- `FREE_TIER_COST_PER_WEAR_ENABLED`
- `FREE_TIER_WISHLIST_INTENT_ENABLED`
- `FREE_TIER_CLOSET_FILTERS_ENABLED`
- `FREE_TIER_WEAR_AGAIN_ENABLED`
- `FREE_TIER_ACTIVITY_LOG_ENABLED`
- `FREE_TIER_STYLE_CHALLENGES_ENABLED`
- helper: `isFreeTierFeatureEnabled(subFlag)` = master && subFlag

## Storage keys (AsyncStorage, versioned envelope v1)

Envelope: `{ version: 1, userId?, updatedAt, data }` — corrupt or
wrong-version payloads are cleared and reset silently. Never stores raw
images, auth tokens, precise location, or sensitive personal data. No sync.

- `kscan.freeTier.brandSizing.v1` — `Record<brandKey, BrandSizingEntry>`
- `kscan.freeTier.outfitFeedback.v1` — `Record<targetId, OutfitFeedbackEntry>` (rating 1–5 + tags)
- `kscan.freeTier.careNotes.v1` — `Record<itemId, CareNoteEntry>`
- `kscan.freeTier.wishlistIntent.v1` — `Record<itemId, WishlistIntentEntry>`
- `kscan.freeTier.collections.v1` — `OutfitCollection[]`
- `kscan.freeTier.wearTracking.v1` — `Record<itemId, WearTrackingEntry>` (wearCount, lastWornAt, estimatedPrice — also serves cost-per-wear; no separate costPerWear key)
- `kscan.freeTier.activityLog.v1` — `ActivityEvent[]` capped at 50
- `kscan.freeTier.styleBoards.v1` — `SavedOutfit[]` (user-saved looks, capped 40)
- `kscan.freeTier.utilityMeta.v1` — daily-prompt state, completed challenges, counters

All shapes are defined in `services/free-tier/wardrobeUtilityTypes.ts`.

## Files added

constants/
- freeTierUtilityFlags.ts

services/free-tier/
- wardrobeUtilityTypes.ts · freeTierStorage.ts · itemNormalization.ts
- outfitGenerator.ts · dailyStylePrompt.ts · wardrobeStats.ts · shareTextBuilder.ts
- outfitCollections.ts · savedOutfits.ts (extra: styleBoards persistence)
- duplicateDetector.ts · brandSizingMemory.ts · outfitFeedback.ts · careNotes.ts
- costPerWear.ts · wishlistIntent.ts · closetFilters.ts · wearAgainSuggestions.ts
- pairingSuggestions.ts · activityLog.ts · styleChallenges.ts · seasonalNudges.ts
- postSaveNudges.ts · freeTierPreviewData.ts

hooks/
- useWardrobeUtility.ts · useOutfitGenerator.ts · useDailyStylePrompt.ts
- useWardrobeStats.ts · useShareOutfit.ts · useOutfitCollections.ts
- useDuplicateHints.ts · useBrandSizingMemory.ts · useOutfitFeedback.ts
- useCareNotes.ts · useCostPerWear.ts · useWishlistIntent.ts
- useClosetFilters.ts · useWearAgainSuggestions.ts · useActivityLog.ts
- useStyleChallenges.ts

components/free-tier/
- freeTierUi.tsx (shared primitives: card, chips, buttons, stat bars)
- FreeTierUtilitySection.tsx · SavedItemUtilityPanel.tsx · ScanResultUtilityFooter.tsx (extra)
- OutfitGeneratorCard.tsx · SavedOutfitCard.tsx · DailyStylePromptCard.tsx
- WardrobeStatsCard.tsx · ShareableOutfitCard.tsx · ShareOutfitButton.tsx
- OutfitCollectionCard.tsx · OutfitCollectionsSection.tsx
- WardrobeDuplicateHintCard.tsx · BrandSizingNoteCard.tsx · OutfitRatingCard.tsx
- CareNoteCard.tsx · CostPerWearBadge.tsx · CostPerWearCard.tsx
- WishlistIntentCard.tsx · ClosetFilterBar.tsx · WearAgainSuggestionCard.tsx
- CompleteTheLookCard.tsx · RecentActivityLogCard.tsx · PostSaveNudge.tsx
- StyleChallengeCard.tsx · SeasonalNudgeCard.tsx · EmptyClosetUtilityState.tsx

docs/
- FREE_TIER_UTILITY_EXPANSION_MAP.md (this file)

## Existing files modified (2, both guarded)

1. `app/library.tsx` — added 2 imports + one flag-guarded
   `<FreeTierUtilitySection rawItems={scans} variant="library" />` block
   between the Scans grid and the Inspiration section. Renders null unless
   the master flag is on.
2. `components/scan-results/ScanResultV2.tsx` — added 1 import + one
   flag-guarded `<ScanResultUtilityFooter result={v2Data} />` mount between
   Purchase Options and the privacy footer. Renders null unless the master
   flag is on.

No sacred files touched (`app/_layout.tsx`, `app/index.tsx`,
`app/style-chat/[sessionId]`, auth/onboarding, native folders, build config,
package files, env files, Supabase functions all untouched).

## Integration points used

- Library screen → `FreeTierUtilitySection` (daily prompt, outfit generator,
  collections, seasonal nudge, empty state)
- Scan result screen → `ScanResultUtilityFooter` (duplicate hint, brand
  sizing note, wishlist intent)

## Integration points deferred (components built, not mounted)

- Home screen "For You" → `FreeTierUtilitySection variant="home"`
  (WardrobeStatsCard, RecentActivityLogCard, StyleChallengeCard). Deferred
  because home surfaces (`HomeV2` / `HomeLuxuryTechV1`) are mid-flight in
  other uncommitted work on this machine.
- Library detail / saved item view → `SavedItemUtilityPanel` (no dedicated
  item-detail screen exists yet; panel is ready).
- ProductShelf lower area → `WishlistIntentCard`, `BrandSizingNoteCard`.
- Dressing Room item detail → `ShareOutfitButton`, `OutfitRatingCard`,
  `CompleteTheLookCard`.
- Library grid filtering → `ClosetFilterBar` + `useClosetFilters` (wiring
  into the existing scans grid would require reshaping the pair-based grid
  render; deferred as P2).
- Post-save toast → `PostSaveNudge` (host save flow lives in scan flow files
  being debugged separately).

## Known limitations

- **No user-id scoping by default.** Storage is device-scoped; `writeStore`
  accepts an optional `userId` and stamps the envelope, but callers currently
  don't pass one (avoids coupling hooks to AuthSessionContext). Sign-out does
  NOT clear utility data yet; `clearAllFreeTierStores()` exists and can be
  wired into the existing sign-out path later.
- Saved scans have no brand/occasion/season fields today, so brand-, season-
  and occasion-driven features activate only for product-shelf items or
  future metadata.
- Outfit feedback is intentionally separate from Style DNA feedback
  (`useStyleDnaFeedback`) to avoid touching sacred StyleChat files; a later
  merge could unify them.
- Collections rename UX is a lightweight prototype (reuses the create input).
- Share is plain-text only (RN `Share`); no image capture dependency added.
- `savedOutfits.ts` and `ScanResultUtilityFooter.tsx` are two files beyond
  the suggested tree (persistence for "Save as look" and the minimal scan
  integration wrapper); both follow the same rules.

## Validation still required (none run — no-terminal rule)

- `npx tsc --noEmit`
- ESLint / import cycle check
- Metro build + device smoke: enable `EXPO_PUBLIC_FREE_TIER_UTILITY_ENABLED=true`
  plus desired sub-flags in a local (uncommitted) .env, verify Library and
  scan-result surfaces, then verify default build renders identically with
  flags absent.
- Storage round-trip QA on device (save/rate/mark-worn → relaunch).

## Confirmations

- No native (Android/iOS) config changes; app.json/eas.json/gradle/Info.plist untouched.
- No dependencies added; package.json/lock untouched.
- No Supabase schema, migrations, or edge-function changes; no new endpoints.
- No auth/onboarding/legal/privacy/permissions changes.
- No scanner/StyleChat/DressingRoom/ProductShelf backend logic changes.
- No upsell-tier or monetization language anywhere in this layer.
- No fake data injected into user Library, history, or activity;
  preview content is empty-state/example-labeled only.
