# Google Play Data Safety Mapping Draft - 2026-06-12

> Draft only. Not a finalized Play Console Data Safety submission. Owner review is required before any value here is entered into Play Console.

## Scope

- App: K Scan (fashion / clothing scan and style app)
- Package: `com.kscanai.app`
- VersionName: `1.0.0`
- VersionCode: `5`
- Branch / commit: `release/android-1.0.0` at `3f79470463611e89f17f76251fb71f65c9f49cb3`
- Track readiness: draft only, not submitted
- Production build profile: app-bundle, `distribution: store` (`eas.json`)
- Source evidence: prior QA files from Prompts 3-8, Prompt 10 provider/data-safety audit, plus read-only config/manifest/package/code scans performed in this pass.

### Evidence Files Reviewed

- `qa/account-lifecycle-release-readiness-2026-06-12.md` (deletion coverage matrix; cross-referenced, not recreated)
- `qa/public-copy-privacy-alignment-2026-06-12.md`
- `qa/stylechat-release-readiness-2026-06-12.md`
- `qa/google-play-store-listing-draft-2026-06-12.md`
- `qa/google-play-reviewer-notes-2026-06-12.md`
- `qa/google-play-store-assets-checklist-2026-06-12.md`
- `docs/privacy-data-management.md`
- `docs/app-review-information-template.md` (carries release-scope warning; Apple-era, not source-of-truth)
- `docs/apple-app-store-submission-runbook.md` (carries release-scope warning; Apple-era, not source-of-truth)

### Config / Scan Evidence Snapshot

- Active Android permissions (`app.json`, `android/app/src/main/AndroidManifest.xml`): `CAMERA`, `INTERNET`, `VIBRATE`.
- Blocked / removed permissions: `RECORD_AUDIO` (blocked in `app.json`); release manifest removes `SYSTEM_ALERT_WINDOW`, `RECORD_AUDIO`, `READ_EXTERNAL_STORAGE`, `WRITE_EXTERNAL_STORAGE` via `tools:node="remove"`.
- No `LOCATION`, no `CONTACTS`, no `com.google.android.gms.permission.AD_ID` present.
- `android:allowBackup="false"` in the main manifest (Android auto-backup disabled).
- No advertising/analytics/tracking SDKs detected in `package.json` (no firebase, admob, segment, fbsdk/facebook, branch, appsflyer, adjust, amplitude, mixpanel).
- No payment/IAP SDKs detected in `package.json` (no revenuecat, stripe, billing, iap, adapty, superwall).
- No Advertising ID / AAID code references found in `app`, `components`, `hooks`, `services`, `constants`, `android`, `package.json`, `app.json`.
- AI image analysis path: `app/api/analyze+api.js` calls Google Gemini (`generativelanguage.googleapis.com`, `gemini-2.0-flash-exp`) using `process.env.GEMINI_API_KEY` (server-side env, not a hardcoded client literal).
- Backend shopping/search Edge Functions invoked from client services: `nike-shoe-details`, `search-vinted-secondhand`, `kickscrew` (RapidAPI), product-search/deals, try-on. These can forward style/scan/search context to third-party shopping/search providers via the backend.
- Cloud image storage: Supabase Storage `style-library-images` bucket, `{userId}/...` paths (`services/styleObjects.ts`).
- Secrets boundary scan: no hardcoded provider keys, service-role tokens, or admin credentials found in the mobile client. The only provider-key reference is `process.env.GEMINI_API_KEY` inside a server API route.

### Prompt 10 Provider/Data Safety Audit Addendum

