# Scan Home/Back UI Patch — QA Report

## Existing Navigation Affordance Found

V2 scan flow (`ScanLanding`, `LiveScanCamera`, `CaptureReview`, `AnalyzingScan`):
- `ScanRoomHeader` with brand mark and optional AIStarBadge — no navigation action
- `LiveScanCamera` secondary controls: Upload, TextScan, Back — Back goes to scan landing
- `CaptureReview`: Analyze, Retake — no Home action
- `AnalyzingScan`: no navigation actions
- `ScanResultV2` / `AnalysisCard` (result Modals): dismiss button — goes back to scan, not Home

V1 legacy scan flow (`app.js`):
- `renderCameraScreen()`: Library button, Dressing Rooms button, QA button, Privacy & Data button, Scan button — none go to Home
- `renderPreviewScreen()`: brand title, subtitle, action buttons — no Home action

## Kept, Replaced, or Restyled

Existing Back/Back buttons were kept. New Home button added alongside existing controls.
Reason: Existing controls navigate to scan landing, library, or other subscreens; none go to Home.

## HUD/Header Integration Strategy

V2: Added `rightAction` prop to `ScanRoomHeader`. Home button renders as a small pill in the trailing slot of the header row.
V1: Added Home button to `renderPreviewScreen()` previewHeader as a right-aligned pill, and to `renderCameraScreen()` as an absolutely positioned top-left pill on the camera overlay.

## Scan States Inspected

- `idle` (V2: `ScanLanding` / `LiveScanCamera`)
- `capturing` (V2: overlay spinner)
- `preview` (V2: `CaptureReview`)
- `processing` (V2: `AnalyzingScan`)
- `result` (V2: `ScanResultV2` / `AnalysisCard` Modal)
- `non-fashion` / `error` (V2: `renderPreviewScreen()`)
- `idle` / `capturing` (V1: `renderCameraScreen()`)
- `preview` / `processing` / `result` / `non-fashion` / `error` (V1: `renderPreviewScreen()`)
- Permission denied (V2: `LiveScanCamera` permission state)

## Button Visible in Idle

Yes. `ScanLanding` and `LiveScanCamera` (V2) show Home button in `ScanRoomHeader`. V1 `renderCameraScreen()` shows Home button on overlay.

## Button Visible in Permission Denied

Yes. `LiveScanCamera` permission denied state shows `ScanRoomHeader` with Home button.

## Button Visible During Analysis

Yes. `AnalyzingScan` shows `ScanRoomHeader` with Home button. `CaptureReview` shows `ScanRoomHeader` with Home button.

## Button Disabled During Active Processing

No. The Home button is always enabled. The existing Android BackHandler already blocks back during processing (`status === 'processing'`), but the Home button is a navigation action that uses `router.replace('/')`. The user can always navigate Home.

## State Machine Changed

No. The scan state machine (`useKScan`) is unchanged. The Home button only triggers navigation.

## Camera Lifecycle Changed

No. The camera lifecycle is managed by the parent component. The Home button only triggers `router.replace('/')` and allows normal unmount cleanup.

## Permission Denied Visibility

Yes. Home button remains visible in `LiveScanCamera` permission denied state.

## TextScan Affected

No. TextScan is a separate route (`/text-scan`). The Home button is only added to the main scan surface components.

## Feature Flag / Theme Behavior

The Home button uses the same theme as the surrounding surface:
- V2 components: `LUXURY` tokens (pearl background, plum text, champagne border)
- V1 preview screen: `COLORS` tokens (dark overlay, text inverse, champagne gold border)
- V1 camera screen: `COLORS` tokens (dark overlay, text inverse)

## Overlay Collision Risk

V2: `ScanRoomHeader` is at the top of the screen, above the viewfinder/image card. No collision with camera controls, scan frame, capture button, or instruction cards.
V1: `renderPreviewScreen()` Home button is in the previewHeader row, right-aligned. No collision with preview image or action buttons.
V1: `renderCameraScreen()` Home button is at `top: LAYOUT.safeTop + SPACING.lg, left: LAYOUT.screenPadding`. This is on the left side of the overlay, clear of the brand title text and the `libraryButton` (which is on the right).

## Navigation Context

Home route used: `/`
Back available: Yes (existing Back buttons preserved)
router.back used: No (existing Back buttons use `onBack` callbacks that go to scan landing or `router.back()`)
router.replace used: Yes — `handleHome` callback uses `router.replace('/')` to go to Home
Reason: `router.replace('/')` ensures the scan screen is removed from the navigation stack, so Android Back from Home does not return to scan.

## Files Changed

- `app.js` — added `handleHome` callback, passed `onHome` to all V2 components, added Home button to `renderPreviewScreen()`, added Home button to `renderCameraScreen()`, added styles
- `components/scan-room/ScanRoomHeader.tsx` — added `rightAction` prop, restructured layout with `space-between` row
- `components/scan-room/ScanLanding.tsx` — added `onHome` prop, passed Home button to `ScanRoomHeader`
- `components/scan-room/LiveScanCamera.tsx` — added `onHome` prop, passed Home button to `ScanRoomHeader` (both camera and permission denied states)
- `components/scan-room/CaptureReview.tsx` — added `onHome` prop, passed Home button to `ScanRoomHeader`
- `components/scan-room/AnalyzingScan.tsx` — added `onHome` prop, passed Home button to `ScanRoomHeader` (both normal and error states)

## Validation

- `npx tsc --noEmit`: **PASS** (no errors)
- `node --test __tests__/*.js`: Known baseline failures remain. No new failures.
- `git diff --check`: No whitespace errors.

## Manual Smoke Checklist

- [ ] Button visible on idle Scan screen (V2 ScanLanding, V2 LiveScanCamera, V1 renderCameraScreen)
- [ ] Button visible and functional when camera permission is denied (V2 LiveScanCamera)
- [ ] Button does not overlap flash/camera/HUD controls (V2 header is above viewfinder)
- [ ] Button does not overlap scan frame (V2 header is above viewfinder)
- [ ] Button does not overlap capture button (V2 header is above controls)
- [ ] Button does not overlap instruction cards (V2 header is above cards)
- [ ] Button visible on small-screen device (header uses `minHeight: 44` and safe area)
- [ ] Button behavior during capture/analyzing is safe (always enabled, navigation only)
- [ ] Button visible on results screen if part of same Scan surface (V1/V2 `renderPreviewScreen()` has Home button; V2 Modal result screens have existing dismiss affordance)
- [ ] Button does not duplicate an existing Back/Home action (existing Back goes to scan landing; new Home goes to Home)
- [ ] Android Back from Home does not reveal Scan (uses `router.replace('/')`)
- [ ] TextScan is unaffected (separate route)

## Runtime / Manual Smoke

Runtime/manual smoke run: NOT RUN — requires human device/emulator testing.

## Recommended Next Step

Manual smoke test on iOS and Android device/emulator to verify Home button visibility, touch target size, and navigation behavior across all scan states.
