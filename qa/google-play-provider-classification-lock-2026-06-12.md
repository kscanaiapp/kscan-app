# Google Play Provider Classification Lock - 2026-06-12

> Provider classification lock for Google Submission v2 Prompt 11B. This document locks the AI/infrastructure provider classification needed before final Play Console Data Safety answers. It is NOT a final Play Console Data Safety submission and does not mark the Data Safety form ready. Continues from Prompt 10 (`3797b8b`) and Prompt 11A (`e743d3b`).
>
> Cross-references: `qa/google-play-ai-provider-decision-brief-2026-06-12.md` (Prompt 11A), `qa/google-play-provider-data-safety-audit-2026-06-12.md` (Prompt 10), `qa/google-play-data-safety-mapping-draft-2026-06-12.md`.

---

## 1. Baseline Verification

- Branch verified: `release/android-1.0.0`.
- Local HEAD at this pass: `d406c0e716da4abc03d59a924a892c8d336e17ca`.
- VersionName: `1.0.0`; VersionCode: `5` in both `app.json` and `android/app/build.gradle`.
- Package ID: `com.kscanai.app`.
- Required history present: Prompt 10 `3797b8b`, Prompt 11A `e743d3b`. Both `git branch --contains` resolve to `release/android-1.0.0`. Also present: `79ae784`, `3f79470`.
- Two legal-doc commits sit after Prompt 11A on the branch: `b33b98f` (add app-repo fallback privacy/terms) and `d406c0e` (remove unused fallback legal docs). These do not change provider behavior.
- Tracked status before edits: clean. Only untracked QA/local/runtime artifacts present (screenshots, `*.xml` UI dumps, build folders, `deletion-fix.patch`, untracked `supabase/functions/search-vinted-secondhand/`). None staged.
- Disallowed commands not run: `expo prebuild`, `expo prebuild --clean`, `eas build`, `eas submit`, push. No native/config/schema/migration/auth/deletion/build changes.

## 2. Owner Updates Since Prompt 11A

Owner-provided facts for this pass (treated as owner statements; repo alignment verified where possible):

- Gemini has been upgraded to a paid / prepaid tier. (Prompt 11A recorded the production tier as unpaid; this is a positive change.)
- Privacy Policy and Terms & Conditions have been updated to reflect current app status (live website copy; not in this repo).
- 18+ target audience remains locked for the first Android release.
- StyleChat remains a core feature and is driven by Gemini.
- Commerce/search APIs are intended active release flows.
- OpenRouter production status remains uncertain (owner).
- OpenRouter ZDR enforcement remains uncertain (owner).
- Supabase DPA / log retention / log-body posture still needs classification (owner).

Guardrails applied: the paid-Gemini upgrade is NOT assumed verified from repo evidence; OpenRouter is NOT assumed inactive; OpenRouter ZDR is NOT assumed active; Supabase logs are NOT assumed clean.

## 3. Documentation Reviewed (Repo)

- `qa/google-play-ai-provider-decision-brief-2026-06-12.md` (Prompt 11A decision lock).
- `qa/google-play-provider-data-safety-audit-2026-06-12.md` (Prompt 10 audit).
- `qa/google-play-data-safety-mapping-draft-2026-06-12.md` (live Data Safety draft).
- `qa/google-play-store-listing-draft-2026-06-12.md`, `qa/google-play-reviewer-notes-2026-06-12.md`, `qa/google-play-store-assets-checklist-2026-06-12.md` (18+/adult-AI posture already aligned; store listing explicitly avoids paid-tier/no-training/no-retention/OpenRouter-ZDR claims).
- `qa/public-copy-privacy-alignment-2026-06-12.md` (public/website copy follow-ups; website repo untouched).
- `apple-audit-assets/privacy.md`, `apple-audit-assets/terms.md` (Apple-beta reference copy, May 2026 — see §10).

## 4. Official Provider Documentation Reviewed

Reviewed 2026-06-12. Account/billing/dashboard-specific facts are explicitly marked confirmation-required; only published policy positions are treated as known.

