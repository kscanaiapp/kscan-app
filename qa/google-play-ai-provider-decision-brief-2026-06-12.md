# Google Play AI Provider Decision Brief - 2026-06-12

> Decision-lock brief for Google Submission v2 Prompt 11A. This is not final Play Console Data Safety text and does not mark the Data Safety form ready for submission.

## 1. Baseline Verification

- Branch verified: `release/android-1.0.0`.
- Local HEAD before this pass: `3797b8bf5fd31506b14b41b0e5f5256eec10c00a`.
- Recent required history present: `79ae784`, `3f79470`, `3797b8b`.
- VersionName: `1.0.0`.
- VersionCode: `5` in `app.json` and `android/app/build.gradle`.
- Package ID: `com.kscanai.app`.
- Prompt 10 audit file present: yes.
- Data Safety draft present: yes.
- Store listing draft present: yes.
- Reviewer notes present: yes.
- Store asset checklist present: yes.
- Tracked status before edits: clean.
- Untracked QA/local artifacts: present, ignored, not staged.
- Disallowed commands not run: `expo prebuild`, `expo prebuild --clean`, `eas build`, `eas submit`, push.

## 2. Owner Decisions Received

- First Android release target audience is locked to users 18 and older.
- Owner rationale: StyleChat is powered by Gemini and first release should align with Gemini API age requirements without building age-gating in this release.
- Current Gemini production tier per owner: unpaid Gemini API quota.
- Owner may upgrade Gemini to paid tier after internal testing, but paid tier is not currently confirmed.
- Owner is not pursuing 13+ or 16+ for the first Android release.
- OpenRouter production status is unknown, but owner believes it may be active.
- OpenRouter ZDR enforcement is unknown.
- Supabase account/logging posture is active, but DPA/log retention remain unknown.
- Commerce providers are intended active release flows, but this brief only covers overlap with AI-provider processing.

## 3. Official Provider Documentation Reviewed

Official documentation reviewed on 2026-06-12:

- Gemini API Additional Terms of Service: `https://ai.google.dev/gemini-api/terms`
- Gemini API Data Logging and Sharing: `https://ai.google.dev/gemini-api/docs/logs-policy`
- Gemini Developer API zero data retention: `https://ai.google.dev/gemini-api/docs/zdr`
- OpenRouter Data Collection: `https://openrouter.ai/docs/guides/privacy/data-collection`
- OpenRouter Provider Logging: `https://openrouter.ai/docs/guides/privacy/provider-logging`
- OpenRouter Zero Data Retention: `https://openrouter.ai/docs/guides/features/zdr`
- Supabase DPA: `https://supabase.com/legal/dpa`
- Supabase telemetry/logging: `https://supabase.com/docs/guides/telemetry/logs`
- Supabase Edge Function logging: `https://supabase.com/docs/guides/functions/logging`
- Supabase platform audit logs: `https://supabase.com/docs/guides/security/platform-audit-logs`
- Google Play target audience settings: `https://support.google.com/googleplay/android-developer/answer/9867159`
- Google Play Families policies: `https://support.google.com/googleplay/android-developer/answer/9893335`

Provider-documentation summary:

- Gemini current terms require API/API-client use to avoid under-18 users and under-18-directed API clients. The 18+ Play target-audience decision resolves the first-release under-18 compatibility blocker only if Play Console selects 18+ only and store/app assets are not youth-directed.
- Gemini unpaid services allow Google product-improvement use and human review of submitted inputs/outputs. This blocks no-training, no-human-review, and service-provider-only claims while the production key remains unpaid.
- Gemini paid services are treated differently under the terms: prompts/files/responses are not used to improve Google products, and paid-service prompts/responses are processed under Google's processor DPA, but paid status, billing project, DPA/account terms, and logging posture still require provider dashboard/legal confirmation.
- OpenRouter says prompt/response storage and OpenRouter use of inputs/outputs are opt-in on its side, but provider routing has separate provider policies. ZDR can be enforced globally, per model group/guardrail, or per request. The repo does not prove ZDR enforcement.
- Supabase logs are product/plan dependent. Edge Function invocations can expose request/response data, and custom `console` output appears in function logs. DPA becomes binding only after the owner completes Supabase's DPA process.
- Google Play requires accurate target-audience declarations. Store listing imagery/terminology can affect Google's assessment, and apps including children in their target audience trigger Families requirements.

## 4. 18+ Target Audience Lock