- Cross-reference: `qa/google-play-provider-data-safety-audit-2026-06-12.md`.
- Hosted image analysis uses `server.js` and sends base64 clothing image content plus prompt/instruction text to Google Gemini. Final Data Safety sharing/service-provider classification is blocked on Gemini account tier, DPA, retention, training/data-use settings, and abuse-monitoring/log review.
- `server.js` also contains a conditional OpenRouter image-analysis path gated by `USE_OPENROUTER=true` and `OPENROUTER_API_KEY`. If enabled, it sends the image as a base64 data URI in an `image_url` field. Production env must prove this path is disabled or complete provider review.
- StyleChat sends user chat text, bounded recent message history, and compact style context/memory to Gemini through `stylechat-generate`; no StyleChat image/base64 payload was found. Provider retention/training and Edge log retention remain P0 owner/provider blockers.
- Secondhand search is active at the client level through `search-vinted-secondhand`, but the tracked release source-of-truth for the deployed Edge Function/provider is unresolved in this pass. Do not assume Vinted/Apify/provider retention or service-provider status without owner confirmation.
- KicksCrew/RapidAPI is conditional on KicksCrew product URL enrichment. Product-search/deals, try-on, and Nike RapidAPI paths exist but no active release caller was verified for the latter three; keep them inactive or review provider terms before enabling.
- No advertising/tracking SDKs, `AD_ID` permission, or Advertising ID code were found in repo evidence. Owner must still confirm no off-repo analytics, affiliate attribution, targeted advertising, or commercial tracking arrangement exists.
- Backend/Edge/Supabase logs require owner review for production debug flags, partial identifiers, search-query logging in conditional functions, IP/session metadata, retention, and DPA status.
- Target audience remains P0 owner/legal review: repo evidence says the app is not designed for children under 13, but Gemini API terms require review before selecting any under-18 Play audience while AI flows are active.

## Executive Summary

This draft maps the release candidate's known data collection, sharing, security, and deletion behavior for Google Play Data Safety preparation. It should be reviewed by the owner before entering final answers in Play Console.

## Data Collection Matrix

