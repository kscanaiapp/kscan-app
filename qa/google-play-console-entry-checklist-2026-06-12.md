# Google Play Console Entry Checklist - 2026-06-12

> Google Submission v2 - Prompt 13. Operator-facing checklist for entering K Scan AI
> release `1.0.0` / versionCode `5` in Google Play Console.
>
> Source of truth: `qa/google-play-data-safety-final-answers-2026-06-12.md`.
> This checklist does not build, upload, submit, or update Play Console.

Last updated: June 12, 2026.

## 1. Release identity

- App name: `K Scan`
- Package ID / applicationId: `com.kscanai.app`
- Version name: `1.0.0`
- Version code: `5`
- Branch verified for Prompt 13: `release/android-1.0.0`
- Canonical Prompt 12 commit verified: `b6bca65e49c928d804ac304574218b1bebee165b`
- Build/upload status: AAB upload not performed in Prompt 13.

## 2. Canonical source documents

Use these repo files while entering Play Console:

- Data Safety final answers: `qa/google-play-data-safety-final-answers-2026-06-12.md`
- Executive readiness lock: `qa/google-play-submission-readiness-lock-2026-06-12.md`
- Provider posture: `qa/google-play-provider-classification-lock-2026-06-12.md`
- Store listing copy: `qa/google-play-store-listing-draft-2026-06-12.md`
- Reviewer notes: `qa/google-play-reviewer-notes-2026-06-12.md`
- Assets checklist: `qa/google-play-store-assets-checklist-2026-06-12.md`
- Prompt 13 readiness report: `qa/google-play-prompt-13-readiness-report-2026-06-12.md`
- DOCX/staging reconciliation: `qa/google-play-data-safety-docx-reconciliation-2026-06-12.md`

Older Prompt 10/11 staging docs and any owner-provided/staging DOCX with `NOT FINAL`,
`BLOCKED`, or `To be confirmed` status are superseded for Play Console entry by the
committed Prompt 12 final answer packet.

## 3. Data Safety entries

- Data collection: `Yes`
- Conservative disclosure: `Yes`
- Encrypted in transit: `Yes`
- Deletion request mechanism: `Yes`
- Photos/images: collected `Yes`; shared `Yes` under OpenRouter Gate C conservative disclosure.
- StyleChat messages: collected `Yes`; shared `No` under paid-Gemini service-provider framing.
- Email / User IDs / OAuth account data: collected `Yes`; service-provider/auth-provider context.
- Advertising ID: not collected.
- Location: not collected.
- Audio: not collected.
- Contacts, calendar, financial, health, and web browsing history: not collected.
- Do not claim ephemeral processing, end-to-end encryption, zero-knowledge, no retention, ZDR, or fully automated deletion.