| Target Audience Lock | Status |
|---|---|
| First Android release target audience | 18+ |
| 13-15 selected in Play Console | No |
| 16-17 selected in Play Console | No |
| 18+ selected in Play Console | Yes, required for submission |
| Families / Designed for Children | No |
| Child-directed copy found | No in active Play listing/reviewer copy after safe fixes; legacy privacy-protection references are not target copy |
| Teen-directed copy found | No in active Play listing/reviewer copy after safe fixes |
| Child/teen-directed visual asset risk found | Unknown until final screenshots/graphics are reviewed |
| Store listing alignment needed | Yes, fixed in this pass |
| Privacy policy alignment needed | Unknown; website/privacy-policy owner review remains required |
| Asset checklist alignment needed | Yes, fixed in this pass |
| Required action | In Play Console, select 18+ only, do not join Families, and use adult/no-people visuals with no school, teen, child, or family-directed context |

## 5. Target-Audience Copy and Asset Alignment Scan

Repo scan findings:

- `qa/google-play-store-assets-checklist-2026-06-12.md` previously said the app was "not designed for children under 13" and deferred higher minimum-age selection. This was aligned to 18+.
- `qa/google-play-data-safety-mapping-draft-2026-06-12.md` previously treated target audience as a P0 open decision and mentioned 13+/16+ choices. This was aligned to the owner decision.
- Active store listing/reviewer copy did not market the app to teens, students, children, families, schools, or all ages.
- `app/privacy.tsx`, `services/privacyPolicy.js`, and `docs/privacy-data-management.md` contain existing minor-protection logic/copy for sale/sharing defaults. These are privacy-law controls, not Play target-audience marketing, and were not changed because code/privacy-policy behavior changes are out of scope.
- No screenshots or graphics were generated or reviewed in runtime. Asset risk remains unknown until the final asset set is inspected.

## 6. Gemini Current Posture

| Gemini Current Posture | Status |
|---|---|
| Active in release path | Yes |
| Used for StyleChat | Yes |
| Used for image analysis | Yes |
| Current production tier per owner | Unpaid |
| Paid tier migration available per owner | Yes, after internal testing |
| Raw images/base64 sent | Yes, for image analysis |
| Text prompts/chat messages sent | Yes |
| User IDs/emails sent | No repo evidence that full user IDs or emails are sent to Gemini; user IDs are used server-side for auth/quota/context |
| Logs contain prompts/images/user identifiers | Unknown overall; no raw client/StyleChat custom prompt or image logs found, but server debug/provider preview flags and Supabase invocation logging require owner confirmation |
| Training/product-improvement risk under current unpaid tier | Yes |
| Under-18 API-client compatibility blocker after 18+ selection | Resolved for first Android release if 18+ only is selected and copy/assets are not youth-directed |
| Service-provider-only classification while unpaid | No |
| Required action | Keep Gemini as `UNPAID TIER RISK` until paid tier is confirmed or owner/legal approves conservative unpaid-tier disclosure |

## 7. Gemini Unpaid-Tier Internal-Testing Posture

Internal testing may continue only with a conservative note:

- Use limited testers, preferably confirmed adults.
- Inform testers that prompts, images, chat messages, and model responses may be processed under unpaid Gemini terms.
- Do not tell testers or reviewers that unpaid Gemini has no training, no human review, no retention, or service-provider-only processing.
- Keep sensitive/personal data out of test prompts and images.
- Do not use unpaid-tier posture as final Play Data Safety evidence unless conservative disclosure is explicitly approved.

## 8. Gemini Unpaid-Tier Final-Submission Fallback Branch

Status: `UNPAID TIER RISK - requires conservative Data Safety posture`.

If owner does not upgrade to paid Gemini before final Play submission:

- Data Safety cannot claim Gemini is service-provider-only.
- Data Safety cannot claim no training/product improvement.
- Data Safety cannot claim no human review.
- Data Safety cannot claim AI data is not shared.
- Data Safety must conservatively disclose third-party AI processing.
- Final Play Console submission remains blocked unless owner/legal explicitly approves conservative unpaid-Gemini disclosure.

## 9. Gemini Paid-Tier Migration Gate

| Required verification | Status | Notes |
|---|---|---|
| Cloud Billing active for production Gemini key | PROVIDER DASHBOARD CONFIRMATION REQUIRED | Owner says current tier is unpaid. |
| Production environment uses paid Gemini quota, not unpaid quota | PROVIDER DASHBOARD CONFIRMATION REQUIRED | Must confirm the exact production key/project. |
| DPA / Cloud terms accepted or available | LEGAL REVIEW REQUIRED | Official terms reference Google's processor DPA for paid services, but K Scan acceptance/binding status is not verified. |
| No prompt/image/model-response training for paid API use, per official terms | CONFIRMED | Official paid-service terms support this policy statement; still tied to verifying production paid status. |
| Abuse/security logging posture documented | PROVIDER DASHBOARD CONFIRMATION REQUIRED | Paid services still have limited abuse/security logging unless ZDR is separately approved. |
| Retention window documented | PROVIDER DASHBOARD CONFIRMATION REQUIRED | Official docs say limited periods; project-specific ZDR/log configuration is unverified. |
| 18+ target audience remains locked | CONFIRMED | Owner decision locked; Play Console entry still must select 18+ only. |

