# Build 35 — iPadOS optimization pass

Branch: `repair/build35-ipados-optimization` from `integration/build35-v1-convergence` @ `e8667b3b`.
Scope: source-level responsive layout only. No backend, Supabase, RevenueCat, scanner provider,
Elise prompt/model, VTO inference, entitlement, purchase, deletion or native-config change.

## Starting point

The integration line already carried a width-class layout system (`services/responsiveLayout.js`,
`hooks/useResponsiveLayout.ts`), `supportsTablet: true`, iPhone portrait-only / iPad all four
orientations, and no `UIRequiresFullScreen`. Grids (Closet, Recent Scans, Looks, Dressing Rooms,
Shared Rooms), `LuxuryScreen`'s 840pt content column, the Elise conversation column, the sign-in and
onboarding form column and 18 capped sheets were already in place and guarded by
`__tests__/responsiveScreenContracts.test.js`.

This pass found where that system did not yet reach, and fixed it.

## Layout classes

All behavior derives from the live window (`useWindowDimensions`), never a device model. No screen
reads `Platform.isPad`.

| Class | Rule | Covers |
|---|---|---|
| Compact width | `< 700pt` | Every iPhone (≤ 440pt), Slide Over, ½ Split View (507–678pt). Certified iPhone layout, unchanged. |
| Regular width | `≥ 700pt` | iPad mini/11"/13" portrait, ⅔ Split View, every landscape window. Centered columns, 3-col grids. |
| Wide | `≥ 1000pt` | 13" portrait, 11"/13" landscape. 4-col grids. |
| Results workspace | regular **and** `≥ 820pt` (new) | 11" portrait (820/834pt) and every full-screen landscape. Two-pane scan results. iPad mini portrait (744pt) and ⅔ Split View keep the single-column sheet. |
| Compact height | `< 500pt` (new) | Phone landscape only (≤ 440pt). Every iPad landscape height is ≥ 744pt. |

Column caps (unchanged): content 840 · conversation 640 · form 560 · modal 560 · media 420.
New: results workspace 820, workspace media 340 (4:5 → 340×425).

## Screen inventory

Priority: P1 = visible layout defect on a primary flow; P2 = visible on a secondary flow;
P3 = cosmetic / consistency. "Already suitable" = verified in source against the window classes.

