# Google Play Store Listing — K Scan AI

_Last updated: 2026-06-04. Production AAB build completed 2026-06-04. Update this file with every release._

---

# Google Play Store Listing — K Scan AI

*Last updated: 2026-06-04. Production AAB build completed 2026-06-04. Update this file with every release.*

---

## 0. Android Production Build Status

| Field                                  | Value                                                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Production Android AAB build completed | **Yes**                                                                                                      |
| Build date                             | 2026-06-04                                                                                                   |
| Build profile                          | `production`                                                                                                 |
| Artifact type                          | Android App Bundle (.aab)                                                                                    |
| EAS build ID                           | `c9b9a218-6c11-4548-83b0-b8376dc55aa1`                                                                       |
| EAS build URL                          | https://expo.dev/accounts/ams2dad/projects/kscan/builds/c9b9a218-6c11-4548-83b0-b8376dc55aa1                 |
| Artifact download URL                  | https://expo.dev/artifacts/eas/qULQj9kjkP1YGMUWXZbAAD.aab                                                    |
| Branch                                 | `fix/play-store-blockers`                                                                                    |
| Commit                                 | `d479d10`                                                                                                    |
| Credential                             | Uses current default EAS Android production keystore — Build Credentials loFzVVCde6. No secrets stored here. |
| Submission occurred                    | No                                                                                                           |

### Remaining blockers before Play upload

* [ ] Public deletion URL `https://kscan.app/legal/delete-account` not yet live
* [ ] Reviewer test account not yet created and added to Play Console app access notes
* [ ] Google Play listing assets not yet complete (feature graphic 1024×500, phone screenshots)
* [ ] Play Console Data Safety form not yet completed
* [ ] Physical Android smoke test on a real device still required
* [ ] AAB must be uploaded manually to Google Play Internal Testing

---

## 1. App Identity

| Field          | Value                                |
| -------------- | ------------------------------------ |
| App name       | K Scan AI                            |
| Package name   | `com.kscanai.app`                    |
| Version name   | 1.0.0                                |
| Version code   | 1                                    |
| EAS project ID | a075728d-bd77-446f-843d-0f63fd54cc2e |

---

## 2. Short Description (≤ 80 chars)

> Scan fashion inspiration to discover your style and find matching items.

---

## 3. Full Description (≤ 4 000 chars)

K Scan AI is a fashion visual discovery app. Point your camera at an outfit, snap a photo, or upload a fashion image, and K Scan AI derives style attributes — silhouette, color palette, material, and category — to help you understand and refine your personal aesthetic.

**Discover your style**
Scan any clothing item, outfit, or fashion inspiration. K Scan AI identifies key style attributes and presents them in a clean analysis card.

**Save and organize**
Build a Style Library of up to 25 scans. Create Dressing Rooms to organize saved items by occasion, season, or theme.

**Share your looks**
Share a Dressing Room with anyone via a private link. The recipient can preview room items without creating an account. You control the link and can revoke it at any time.

**Privacy you control**
K Scan AI offers clear data choices in the Privacy screen. Sign in to sync preferences across devices. Request a data export, correction, or full account deletion at any time from within the app.

*AI-generated style attributes and product suggestions are for informational purposes only. Prices, availability, and retailer information are not guaranteed. K Scan AI is not affiliated with any fashion brand or retailer.*

---

## 4. Category and Tags

| Field              | Value                                      |
| ------------------ | ------------------------------------------ |
| Primary category   | Lifestyle                                  |
| Secondary category | Shopping                                   |
| Tags               | fashion, style, wardrobe, outfit, clothing |

---

## 5. Content Rating

* No user-to-user communication in the core app (shared rooms are anonymous preview links)
* No mature or violent content
* No gambling
* Likely rating: **Everyone** (ESRB equivalent: E)
* Complete IARC questionnaire at Play Console submission time

---

## 6. Target Audience