- **Gemini API Additional Terms / data-use** (`https://ai.google.dev/gemini-api/terms`, `https://ai.google.dev/gemini-api/docs/logs-policy`, `https://ai.google.dev/gemini-api/docs/zdr`):
  - Unpaid/free tier: Google uses submitted content and responses to "provide, improve, and develop Google products and services and machine learning technologies." Human reviewers may read/annotate input and output (Google states this data is disconnected from Google Account / API key / Cloud project before review). Users are told: "Do not submit sensitive, confidential, or personal information to the Unpaid Services."
  - Paid services tier: "Google doesn't use your prompts ... or responses to improve our products." Paid-tier data is processed "in accordance with the Data Processing Addendum for Products Where Google is a Data Processor," and retained only for abuse/Prohibited-Use-Policy detection and legal/regulatory requirements.
  - Net: paid tier is the tier that supports a service-provider/processor classification and a no-product-improvement statement. The repo cannot prove which tier the production key uses (see §5).
- **OpenRouter privacy/logging/ZDR** (`https://openrouter.ai/docs/guides/privacy/data-collection`, `.../privacy/provider-logging`, `.../features/zdr`):
  - OpenRouter does not store prompts/responses by default ("OpenRouter does not store your prompts or responses, unless you opt in"). Private input/output logging and "OpenRouter use of prompts for product improvement" are both Off by default and require explicit opt-in.
  - Critical caveat: this covers OpenRouter's own storage, NOT the downstream routed model providers. Each routed upstream provider (the host actually serving the model) has its own retention/training policy. ZDR and restricted provider routing are the mechanisms that constrain that downstream layer; they must be explicitly enabled (account- and/or per-request-level).
- **Supabase** (`https://supabase.com/legal/dpa`, `https://supabase.com/docs/guides/functions/logging`, `https://supabase.com/docs/guides/telemetry/logs`, `https://supabase.com/docs/guides/security/platform-audit-logs`):
  - Edge Function invocations and `console` output appear in function logs; platform logs are product/plan dependent and may include request/response and IP/session metadata depending on log source. The Supabase DPA becomes binding only after the owner completes Supabase's DPA process.
- **Google Play** (`https://support.google.com/googleplay/android-developer/answer/9867159`, `.../answer/9893335`): target-audience declarations must be accurate; selecting under-18 groups triggers Families requirements. 18+-only avoids that path.

## 5. Gemini Classification

### Repo evidence

- Single key `GEMINI_API_KEY` (server-side env) serves BOTH Gemini paths. There is no second/unpaid Gemini key or alternate Gemini project in tracked code.
- StyleChat (text): `supabase/functions/stylechat-generate/index.ts` posts text-only (`system_instruction` + bounded history + current message + compact style-memory text) to `generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`; default `gemini-1.5-flash`, override `STYLECHAT_GEMINI_MODEL`; kill switch `STYLECHAT_AI_ENABLED=false`. No image/base64 in the StyleChat payload. No email or full user ID sent to Gemini (user id used server-side only).
- Image analysis (production hosted backend): `server.js` posts base64 image (`inline_data`) to `gemini-2.0-flash:generateContent` — but ONLY when `USE_OPENROUTER` is false. When `USE_OPENROUTER=true`, image analysis does NOT go to Gemini (see §6).
- Image analysis (Expo route, secondary): `app/api/analyze+api.js` posts base64 image to `gemini-2.0-flash-exp` using `GEMINI_API_KEY`. The mobile client defaults to the hosted `BASE_URL` (`https://kscan-app-1.onrender.com`, `services/api.js`), so this Expo route is not confirmed to be the production path; treat as conditional.

### Classification

**Gemini — StyleChat (text): PAID TIER — SERVICE-PROVIDER CLASSIFICATION CONDITIONAL — OWNER/DASHBOARD CONFIRMATION REQUIRED.**

