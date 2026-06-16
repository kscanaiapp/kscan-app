# Android Release 1.0.0 — Internal Testing Smoke

**Build:** Play Internal Testing
**Device:** _[fill in — e.g. Pixel 7 emulator API 34 / physical device model]_
**Branch/build version:** `release/android-1.0.0` / `app-production-beta1.aab` (tag `v1.0.0-android-internal`)
**Date:** 2026-06-16

## Pre-flight (static, verified on `release/android-1.0.0`)

All 10 surfaces exist and are wired on the release branch — nothing missing in code.

| # | Check | Maps to | Result |
|---|-------|---------|--------|
| 1 | Launch app | `app/index.tsx`, `app/_layout.tsx` | |
| 2 | Sign in/session | `app/auth/index.tsx` + AuthSessionContext | |
| 3 | Home loads | `app/index.tsx` | |
| 4 | Scan/camera opens | `app/scan/index.tsx` | |
| 5 | StyleChat short prompt response | `app/style-chat/index.tsx`, `app/style-chat/[sessionId].tsx` | |
| 6 | Dressing Rooms opens | `app/dressing-rooms/index.tsx` | |
| 7 | Privacy screen opens | `app/privacy.tsx` | |
| 8 | Delete Account modal opens, cancel works | `app/privacy.tsx` | |
| 9 | Offline/reconnect quick check | `services/api.js` (CONNECTION_INTERRUPTED handling) | |
| 10 | Any crash or stuck loading | (observe during 1–9) | YES / NO |

## Caveats before running

- **Step 5 (StyleChat)** depends on the backend being reachable. A failure here may be infra (server down / API URL) rather than a UI bug — confirm the backend is up before marking FAIL.
- **Step 6 (Dressing Rooms)** = the in-app route `app/dressing-rooms/`. The public *shared-link* room view is separate (`app/(public)/rooms/[token].tsx`); test that path too if shared links are in scope for 1.0.0.

## Notes

_(record observations, anything flaky, repro steps for failures)_

## Screenshots

_(attach or link)_
