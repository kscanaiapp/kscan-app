# Public Copy Privacy Alignment - 2026-06-12

Scope: Android release candidate `release/android-1.0.0` at local commit `593188195470270be955e5c1c9fdd8e4625fe8b4`.

Runtime copy smoke: not executed.

Passwords/secrets included in this note: no.

## Current Release Truths

- StyleChat is included.
- Dressing Rooms are included.
- Google OAuth is included.
- Apple OAuth is included.
- Account deletion request intake is included.
- Pending-deletion UX/route guard is included.
- Deletion processing is manual/operational and should be described with a 30-day pathway.
- Complete automated deletion should not be claimed yet.
- Supabase Storage cleanup remains a follow-up.
- StyleChat burst usage cleanup remains a follow-up.
- Full export worker coverage remains unverified.
- Local device files are not server-deleted.

## Reviewer-Safe Account Deletion Copy

Users can request account deletion in the app from the Privacy screen or through the web delete-account path. Once a request is submitted, the app marks the account as pending deletion, limits normal app access, and provides a clear sign-out path. Requests are processed through our account lifecycle workflow, generally within 30 days, subject to legal, security, and operational requirements.

## Reviewer-Safe Image Upload Copy

K Scan is intended for clothing-focused images. Users should avoid uploading faces, bystanders, or sensitive personal information.

## Play Console App Access Notes

Play Console reviewer access should use the operator-provided demo/test account credentials. Do not store credentials in repository docs.

## Copy Changes Applied

- `app.js`: added visible camera-screen safety copy for clothing-focused images and avoiding faces, bystanders, or sensitive information.
- `app/privacy.tsx`: softened account deletion modal copy to describe account lifecycle review/processing rather than immediate or guaranteed deletion.
- `app/privacy.tsx`: aligned pending-deletion banner with the route-guard behavior and sign-out path.
- `components/InspirationUploadModal.tsx`: replaced absolute private-only upload copy with image safety guidance.
- `components/AddScanToDressingRoomModal.tsx`: replaced private-only scan save copy with scoped Dressing Room and image safety wording.
- `docs/apple-app-store-submission-runbook.md`: added a release-scope warning and replaced stale Android-RC contradictions around OAuth, StyleChat, and Dressing Rooms.
- `docs/app-review-information-template.md`: added a release-scope warning and replaced stale review notes that said Apple/Google auth and photo-library import were not included.
- `qa/account-lifecycle-release-readiness-2026-06-12.md`: updated the stale-doc note so it reflects this copy-alignment pass.

## Copy Overclaim Audit

- Immediate deletion: no active app copy found; QA note contains "do not claim" warning language only.
- Fully automated deletion: no active app copy found; QA note contains "do not claim" warning language only.
- Complete deletion: no active app copy found; QA note contains "do not claim" warning language only.
- All data deleted: no active app copy found.
- On-device-only processing/no cloud processing: no active app copy found.
- Automatic face/bystander blurring: no active app copy found.
- Zero-knowledge fully live: no active app copy found.
- StyleChat/Dressing Rooms not included: stale Apple docs found and corrected with warning banners.
- Google/Apple auth not included: stale Apple docs found and corrected with warning banners.
- Vague absolute privacy/security claims: upload modal private-only language was softened.

## Website Follow-Up

Website repo found at `C:\Users\jsmit\kscan-website`, but tracked status was not clean, so no website files were edited in this pass.

Required website copy follow-ups:

- `app/legal/delete-account/page.tsx`: replace stale line saying the current iOS App Store submission build does not include StyleChat, Dressing Rooms, shared-room links, Google OAuth, or Apple OAuth. Suggested wording: "The current Android release candidate includes StyleChat, Dressing Rooms, token-based shared-room previews, Google OAuth, Apple OAuth, and account deletion request intake. Deletion requests are processed through the account lifecycle workflow, generally within 30 days, subject to legal, security, and operational requirements."
- `app/privacy/page.tsx`: replace stale line saying the current iOS App Store submission build does not include screenshot upload, Dressing Rooms, shared rooms, StyleChat, or style-board uploads. Suggested wording: "The current Android release candidate includes camera scans, photo-library inspiration uploads, Dressing Rooms, shared-room previews, StyleChat, privacy controls, and account lifecycle request paths."
- `app/page.tsx`: update roadmap copy that still presents Dressing Rooms and saved-photo workflows as excluded from the current submission build. Suggested wording: "Dressing Rooms and StyleChat are included in the Android release candidate; screenshot and video workflows remain future scope unless separately enabled."
- `app/beta/page.tsx`: update roadmap labels for Dressing Rooms and StyleChat if this page is intended to describe the current Android RC. Suggested wording: "Included in Android RC" instead of roadmap-only.
- `public/llms.txt` and `public/llms-full.txt`: remove instructions that StyleChat, Dressing Rooms, or Share by Link are not part of the current build. Suggested wording: "The Android RC includes StyleChat, Dressing Rooms, and token-based Share by Link previews."
- `public/docs/KSCAN_FirstLaunch_Modal_Copy.md`: replace "We process your images to generate recommendations, then delete them" with scoped retention wording. Suggested wording: "K Scan processes clothing-focused images to provide scan, style, and shopping features. Retention and deletion depend on the account lifecycle and operational requirements."

## Data Safety Implications

- Data Safety finalization remains deferred.
- No complete automated deletion claim should be made.
- Deletion wording should stay aligned with a generally-within-30-days operational path.
- Local-device scan files are not server-deleted.
- Supabase Storage object cleanup remains a follow-up.
- StyleChat burst usage cleanup remains a follow-up.
- AI provider/runtime retention terms remain a follow-up.

## Deferred Items

- Play Console versionCode history check.
- Data Safety finalization.
- AI provider retention/terms verification.
- Storage cleanup processor enhancement.
- StyleChat burst usage cleanup enhancement.
- Physical-device smoke test.
- Final AAB/internal-track validation.