The paid/prepaid upgrade, if it applies to the production `GEMINI_API_KEY`/billing project, moves StyleChat from the Prompt 11A "UNPAID TIER RISK" to a defensible service-provider/processor posture (no product-improvement; processed under Google's processor DPA), per official paid-tier terms. It cannot be confirmed from repo evidence which billing project the production key belongs to, so it stays CONDITIONAL pending:

- Cloud Billing confirmation that the production key/project is on the paid tier.
- Confirmation that production traffic uses that paid project (not a separate unpaid key/quota).
- Confirmation of the applicable Google processor DPA / paid-service data terms and abuse/security-logging + retention window.
- 18+ Play target audience entered (locked by owner; operator must select 18+ only).

Do NOT claim the paid production key/billing is verified from repo evidence. Do NOT claim no-human-review/no-retention beyond the paid-tier policy statement until the production tier is confirmed.

**Gemini — image/scan analysis: PAID TIER CLASSIFICATION APPLIES ONLY WHEN GEMINI IS THE ACTIVE IMAGE PROVIDER (i.e. `USE_OPENROUTER=false`).** This is the pivotal interaction with §6: a paid Gemini key does NOT improve the image-analysis Data Safety posture if OpenRouter is the active image path. If `USE_OPENROUTER=false` in production, image analysis inherits the same CONDITIONAL paid-tier classification as StyleChat. If `USE_OPENROUTER=true`, the image track is classified under §6, not here.

## 6. OpenRouter Classification

### Repo evidence

- `server.js`: `const USE_OPENROUTER = process.env.USE_OPENROUTER === 'true' && !!OPENROUTER_API_KEY;`. In the `/api/analyze` handler, `if (USE_OPENROUTER)` selects OpenRouter as the **primary** image-analysis provider; Gemini is the alternative when it is false. This is a primary provider switch, not a post-failure fallback.
- `.env.example` ships `USE_OPENROUTER=true` and `OPENROUTER_MODEL=meta-llama/llama-4-scout` as the documented defaults. `OPENROUTER_API_KEY` is a server-side secret.
- `callOpenRouter()` posts to `https://openrouter.ai/api/v1/chat/completions` with `{ model, temperature, messages:[system, {user: text + image_url}] }`, where `image_url.url` is a `data:<mime>;base64,<data>` URI — i.e. the **raw base64 clothing image**.
- **No ZDR and no provider routing in the request.** The OpenRouter request body contains only `model`, `temperature`, `messages`. There is no `provider` routing object, no `provider.zdr`, no ZDR header, and no provider allow-list anywhere in the repo (confirmed by full-repo search; the only `zdr`/"zero data retention" hits are in QA docs and build artifacts). ZDR is therefore NOT enforced in code at any level.
- Base64 is never logged raw on the server (`previewProviderText` redacts `data:image/...;base64,...`; only lengths/status are logged; verbose/provider-preview logs are gated behind `DEV_PROVIDER_LOGS = NODE_ENV !== 'production'` and `KSCAN_DEBUG`).

### Classification

**OpenRouter — image analysis: LIKELY ACTIVE / CONDITIONAL — THIRD-PARTY AI PROCESSING RISK — ZDR / PROVIDER ROUTING CONFIRMATION REQUIRED.**

Per the Prompt 11B rule that a fallback/conditional path is treated as ACTIVE for Data Safety unless disabled by release-path evidence, and because `.env.example` ships it as the *primary* image path (`USE_OPENROUTER=true`), OpenRouter must be treated as active for the image-analysis flow unless production env proves `USE_OPENROUTER=false`. This is a stronger posture than Prompt 11A's "fallback-only/unknown."

Key facts:
- Raw base64 image is sent to OpenRouter and routed to `meta-llama/llama-4-scout`'s upstream host.
- OpenRouter's own default is no-retention, BUT downstream provider routing is uncontrolled in code (no ZDR, no provider restriction), so the upstream host's retention/training policy governs. K Scan cannot claim zero data retention for this track from repo evidence.

**Decision gate (one must be true for Prompt 12):**
- **A. OpenRouter inactive for this release** — owner confirms `USE_OPENROUTER=false` in the production backend env; image analysis then runs on (paid) Gemini and inherits §5. Best posture.
- **B. OpenRouter active with verified ZDR + restricted provider routing** — owner confirms account-level ZDR and a ZDR-compatible provider allow-list (note: not currently implemented per-request in code). Requires provider-dashboard evidence.
- **C. OpenRouter active, conservatively disclosed as third-party AI processing** — owner explicitly accepts conservative disclosure.

If C is chosen, use this disclosure profile (from the prompt's approved language): "K Scan AI utilizes third-party AI infrastructure to analyze clothing-focused images or fashion-related prompts only when needed to provide requested fashion attributes or style assistance. Data is encrypted in transit and passed to external AI models solely to provide the requested service. Unless ZDR and provider routing are verified, K Scan cannot claim zero data retention for these AI tracks."

## 7. Supabase Classification

### Repo evidence

- Supabase is active for auth, database (RLS), storage (`style-library-images`, `{userId}/...`), Edge Functions, and account lifecycle.
- AI request routing through Supabase: StyleChat runs through the `stylechat-generate` Edge Function (client → Edge → Gemini). Image analysis does NOT route through Supabase Edge Functions (it uses the hosted `server.js` backend on Render / the Expo route).
- `stylechat-generate` own logging is metadata-only: `uid.slice(0,8)`, `sessionId.slice(0,8)`, model name, `memoryText.length`, history count, response length, token count, elapsed ms, and HTTP status/`bodyChars` on errors. No raw chat message, no email, no full user ID, no image, no secret is logged. (Verified line-by-line; no Lane C redaction required — see §13.)
- Platform-level caveat: the StyleChat request body is `{ sessionId, message }`, and `message` is user content. Supabase's own platform/Edge invocation log capture (separate from the function's `console` output) and retention are plan-dependent and not provable from repo.

### Classification

**Supabase — auth/account data: SERVICE PROVIDER (infrastructure) — DPA CONFIRMATION REQUIRED.** Supabase processes account data to operate the backend. Not a third-party sharing risk on infrastructure grounds alone; the only open item is binding DPA completion + retention.

**Supabase — Edge Function / AI request logging: SERVICE PROVIDER — LOGGING/RETENTION CONFIRMATION REQUIRED.** Function-level logging is clean (metadata-only). Confirmation required for: Supabase plan, DPA completion, platform/Edge invocation log retention and whether platform logs capture StyleChat request bodies, and that `NODE_ENV=production` (so the hosted backend's `DEV_PROVIDER_LOGS` and provider-preview logging are off) and `KSCAN_DEBUG`/`DEBUG_AI_PIPELINE` are unset in production.

**Supabase — storage / user-uploaded image handling (as relevant to AI logs): SERVICE PROVIDER — storage objects persisted (not ephemeral).** Stored under `{userId}/...`; storage-object deletion remains a separate deletion follow-up (out of this prompt's scope). No image base64 is logged.

## 8. Final Provider Classification Matrix

### Gemini — StyleChat (text)
- Purpose: conversational styling assistant.
- Active in production release path: **Yes** (unless `STYLECHAT_AI_ENABLED=false`).
- Flow direction: client → server (Supabase Edge `stylechat-generate`) → provider (Gemini).
- Data sent: chat message + bounded recent history + system instruction + compact style-memory text (brands/colors/categories/budget).
- Raw image/base64 sent: **No** · Text prompts/chat messages: **Yes** · Image URL: **No** · User ID/email: **No** (server-side only) · Device/ad ID: **No** · IP/log metadata: provider/platform-dependent, **Unknown**.
- Retention known: **No** (account-dependent) · Training/product-improvement risk: **No on paid tier per official terms; CONDITIONAL on production tier confirmation** · Human-review risk: **No on paid tier; Yes if unpaid**.
- DPA/service terms known: **Conditional** (paid-tier processor DPA per official docs; production tier unconfirmed).
- Service-provider classification defensible: **Conditional** (defensible once paid production key confirmed).
- Data sharing disclosure required: **Conditional**.
- Play Data Safety checkbox implication: Data NOT shared / service-provider processing **IF** paid tier confirmed; otherwise Data IS shared / third-party AI processing.
- Recommended Play posture: declare AI text processing as collected/processed; service-provider (not shared) only after paid-tier dashboard confirmation, else conservative third-party-AI disclosure.
- Remaining blocker: production Gemini billing/tier + DPA confirmation.
- Confidence: **Medium** (High on payload/path; Low on production billing tier).

### Gemini — image / scan analysis
- Purpose: clothing image analysis.
- Active in production release path: **Conditional** — active on Gemini ONLY when `USE_OPENROUTER=false`; otherwise routed to OpenRouter (§6).
- Flow direction: client → server (`server.js` hosted backend; `app/api/analyze+api.js` Expo route conditional) → provider (Gemini).
- Data sent: system prompt + base64 image (`inline_data`).
- Raw image/base64 sent: **Yes** · Text prompts: **Yes** (system prompt) · Image URL: **No** · User ID/email: **No** · Device/ad ID: **No** · IP/log metadata: **Unknown**.
- Retention known: **No** · Training/product-improvement risk: **No on paid tier; CONDITIONAL** · Human-review risk: **No on paid tier; Yes if unpaid**.
- DPA/service terms known: **Conditional** (paid-tier).
- Service-provider classification defensible: **Conditional** (and only if `USE_OPENROUTER=false`).
- Data sharing disclosure required: **Conditional**.
- Play Data Safety checkbox implication: Photos/images collected/processed; NOT shared / service-provider **IF** paid Gemini AND `USE_OPENROUTER=false`; otherwise see OpenRouter row.
- Recommended Play posture: declare photos/images collected/processed; service-provider only if paid-Gemini + OpenRouter-off both confirmed.
- Remaining blocker: production `USE_OPENROUTER` state + Gemini paid-tier confirmation.
- Confidence: **Medium**.

### OpenRouter — image analysis / fallback / provider routing
- Purpose: AI clothing image analysis (primary image provider when `USE_OPENROUTER=true`).
- Active in production release path: **Likely / Conditional** — `.env.example` default is `true`; treat as ACTIVE unless production env proves `false`.
- Flow direction: client → server (`server.js`) → provider (OpenRouter → upstream model host).
- Data sent: model name + system prompt + "Analyze this garment image." + base64 image as `image_url` data URI.
- Raw image/base64 sent: **Yes** · Text prompts: **Yes** · Image URL: **Yes** (base64 data URI) · User ID/email: **No** · Device/ad ID: **No** · IP/log metadata: upstream-provider-dependent, **Unknown**.
- Retention known: **No** (OpenRouter own default no-retention, but downstream routing uncontrolled; no ZDR/provider allow-list in code) · Training/product-improvement risk: **Unknown** (downstream-provider-dependent) · Human-review risk: **Unknown**.
- DPA/service terms known: **No**.
- Service-provider classification defensible: **No / Conditional** (only with verified ZDR + restricted routing).
- Data sharing disclosure required: **Yes / Conditional**.
- Play Data Safety checkbox implication: Data IS shared with third parties / third-party AI processing — UNLESS owner proves inactive (`USE_OPENROUTER=false`) or verified ZDR + restricted routing.
- Recommended Play posture: conservative third-party-AI-processing disclosure unless owner picks gate A or B (§6).
- Remaining blocker: production `USE_OPENROUTER` state; if active, ZDR + provider-routing evidence.
- Confidence: **High** on payload + absence of ZDR in code; **Unknown** on production env activation.

### Supabase — auth / account data
- Purpose: authentication, account, profile, privacy settings, deletion lifecycle.
- Active in production release path: **Yes**.
- Flow direction: client → Supabase (server-only / service-provider).
- Data sent: email/auth identifier, user ID, profile/privacy fields, OAuth identity.
- Raw image/base64: **No** · Text prompts: **No** · Image URL: **No** · User ID/email: **Yes** (to Supabase as backend) · Device/ad ID: **No** · IP/log metadata: **Yes/Unknown** (platform logs/plan-dependent).
- Retention known: **No** (plan/DPA-dependent) · Training/product-improvement risk: **No** (infrastructure) · Human-review risk: **No** (expected).
- DPA/service terms known: **No** (DPA binding only after owner completes Supabase DPA process).
- Service-provider classification defensible: **Yes** (infrastructure processor).
- Data sharing disclosure required: **No** (service-provider) — subject to DPA confirmation.
- Play Data Safety checkbox implication: Data NOT shared / service-provider processing.
- Recommended Play posture: service-provider; complete Supabase DPA; confirm retention.
- Remaining blocker: DPA completion + retention confirmation.
- Confidence: **High** on role; **Medium** on retention/DPA state.

### Supabase — Edge Function / AI request logging
- Purpose: StyleChat AI request routing + abuse/quota enforcement + diagnostics.
- Active in production release path: **Yes** (StyleChat path).
- Flow direction: server-only (Edge Function logs).
- Data sent (to logs): metadata only — partial uid/session (8-char), model, lengths, counts, status. StyleChat request body (`{sessionId, message}`) may be captured by Supabase platform invocation logging (plan-dependent), and `message` is user content.
- Raw image/base64: **No** · Text prompts/chat messages: **No in function `console` output; platform invocation log capture Unknown** · Image URL: **No** · User ID/email: **No (8-char partial only)** · Device/ad ID: **No** · IP/log metadata: **Unknown** (platform/plan-dependent).
- Retention known: **No** · Training risk: **No** · Human-review risk: **No** (expected).
- DPA/service terms known: **No**.
- Service-provider classification defensible: **Yes/Conditional** (clean function logging; platform log retention unverified).
- Data sharing disclosure required: **No / Conditional**.
- Play Data Safety checkbox implication: service-provider diagnostics; not third-party sharing.
- Recommended Play posture: service-provider; confirm platform log retention + that production debug flags are off.
- Remaining blocker: platform log retention / DPA / production `NODE_ENV` + debug flags.
- Confidence: **High** on function-level logging; **Unknown** on platform retention.

### Supabase — storage / user-uploaded image handling (AI-log relevance only)
- Purpose: store user clothing/inspiration images.
- Active in production release path: **Yes** (storage), but **NOT in AI-log path** (images are not logged; image base64 is redacted on the AI backend).
- Flow direction: client → Supabase Storage (`{userId}/...`).
- Raw image/base64: stored (not logged) · IP/log metadata: **Unknown**.
- Retention known: **No** · Training risk: **No** · Human-review risk: **No**.
- Service-provider classification defensible: **Yes** (storage processor).
- Data sharing disclosure required: **No**.
- Play Data Safety checkbox implication: photos/images stored (not ephemeral); service-provider.
- Recommended Play posture: declare photos collected/stored; storage-object deletion is a separate follow-up.
- Remaining blocker: storage deletion follow-up (out of scope here).
- Confidence: **High**.

## 9. Play Console Checkbox Implications

- **Photos / images:** collected and processed (sent to an AI provider for analysis; some stored in Supabase Storage). Do NOT mark "no photos collected." Not ephemeral.
- **AI prompts / messages (StyleChat text):** collected/processed; sent to Gemini.
- **Email / auth identifier, user ID, OAuth identity:** collected (Supabase Auth/OAuth).
- **Advertising ID / AAID:** no `AD_ID` permission, no ad/analytics SDKs, no AAID code in repo → likely not collected (owner sign-off still required).
- **Approximate location / IP:** Unknown — disclose only if backend/Supabase/provider logs use/retain IP for location-like purposes.
- **Data sharing:** depends on the §6/§5 gates. With OpenRouter active and no ZDR, the image track is third-party AI processing (sharing-style disclosure). With paid Gemini + `USE_OPENROUTER=false`, AI tracks can be service-provider (not shared). Until the owner picks a gate, the conservative answer is third-party AI processing for the image track.
- **Target audience:** 18+ only; not Families/Designed for Children (already aligned in listing/reviewer/assets docs).

## 10. Data Safety Implications

- Do NOT mark the Play Console Data Safety form final — provider classification is now locked but two of three provider decisions still require owner/dashboard confirmation or explicit conservative-disclosure acceptance.
- The live Data Safety draft (`qa/google-play-data-safety-mapping-draft-2026-06-12.md`) is consistent with these findings after the Prompt 11B addendum (§13); no contradictions remain.
- Store listing/reviewer/assets copy already avoid paid-tier/no-training/no-retention/ZDR overclaims and are 18+-aligned — no change needed.
- In-repo `apple-audit-assets/privacy.md` / `terms.md` are Apple-beta reference copy (May 2026): they disclose that scan images go to a backend AI service but do NOT name third-party AI sub-processors (Gemini/OpenRouter) and predate the 18+ posture; line "Uploaded images are not analyzed by AI in this build" is scoped to inspiration uploads. These are reference-only and were NOT edited. The owner reports the live website Privacy Policy/Terms are updated; the website repo is the Play source-of-truth and was not touched (separate repo, untracked changes present). Owner/legal must confirm the live policy discloses third-party AI image/text processing and the 18+ posture.

## 11. Remaining Owner / Provider Confirmations

**P0 (gate Prompt 12):**
1. Gemini production tier: confirm Cloud Billing / paid-or-prepaid status of the production `GEMINI_API_KEY` project AND that production traffic uses it. (OWNER + PROVIDER DASHBOARD CONFIRMATION REQUIRED.)
2. Gemini paid-service DPA / data terms + abuse-logging + retention window. (LEGAL REVIEW REQUIRED.)
3. Production `USE_OPENROUTER` value. If `true` (active): ZDR + restricted provider routing evidence, or accept gate C conservative disclosure. If `false`: document it. (OWNER + PROVIDER DASHBOARD CONFIRMATION REQUIRED.)
4. Supabase plan + DPA completion + Edge/platform invocation log retention + whether platform logs capture StyleChat request bodies + production `NODE_ENV=production` and `KSCAN_DEBUG`/`DEBUG_AI_PIPELINE`/`DEV_PROVIDER_LOGS` off. (OWNER CONFIRMATION REQUIRED.)
5. Live website Privacy Policy / Terms disclose third-party AI processing + 18+ posture. (LEGAL REVIEW REQUIRED.)

**P1:**
- Confirm `app/api/analyze+api.js` Expo route is not the production image path (mobile client defaults to hosted `server.js`).
- Confirm commerce/search Edge Functions (`search-vinted-secondhand` deployed source-of-truth, KicksCrew/RapidAPI) provider terms — outside AI-provider classification but part of final Data Safety sharing answers.
- Confirm no off-repo analytics/affiliate/ad attribution.

## 12. Prompt 12 Readiness Decision

**NOT READY** (narrowly). The provider classification is now locked and evidence-backed for every AI/infrastructure flow, but final Play Console Data Safety answers cannot be entered until the owner resolves the P0 confirmations in §11 by choosing, per provider, one evidence-backed conclusion OR an explicit conservative-disclosure acceptance. Specifically:

- Gemini: paid-tier is now classifiable as service-provider CONDITIONAL — needs production billing/tier confirmation OR accept conservative disclosure.
- OpenRouter: needs gate A (inactive) / B (verified ZDR+routing) / C (explicit conservative disclosure).
- Supabase: service-provider — needs DPA + log-retention confirmation OR conservative disclosure.

Prompt 12 may proceed as soon as the owner: (a) confirms paid Gemini production tier OR accepts conservative AI disclosure; (b) picks an OpenRouter gate; and (c) confirms Supabase DPA/logging OR accepts conservative disclosure. No further repo investigation is required — the remaining work is owner/provider/legal confirmation, not engineering.

## 13. Safe Fixes Applied

Documentation-only (Safe Fix Lane A + D). No client-side code changes (Lane B) and no Supabase Edge Function changes (Lane C) were required — a full search of `app/`, `components/`, `services/`, `lib/`, `hooks/`, and `supabase/functions/` found NO unsafe logging of raw prompts, chat messages, base64 images, full image URLs, emails, access/refresh tokens, API keys, or full user IDs. `stylechat-generate` logs metadata only; the hosted AI backend (`server.js`, outside the Lane B/C sandbox) already redacts base64 and gates verbose logs behind `NODE_ENV`/`KSCAN_DEBUG` — documented as a production-flag confirmation item, not modified.

| File | Issue found | Evidence | Fix applied | Why it is safe | Verification run |
|---|---|---|---|---|---|
| `qa/google-play-provider-classification-lock-2026-06-12.md` | Required Prompt 11B classification-lock artifact missing | `Test-Path` returned absent | Created this provider classification lock | New QA doc only; no runtime/config behavior changed | `git diff --check`, `git status --short` |
| `qa/google-play-data-safety-mapping-draft-2026-06-12.md` | Stated current Gemini tier as "unpaid" (now superseded) and lacked the OpenRouter primary-path / no-ZDR finding and Supabase DPA confirmation framing | §62 "unpaid"; OpenRouter described as conditional only | Added a Prompt 11B addendum: paid/prepaid Gemini update (pending dashboard confirmation), OpenRouter primary-path + no-ZDR finding, Supabase logging/DPA confirmation, cross-ref to this lock | Draft remains explicitly non-final; conservative; no Play answer marked complete | `git diff --check`, `git diff --stat` |
| `qa/google-play-ai-provider-decision-brief-2026-06-12.md` | Reads as if "unpaid" is the latest Gemini word | §2/§6 record unpaid as current tier | Added a short "Prompt 11B Update" forward-pointer noting the owner paid/prepaid upgrade and directing to this lock; preserved the historical Prompt 11A unpaid record | Preserves the 11A decision-lock record; adds non-contradictory forward note | `git diff --check`, `git diff --stat` |

Forbidden actions avoided: no "final/complete" Data Safety claim; no claim that paid Gemini production key/billing is verified; no claim OpenRouter ZDR is active; no claim Supabase logs are clean; no removal of blocker language; no code/native/schema/migration/auth/deletion/build changes; no provider-routing changes; no staging of untracked artifacts; no push.

## 14. Final Status

Provider classification: **LOCKED** for every AI/infrastructure flow, each with an evidence-backed conclusion or an explicit conditional/confirmation-required state.

- Gemini — StyleChat (text): PAID TIER — SERVICE-PROVIDER CLASSIFICATION CONDITIONAL — OWNER/DASHBOARD CONFIRMATION REQUIRED.
- Gemini — image analysis: as above, but only when `USE_OPENROUTER=false`.
- OpenRouter — image analysis: LIKELY ACTIVE / CONDITIONAL — THIRD-PARTY AI PROCESSING RISK — ZDR / PROVIDER ROUTING CONFIRMATION REQUIRED.
- Supabase — auth/account, Edge AI logging, storage: SERVICE PROVIDER — DPA / LOGGING / RETENTION CONFIRMATION REQUIRED.

**Google Submission v2 Prompt 11B Status: PASS WITH NOTES.**

**Prompt 12 Readiness: NOT READY** — pending the §11 P0 owner/provider/legal confirmations (or explicit conservative-disclosure acceptances). No further engineering investigation required.

---

### Prompt 12 Update (2026-06-12)

Prompt 12 resolved the §12 readiness gate by selecting **explicit conservative disclosure** rather than waiting on every dashboard fact: **OpenRouter Gate C** (images declared shared with a third-party AI provider), paid-Gemini service-provider framing for StyleChat text, and Supabase service-provider. The live Privacy Policy (`https://kscan.app/legal/privacy`) was verified to disclose third-party AI processing of images/messages, so no Data Safety↔policy contradiction remains. The §11 P0 items are now reclassified as **P1 confirmations/optimizations** (conservative disclosure covers submission).

Final answers: `qa/google-play-data-safety-final-answers-2026-06-12.md`. Go/no-go: `qa/google-play-submission-readiness-lock-2026-06-12.md`. **Prompt 12: PASS WITH NOTES · Prompt 13: READY.**
