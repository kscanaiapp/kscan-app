# iOS Physical Device Smoke Test Checklist — K Scan (v1.0.0, build 3)

> Run on a physical iPhone via TestFlight before submitting for App Review.
> Scope: email/password-only release candidate.

This release build is email/password-only. Google Sign-In, Sign in with Apple, OAuth callback, Hide My Email, and Apple private relay flows are not expected in this build.

## Install & First Launch

- [ ] Install via TestFlight on a physical iPhone (iOS 16+).
- [ ] First launch reaches the auth screen without crash.
- [ ] Splash/icon render correctly.

## Email Authentication (submission gate — email auth only)

- [ ] Create account with email/password; complete email confirmation if prompted.
- [ ] Email confirmation / password-reset links open the app via `kscan://auth/callback` and complete successfully.
- [ ] Sign in with an existing account.
- [ ] Sign out, sign back in.
- [ ] Session persistence: force-quit, relaunch — still signed in.
- [ ] Wrong-password and malformed-email errors are readable and recoverable.

## Camera & Scan

- [ ] Camera permission prompt appears once, with the exact expected purpose string.
- [ ] Deny → re-enable in Settings → scan flow recovers.
- [ ] Capture completes; analyzing state shows.
- [ ] Cold-start case: first scan after idle may take 30–60 s — completes or fails gracefully with retry.

## Results & Save

- [ ] Analysis results render correctly.
- [ ] Product links open.
- [ ] Save result succeeds.

## Style Library

- [ ] Saved items appear and reopen correctly.
- [ ] Library persists across relaunch.

## Privacy Controls

- [ ] Privacy screen opens; policy/terms/support links load.
- [ ] Preferences persist across relaunch.

## Account Deletion

- [ ] Deletion request flow completes with confirmation (throwaway account only).
- [ ] Request is recorded server-side (verify in intake table during beta).

## Permission Hygiene (must all be NO PROMPT)

- [ ] No microphone permission prompt at any point — including during camera/scan use.
- [ ] No location prompt.
- [ ] No push-notification prompt.
- [ ] No App Tracking Transparency (ATT) prompt.
- [ ] No photo-library prompt (no picker in this build).
- [ ] No other unexpected permission prompts anywhere in the session.

## Removed-Flow Verification

- [ ] Auth screen shows **no** Google or Apple sign-in buttons.
- [ ] No StyleChat, Dressing Rooms, or Shared Rooms entry points appear anywhere.

## Submission Gate

All email-auth, camera/scan, results, library, privacy, deletion, and permission-hygiene items above must pass. Third-party auth items are intentionally absent from this gate — they do not exist in this build.
