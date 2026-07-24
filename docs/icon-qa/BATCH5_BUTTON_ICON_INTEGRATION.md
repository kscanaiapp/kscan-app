# Batch 5 — Product icon button integration (iOS v17)

Branch: `integration/ios-v17-prelaunch-complete`
Starting SHA: `a6f5388`

## Scope

Per the owner's Batch 5 scope correction, this batch is a **button-asset
replacement**, not a full icon-system integration:

> Replace the generic AI-star/sparkle icons only where they are used as button
> icons on active app surfaces. Do not replace decorative sparkles,
> illustrations, status indicators, headers, badges, or non-button artwork. Do
> not invent substitute icons for surfaces without an approved custom asset.

## Provenance

| Item | Value |
| --- | --- |
| Donor branch | `origin/integration/ios-v16-final-qa` |
| Donor commit | `61059fb` — product icon system |
| Merge base with `a6f5388` | `5b687b6` |

The donor branch **predates Batches 1–4A**. It was therefore never merged.
Only the approved icon components were ported.

Excluded from the donor, deliberately:

| Donor path | Decision | Reason |
| --- | --- | --- |
| `0f19d22`, `21637dd`, `60011d5` | EXCLUDE | Avatar/speech commits superseded by Batch 4 / 4A |
| `app/dev/icon-review.tsx` | EXCLUDE | Icon-framework tooling; adds a route. Out of corrected scope |
| `scripts/generate-kscan-icon-evidence.js` | EXCLUDE | Framework tooling, out of corrected scope |
| `docs/icon-qa/**` (donor tree), `3bf8005` | EXCLUDE | Documents the broader v16 full-system integration; inaccurate for this batch |
| `components/home/HomeStylistCard.tsx` | EXCLUDE | Donor replaced a **section-header** sparkle — decorative, not a button icon |

## Dependency

`react-native-svg@15.12.1` added as a direct, exact dependency — the Expo SDK 54
canonical pin. The approved icons exist only as `react-native-svg` components;
there is no raster variant.

Owner approval was obtained before adding it (native dependency, Batch 5 §23).
It autolinks: **no** `app.json`, `eas.json`, plugin, or native project change.
iOS is managed (no `ios/` directory), so EAS prebuild generates the pod. The
change cannot reach an existing binary over-the-air — build 17 must be a fresh
native build, which it already is.

## Replacements applied (7 buttons, 3 active surfaces)

| Surface | Button | Was | Now | Handler / route | Preserved |
| --- | --- | --- | --- | --- | --- |
| Home | START SCAN | `✧` in title | `visual-search` | `router.push('/scan')` | label, hint, testID |
| Home | RECENT SCANS | `✦` | `recent-scans` | `router.push('/library')` | label, hint, testID |
| Home | VISUAL SEARCH | `◈` | `visual-search` | `router.push('/scan')` | label, hint, testID |
| Home | SAVE & ORGANIZE | `◇` | `save-organize` | `router.push('/library')` | label, hint, testID |
| Home | DRESSING ROOMS | `◉` | `dressing-rooms` | `router.push('/dressing-rooms')` | label, hint, testID |
| Home | TEXTSCAN | `✧` | `textscan` | `handleOpenTextScan` | flag gating, loading/disabled |
| Scan landing | Describe an item | `✧` | `textscan` | `onTextScan` | label, testID, disabled state |
| Live camera | TextScan pill | `✧` | `textscan` | `onTextScan` | label, flag gating |

### Deviation from donor QA — START SCAN

The donor's v16 test suite asserted `title="✧ START SCAN"` should be **kept**.
Under the corrected scope this is an active button using a generic AI-star for
which an approved icon (`visual-search`, the same `/scan` action already
carrying that icon on this screen) exists, so it was replaced. This is a
deliberate, recorded deviation from the v16 baseline.

The hero CTA is a **primary** (plum-filled) button. `KScanIcon` defaults to
plum, which would have rendered an invisible icon, so the CTA passes the
donor's own `plum-inverted` treatment: `color=inverse`,
`accentColor=goldChampagne`.

## Deliberately NOT replaced

Decorative / non-button, and regression-guarded by test:

- `HomeStylistCard` "YOUR STYLIST" header sparkle
- `app/privacy.tsx`, `app/onboarding/index.tsx` trust bullets
- `app/text-scan/index.tsx` intro + processing sparkles (status indicator)
- `AIStarBadge` (badge), `TextScanSuggestionChip` (no approved asset)
- `ScanRoomHeader`, `ScanResultV2` dividers
- `ScanLanding` feature-cell icons (non-button)
- `EmptyStateCard` artwork in `LiveScanCamera`, `AnalyzingScan` (illustration)
- Dressing-room `SHARED_ROOM_GLYPH` / `OWNED_ROOM_GLYPH` cover fallbacks
- `PermissionsStepV1` permission-card icons; home profile avatar fallback

No approved asset exists for these onboarding CTAs, so their sparkles remain and
are explicitly allowlisted (with a staleness guard) rather than silently ignored:

- `WelcomeStepV1` — `✧ GET STARTED`
- `PermissionsStepV1` — `✧ CONTINUE TO HOME` / `✧ SAVING...`

`HomeLegacy.tsx` and `HomeV2.tsx` retain glyphs but are **unrouted**; a test
asserts they are never rendered.

## Verification

| Check | Result |
| --- | --- |
| Focused Batch 5 tests | 29 / 29 pass (`npm run test:kscan-icons`) |
| TypeScript (`tsc --noEmit`) | 0 errors |
| Full Node suite | 1682 / 1682 pass (baseline 1653 + 29 new) |
| `git diff --check` | clean |

The global proof — *no active app button retains a generic AI-star where an
approved icon exists* — walks every `.tsx` under `app/` and `components/`,
resolves the enclosing JSX element for each sparkle-bearing `icon`/`title`
prop, and excludes illustration components. A negative-control test asserts the
detector still fires on the allowlisted files, so it cannot rot into a vacuous
pass.

Physical-device layout verification is **not** claimed: no build was produced.

## Carried to Batch 6

- `appVersionSource: "local"`, checked-in `ios.buildNumber: "16"`, target 17 —
  collision unresolved by design.
- No `autoIncrement` key in any EAS profile.
- Native reconciliation for the newly added `react-native-svg` pod.