Official reference: [Google Play Data safety section](https://support.google.com/googleplay/android-developer/answer/10787469?hl=en).

## 4. Target Audience / Families entries

- Target age group: select `18+` only.
- Do not select `13-15` or `16-17`.
- Families / Designed for Children: do not participate.
- App directed to children: `No`.
- 18+ posture reflects AI-provider, commerce, and privacy scoping; it does not imply mature content.

Official reference: [Target audience and app content](https://support.google.com/googleplay/android-developer/answer/9867159?hl=en).

## 5. Privacy Policy URL

- Enter: `https://kscan.app/legal/privacy`
- Prompt 12 reported the live page as consistent with conservative AI disclosure.
- P1 / LEGAL REVIEW REQUIRED: confirm the full privacy policy PDF remains aligned with the live notice page and AI subprocessors before final owner go/no-go.

Official reference: [Google Play User Data policy](https://support.google.com/googleplay/android-developer/answer/10144311?hl=en).

## 6. Account deletion URL

- Enter: `https://kscan.app/legal/delete-account`
- In-app path: Privacy screen account deletion request path.
- Do not claim instant deletion.
- Do not claim complete automated deletion.
- Use the 30-day operational processing posture from Prompt 12.

Official reference: [Account deletion requirements](https://support.google.com/googleplay/android-developer/answer/13327111?hl=en).

## 7. Ads declaration

- Ads declaration: `No ads`
- Advertising ID: not collected.
- No `AD_ID` permission was found in Android config/manifest during Prompt 13.

## 8. Content rating questionnaire notes

- Category posture: lifestyle / fashion / shopping-style utility.
- No gambling, violence, sexual content, alcohol/tobacco/drug promotion, or public feed verified.
- User-generated content exists in private StyleChat and user-controlled Dressing Rooms.
- Support path exists: `https://kscan.app/support`
- Final IARC content rating must be completed by the Play Console operator.

## 9. App access / reviewer notes

- Use `qa/google-play-reviewer-notes-2026-06-12.md`.
- Enter reviewer credentials only inside Play Console.
- Do not commit real passwords or production credentials.
- Use a disposable account for destructive deletion testing when possible.
- Include the neutral AI Processing Reviewer Note from the reviewer notes file.

## 10. Store listing entry checklist

- App name: `K Scan`
- Short description: choose one option from `qa/google-play-store-listing-draft-2026-06-12.md`.
- Full description: use the 18+-aligned draft from the same file.
- What's New: use version `1.0.0` / versionCode `5` notes if Play Console requests release notes.
- Avoid claims about minors, families, smart glasses, voice, AR, virtual try-on, headless checkout, zero-knowledge, ZDR, no retention, all processing on-device, automatic face blur, or complete automated deletion.

## 11. Screenshot / asset checklist

- Use `qa/google-play-store-assets-checklist-2026-06-12.md`.
- Screenshots should use adult models or no people.
- Avoid school, classroom, teen-bedroom, youth-sports, family, child-directed, or all-ages contexts.
- Required operator assets remain app icon, feature graphic, phone screenshots, and optional tablet screenshots only if tablet-optimized assets exist.

## 12. AAB upload gate

- Do not upload an AAB until owner explicitly approves.
- Prompt 13 verified repo config only; it did not build or upload.
- Before upload, inspect the final built/merged manifest and confirm it still contains only expected permissions.
- Confirm the AAB package is `com.kscanai.app`, versionName `1.0.0`, versionCode `5`.
- AAB Build Gate: `REPO-READY / PENDING OWNER`
- Actual AAB build: `PENDING OWNER after minor UX/UI polish`

Official reference: [Prepare and roll out a release](https://support.google.com/googleplay/android-developer/answer/9859348?hl=en).

## 13. Internal testing track gate

- Create or edit the internal testing release only after the AAB is ready.
- Add the AAB to the track, name the release, enter release notes, and review Play Console warnings/errors.
- Do not roll out or submit until Play Console entries, assets, app access, content rating, and owner go/no-go are complete.

## 14. VersionCode / Play Console version history check

- Repo versionCode is `5`.
- Play Console version history is not repo-verifiable.
- Status: `PLAY CONSOLE OWNER CONFIRMATION REQUIRED`.
- Before upload, confirm versionCode `5` has not already been used in any Play Console track.
- If versionCode `5` is already used, stop and request a separate build/versioning prompt; do not bump it in Prompt 13.

Official reference: [App update/version code requirements](https://support.google.com/googleplay/android-developer/answer/9859350?hl=en).

## 15. Final owner go/no-go checklist

- [ ] Data Safety entered from the Prompt 12 final answer packet.
- [ ] Target audience set to 18+ only; Families not selected.
- [ ] Privacy Policy URL entered.
- [ ] Account deletion URL entered.
- [ ] Ads declaration set to no ads.
- [ ] Content rating completed.
- [ ] App access / reviewer notes entered.
- [ ] Store listing copy entered.
- [ ] Screenshots and feature graphic reviewed for 18+ alignment.
- [ ] Play Console versionCode history checked.
- [ ] Minor UX/UI polish completed or explicitly waived by owner.
- [ ] AAB built and merged manifest inspected.
- [ ] Internal testing track release reviewed.
- [ ] Owner gives final go/no-go.

## Final checklist status

Prompt 13 Status: `PASS WITH NOTES`

Play Console Entry Ready: `YES`

AAB Build Gate: `REPO-READY / PENDING OWNER`

Submission Ready: `PENDING OWNER`