| Data Type | Collected? | Source / Feature | Purpose | Shared? | Stored? | Ephemeral? | Deletion coverage | Notes |
|-----------|------------|------------------|---------|---------|---------|------------|-------------------|-------|
| Email address / auth identifier | Likely yes | Supabase Auth sign-in (email/password and OAuth) | Account, sign-in, app functionality | Provider/auth review required | Yes (backend) | No | DB cascade on `auth.users` delete | Identifies the account; deletion via manual processor + cascade. |
| OAuth provider account identifier | Likely yes | Google OAuth, Apple OAuth (`app/auth/index.tsx`) | Sign-in / account linkage | Provider/auth review required | Yes (backend) | No | Cascade via `auth.users` | Provider acts as identity service; minimal scopes should be confirmed. |
| User ID / profile record | Likely yes | `profiles`, `privacy_settings` | Account, personalization, privacy controls | Service-provider processing (Supabase) | Yes (backend) | No | FK cascade | Includes `age_group`, sale/sharing opt-out state. |
| OAuth profile fields (name, photo URL, locale) | Conditional / owner must verify | Google/Apple OAuth scopes | Account display / personalization if requested | Provider/auth review required | Depends on scopes | No | Cascade with profile | Depends on actual requested scopes; verify before final entry. |
| Scan / library metadata | Likely yes | Camera scan + library | Core scan/style functionality | Service-provider processing | Local + cloud rows depending on surface | Partly | Account rows cascade; local cache device-only | Some saved-scan JSON is device-local and not server-deleted. |
| Clothing / image uploads | Likely yes | Camera scans, inspiration uploads, room images | Scan, style, room features; AI analysis | Sharing/provider review required (AI + storage) | Yes (Supabase Storage `style-library-images`) | No (stored) | Rows cascade; storage object removal NOT verified | Images sent to Gemini for analysis; storage object cleanup is a follow-up. |
| StyleChat messages | Likely yes | StyleChat sessions/messages | Conversational styling feature | Sharing/provider review required (AI) | Yes (`style_chat_sessions`, `style_chat_messages`) | Not verified | FK cascade | Text may reach an AI provider; provider terms unverified. |
| Style Memory / personalization signals | Likely yes | `style_memory_events`, in-memory cache | Personalization | Service-provider processing | Yes (events table); cache cleared on sign-out | Cache only | DB cascade | Verify no persistent summaries outside `style_memory_events`. |
| Dressing Room items | Likely yes | `dressing_rooms`, `dressing_room_items`, `looks`, `look_items` | Organize style inspiration | User-initiated sharing only when shared | Yes (backend) | No | FK/cascade | Private by default. |
| Dressing Room messages / reactions | Likely yes | `dressing_room_messages`, `dressing_room_item_reactions` | Room collaboration | Visible to invited room participants | Yes (backend) | No | FK/cascade | Not exposed in public previews. |
| Inspiration uploads | Likely yes | `inspiration_items`, `dressing_room_inspiration_items`, storage paths | Style inspiration | Service-provider/storage | Yes (backend + storage) | No | Rows cascade; storage object removal NOT verified | Storage cleanup follow-up. |
| Public share tokens / previews | Conditional (user-initiated) | `room_shares`, public preview RPC | User-chosen sharing of a room preview | Yes, by explicit user action | Yes (backend) | No | Cascade from room/owner | Verify preview unavailable after deletion at runtime. |
| Device / app metadata (sessions, diagnostics) | Conditional / owner must verify | Supabase auth/session, backend/provider logs | Sessions, reliability, security | Service-provider processing | Provider/backend dependent | Provider dependent | Not fully mapped | Confirm what session/diagnostic metadata is retained. |
| Usage counters (rate limiting / abuse) | Likely yes | `style_chat_usage`, `style_chat_daily_usage`, `style_chat_burst_usage` | Anti-abuse / rate limiting | Service-provider processing | Yes (backend) | No | monthly/daily cascade; burst table has NO FK | Burst usage cleanup is a follow-up. |
| Advertising ID / AAID | Likely NOT collected | No `AD_ID` permission, no ad/analytics SDKs, no AAID code | N/A | No | No | N/A | N/A | Owner to confirm before finalizing the Play Console AAID declaration. |
| Approximate Location / IP-derived region | Conditional / owner must verify | Supabase/backend/provider logs if IP is used to infer region, including Supabase Auth / Edge Function / Realtime websocket logs | Security, abuse prevention, regional routing, diagnostics, rate limiting, or localization if applicable | Owner/provider review required | Provider/backend dependent | Usually not ephemeral if retained in logs | Not fully mapped | Disclose only if IP is used to infer city/region/location or retained for location-like purposes. No mobile location permission was found. |
| Account deletion request records | Likely yes | `deletion_requests`, `handle-user-deletion` | Honor deletion requests | Service-provider/operations | Yes (backend; may be retained for audit) | No | Intake covered; some records intentionally retained for audit | Manual processor + 30-day pathway. |
| Export / correction request records | Likely yes | `privacy_export_requests`, `privacy_correction_requests` | Honor export/correction requests | Service-provider/operations | Yes (backend) | No | Request records only | Full export worker coverage unverified. |
| Support contact data | Conditional / owner must verify | Support path `https://kscan.app/support` | User support | Service-provider/operations review | Depends on support tooling | No | Outside app DB | Confirm support workflow and vendor data use. |
| Shopping / product search context | Conditional / owner must verify | Edge fns: `nike-shoe-details`, `search-vinted-secondhand`, `kickscrew` RapidAPI, product-search/deals, try-on | Product discovery / shopping suggestions | Third-party shopping/search provider review required | Provider dependent | Provider dependent | Not mapped (third-party) | Style/scan/search context may be sent to third-party shopping/search providers via backend; confirm provider terms. |
| Body measurements / sizing / health data | Likely NOT collected unless owner confirms | No verified body measurement or health-data feature in current release evidence | Not applicable | No | No | Not applicable | Not applicable | Fashion/style functionality should not be described as health, fitness, biometric, or body measurement processing unless owner confirms otherwise. |

### Photos / Media Clarification

- K Scan is intended for clothing-focused images uploaded or stored for app functionality.
- The app does not intend to capture faces or bystanders. No automatic face/bystander blurring is verified as production behavior.
- If users accidentally upload faces/bystanders, that is user-provided unintended content risk, not intended app collection. In-app copy directs users to upload clothing-focused images only and avoid faces, bystanders, or sensitive information.