## 10. Gemini Under-18 Issue Resolution via 18+ Release Posture

The under-18 Gemini blocker is resolved for the first Android release only as a target-audience/API-client compatibility issue.

This resolution depends on:

- Play Console selecting 18+ only.
- No 13-15 or 16-17 target groups.
- No Families/Designed for Children participation.
- Store listing, screenshots, feature graphic, privacy copy, and reviewer notes not being child-directed or teen-directed.
- StyleChat and AI-powered features being described as intended for adult users.

This does not resolve unpaid-tier data-use/training/human-review risk.

## 11. OpenRouter Production + ZDR Decision Gate

| OpenRouter Decision Gate | Status |
|---|---|
| Active in production | Unknown; owner believes it may be active |
| Used for image analysis | Yes if `USE_OPENROUTER=true` |
| Used for StyleChat | No repo evidence |
| Fallback-only or primary | Unknown; `server.js` routes image analysis through OpenRouter instead of Gemini when enabled |
| ZDR enabled globally | Unknown |
| ZDR passed per request | No repo evidence |
| Restricted to ZDR-compatible endpoints | Unknown |
| Upstream provider route known | Unknown |
| Prompts/images/responses retained without ZDR | Unknown |
| If active without ZDR | Classify as sharing / third-party AI processing risk |
| Required action | Confirm production `USE_OPENROUTER`, model/provider endpoint, account privacy settings, per-request/account ZDR, and provider data policy before service-provider/ZDR-safe classification |

Decision: keep OpenRouter as a P0 blocker until production status and ZDR enforcement are confirmed or OpenRouter is documented inactive for the release.

## 12. Supabase AI Logging Gate

| Supabase AI Logging Gate | Status |
|---|---|
| AI requests pass through Supabase Edge Function | Yes for StyleChat; image analysis uses hosted backend / Expo route, not the StyleChat Edge Function |
| Logs may contain prompts/chat messages | Unknown/possible because Edge Function invocations can include request/response body data; custom logs did not show raw messages |
| Logs may contain image URLs/base64 | No repo evidence for StyleChat; no image/base64 in StyleChat payload |
| Logs may contain user IDs/emails | Partial user/session IDs appear in custom StyleChat logs; Supabase audit/auth logs may include email/IP depending log source |
| Log retention known | No; plan/account dependent |
| DPA/account posture known | No |
| Debug logging enabled in production | Unknown |
| If DPA/log retention unavailable | Conservative disclosure required / owner confirmation required |
| Required action | Confirm Supabase plan, DPA completion, log retention, log body visibility, production debug flags, and whether function invocation logs include StyleChat request bodies |

Decision: keep Supabase AI logging/DPA as a P0 confirmation item for final Data Safety.

## 13. Safe Fixes Applied

Safe fixes were documentation-only.

| File | Issue found | Evidence | Fix applied | Why it is safe | Verification run |
|---|---|---|---|---|---|
| `qa/google-play-ai-provider-decision-brief-2026-06-12.md` | Required Prompt 11A artifact missing | `Test-Path` before edits returned absent for this file | Created this decision brief | New QA doc only; no runtime/config behavior changed | `git diff --check` |
| `qa/google-play-data-safety-mapping-draft-2026-06-12.md` | Target audience still treated as open 13+/16+/other decision | Existing P0 rows referenced under-18 choices | Added 18+ decision addendum and updated owner-review rows | Data Safety remains draft and not final | `git diff --check` |
| `qa/google-play-provider-data-safety-audit-2026-06-12.md` | Prompt 10 target-audience blocker not updated with owner 18+ decision | Prompt 10 final status remained blocked for target audience plus providers | Added Prompt 11A follow-up addendum | Preserves Prompt 10 evidence; narrows only the owner-decision update | `git diff --check` |
| `qa/google-play-store-listing-draft-2026-06-12.md` | Listing did not explicitly lock adult-only release posture | Listing copy was neutral but did not state 18+ | Added 18+ intended-user wording and AI/provider nuance | Store-copy doc only; no Play Console change made | `git diff --check` |
| `qa/google-play-reviewer-notes-2026-06-12.md` | Reviewer notes lacked 18+ / adult AI posture | Existing AI note did not mention target audience | Added target-audience and adult AI reviewer notes | Reviewer doc only; no app behavior changed | `git diff --check` |
| `qa/google-play-store-assets-checklist-2026-06-12.md` | Asset checklist used under-13 framing and lacked required visual guidance | Target audience section said not designed for children under 13 | Replaced with 18+ selection guidance and adult/no-people asset rules | Asset QA doc only; no assets/config changed | `git diff --check` |