* Age 16+ recommended (under-16 sale/sharing protections are enforced in app)
* No child-directed content; do not target children's audience in Play Console
* Appeals to fashion-conscious consumers, style-curious general audience

---

## 7. Ads Declaration

* No third-party ads SDK in the current build
* Declare: "This app contains no ads" in Play Console

---

## 8. App Access for Reviewers

The app requires account creation to access account-level privacy features and Dressing Rooms. Core camera scan, Style Library, and basic Privacy screen browsing are accessible without an account.

**Reviewer credentials (placeholder — fill in before submission):**

| Field    | Value                                                                           |
| -------- | ------------------------------------------------------------------------------- |
| Email    | *TODO: create [reviewer@kscanai.app](mailto:reviewer@kscanai.app) test account* |
| Password | *TODO: set before Play submission*                                              |

**Reviewer instructions:**

1. Install the app. The camera scan screen is the home screen.
2. Tap the camera shutter to scan a fashion item or upload a photo.
3. Review the style analysis card.
4. Navigate to the Style Library tab to view saved scans.
5. Navigate to Dressing Rooms to create and manage rooms.
6. Tap the share icon on a Dressing Room to generate a share link.
7. Tap Settings → Privacy to review privacy controls.
8. From Privacy, tap "Delete Account" to test the deletion request flow (use test account — this submits a real deletion request).

---

## 9. Privacy Policy URL

`https://kscan.app/legal/privacy`

*Required: this page must exist and be publicly accessible before submission.*

---

## 10. Support URL

`https://kscan.app/support`

---

## 11. Account Deletion URL

**Required before Play submission.** Google Play requires a publicly accessible account deletion resource.

Target URL: `https://kscan.app/legal/delete-account`

**Website repo handoff (create this page before submission):**

The page at `/legal/delete-account` must include:

* Product name: K Scan AI
* How to request deletion: sign in to the K Scan AI app → Privacy → Delete Account, OR email [support@kscanai.app](mailto:support@kscanai.app) with subject "Account Deletion Request" and include the email address associated with the account.
* What information is required: email address associated with the K Scan account
* What data is deleted: account record, privacy preferences, saved style scans, dressing room contents, dressing room share links, and all personally linked data
* Retention exceptions: data may be retained where required by law, for fraud prevention, security, or to resolve disputes
* Processing time: deletion requests are processed within 30 days of submission
* Contact: [support@kscanai.app](mailto:support@kscanai.app)

---

## 12. Data Safety — Summary

Complete the full Data Safety form in Play Console. Answers must match the current implementation.

### Data collected and shared

| Data type                                   | Collected? | Shared? | Purpose                                             | Optional?                     |
| ------------------------------------------- | ---------- | ------- | --------------------------------------------------- | ----------------------------- |
| Email address                               | Yes        | No      | Account creation, deletion                          | Required for account features |
| Photos / images                             | Yes        | No      | Fashion style analysis (uploaded for AI processing) | Required for core feature     |
| User-generated content (room titles, notes) | Yes        | No      | Saved to user account                               | Optional                      |
| App activity (scans, library, rooms)        | Yes        | No      | Provide app features                                | Required for core feature     |

### Data not collected

* Location data
* Contacts
* SMS
* Calendar
* Biometric or face geometry data (K Scan does not perform facial recognition, biometric identification, or on-device face filtering; images are uploaded to a cloud AI service for fashion attribute analysis)
* Financial information

### Security practices

* Data is encrypted in transit (HTTPS / TLS for all API and Supabase calls)
* Users can request deletion of their data from within the app

### Shared room disclosure

Dressing Room share links are **user-initiated** and produce a **public-by-token anonymous preview**. The share link is not guessable (it uses a random token) but is not authenticated — anyone with the link can view the room's title, note, item count, and saved item thumbnails with style attributes. The owner can **revoke** the link at any time from the Dressing Room detail screen. Once revoked, the link returns "unavailable." This behavior must be disclosed in Data Safety as user-initiated data sharing that the user can delete.