---

# Play Console Answer Guidance Draft

All positions below are conservative drafts for owner review, not final Play Console answers.

## Data collection

- Email / auth identifier: **likely collect**.
- OAuth account identifier: **likely collect**.
- User ID / profile record: **likely collect**.
- OAuth profile fields (name/photo/locale): **unclear / owner must verify** (scope dependent).
- Photos / clothing image uploads: **likely collect**.
- App activity / user content (scans, StyleChat, rooms, inspiration, looks): **likely collect**.
- Usage counters / diagnostics metadata: **likely collect** (anti-abuse / reliability).
- Approximate location / IP-derived region: **unclear / owner must verify**.
- Advertising ID / AAID: **likely do not collect**.
- Financial / payment data: **likely do not collect**.
- Health / fitness / body measurements: **likely do not collect**.
- Contacts / precise location / microphone audio: **likely do not collect** (no permission, blocked/removed in manifest).

### Ephemeral Processing Notes

For any data transmitted off-device but not retained beyond real-time processing:

- Mark as **ephemeral only if** implementation/provider evidence supports it.
- Mark as **not verified** if provider logs, security review, debugging, moderation, or retention may occur.
- Mark as **owner/provider review required** if upstream terms are not confirmed.

Specific to this release:

- StyleChat text and clothing-image AI processing must **not** be claimed ephemeral until AI provider terms and server-side logging/retention are confirmed. Gemini is the verified image-analysis provider; its retention/training posture for this account is unverified here.
- Supabase Storage image objects are persisted (not ephemeral).
- Style Memory in-memory cache is process-local and invalidated on sign-out, but `style_memory_events` rows persist in the backend.

## Data sharing

Conservative draft: treat AI/image processing as potential sharing until provider terms prove service-provider-only processing. Do not claim "not shared" for AI-processed StyleChat/image data until provider terms and account settings are verified.

### Conditional Data Use Override Matrix

| Data Flow | Conservative Draft Position | Can be treated as service-provider processing only if... | Must be disclosed as sharing if... | Owner Verification Needed |
|-----------|-----------------------------|-----------------------------------------------------------|------------------------------------|---------------------------|
| StyleChat text to AI provider | Sharing/provider review required | Provider processes only on K Scan's behalf, under K Scan instructions, with no provider-side training/model improvement or unrelated use | Provider uses prompts for model improvement, aggregate product improvement, advertising, cross-customer profiling, or other independent purposes | Confirm final AI provider terms and account settings |
| Clothing images to AI/vision provider (Gemini) | Sharing/provider review required | Provider processes only on K Scan's behalf, under K Scan instructions, with no provider-side training/model improvement or unrelated use | Provider stores/reviews/uses images for provider purposes beyond contracted processing | Confirm final AI provider terms and image retention settings (Gemini API account data-use settings) |
| Supabase backend/storage/auth | Likely service-provider processing | Supabase processes on K Scan's behalf as backend/auth/storage provider | Supabase uses app user data for independent purposes beyond service operation | Confirm Supabase terms, logs, retention, subprocessors |
| Supabase Realtime websocket data | Likely service-provider processing / IP review required | Realtime logs are used only for service operation, security, reliability, and rate limiting | Realtime metadata/IP data is used for analytics, profiling, regional targeting, or independent purposes | Confirm Supabase Realtime logging and retention behavior |
| OAuth profile data to Google/Apple | Service-provider/auth processing review required | Provider acts as identity/auth service for sign-in only and app requests minimal scopes | Provider or app uses OAuth profile data for advertising, targeting, profiling, or unrelated purposes | Verify OAuth scopes and provider terms |
| Shopping/search context to third-party shopping providers | Sharing/provider review required | Provider returns results only on K Scan's behalf with no independent reuse of user query/scan context | Provider (e.g. Vinted/KicksCrew-RapidAPI/Nike/product-deals) retains or reuses query/scan context for its own purposes | Confirm each shopping/search provider's terms and what context is forwarded |
| Public share tokens/previews | User-initiated sharing | User intentionally creates/shares token preview | App publishes or indexes content without user action | Confirm runtime sharing behavior |
| Support/privacy requests | Service-provider/operations review | Support tooling processes on K Scan's behalf | External support vendor uses data independently | Confirm support workflow |