| Screen / surface | Existing behavior on iPad | Defect | Priority | Change |
|---|---|---|---|---|
| Home (`HomeLuxuryTechV1`) | 840pt column; hero image 140×180, 28pt headline | Phone-sized hero floating in a large card | P2 | Regular width: 240×320 hero image (below source resolution at @2x), 40pt headline, 16pt body |
| Home feature chips / Voice Scan / TextScan / Watchlist | Flex row in 840 column (5 chips fit one row) | — | — | Already suitable |
| Scanner — live camera (`LiveScanCamera`) | Viewfinder width+height constrained, ≤ 420pt | Instruction card stretched to full window width under a 420pt viewfinder | P2 | Card centered at the 560pt column (phone inset unchanged) |
| Scanner — capture review (`CaptureReview`) | Image ≤ 420pt | Metadata/guidance cards and pinned Retake/Analyze bar stretched to full width | P1 | Content and action bar centered at the 560pt column |
| Scanner — analyzing (`AnalyzingScan`) | Thumbnail ≤ 280pt | Processing card stretched to full width | P2 | Card centered at the 560pt column |
| Scanner — legacy preview (`app.js`) | Media and CTAs capped | — | — | Already suitable |
| Scan results (`ScanResultV2`) | 560pt bottom sheet; hero stacked above analysis | Phone-width sheet on a 1024–1366pt window; commerce carousels showed ~2.5 cards | P1 | ≥ 820pt windows: 820pt two-pane workspace — garment (340pt) left, detected items + style match right; style analysis, similar finds, purchase options and Black-owned discovery full-width below. Same element instances as the phone sheet. |
| Scan results — multi-item review / empty state | 560pt sheet | — | — | Already suitable (kept at 560) |
| Product compare / Product shelf sheets | Capped 560 | — | — | Already suitable |
| Elise conversation (`style-chat/[sessionId]`) | Messages + composer in 640pt column | (a) iPad landscape treated as a short window: composer capped to 84pt and list padding compacted; (b) visual-context bar, attachment bar, error banner and "Style this" chip spanned the full window, detached from the conversation | P1 | (a) Compaction keyed on compact **height**; (b) bars moved into the conversation column |
| Elise composer (`StyleChatInput`) | — | Same landscape compaction defect | P1 | Keyed on compact height |
| Elise header / avatar | Fixed-size avatar in header | — | — | Already suitable (avatar not scaled) |
| Elise sessions list (`style-chat/index`) | LuxuryScreen column | — | — | Already suitable |
| Closet / Recent Scans (`library`) | 3/4-column grids from live window | — | — | Already suitable |
| Closet intake / item edit / manual classify | iOS `pageSheet` (system-sized on iPad) | — | — | Already suitable |
| Mirror Selfie extraction sheet | Bottom sheet | Spanned full window width | P2 | Capped + centered at 560 |
| Dressing Rooms list / room / public room | Grids + capped modals | — | — | Already suitable |
| Private dressing room (`stylist/dressing-room`) | LuxuryScreen column | 4 bottom sheets (slot editor, comparison, discard-edits confirm, occasion) spanned full width | P2 | Shared `sheet` style capped + centered at 560 |
| Stylist / saved looks / Looks | LuxuryScreen column, capped modals | — | — | Already suitable |
| Virtual Try-On sheet / Try-On Studio / Closet try-on | Sheet capped 560; result `aspectRatio 0.8` + `contain` | — | — | Already suitable (no stretch, no distortion) |
| K+ membership sheet / fallback paywall | Full-screen modal, 560 content column, store-sourced prices | — (literal `560` duplicates the token; left as-is to keep the paywall render harness unchanged) | P3 | Already suitable |
| K+ hosted RevenueCat paywall | Native RevenueCat UI | — | — | Untouched by design |
| K+ Early Access sheet | Capped | — | — | Already suitable |
| Packing / date-range picker | LuxuryScreen column; pageSheet picker capped 560 | — | — | Already suitable |
| Watchlist list / detail | LuxuryScreen column | — | — | Already suitable |
| TextScan / Voice listening sheet | LuxuryScreen column; capped sheet | — | — | Already suitable |
| Purchase import | LuxuryScreen column | — | — | Already suitable |
| Sign in (`auth/index`) / Onboarding | 560pt form column | — | — | Already suitable |
| Password reset (`auth/reset`) | Full-width card | Email field and button stretched across the window | P2 | Card capped + centered at 560 |
| Set new password (`auth/update-password`) | Full-width card | Same | P2 | Same |
| Auth callback (`auth/callback`) | Full-width card | Same | P3 | Same |
| Privacy / account / deletion (`privacy`) | LuxuryScreen column, capped modals | — | — | Already suitable (deletion flow untouched) |
| AI-output report sheet | Capped | — | — | Already suitable |

30 routes (excluding layouts) and the 31 files that present a `<Modal>` were reviewed in source; 16 source files changed, 4 test files changed, plus this document.

## Window resizing

Every new value is derived during render from `useWindowDimensions()`; none is stored in state or
threaded into an effect dependency, so rotation, Split View and Stage Manager resizes re-lay-out without
re-running requests, recreating camera sessions, clearing Elise drafts or dropping selected images. The
results workspace switches arrangement only; the same `ScanResultHero`, detected-items and style-match
elements are rendered in both layouts, and the Similar Finds scroll target stays a direct ScrollView child.

## Not changed (by boundary)

`app.json` orientation/tablet keys, `UIRequiresFullScreen`, Android config, RevenueCat products and
paywalls, purchase/restore/entitlement code, Supabase, scanner provider/recognition, Elise prompt and
voice, VTO inference, privacy masking, account deletion, Apple authorization.

## Verification

See the PR description for exact commands and results. No iPad simulator is available on the Windows
host used for this pass, so there are no simulator screenshots; layout is verified by pure-math and
source-contract tests (`__tests__/responsiveLayout.test.js`, `__tests__/responsiveScreenContracts.test.js`).

## Remaining real-device / simulator validation

1. 13" iPad landscape + portrait: scan results workspace (single item, multi-item confirmation,
   pending/empty/error commerce).
2. 11" portrait (834pt) at the workspace threshold; iPad mini portrait (744pt) stays single column.
3. Elise in iPad landscape with the hardware and software keyboards (WP-ELISE-07 offset was not
   changed; iPad windowed modes were already noted as untested there).
4. Live camera in Stage Manager short windows (viewfinder height budget).
5. Large accessibility text on Home hero (40pt headline) and the workspace right pane.
6. App Store 13" iPad screenshots (2064×2752 or 2752×2064) from real application states.