---

## 13. Android Permissions — Release Inventory

| Permission                                  | Source                         | Justification                                                                            | Keep / Remove  |
| ------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------- | -------------- |
| `android.permission.CAMERA`                 | app.json + manifest            | Core feature: user photographs fashion items                                             | **KEEP**       |
| `android.permission.INTERNET`               | app.json + manifest            | Network calls to AI and Supabase backends                                                | **KEEP**       |
| `android.permission.VIBRATE`                | app.json + manifest            | Haptic feedback on scan completion                                                       | **KEEP**       |
| `android.permission.RECORD_AUDIO`           | Removed (was in main manifest) | Not required; camera plugin configured with `microphonePermission: false`                | **REMOVED**    |
| `android.permission.READ_EXTERNAL_STORAGE`  | Removed (was in main manifest) | Not required; app uses internal storage and image picker only                            | **REMOVED**    |
| `android.permission.WRITE_EXTERNAL_STORAGE` | Removed (was in main manifest) | Not required; no external writes                                                         | **REMOVED**    |
| `android.permission.SYSTEM_ALERT_WINDOW`    | Debug manifests only           | Dev tools overlay; explicitly blocked from release via `src/release/AndroidManifest.xml` | **DEBUG ONLY** |

---

## 14. Known Limitations Before Play Submission

* [ ] Account deletion is request-based (30-day processing window), not immediate erasure. Copy in Privacy screen accurately reflects this. Downstream erasure worker must be implemented.
* [ ] Public deletion URL `https://kscan.app/legal/delete-account` does not yet exist. Website repo must create it before Play submission (see handoff in section 11).
* [ ] Reviewer credentials (test account) must be created and added to this file before submission.
* [ ] Privacy Policy at `https://kscan.app/legal/privacy` must be live and publicly accessible.
* [x] Release signing credentials configured in EAS (Build Credentials loFzVVCde6).
* [x] Production AAB built successfully via `eas build --platform android --profile production` on 2026-06-04.
* [ ] No automated test suite for the full Android build path; manual smoke test on a physical device required before closed testing.
* [ ] `android:allowBackup="false"` is set. Document this for users who expect device backup to preserve app state.

---

## 15. Internal Testing Readiness

* [x] Branch `fix/play-store-blockers` created
* [x] Unjustified permissions removed from release manifest
* [x] `android:allowBackup="false"` set
* [x] Release build type no longer references debug keystore
* [x] `eas.json` production profile targets `app-bundle`
* [x] `.gitignore` excludes keystore/jks files
* [x] EAS credentials configured — Build Credentials loFzVVCde6 (default)
* [x] Production AAB built and available — build c9b9a218 / 2026-06-04
* [ ] Test account created for reviewer notes
* [ ] `https://kscan.app/legal/delete-account` created and live
* [ ] Privacy Policy live at `https://kscan.app/legal/privacy`

---

## 16. Closed Testing Readiness

All Internal Testing items above, plus:

* [ ] Physical device smoke test of camera scan, style analysis, library, dressing rooms, share link, and deletion request flow
* [ ] Verify share link revocation: create link → open anonymous preview → revoke → confirm preview returns unavailable
* [ ] Verify deletion request flow: submit → confirm pending state → sign out occurs

---

## 17. Do Not Submit to Production Until

1. Public deletion URL is live and Google Play account deletion form has been completed with the URL.
2. Privacy Policy URL is live.
3. Reviewer test account credentials are added here and entered in Play Console.
4. ~~EAS production build succeeds with managed credentials~~ — **Done** (build c9b9a218, 2026-06-04).
5. AAB upload and internal test track install verified on at least one real Android device.
6. Data Safety form in Play Console is completed and matches this document.
7. Content rating IARC questionnaire is completed.

