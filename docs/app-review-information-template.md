# K Scan App Review Information Template

Last updated: 2026-06-12

Use this template when filling App Store Connect App Review Information. Do not commit real reviewer passwords or Apple account secrets to this repository.

## Contact Information

- First name:
- Last name:
- Phone number:
- Email:

## Reviewer Account

- Username or email:
- Password: enter directly in App Store Connect only
- Account status: active, email-confirmed, not pending deletion
- Region/country:
- Notes:

## Review Notes

```text
This release uses email/password authentication only. Sign in with Apple, Google Sign-In, subscriptions, in-app purchases, ads, tracking, push notifications, location, microphone, and photo library import are not part of this build.

To review the app:
1. Sign in with the reviewer email/password above.
2. Allow camera access when prompted.
3. Capture a clothing item or outfit for scan analysis.
4. Save a result to the local library, then delete it from the library.
5. Open Privacy controls to review privacy settings, export/correction request entry points, and Delete Account.

Users can request account deletion in the app from Privacy > Delete Account. The request is recorded server-side, the account is marked pending deletion, and pending-deletion accounts are blocked from normal app use. K Scan processes deletion requests manually using a service-role Supabase operator script and completes eligible requests within 30 days.
```

## Pre-Submission Checks

- [ ] Reviewer account can sign in on the exact TestFlight build.
- [ ] Reviewer account has completed email confirmation if Supabase requires it.
- [ ] Reviewer account is not already in `pending_deletion`.
- [ ] Camera permission prompt appears with the expected purpose text.
- [ ] No microphone, photo library, location, ATT, push, payment, subscription, or ad prompt appears.
- [ ] Privacy URL works: `https://kscan.app/legal/privacy`.
- [ ] Support URL works: `https://kscan.app/support`.
- [ ] Account deletion URL works: `https://kscan.app/legal/delete-account`.
