# TestFlight — What to Test (v1.0.0, build 3)

> Pasted into TestFlight → Test Information → What to Test.
> Scope: email/password-only release candidate.

## Authentication

This TestFlight build uses email/password authentication only. Do not test Google Sign-In or Sign in with Apple unless those options appear in a later build.

- Create a new account with email/password (email confirmation may be required — complete it from the email link).
- Sign in with an existing account.
- Sign out and sign back in.
- Force-quit the app and relaunch: the session should persist without re-entering credentials.
- Password reset: request a reset email and complete it via the link (opens the app's auth callback).

## Home

- Home screen loads after sign-in.
- Primary scan entry point is visible and responsive.

## Scan

- Camera permission prompt appears on first scan with the expected description.
- Denying then re-enabling camera permission in Settings recovers gracefully.
- Capture a photo of a clothing item or outfit.
- Loading/analyzing state displays while the backend processes.

## Results

- AI style analysis renders correctly and is readable.
- Product links open correctly.
- Saving a result works.

## Style Library

- Saved scans appear in the library.
- Reopening a saved item displays its details.

## Privacy Controls

- Privacy screen opens; privacy policy, terms, and support links work. `[VERIFY LIVE BEFORE SUBMISSION]`
- Privacy preferences (if shown) persist across app restarts.

## Account Deletion

- The deletion request flow completes and shows confirmation.
- (Testers: use a throwaway account for this.)

## Known Limitation — Backend Cold Start

The analysis backend may cold-start after inactivity; the first scan can take 30–60 seconds or time out. Retry once before filing a bug.

## Not Included in This Release Build

StyleChat is not included in this release build — do not test it. Dressing Rooms and Shared Rooms are likewise not present in this build; any references to them belong to future releases.

## Reporting

Report crashes, hangs, unexpected permission prompts (especially microphone, location, or tracking — none should ever appear), and any screen where the UI is unusable.
