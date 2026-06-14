# Google Play Store Assets Checklist - 2026-06-12

Scope: Android release candidate `release/android-1.0.0` at local commit `4b93bda20d824c285910eff201d1a7bd0fd0a3d6`.

Passwords/secrets included in this note: no.

Do not use this note to finalize the Play Console Data Safety form.

## Required Store Text

- [x] App name: `K Scan`
- [x] Short description draft: see `qa/google-play-store-listing-draft-2026-06-12.md`
- [x] Full description draft: see `qa/google-play-store-listing-draft-2026-06-12.md`
- [x] What's new draft, if required: see `qa/google-play-store-listing-draft-2026-06-12.md`
- [x] Privacy Policy URL: `https://kscan.app/legal/privacy`
- [x] Delete Account URL: `https://kscan.app/legal/delete-account`
- [x] Support URL: `https://kscan.app/support`

## Website URL Verification

Checked on 2026-06-12 with `Invoke-WebRequest`.

| URL | Status | Alignment note |
|-----|--------|----------------|
| `https://kscan.app/legal/privacy` | 200 confirmed | Page describes backend processing, account/privacy infrastructure, no active on-device face-blur claim, account deletion requests, and 30-day processing language. |
| `https://kscan.app/legal/delete-account` | 200 confirmed | Page describes in-app/email deletion requests, non-immediate deletion, StyleChat/Dressing Rooms deletion scope, and 30-day processing language. Owner should review storage-cleanup caveats before final Data Safety wording. |
| `https://kscan.app/support` | 200 confirmed | Page describes support, account deletion help, data export/correction help, and 30-day deletion processing language. |

No stale "StyleChat not included" or "Dressing Rooms not included" contradiction was observed in the fetched page content. Because Supabase Storage cleanup remains a follow-up, final owner review should confirm whether the delete-account page needs an additional storage-object caveat before final Play Console/Data Safety entry.

## Reviewer Access

- [ ] Demo/test account available.
- [ ] Credentials entered only in Play Console.
- [ ] Credentials not committed to repo.
- [ ] Disposable reviewer account available for deletion-path testing if possible.
- [ ] Primary demo account not used for destructive deletion testing if needed for multiple review rounds.

## Screenshots Needed

Screenshot creation is deferred to the operator/designer. This packet does not generate screenshots via emulator, simulator, or physical device.

- Home screen.
- Scan/camera flow with clothing-only safety guidance.
- StyleChat.
- Dressing Rooms.
- Library/saved style ideas.
- Privacy screen.
- Pending-deletion banner, if using a disposable account.

### Screenshot / Visual Target-Audience Guidance

- Screenshots and visual assets should use adult models or no people.
- Avoid school, classroom, teen-bedroom, youth-sports, or child/family-directed visual contexts.
- Avoid copy that suggests teen, student, child, family, all-ages, 13+, or 16+ use.
- 18+ target audience does not imply mature content; it reflects provider-policy and commerce/privacy scoping.
- Users should upload clothing-focused images; do not show surveillance, facial recognition, biometric identification, or identifying-people use cases.

## Graphic Assets

- [ ] App icon.
- [ ] Feature graphic.
- [ ] Phone screenshots.
- [ ] Tablet screenshots only if the app UI is optimized for tablets.
- [ ] Phone-only for initial release, unless operator confirms tablet-optimized assets are available.

## Policy / Support URLs

- Privacy Policy URL: `https://kscan.app/legal/privacy` - confirmed 200.
- Delete Account URL: `https://kscan.app/legal/delete-account` - confirmed 200.
- Support URL: `https://kscan.app/support` - confirmed 200.

## Content Rating / Target Audience / Ads / Pricing Notes

### Content Rating Draft Notes

Prepare Play Console content rating answers from current implementation facts only:

- Lifestyle / fashion / shopping-style utility.
- No gambling.
- No violence.
- No sexual content.
- No alcohol/tobacco/drug promotion.
- No persistent public feed verified.
- User-generated content exists in private StyleChat and user-controlled Dressing Rooms.
- In-app report/block is not verified; support path exists at `https://kscan.app/support`.
- Final IARC answers must be entered and verified by the operator in Play Console.

Do not claim a final content rating from this packet.

### Target Audience Draft Notes

```text
Intended audience: users 18 and older interested in fashion, clothing inspiration, wardrobe organization, and style discovery.
```

```text
K Scan AI is not directed to children or minors.
```

```text
Google Play target age groups: select 18+ only. Do not select 13-15 or 16-17 for this first Android release. Do not participate in Families / Designed for Children.
```

```text
The 18+ posture is selected to align StyleChat/Gemini-powered functionality with Gemini API age requirements without adding age-gating in the first release. It does not mean the app contains mature content.
```

### Ads Declaration Draft Notes

```text
This app does not contain ads.
```

No advertising SDKs were detected in prior package scans. If package inspection later finds an ad SDK, revisit this declaration.

### Pricing / IAP Draft Notes

```text
No paid features, subscriptions, or in-app purchases are included in this release candidate unless the operator confirms otherwise.
```

Payment/IAP reference scan on 2026-06-12:

- Command: `Select-String -Path package.json -Pattern "iap", "in-app", "purchase", "billing", "revenuecat", "stripe", "adapty", "superwall"`
- Result: no matches.

## Data Safety Pre-Mapping Notes

- Camera/images are used for app functionality.
- User-generated StyleChat text is used for app functionality/personalization.
- Dressing Room content is user-created and private by default.
- Account/profile/auth data is used for account management and app functionality.
- Usage counters are used for service reliability and abuse prevention.
- No tracking/ad SDKs were detected in prior package scans.
- Deletion request path exists.
- Complete automated deletion is not claimed.
- Final Play Console Data Safety answers are canonical in `qa/google-play-data-safety-final-answers-2026-06-12.md`.
- Provider retention/terms still require P1 owner/provider confirmation; conservative disclosure covers Play Console entry readiness.

Do not fill the Play Console Data Safety form from this asset checklist. Use the final answer packet and `qa/google-play-console-entry-checklist-2026-06-12.md`.

## Final Checks Before Upload

- [x] versionCode 5 confirmed in `app.json`.
- [x] versionCode 5 confirmed in `android/app/build.gradle`.
- [x] versionName 1.0.0 confirmed.
- [x] Package/applicationId `com.kscanai.app` confirmed.
- [x] Production EAS profile remains store distribution with `app-bundle`.
- [x] AAB not yet built in this prompt.
- [x] Data Safety final answer packet ready; Play Console form not yet submitted.
- [x] Physical-device smoke COMPLETE — see `qa/final-release-smoke-2026-06-14.md` (Samsung SM-S936U, Android 16, PASS WITH NOTES, 2026-06-14). ~~Physical-device smoke not yet complete.~~
- [x] Runtime smoke COMPLETE (physical device, 2026-06-14). AAB build and internal-track upload remain owner actions. ~~Runtime smoke and AAB/internal-track validation remain deferred.~~
- [ ] Website/legal source should receive final owner review before owner go/no-go because storage cleanup remains a deletion follow-up.

## Release Decision

STORE ASSET CHECKLIST STATUS: PASS WITH NOTES - SAFE FOR OWNER REVIEW BEFORE PLAY CONSOLE ENTRY
