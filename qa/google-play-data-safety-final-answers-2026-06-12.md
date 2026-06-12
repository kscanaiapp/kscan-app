# Google Play Data Safety — Final Answer Packet (2026-06-12)

> Google Submission v2 — Prompt 12. This is the canonical, Play Console-ready Data Safety
> answer packet for K Scan AI. It converts the Prompt 11B provider-classification lock into
> final Play Console answer guidance, using **conservative disclosure** where a provider or
> production configuration cannot be fully proven from repo evidence.
>
> This document does NOT update Play Console, upload an AAB, or submit for review. It is the
> answer source-of-truth the operator types into Play Console.
>
> Continues from: Prompt 10 `3797b8b` (provider audit), Prompt 11A `e743d3b` (18+ / provider
> posture), Prompt 11B `40552e3` (provider classification lock).
> Cross-references: `qa/google-play-provider-classification-lock-2026-06-12.md`,
> `qa/google-play-data-safety-mapping-draft-2026-06-12.md`,
> `qa/google-play-reviewer-notes-2026-06-12.md`,
> `qa/google-play-store-listing-draft-2026-06-12.md`,
> `qa/google-play-store-assets-checklist-2026-06-12.md`,
> `qa/google-play-submission-readiness-lock-2026-06-12.md`.

Last updated: June 12, 2026.

---

## 1. Baseline verification

- Branch: `release/android-1.0.0` (verified).
- HEAD at start of Prompt 12: `40552e36e781cf1ace96c985ed79fd3710761950` (Prompt 11B lock).
- Required history present on branch: Prompt 10 `3797b8b`, Prompt 11A `e743d3b`, Prompt 11B `40552e3` (all resolve via `git branch --contains`).
- VersionName `1.0.0`; VersionCode `5` — consistent in `app.json` (line 36) and `android/app/build.gradle` (lines 95–96).
- Package ID: `com.kscanai.app`.
- Tracked tree clean before Prompt 12 edits; only untracked QA/local/runtime artifacts present (screenshots, `*.xml` UI dumps, build folders). None staged.
- Disallowed commands NOT run: `expo prebuild`, `eas build`, `eas submit`, `supabase deploy`, push. No native/schema/migration/auth/deletion/build changes.

## 2. Source documents reviewed

Repo QA docs:
- `qa/google-play-provider-classification-lock-2026-06-12.md` (Prompt 11B — full provider matrix).
- `qa/google-play-data-safety-mapping-draft-2026-06-12.md` (live mapping draft).
- `qa/google-play-ai-provider-decision-brief-2026-06-12.md` (Prompt 11A).
- `qa/google-play-provider-data-safety-audit-2026-06-12.md` (Prompt 10).
- `qa/google-play-reviewer-notes-2026-06-12.md`, `qa/google-play-store-listing-draft-2026-06-12.md`, `qa/google-play-store-assets-checklist-2026-06-12.md`.

Repo config verified directly this pass:
- `app.json` Android permissions: `CAMERA`, `INTERNET`, `VIBRATE` only. `RECORD_AUDIO` blocked; `microphonePermission:false`. No `AD_ID`, no `LOCATION`, no `CONTACTS`.
- `android/app/src/main/AndroidManifest.xml`: same three permissions; nothing else declared.
- `.env.example`: `USE_OPENROUTER=true`, `OPENROUTER_MODEL=meta-llama/llama-4-scout` (documented defaults).

Live public copy verified this pass (`https://kscan.app/legal/privacy`, fetched 2026-06-12):
- Discloses that "Images, StyleChat messages, and related content may be processed through secure cloud systems and AI providers to provide scan results, StyleChat, product matching, shopping links, support, safety, and service improvement."
- Discloses retailer links lead to third-party sites; Supabase as infrastructure; no third-party ad SDKs / no Advertising ID for targeted ads; not surveillance/biometric; 18+ only; deletion via Privacy > Delete Account, generally within 30 days.
- "Last updated: May 2026"; links to full Privacy Policy PDF (`/docs/kscan-privacy-policy.pdf`), Terms, Delete Account, Do Not Sell or Share, Support.
- Conclusion: the live policy **discloses third-party AI processing of images and messages**, which is consistent with (and no stricter than) the conservative Data Safety answers below.

## 3. Owner confirmations carried forward

