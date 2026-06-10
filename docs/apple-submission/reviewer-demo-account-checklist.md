# Reviewer Demo Account Checklist (v1.0.0, build 3)

> Scope: email/password-only release candidate.

Because this release does not include third-party authentication, App Review must be able to complete the review using the provided email/password reviewer account.

## Primary Reviewer Path — Email/Password Only

- [ ] Create the reviewer account with email/password before submission.
- [ ] Pre-verify the reviewer email so no confirmation step blocks App Review sign-in.
- [ ] Confirm there is no email-verification blocker on first sign-in from a fresh device.
- [ ] Test sign-in end-to-end with the exact credentials that will be submitted.
- [ ] Check credential readability: no ambiguous characters (`0/O`, `1/l/I`), no trailing spaces, copy-paste safe.
- [ ] Create a backup reviewer account (also pre-verified and sign-in-tested) in case the primary is locked or deleted.

## Demo Content

- [ ] Seed the reviewer account with at least 2–3 saved scans so the Style Library is not empty.
- [ ] Verify saved items render correctly when opened.

## Privacy & Deletion

- [ ] Verify the Privacy screen and its links work while signed in as the reviewer.
- [ ] Verify the account deletion request flow works (test with the backup account or a throwaway, never the primary reviewer account before review completes).
- [ ] Verify privacy policy and support URLs are live before entering them in App Store Connect.

## Backend Safety

- [ ] Warm the Render backend shortly before submission windows if possible (cold start is 30–60 s).
- [ ] Confirm rate limits cannot lock out the reviewer account during normal review usage.

## After Review

- [ ] Rotate reviewer credentials after review completes.

## Not Included in This Release (future-release note only)

Google Sign-In, Sign in with Apple, OAuth callbacks, Hide My Email, and Apple private relay email handling are not part of this build. No validation items for them are required. If third-party auth ships in a later release, re-add provider sign-in checks and Apple private relay deletion checks at that time.
