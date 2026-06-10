# App Privacy Nutrition Label Prep — K Scan (v1.0.0, build 3)

> Working sheet for App Store Connect → App Privacy answers.
> Scope: email/password-only release candidate on `feature/beta-account-lifecycle`.

Current release authentication scope: email/password only. Google Sign-In, Sign in with Apple, Apple private relay identifiers, and Google OAuth identifiers are not expected for this build unless later code changes reintroduce those providers.

## Data Types Expected in This Release

| Data | Collected | Linked to User | Used for Tracking | Source / Notes |
|---|---|---|---|---|
| Email address | YES | YES | NO | Supabase email/password auth |
| User ID (Supabase auth ID) | YES | YES | NO | Account identity; ties saved content to the account |
| Scan images (photos of clothing/outfits) | YES (processed) | YES | NO | Sent to the analysis backend; saved results retained with the account |
| Saved content (Style Library items, analysis results) | YES | YES | NO | User-created content tied to the account |
| Account deletion request data | YES | YES | NO | Recorded via server-side intake function; processed manually during beta |
| Backend logs / diagnostics | YES (server-side) | Possibly | NO | Render/Supabase server logs; verify retention and whether user IDs appear in logs before filing labels |

## Data Types NOT Expected in This Release

| Data | Status | Reason |
|---|---|---|
| Google account identifier | NOT EXPECTED | Google Sign-In is not in this build (no dependency or config evidence) |
| Apple private relay email identifier | NOT EXPECTED | Sign in with Apple is not in this build |
| OAuth provider IDs / tokens | NOT EXPECTED | No OAuth provider is configured in this build |
| Precise/coarse location | NOT COLLECTED | No location code or permission |
| Contacts, health, financial data | NOT COLLECTED | No such features |
| Advertising data / IDFA | NOT COLLECTED | No ad or attribution SDK present |
| Microphone/audio data | NOT COLLECTED | Microphone explicitly suppressed (`microphonePermission: false`) |
| Shared Room data | NOT INCLUDED | Shared Rooms are not reachable in this release build |
| Dressing Room data | NOT INCLUDED | Dressing Rooms are not reachable in this release build |

## StyleChat / AI Conversation Data

StyleChat is **not included in the current release build**. Do not declare StyleChat conversation data on this release's privacy label. This row is retained for **future-release verification only**: if StyleChat ships later, re-inventory AI conversation content, style memory/personalization context, and third-party model processing before updating the label.

## Final Verification Items (before filing the label)

- [ ] Tracking: `[VERIFY BEFORE SUBMISSION]` confirm no SDK performs cross-app tracking -> "Data Used to Track You: None" expected.
- [ ] IDFA: `[VERIFY BEFORE SUBMISSION]` confirm no dependency reads the advertising identifier -> no ATT prompt, no AppTrackingTransparency usage.
- [ ] ATT: `[VERIFY BEFORE SUBMISSION]` confirm the built app never shows a tracking prompt (physical-device smoke test item).
- [ ] Re-run a dependency inventory on the final lockfile before submission; any new SDK requires revisiting this sheet.
- [ ] Confirm backend log retention and content (whether emails/user IDs appear) to answer "Diagnostics" accurately.