Per the Prompt 12 owner handoff and committed QA docs (treated as **OWNER CONFIRMATION RECORDED**):
1. All Prompt 11 cleanup completed; proceed to Prompt 12.
2. Gemini upgraded to a paid / prepaid tier. (Production billing project not repo-verifiable → dashboard confirmation remains a P1 follow-up, not a blocker.)
3. Privacy Policy updated (live page present, discloses AI processing).
4. Terms & Conditions updated (live page present per footer).
5. 18+ target audience remains locked.

Still **OWNER / PROVIDER DASHBOARD CONFIRMATION REQUIRED** (P1, conservative-disclosure-covered): Gemini production billing tier; production `USE_OPENROUTER` value and any ZDR/provider-routing; Supabase DPA completion + platform/Edge log retention + production `NODE_ENV`/debug flags off.

## 4. Provider gate selected / conservative disclosure posture

**Conservative disclosure: YES.**

- **Gemini — StyleChat text:** paid/prepaid owner-confirmed → service-provider/processor framing adopted (no product-improvement per Google's paid-tier terms). Dashboard confirmation of the production billing project is a P1 follow-up. Answer: messages collected; **not "shared"** (service-provider processing). Do not claim no-retention/no-human-review beyond the paid-tier policy statement.
- **Gemini — image analysis:** only routes to Gemini when `USE_OPENROUTER=false`; production value unproven → governed by the OpenRouter gate below.
- **OpenRouter — image analysis: Gate C (conservative).** `.env.example` ships `USE_OPENROUTER=true` as the primary image path; no ZDR or provider-routing object exists anywhere in repo code. Production cannot be proven `false`, so images are treated as **shared with a third-party AI routing/model provider**. Do not claim ephemeral, zero-retention, or service-provider-only for the image track.
- **Supabase:** service-provider (infrastructure) for auth/DB/storage/Edge. Not third-party sharing on infrastructure grounds. DPA + log-retention confirmation is a P1 follow-up.

Rationale: an accurate conservative disclosure is available for every flow, so per the Prompt 12 readiness rule, submission proceeds and the more-favorable postures (paid-Gemini-for-images via `USE_OPENROUTER=false`, or verified ZDR) are documented as P1 optimizations rather than blockers.

## 5. Data Safety answer summary (Play Console "Data collection and security")

- **Does your app collect or share any of the required user data types?** → **Yes.**
- **Is all user data encrypted in transit?** → **Yes** (HTTPS/TLS to Supabase and AI backends).
- **Do you provide a way for users to request that their data be deleted?** → **Yes** (in-app Privacy > Delete Account, and web delete-account path).
- Data is collected (sent off-device and, in most cases, stored), not merely processed ephemerally.
- The app **shares** data with third parties for one track: clothing **images** sent to a third-party AI processing/routing provider (conservative Gate C). All other off-device transfers are to **service providers** (Supabase) or **user-selected authentication providers** (Google/Apple), which Play does not count as "sharing."

## 6. Data types collected

Format per type: Collected · Required/Optional · Purpose · Ephemeral · Encrypted in transit · User can request deletion.

**Personal info**
- **Email address** — Collected: Yes · Required (to create/sign in to an account) · Purposes: Account management, App functionality, Security/fraud prevention · Ephemeral: No · Encrypted in transit: Yes · Deletion: Yes. Source: Supabase Auth (email/password + OAuth).
- **User IDs** — Collected: Yes · Required · Purposes: Account management, App functionality, Personalization · Ephemeral: No · Encrypted: Yes · Deletion: Yes. Supabase user id; OAuth account identifier.
- **Name** — Collected: Yes (conditional on OAuth profile scope; owner to confirm scopes) · Optional · Purpose: Account management / display · Ephemeral: No · Encrypted: Yes · Deletion: Yes. If no name is stored/displayed, mark not collected — **OWNER CONFIRMATION REQUIRED** on OAuth scopes.
- **Other personal info** — Collected: Yes · Optional · Purpose: App functionality, Personalization · Ephemeral: No · Encrypted: Yes · Deletion: Yes. Profile/privacy fields incl. `age_group` and sale/sharing opt-out state.

**Photos and videos**
- **Photos** — Collected: Yes · Required for scan/upload features · Purposes: App functionality · Ephemeral: No (stored in Supabase Storage `style-library-images/{userId}/...`) · Encrypted: Yes · Deletion: Yes (account rows cascade; **storage-object cleanup is a tracked deletion follow-up**). **This type is SHARED — see §7.**
- **Videos** — Collected: No (no video capture/upload verified).

**Messages**
- **Other in-app messages (StyleChat)** — Collected: Yes · Optional (feature use) · Purposes: App functionality, Personalization · Ephemeral: No (persisted in `style_chat_*`) · Encrypted: Yes · Deletion: Yes (FK cascade). Sent to Gemini (service-provider, paid) — **not shared** under §7. Do not claim ephemeral.

**App activity**
- **App interactions** — Collected: Yes · Optional · Purpose: App functionality, Analytics (service reliability/anti-abuse) · Ephemeral: No · Encrypted: Yes · Deletion: Yes. Scans, dressing rooms, looks, navigation, usage counters.
- **In-app search history** — Collected: Yes (conditional; product/style search) · Optional · Purpose: App functionality · Ephemeral: No · Encrypted: Yes · Deletion: Yes. Note commerce/search forwarding in §7 (owner verify).
- **Other user-generated content** — Collected: Yes · Optional · Purpose: App functionality · Ephemeral: No · Encrypted: Yes · Deletion: Yes. Images, StyleChat text, dressing rooms, inspiration, looks.
- **Installed apps / Other actions** — Collected: No.

**App info and performance**
- **Diagnostics / Crash logs / Other app performance** — Collected: Yes (conditional — backend/Supabase service logs; no third-party analytics/crash SDK found in `package.json`) · Optional · Purpose: App functionality, Security, service reliability · Ephemeral: No · Encrypted: Yes · Deletion: associated with account where applicable. If the operator adds no dedicated analytics SDK, the minimal honest answer is to declare Diagnostics under service-provider processing. **OWNER CONFIRMATION** on whether to declare Diagnostics.

**Device or other IDs**
- **Device or other IDs** — Collected: Conditional — session/auth identifiers and any push token (service-provider). **Not** Advertising ID. Purpose: Account management, Security. Ephemeral: No · Encrypted: Yes · Deletion: tied to account. **OWNER CONFIRMATION** on push-token usage; if only Supabase session tokens, this can be declared under service-provider security rather than a tracked identifier.

**Not collected (declare "No"):**
Address; Phone number; Race/ethnicity; Political/religious beliefs; Sexual orientation; Other personal info beyond the above; **Financial info** (no payment/IAP SDK); **Payment/purchase history**; **Health and fitness** (fashion ≠ health/biometric); **Audio** (mic blocked, `RECORD_AUDIO` removed); **Music/other audio files**; **Files and docs**; **Calendar**; **Contacts**; **Approximate location**; **Precise location** (no location permission — see IP note §8); **Web browsing history**; **Advertising ID / AAID** (no `AD_ID` permission, no ad/analytics SDK, no AAID code).

## 7. Data types shared (Play "shared with third parties")

Only one data type is shared under the conservative posture:

- **Photos** — **Shared: Yes.** Purpose: App functionality (AI image analysis). Recipient type: third-party **AI routing/model provider** (OpenRouter → upstream model host, Gate C). Reason: `.env.example` defaults `USE_OPENROUTER=true`, image sent as a base64 `image_url` data URI, no ZDR/provider-routing in code; production cannot be proven otherwise. Do not claim ephemeral or zero-retention for this transfer.
  - If the owner later confirms **`USE_OPENROUTER=false` in production** (image analysis on paid Gemini) **or** verified **ZDR + restricted provider routing**, Photos sharing may be downgraded to service-provider (not shared). Tracked as **P1 optimization** — see readiness lock.

**Not counted as "sharing" by Play (service-provider / user-initiated), declare accordingly:**
- StyleChat **messages** → Gemini paid-tier service-provider processing (not shared), pending dashboard confirmation.
- **Email / User IDs / Name / profile** → Supabase (service-provider) and Google/Apple (user-initiated authentication). Not shared.
- **App activity, diagnostics, identifiers** → Supabase service-provider processing. Not shared.

**Conditional / owner-verify (commerce):** shopping/search context to third-party shopping/search providers (Vinted/`search-vinted-secondhand`, KicksCrew/RapidAPI, product-deals) may constitute sharing if those providers reuse query/scan context. If any commerce path is live at release, declare **In-app search history / App interactions → Shared: Yes** with those providers. **OWNER CONFIRMATION REQUIRED** on which commerce paths ship in v1.0.0 and their terms (P1).

## 8. Data purposes (Play purpose checkboxes)

- **App functionality** — email, user IDs, name, photos, messages, app activity, search, identifiers.
- **Account management** — email, user IDs, name, identifiers.
- **Personalization** — user IDs, messages, app activity (StyleChat/style memory).
- **Analytics** — app activity / diagnostics (service reliability, anti-abuse) — only if Diagnostics declared.
- **Fraud prevention, security, and compliance** — email, user IDs, identifiers, diagnostics.
- **Do NOT select:** Advertising or marketing; Personalization for ads. No ad SDKs, no AAID, no tracking.

## 9. Security practices

- **Encrypted in transit:** Yes (HTTPS/TLS to Supabase, Gemini, and the hosted image backend).
- **Users can request data deletion:** Yes (in-app Privacy > Delete Account + web path).
- **Data collection is a mix of required (account/auth) and optional (feature content).**
- **Ephemeral processing:** Not claimed. Images, messages, account data, dressing rooms, and uploads persist.
- Do NOT claim: end-to-end encryption; on-device-only/zero-knowledge; app-level encryption at rest beyond provider-managed; no-training/no-retention/ZDR for AI tracks; complete automated deletion.
- RLS is enabled on user-scoped tables (`auth.uid()` scoping) per `docs/privacy-data-management.md`. "Independent security review" is **not** claimed.

## 10. Data deletion / account deletion answers

- **Does the app let users request account deletion?** → **Yes.** In-app: Privacy screen → `handle-user-deletion`. Web: `https://kscan.app/legal/delete-account` (verified 200, page describes in-app/email deletion, non-immediate, 30-day processing).
- **Deletion URL for Play Console:** `https://kscan.app/legal/delete-account`.
- **Does deletion include associated user data?** → **Yes, with documented exceptions.** Cascade via `auth.users(id) on delete cascade` covers auth user, profiles/privacy, StyleChat sessions/messages/usage (except burst), style-memory events, dressing rooms/items/looks, room messages/reactions, share tokens, inspiration rows.
- **Documented exceptions (do not claim complete automated deletion):** Supabase Storage objects, `style_chat_burst_usage` rows (no FK), local device file caches, and records intentionally retained for legal/audit. Processing is operational, generally within 30 days. Android auto-backup disabled (`allowBackup="false"`).
- **Reviewer note wording:** see §13 / `qa/google-play-reviewer-notes-2026-06-12.md` (account deletion note).
- **P1 follow-up:** owner should decide whether the live delete-account page needs an explicit storage-object cleanup caveat before final wording lock.

## 11. Target audience / Families answers

- **Target age group:** **18 and older only.** Do NOT select 13–15 or 16–17.
- **Families / Designed for Children:** **Do NOT** participate / opt in.
- **Is the app directed to children?** → **No.**
- **Ads to children / child-directed content:** N/A — app is 18+ and contains no ads.
- Rationale for reviewer/appeals: the 18+ posture aligns AI-provider, commerce, and privacy scoping; it does **not** indicate mature content. Store listing, reviewer notes, assets checklist, and the live Privacy Notice are all 18+-aligned (verified).

## 12. Privacy Policy / Terms alignment

- **Privacy Policy URL (Play Console):** `https://kscan.app/legal/privacy` (verified 200, 2026-06-12).
- The live Privacy Notice discloses third-party AI processing of images and messages, third-party retailer links, Supabase infrastructure, no Advertising ID/ad SDKs, non-biometric scope, 18+, and 30-day deletion — **consistent with and no stricter than** the conservative Data Safety answers here. No contradiction found.
- Terms URL present in site footer (`https://kscan.app/legal/terms`); full Privacy Policy PDF at `/docs/kscan-privacy-policy.pdf`.
- **P1 / LEGAL REVIEW:** confirm the full Privacy Policy PDF (the complete legal document, not just the notice summary) explicitly names AI sub-processors / third-party image sharing and carries a current "last updated" date (the notice page shows "May 2026"). The summary page is sufficient for consistency; the owner/legal should confirm the PDF matches before final lock.

## 13. Reviewer notes final copy

Use the copy in `qa/google-play-reviewer-notes-2026-06-12.md` (18+, account deletion, image-upload, StyleChat, dressing-rooms, API-limits notes). It is accurate and avoids overclaims. Recommended one-line addition for AI transparency (neutral, no overclaim):

```text
AI note: K Scan uses third-party AI services to analyze clothing-focused images and to power
StyleChat. Images may be processed by an external AI provider to return fashion attributes;
the app does not expose provider API keys in the mobile client and does not perform facial
recognition, biometric identification, or person identification.
```

Do NOT add: zero-retention, no-training, ZDR, or "service-provider only for images" claims to reviewer notes.

## 14. Play Console metadata / permissions alignment

- Android permissions (`CAMERA`, `INTERNET`, `VIBRATE`) are consistent with the Data Safety answers: camera → photos collection; internet → all network flows; vibrate → haptics (no data). **No contradiction.**
- No `AD_ID` permission ↔ Advertising ID "not collected" ✓. No `LOCATION` permission ↔ location "not collected" ✓. `RECORD_AUDIO` blocked ↔ audio "not collected" ✓.
- VersionName/Code and package ID consistent across `app.json` and `build.gradle` ✓.
- No Lane D metadata/permission fix was required (nothing contradicts the Data Safety answers).

## 15. Play Console entry checklist

- [ ] Data Safety form completed from §5–§9 (Yes collection; Photos shared; encrypted in transit; deletion available).
- [ ] Privacy Policy URL entered: `https://kscan.app/legal/privacy` (live).
- [ ] Account/Data deletion URL entered: `https://kscan.app/legal/delete-account` (live).
- [ ] Target audience: **18+ only**; Families **not** selected.
- [ ] Ads declaration: **No ads**.
- [ ] Content rating (IARC) questionnaire completed by operator (lifestyle/fashion; no gambling/violence/sexual/substances; private UGC in StyleChat/Dressing Rooms).
- [ ] App access instructions / reviewer credentials entered in Play Console only (not in repo).
- [ ] Store listing entered from `qa/google-play-store-listing-draft-2026-06-12.md`.
- [ ] Screenshots/assets reviewed for 18+ alignment (adult or no people; no youth contexts).
- [ ] Metadata/permissions match Data Safety (verified — §14).
- [ ] AAB uploaded **only after owner approval** (not in this prompt).

## 16. Remaining owner confirmations

**P0 (none that block readiness — all have an accurate conservative answer):**
- None. Every flow has a defensible conservative Data Safety answer; live Privacy Policy is consistent; deletion + privacy URLs are live; metadata is consistent; 18+ is locked.

**P1 (optimizations / confirmations; conservative disclosure already covers submission):**
1. Gemini production billing tier (Cloud Billing) + that production traffic uses the paid project → lets StyleChat/text stay service-provider with full confidence. (OWNER / PROVIDER DASHBOARD CONFIRMATION REQUIRED.)
2. Production `USE_OPENROUTER` value; if `false`, image track → paid Gemini and Photos "shared" can be downgraded to service-provider. If `true`, optionally enable ZDR + restricted provider routing. (OWNER / PROVIDER DASHBOARD CONFIRMATION REQUIRED.)
3. Supabase DPA completion + platform/Edge invocation-log retention + production `NODE_ENV=production` and `KSCAN_DEBUG`/`DEBUG_AI_PIPELINE`/`DEV_PROVIDER_LOGS` off. (OWNER CONFIRMATION REQUIRED.)
4. Commerce/search providers shipping in v1.0.0 and their terms → governs whether In-app search / App interactions are declared "shared." (OWNER CONFIRMATION REQUIRED.)
5. Full Privacy Policy PDF names AI sub-processors and carries a current date. (LEGAL REVIEW REQUIRED.)
6. OAuth scopes (whether Name is stored) and push-token usage (Device IDs). (OWNER CONFIRMATION REQUIRED.)
7. Supabase Storage object cleanup timeline and `style_chat_burst_usage` cleanup before any "complete deletion" claim. (OWNER CONFIRMATION REQUIRED.)

## 17. Final submission readiness status

**Google Submission v2 Prompt 12 Status: PASS WITH NOTES.**

The final Data Safety answer packet is internally consistent, uses accurate conservative disclosure for the unprovable provider facts, and is consistent with the live Privacy Policy, the 18+ posture, live deletion/privacy URLs, and the app's declared permissions. No P0 contradiction remains. Remaining items are P1 confirmations/optimizations that conservative disclosure already covers.

**Prompt 13 Readiness: READY.**
