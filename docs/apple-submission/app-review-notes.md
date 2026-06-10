# App Review Notes — K Scan (v1.0.0, build 3)

> Scope: email/password-only release candidate on branch `feature/beta-account-lifecycle`.
> These notes are pasted into App Store Connect → App Review Information → Notes.

## Authentication

This release uses email/password authentication for reviewer access.
Google Sign-In and Sign in with Apple are not included in this release build.
Because this build does not offer third-party sign-in, Sign in with Apple is not required for this release.

- The app requires authentication; there is no guest mode.
- The reviewer demo account is pre-verified — no email confirmation step will block sign-in.

## Demo Account

- Email: `[TBD BEFORE SUBMISSION]`
- Password: `[TBD BEFORE SUBMISSION]`

Credentials will be created, pre-verified, and sign-in-tested before submission, and rotated after review completes.

## Reviewer Path

1. Sign in with the demo account (email/password).
2. Allow camera permission when prompted.
3. Scan a clothing item or outfit from the Home screen.
4. Review the AI style analysis results.
5. Save a result, then open the Style Library.
6. Open Privacy controls (privacy policy, terms, support, account deletion).

## Camera Usage

K Scan uses the camera to photograph the user's outfit or clothing item for AI style analysis. This is the app's core feature. The purpose string in the build matches this exactly.

## Microphone

This iOS release does not use the microphone. The iOS app config does not declare a microphone usage description, and no microphone prompt should ever appear.

## Backend Cold-Start Note

The analysis backend is hosted on Render. The first request after a period of inactivity may cold-start and take 30–60 seconds. If a scan times out on the first attempt, please retry once.

## Account Deletion

- In-app path: Privacy screen -> Delete Account. `[VERIFY BEFORE SUBMISSION]`
- Deletion requests are routed through a server-side function and recorded immediately.
- During beta, deletion requests are processed manually, with a completion target within 30 days of the request.
- A web deletion path is also documented on the public site.

## Privacy Policy / Support

- Privacy policy URL: as listed in App Store Connect metadata (served from the K Scan website). `[VERIFY LIVE BEFORE SUBMISSION]`
- Support URL: as listed in App Store Connect metadata. `[VERIFY LIVE BEFORE SUBMISSION]`
- Terms of service: linked from the in-app Privacy screen. `[VERIFY LIVE BEFORE SUBMISSION]`

## Export Compliance

K Scan uses standard HTTPS network encryption only. The iOS config sets `ITSAppUsesNonExemptEncryption` to `false`; answer App Store Connect export-compliance questions consistently with that setting after the final build is selected.

## Not Included in This Release

StyleChat, shared/dressing rooms, photo library import, third-party sign-in, push notifications, location, tracking/advertising, and in-app purchases are not part of this build. If review encounters references to these anywhere, treat them as future-release material.
