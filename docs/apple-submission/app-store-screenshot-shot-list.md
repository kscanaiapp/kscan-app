# App Store Screenshot Shot List — K Scan (v1.0.0)

> Scope: email/password-only release candidate. iPhone-only (`supportsTablet: false`) — no iPad screenshots required.
> Rule: every screenshot must show a feature that exists in this build. No OAuth buttons, no Google Sign-In, no Sign in with Apple appear anywhere in the app or the screenshots.

## Primary Carousel (in order)

1. **Home** — branded home screen with the scan entry point.
2. **Scan / Camera** — camera view framing an outfit (use a staged outfit; no bystanders, no identifiable third parties).
3. **Results** — AI style analysis of a scanned item, with product matches visible.
4. **Style Library** — saved scans grid/list with 3+ items (seed demo content first).
5. **Privacy Controls** — privacy screen showing user-facing data controls.

## Compliance-Only Captures (not in the primary carousel)

- **Account deletion flow** — capture for records/review-response use; do not use as a marketing screenshot.
- **Auth screen (email/password)** — capture for records; confirms no third-party login buttons. Not for the carousel.

## Excluded from This Release

- **StyleChat** — not in this release build; excluded from the carousel and all marketing imagery.
- **Dressing Rooms / Shared Rooms** — not present in this build; excluded.
- Any screen showing OAuth/Google/Apple sign-in — does not exist in this build and must not appear.

## Production Notes

- Capture on a physical iPhone at required App Store resolutions (6.9" and 6.5" classes cover current requirements; confirm against App Store Connect at upload time).
- Dark UI: verify status-bar legibility in captures.
- Backend must be warm before capturing Results (cold start is 30–60 s).
- No personal data in any capture: use the demo account, demo content only.