Worst-case/conservative draft: assume sharing may be required until provider terms prove service-provider-only processing. If unsure, mark "owner/legal/provider review required."

## User Choice and Control Notes

- Camera permission is user-controlled by the OS.
- Google/Apple OAuth consent is provider-mediated.
- Account deletion request path exists in the app (Privacy screen).
- Web delete-account path exists.
- Data export/correction request paths exist or are documented as request-based.
- Sale/sharing opt-out (`privacy_settings.opt_out_of_sale`) is exposed in-app; minor age groups (`under_13`, `age_13_to_15`) force opt-out and disable the toggle (`docs/privacy-data-management.md`).
- Users may revoke OAuth app access through provider account settings, subject to Google/Apple account controls.
- Do not claim one-tap provider-token revocation unless implemented and verified.

## Data security

- Data is transmitted over HTTPS/TLS.
- Data at rest is expected to rely on provider-managed backend/storage encryption where applicable.
- Do not claim app-level encryption at rest unless verified.
- Do not claim end-to-end encryption.
- Do not claim fully live zero-knowledge architecture.
- Do not claim all PII is masked on device.
- RLS is enabled on user-scoped tables (e.g. `privacy_settings`), scoping access to `auth.uid()` (evidence: `docs/privacy-data-management.md`).

## Data deletion

- In-app account deletion request path exists (Privacy screen → `handle-user-deletion`).
- Web delete-account path exists.
- Requests are processed through an operational workflow generally within 30 days, subject to legal, security, and operational requirements.
- Do not claim immediate deletion.
- Do not claim complete automated deletion.
- Android auto-backup is disabled (`allowBackup="false"`), which reduces the risk of OS-level backup persisting data after deletion; this should still be confirmed against any cloud/Google account backup paths.
- Follow-ups before any "complete deletion" claim: Supabase Storage object cleanup, StyleChat burst usage cleanup (`style_chat_burst_usage` has no FK), local device file limitations, export worker verification, and processor dry-run coverage of newer tables.
- Deletion coverage summary (from `qa/account-lifecycle-release-readiness-2026-06-12.md`): auth user, profiles/privacy, StyleChat sessions/messages/usage (except burst), Style Memory events, dressing rooms/items/looks, room messages/reactions, share tokens, and inspiration rows are covered by `auth.users(id) on delete cascade` / FK cascade. NOT covered automatically: Supabase Storage objects, StyleChat burst usage rows, and local device file caches.

## Advertising ID / AAID

- No `AD_ID` permission, no ad/analytics SDKs, and no AAID code references were found → Advertising ID is **likely not collected**.
- If Firebase/analytics/ad SDKs or AAID references are added later, mark owner review required.
- Do not finalize the Play Console Advertising ID declaration in this prompt.

## Tracking / ads

- No tracking/ad SDKs detected in package scan.
- App does not contain ads unless owner confirms otherwise.
- Final Play Console declaration requires owner review.

## Financial / payment data

- No payment/IAP SDKs detected.
- App does not include paid features/IAP unless owner confirms otherwise.

---

# Owner Review Required Before Final Data Safety Submission