No client-side logging redactions were made. Unsafe or ambiguous backend/Edge logging concerns were documented because server/Edge code changes are outside this prompt's safe-fix lane.

## 14. Recommended AI Provider Release Path

Recommended path:

- Lock Play Console target audience to 18+ only.
- Scrub store listing/privacy/reviewer/assets copy for teen/minor/13+/16+ language.
- Internal testing may continue on unpaid Gemini only with unpaid-tier risk documented and 18+ testers.
- Before final Play Console Data Safety submission, either:
  - Path A: Move production Gemini usage to paid tier and confirm DPA/no-training/retention facts.
  - Path B: Keep unpaid Gemini and use conservative Data Safety disclosure for third-party AI processing after owner/legal approval.
- Keep OpenRouter blocked until production status and ZDR enforcement are confirmed or OpenRouter is documented inactive.
- Keep Supabase AI logging blocked until log contents, retention, and DPA/account posture are confirmed.

## 15. Data Safety Implications

- Target Audience Decision: First Android release is intended for users 18 and older only.
- Google Play target age groups should select 18+ only.
- Do not select 13-15 or 16-17 for this release.
- This 18+ posture is selected to align StyleChat/Gemini-powered functionality with Gemini API age requirements without adding age-gating in the first release.
- AI Provider Decision Status: PASS WITH NOTES pending Gemini tier/DPA/logging confirmation, OpenRouter production/ZDR confirmation, and Supabase AI logging confirmation.
- Gemini Current Tier: Owner reports current Gemini usage is unpaid. Internal testing may proceed only with unpaid-tier risk documented. Final Play Console submission requires either paid-tier confirmation or conservative unpaid-tier disclosure.
- Do not mark Data Safety final from this brief.
- Do not claim `no training`, `no retention`, `OpenRouter ZDR active`, `Gemini paid tier confirmed`, or `P0 unblocked`.

## 16. Play Console Readiness Status

- Target audience: READY for owner/operator to enter as 18+ only.
- Families/Designed for Children: READY to answer No, subject to final asset/copy review.
- Data Safety: NOT READY for final submission.
- AI provider declarations: PASS WITH NOTES but unresolved for final Play Console Data Safety.
- Prompt 12 readiness: NOT READY until the selected Gemini path is evidence-backed or owner/legal approves conservative unpaid-tier disclosure.

## 17. Required Owner/Provider/Legal Confirmations

P0 confirmations:

- Confirm Cloud Billing/paid Gemini state for the production Gemini key/project, or explicitly approve conservative unpaid-tier disclosure.
- Confirm Gemini DPA/applicable paid-service data terms, abuse/security logging, retention, and ZDR/log configuration if using paid path.
- Confirm production `USE_OPENROUTER` state. If active, confirm ZDR enforcement and upstream provider route/data policy.
- Confirm Supabase plan, DPA completion, Edge Function invocation logging contents, custom log contents, retention, and production debug flags.
- Confirm final screenshots, feature graphic, and listing assets use adult models or no people and no school/classroom/teen/family/child-directed visual context.
- Confirm website privacy/delete-account/support copy aligns with 18+ release posture and unpaid/paid AI-provider disclosure.

## 18. Recommended Prompt 11B Inputs

Provide these to Prompt 11B:

- Production Gemini key/project billing state: unpaid or paid.
- If paid: billing screenshot or dashboard confirmation, DPA/legal acceptance confirmation, logging/ZDR/retention details.
- If unpaid: owner/legal decision approving conservative Data Safety disclosure.
- Production `USE_OPENROUTER` value and OpenRouter model/provider route.
- OpenRouter account privacy settings, ZDR settings, and any per-request `provider.zdr` implementation.
- Supabase plan, DPA status, log retention, and whether Edge Function invocation logs include request/response bodies for `stylechat-generate`.
- Final asset set or screenshot plan for adult/no-people visual review.
- Website/privacy copy status for 18+ and AI-provider disclosure.

## 19. Final Status

Final status: PASS WITH NOTES - 18+ posture locked, AI provider confirmations remain.

Reason: The owner decision resolves the Gemini under-18 target-audience blocker for the first Android release, and safe doc/copy/asset guidance fixes were applied. Final Play Data Safety remains blocked on Gemini paid-vs-unpaid disclosure path, OpenRouter production/ZDR confirmation, and Supabase AI logging/DPA confirmation.

Prompt 11B can proceed.

Prompt 12 cannot proceed until either paid Gemini facts are confirmed or owner/legal explicitly approves conservative unpaid-Gemini Data Safety disclosure, and OpenRouter/Supabase P0 confirmations are resolved or conservatively disclosed.
