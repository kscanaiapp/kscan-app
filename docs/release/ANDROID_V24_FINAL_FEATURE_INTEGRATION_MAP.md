# Android V24 — Final Feature Integration Map

Branch: `integration/android-release-persistence-v24`  
Purpose: safe integration map for the still-pending final feature before AAB pre-build audit.

## Protected contracts (do not regress)

1. Dressing Room owned-room actor isolation (`hooks/useStyleObjects.ts`, `services/ownedRoomListLogic.ts`)
2. Shared with Me membership persistence + generation/tombstones (`hooks/useSharedRoomMemberships.ts`, `services/sharedWithMeListLogic.ts`)
3. Saved-scan commerce authority (tombstones, no undelete, cloud-confirmed delete, currency) (`services/savedScansCloud.ts`, `services/library.js`, `components/AnalysisCard.tsx`)
4. Scanner / `scan-identify` response contract (`supabase/functions/scan-identify/*`, client mappers)
5. Production environment binding (`eas.json` production.env → Expo export must contain `wyyuqfdxucjksghsmhry.supabase.co`)
6. Android permission posture (config plugin + committed manifests + merged release manifest)
7. Auth / session restoration (`contexts/AuthSessionContext.tsx`, auth routes)
8. Elise hierarchy (TextScan → StyleChat handoff; StyleChat not a competing product)
9. QA fixture exclusion (`constants/qaFixtures.js` production empty; no fixture assets in export)

## Likely collision surface for the final feature

| Area | Paths |
|------|-------|
| Routes | `app/`, especially scan / library / dressing-rooms / style-chat / text-scan |
| Components | `components/scan-results/*`, `components/free-tier/*`, `components/style-chat/*`, `components/home/*` |
| Hooks | `hooks/useKScan.js`, `hooks/useLibrary.js`, `hooks/useStyleObjects.ts`, StyleChat hooks |
| Services | `services/styleObjects.ts`, `services/library.js`, `services/savedScansCloud.ts`, `services/scanIdentification*` |
| DB tables | `saved_scans`, dressing-room / shared membership tables, StyleChat tables if AI feature |
| Migrations | only forward-only under `supabase/migrations/` |
| Edge Functions | `scan-identify`, `stylechat-generate`, `shared-room-image-url` |
| Feature flags | `constants/featureFlags.ts`, `eas.json` production/preview env |
| Android permissions | `plugins/withAndroidPermissionBlocklist.js`, `app.json` android.permissions/blockedPermissions, `android/app/src/*/AndroidManifest.xml` |
| Assets | avoid QA fixtures; avatar frames under `assets/stylist-avatars/` |
| Persistence contracts | owned/shared room lists, purchase_options snapshot versioning |
| Tests | `__tests__/ownedRoomActorIsolation.test.js`, `savedScansCloud.test.js`, `androidPermissionBlocklist.test.js`, TextScan/Elise suites |

## Temporary product decision to preserve

- Room-share redemption cap remains the temporary testing value from migration `20260708140542_increase_room_share_redemptions_to_10_for_testing` until an owner decision resets it for store.

## Mandatory post-feature audit gates

1. Full Node test suite (`node --test __tests__/*.js`) + relevant Deno suites
2. `npx tsc --noEmit`
3. `npx expo export --platform android` with `eas.json` production.env injected; verify production Supabase host; no secrets / QA fixture assets
4. `.\gradlew.bat :app:processReleaseMainManifest` and audit merged release permissions
5. Dressing Room authenticated force-stop/relaunch persistence smoke
6. Recent Scans commerce force-stop/relaunch smoke
7. Feature-specific smoke
8. Final version identity verification (`com.kscanai.app`, versionName, versionCode)
9. Signed AAB inspection (only after this map’s feature lands; out of scope for V24 stabilization)

## Explicit non-goals for the feature integration PR

- Do not run EAS production build / submit in the feature PR unless separately authorized
- Do not increment versionCode unless Play evidence requires it
- Do not weaken actor isolation, tombstone, or permission regressions