| Action | Owner | Priority | Status / Notes |
|--------|-------|----------|----------------|
| Confirm final AI provider retention/training/data-use terms | Backend/legal | P0 | Gemini is the verified image-analysis provider; StyleChat AI provider terms unverified. |
| Confirm whether Gemini/AI provider processing is service-provider processing or Data Safety sharing | Backend/legal | P0 | Drives "shared?" answer for StyleChat text and image uploads. |
| Confirm image-processing provider retention/security review behavior | Backend/legal | P0 | Includes Gemini image retention settings. |
| Confirm production OpenRouter env and provider posture | Backend/legal | P0 | `server.js` has conditional OpenRouter image-analysis path; prove disabled or complete provider review. |
| Confirm Gemini API age/client eligibility against Play target audience | Product/legal/backend | P0 | Gemini API terms require review before selecting any under-18 audience while AI features are active. |
| Confirm whether backend/Supabase logs use IP for approximate location, regional routing, security analytics, diagnostics, or rate limiting | Backend | P0 | Determines approximate-location disclosure. |
| Confirm Supabase Realtime websocket logging and IP retention behavior | Backend | P0/P1 | Realtime metadata/IP handling. |
| Confirm Advertising ID / AAID is not collected | Mobile/release | P0 | Scans show no AAID; owner sign-off needed. |
| Confirm third-party shopping/search provider terms and forwarded context | Backend/legal | P0/P1 | Vinted, KicksCrew (RapidAPI), Nike, product-deals, try-on edge functions. |
| Confirm deployed `search-vinted-secondhand` implementation/source-of-truth | Backend/legal | P0 | Client path is active; tracked release files do not prove deployed provider, retention, DPA, or logs. |
| Confirm app is not designed for children under 13 (COPPA / Play target audience) | Product/legal | P0 | App handles `under_13`/`age_13_to_15` age groups for privacy defaults; clarify intended audience vs. child-directed status. |
| Confirm exact target audience selection: 13+, 16+, or other | Product/legal | P0 | Note: privacy logic references under-16 sale/sharing defaults. |
| Confirm exact retention period language | Legal/operations | P0 | Align with 30-day operational path. |
| Confirm deletion processor operational SLA | Backend/operations | P0 | Manual service-role script today. |
| Confirm Supabase Storage cleanup timeline | Backend | P0/P1 | Storage object removal not implemented in processor. |
| Confirm StyleChat burst usage cleanup plan | Backend | P1 | `style_chat_burst_usage` has no FK cascade. |
| Confirm export worker / manual export handling | Operations/backend | P1 | Full export worker coverage unverified. |
| Confirm local device file deletion language | Product/legal | P1 | Local saved scans are device-only. |
| Confirm Android backup / data extraction behavior does not contradict deletion claims | Mobile/release | P1 | `allowBackup="false"` observed; confirm no other backup path. |
| Confirm website privacy/delete-account pages match final language | Website/legal | P0 | See website follow-ups in `qa/public-copy-privacy-alignment-2026-06-12.md`. |
| Confirm no ads/IAP/payment functionality is planned for this release | Product | P0 | No SDKs detected. |
| Confirm physical-device smoke testing before final upload | QA/release | P0 | Runtime smoke deferred. |

---

# Deferred Follow-Up

- Runtime smoke of pending-deletion UX, public-preview-after-deletion, and StyleChat limits (not executed in this pass).
- AAB / internal-track validation (intentionally not run).
- Website repo copy alignment (`C:\Users\jsmit\kscan-website`) — not edited in this prompt; documented in `qa/public-copy-privacy-alignment-2026-06-12.md`.
- Verification of exact OAuth scopes requested from Google/Apple.
- Verification of what StyleChat backend forwards to its AI provider and whether logs retain prompt/message content.
- Verification of which shopping/search providers receive scan/style/query context and their data-use terms.
- `docs/privacy-data-management.md` describes the sign-in route as Email + Password; OAuth is now the primary path. This is an internal architecture note (not a user-facing claim) and was left unchanged in this prompt — flag for a later docs refresh.

---

## Draft Status

DATA SAFETY MAPPING STATUS: PASS WITH NOTES - SAFE TO PROCEED, BUT OWNER/PROVIDER REVIEW REQUIRED BEFORE FINAL PLAY CONSOLE ENTRY

This draft does not authorize AAB generation, EAS Build, EAS Submit, Play submission, or final Data Safety submission.
