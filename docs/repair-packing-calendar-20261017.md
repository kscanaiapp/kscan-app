# PACK-002 in-app calendar repair — 2026-10-17

Campaign verdict: PARTIAL pending independent review, integration and signed iOS/Android acceptance. Source implementation and automated tests do not certify a customer binary.

## Authority and scope

Freshly fetched mobile baseline: integration/build35-v1-convergence at 4080a494a1d78ffaa546cd5055eb51d122afcc9a. Backend authority: rebuild/backend-authority-v2 at 54e9c27d9e39df99b167126382fe8ed9f5f01edb.

New isolated worktree C:/pack1017, branch codex/packing-calendar-repair-20261017, initially clean. No master or old snapshot was used. Related source/routing PRs and open repair branches were inspected in the KPLUS-001 lane; there was no open calendar repair. K+ changes are in their own PR.

The owner clarified that dates must display DD-MM-YYYY and that the calendar should be an in-app popup. The final implementation uses React Native Modal/Pressable controls inside K Scan. It never opens a calendar app, connects a calendar account or requests calendar permission. No dependency or native integration was added; package.json and package-lock.json remain unchanged.

## Changed files and behavior

- components/packing/PackingTripForm.tsx: Leaving and Returning are accessible tap controls. Keyboard is dismissed before opening the picker; editing the calendar does not submit the form. Canonical date-only strings remain in form state. Confirmation updates both dates together; cancellation changes neither.
- components/packing/PackingDateRangePicker.tsx: native in-app modal containing a month grid, month/year navigation, a local Today marker, separate Leaving/Returning selection, highlighted endpoints and continuous range. Opens at saved dates when editing; otherwise opens at the current local month, so the customer can tap a weekday such as next Friday. The form/selection summaries use DD-MM-YYYY.
- components/packing/packingCalendar.ts: pure Gregorian grid/month navigation, localized spoken/month labels, date-only comparisons, local Today and return eligibility. UTC is only an arithmetic/formatting axis; selected date strings never become midnight-UTC payload timestamps.
- components/packing/packingDates.ts: adds formatPackingTripDate for DD-MM-YYYY; existing historical date helpers remain available.
- __tests__/packingCalendar.test.js: executed iOS/Android component surfaces and date arithmetic tests.
- __tests__/build34FinalSmokeRepair.test.js and premiumValueReturnState.test.js: update old text-input assertions to exercise the new calendar/preserve the existing K+ return-state behavior.

Departure <= return; same-day trips remain allowed; the existing 30-night maximum remains enforced. Before-departure and over-limit return days are disabled, and the event handler revalidates them. Changing departure clears an incompatible return. Existing destination, activities, trip type, optional note, K+ gating, generation, refinement and persistence contracts remain unchanged.

Request payload remains PackingTripDraft with destination, startDate/endDate as YYYY-MM-DD, tripType, activities and note. Selecting or confirming dates never invokes generation or a paid AI request. Only the existing form submission calls onSubmit.

## Accessibility and layout

Date controls and calendar days have button roles, full spoken-date labels and selected/disabled states. Departure/return also use L/R text, so meaning does not rely only on color. Today is outlined and underlined. Modal opening requests focus on the title. Month and selection changes are announced. Touch targets are at least 44 wide / 52 high for dates; actions at least 44–48 high. Content scrolls vertically; a 308-point minimum grid can scroll horizontally on unusually narrow screens. Android back and iOS sheet swipe call the cancellation path.

Screen-reader focus restoration, VoiceOver/TalkBack output, Dynamic Type, small-screen native layout, real keyboard dismissal and iOS gesture/Android-back behavior require signed-device acceptance. Automated callbacks are not proof of native gestures or layout.

## Validation

- Focused Packing/return-state suite: 82 passed, 0 failed, 0 skipped.
- Full Node suite: 11,134 passed, 0 failed, 98 existing skips (11,232 total); log .repair-evidence/full-suite.log.
- TypeScript --noEmit: passed; log .repair-evidence/typescript.log.
- Native parity: all 17 checks passed. production and build35-release profile guards passed.
- Dependency reachability: passed, no unapproved critical/high findings or reachability drift. Existing approved vulnerabilities remain outside this repair.
- Apple source readiness: passed its source checks; pre-existing warnings include App Store Connect ID, review/demo credentials and interactive signing validation.
- No native date-picker dependency is in the final candidate. An investigated package was not retained; native configuration and manifests are unchanged.
- Native compile/CI and TestSprite status are recorded in the campaign handoff. This Windows host cannot run Xcode locally.

Remaining checks: real iOS/Android popup layout, current-month/next-Friday selection, cross-month/year range, same-day trip, leap day, before-start and 31-night rejection, reopen/cancel/confirm, timezone/DST travel, screen-reader navigation/focus, Android back, iOS swipe, keyboard present when opening, and one controlled Packing request after explicit submission. Paid generation is not authorized in this campaign.

PACK-002 is P2, source-repaired with source tests passing; device acceptance remains open. No new P0 issue was established. Both production releases remain NOT READY until exact-head CI, independent review, integration and signed runtime acceptance are complete. No EAS build, signing, store upload, paid AI request or backend mutation was performed. A new Play-eligible versionCode and independent iOS release/signing authority are required for future authorized releases.
