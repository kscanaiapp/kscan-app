# Google Play Provider/Data Safety Audit - 2026-06-12

> Draft audit only. Not final Play Console Data Safety answers. Owner, legal, and provider-account review are required before entering final Google Play declarations.

## 1. Baseline Verification

Initial verification commands were run before edits.

- Branch: `release/android-1.0.0`
- HEAD before this pass: `3f79470463611e89f17f76251fb71f65c9f49cb3`
- Recent required history present: `79ae784`, `3f79470`
- VersionCode: `5` in `app.json` and `android/app/build.gradle`
- Required QA files present: data safety mapping, store listing draft, reviewer notes, and asset checklist
- Tracked status before edits: clean
- Untracked local/QA/runtime artifacts: present, ignored, not staged
- Disallowed build/submission commands: not run

## 2. Search Methodology / Commands Run

Repository evidence was gathered with tracked-file searches and targeted payload tracing.

- Baseline: `git branch --show-current`, `git rev-parse HEAD`, `git log --oneline -12`, `git status --short`, `git branch --contains 79ae784`, `git branch --contains 3f79470`, versionCode checks, required QA file checks.
- AI searches: `Gemini`, `Google AI`, `OpenRouter`, `StyleChat`, `stylechat`, `generateContent`, `model`, `generate`.
- Shopping/search searches: `Vinted`, `KicksCrew`, `RapidAPI`, `Nike`, `affiliate`, `retailer`, `product lookup`, `search-vinted`, `secondhand`, `purchaseUrl`, `outbound`, `commerce`, `shopping`.
- Analytics/logging searches: `analytics`, `tracking`, `attribution`, `logError`, `capture`, `Sentry`, `PostHog`, `Mixpanel`, `Amplitude`, `Firebase`, `console.log`, `console.error`, `getAdvertisingId`, `expo-device`, `expo-application`, `pushToken`, `crash`, `diagnostic`.
- Realtime/log searches: `Realtime`, `websocket`, `log_level`, `logflare`, `log_event`, `supabase.channel`, `subscribe`.
- Target audience searches: `children`, `under 13`, `COPPA`, `Family`, `families`, `minor`, `teen`, `target audience`, `age`, `16`.
- Payload tracing focused on `server.js`, `app/api/analyze+api.js`, `services/api.js`, `hooks/useKScan.js`, `services/secondhand.js`, `services/sneakers/`, `services/productSearchDeals.ts`, `services/tryOnClothesPro.ts`, `services/nikeShoeDetails.ts`, and relevant `supabase/functions/` sources.

Official provider documentation was checked only where repo evidence could not determine provider retention/training posture:

- Google Gemini API Additional Terms: `https://ai.google.dev/gemini-api/terms`
- OpenRouter data collection and provider logging docs: `https://openrouter.ai/docs/guides/privacy/data-collection`, `https://openrouter.ai/docs/guides/privacy/provider-logging`
- Supabase DPA page: `https://supabase.com/legal/dpa`
- Apify privacy policy: `https://docs.apify.com/legal/privacy-policy`

## 3. AI Provider Findings

### Provider / Flow: Google Gemini image analysis through hosted backend

- Purpose: Clothing image analysis.
- Active Code Path: Yes.
- Search Method: AI/provider search plus payload tracing through `services/api.js` and `server.js`.
- Repo Evidence: `services/api.js` defaults `BASE_URL` to `https://kscan-app-1.onrender.com`; `server.js` posts to `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent`.
- Flow Direction: client->server->provider.
- Data Sent: Server-side system prompt, user image MIME type, and base64 image data in `inline_data`.
- Raw Image Sent? Yes, as encoded image content.
- Base64 Sent? Yes.
- Image URL Sent? No external image URL found for the Gemini default path.
- Text Prompt/Search Term Sent? Yes, system instruction/prompt text.
- User Identifier Sent? No repo evidence that app user ID/email is sent to Gemini in this path.
- Device/Advertising Identifier Sent? No repo evidence found.
- Affiliate/Click/Referral Identifier Sent? No.
- Likely Play Data Safety Category: Photos/images; app activity or generated scan metadata depending final Play taxonomy; diagnostics if provider/backend logs retain request metadata.
- Sharing / Service Provider / User-Directed / Sale/Sharing Risk / Unknown: BLOCKED - PROVIDER REVIEW REQUIRED. Treat as sharing/provider review until Gemini account tier, DPA, data-use settings, retention, and training posture are confirmed.
- Retention/Training Evidence: Google terms distinguish unpaid and paid services. Unpaid Gemini API/AI Studio content may be used to improve Google products and reviewed by humans; paid services state prompts/responses are not used for product improvement and are processed under Google's DPA. The repo does not prove the production account tier or DPA state.
- Risk Level: High.
- Confidence: High for payload and active path; Unknown for provider/account retention posture.
- Required Owner Decision: Confirm production Gemini account tier, DPA, data-use settings, abuse-monitoring/log retention, and whether this can be declared service-provider processing or must be declared sharing.

### Provider / Flow: Google Gemini image analysis through Expo/server API route

- Purpose: Clothing image analysis.
- Active Code Path: Unknown / conditional.
- Search Method: AI/provider search and direct route inspection.
- Repo Evidence: `app/api/analyze+api.js` calls `generativelanguage.googleapis.com` with model `gemini-2.0-flash-exp` using `process.env.GEMINI_API_KEY`; the mobile client evidence points to hosted `BASE_URL` by default, so this route should not be assumed to be the production release path without deploy confirmation.
- Flow Direction: client->server->provider if deployed/used.
- Data Sent: System prompt and image `inline_data` with MIME type and base64 content.
- Raw Image Sent? Yes if route is active.
- Base64 Sent? Yes if route is active.
- Image URL Sent? No external image URL found.
- Text Prompt/Search Term Sent? Yes.
- User Identifier Sent? No repo evidence found.
- Device/Advertising Identifier Sent? No repo evidence found.
- Affiliate/Click/Referral Identifier Sent? No.
- Likely Play Data Safety Category: Photos/images; app activity/generated scan metadata; diagnostics if logs retain metadata.
- Sharing / Service Provider / User-Directed / Sale/Sharing Risk / Unknown: UNKNOWN - DO NOT ASSUME until deploy routing is confirmed; if active, same Gemini provider blocker as hosted backend.
- Retention/Training Evidence: Same Gemini API terms/account-tier blocker as hosted backend.
- Risk Level: High.
- Confidence: Medium for payload; Low for production activation.
- Required Owner Decision: Confirm whether this route is deployed/used in the Android release and apply the same Gemini provider decision.

### Provider / Flow: OpenRouter image analysis fallback/alternate path

- Purpose: Alternate AI image analysis provider path in backend.
- Active Code Path: Unknown / conditional.
- Search Method: `OpenRouter` search and payload tracing in `server.js`.
- Repo Evidence: `server.js` defines `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, and `USE_OPENROUTER = process.env.USE_OPENROUTER === 'true' && !!OPENROUTER_API_KEY`; `callOpenRouter` posts to `https://openrouter.ai/api/v1/chat/completions`.
- Flow Direction: client->server->provider if `USE_OPENROUTER=true`.
- Data Sent: Model name, system prompt, text instruction, and `image_url` content whose URL is a `data:${mimeType};base64,...` data URI.
- Raw Image Sent? Yes if enabled.
- Base64 Sent? Yes if enabled.
- Image URL Sent? Yes, as a data URI in the `image_url` field; no external hosted image URL found.
- Text Prompt/Search Term Sent? Yes.
- User Identifier Sent? No repo evidence found.
- Device/Advertising Identifier Sent? No repo evidence found.
- Affiliate/Click/Referral Identifier Sent? No.
- Likely Play Data Safety Category: Photos/images; app activity/generated scan metadata; diagnostics if OpenRouter/provider logs retain request metadata.
- Sharing / Service Provider / User-Directed / Sale/Sharing Risk / Unknown: BLOCKED - OWNER REVIEW REQUIRED unless production env proves `USE_OPENROUTER=false`. If enabled, BLOCKED - PROVIDER REVIEW REQUIRED because downstream provider routing/logging/training depends on OpenRouter account/model settings.
- Retention/Training Evidence: OpenRouter docs state prompts/responses pass through multiple touchpoints, OpenRouter metadata is stored, input/output logging and use of inputs/outputs are opt-in, and each routed provider has separate retention/training policies.
- Risk Level: High.
- Confidence: High for conditional payload; Unknown for release env/provider settings.
- Required Owner Decision: Confirm production `USE_OPENROUTER` state, model/provider, privacy settings, input/output logging settings, training opt-out, and whether this provider must be disclosed.

### Provider / Flow: StyleChat Google Gemini through Supabase Edge Function

- Purpose: Conversational styling assistant.
- Active Code Path: Yes, unless release environment disables StyleChat.
- Search Method: `StyleChat` search and payload tracing through `hooks/useStyleChat.ts`, `services/style-chat/providers/edgeStyleChatProvider.ts`, and `supabase/functions/stylechat-generate/index.ts`.
- Repo Evidence: Client sends `{ sessionId, message }` to `stylechat-generate`; Edge Function verifies the JWT user, validates the session, checks quota/burst usage, fetches bounded prior messages and style context, builds a Gemini request, and posts to Gemini (`DEFAULT_MODEL = gemini-1.5-flash` unless env overrides).
- Flow Direction: client->server->provider.
- Data Sent: User chat message, bounded recent conversation history, system instruction, and compact style context/memory derived from user style data. No image payload was found in the StyleChat provider request.
- Raw Image Sent? No repo evidence found.
- Base64 Sent? No.
- Image URL Sent? No repo evidence found.
- Text Prompt/Search Term Sent? Yes, chat message/history and system instruction.
- User Identifier Sent? No repo evidence that the user ID/email is sent to Gemini; user ID is used server-side for auth, RLS, quota, and context lookup.
- Device/Advertising Identifier Sent? No repo evidence found.
- Affiliate/Click/Referral Identifier Sent? No.
- Likely Play Data Safety Category: User-generated content/messages, app activity, personalization/style preferences, diagnostics/usage counters.
- Sharing / Service Provider / User-Directed / Sale/Sharing Risk / Unknown: BLOCKED - PROVIDER REVIEW REQUIRED until Gemini service-provider status, training/retention, and account settings are confirmed.
- Retention/Training Evidence: Same Gemini API terms/account-tier blocker. Edge logs include partial user/session IDs and counts; no raw chat-message log was found in the audited path, but log retention/provider retention remains unverified.
- Risk Level: High.
- Confidence: High for active payload; Unknown for provider retention/training.
- Required Owner Decision: Confirm Gemini terms/account tier for StyleChat, whether messages can be declared service-provider processing, Edge log retention, and whether StyleChat is enabled for audiences under 18.

### Provider / Flow: StyleChat quota, burst limiting, and server logs

- Purpose: Abuse prevention and reliability for StyleChat.
- Active Code Path: Yes.
- Search Method: `burst`, `usage`, `console`, and StyleChat Edge Function inspection.
- Repo Evidence: `style_chat_usage`, `style_chat_daily_usage`, and `style_chat_burst_usage` are used for quota and burst enforcement. Edge logs include partial user/session IDs and operational counts in some branches.
- Flow Direction: server-only / service-provider logs.
- Data Sent: Usage counts and user-linked server-side records; log output may include partial IDs, retry timing, model, memory/history counts, response length, token counts, and elapsed time.
- Raw Image Sent? No.
- Base64 Sent? No.
- Image URL Sent? No.
- Text Prompt/Search Term Sent? No raw message log found in the audited active path.
- User Identifier Sent? Server-side user ID in DB rows; partial ID may appear in Edge logs.
- Device/Advertising Identifier Sent? No repo evidence found.
- Affiliate/Click/Referral Identifier Sent? No.
- Likely Play Data Safety Category: App interactions, diagnostics, identifiers.
- Sharing / Service Provider / User-Directed / Sale/Sharing Risk / Unknown: Service-provider processing likely, but log retention and IP metadata are UNKNOWN - DO NOT ASSUME.
- Retention/Training Evidence: Supabase DPA can be made binding only after owner completes the dashboard/PandaDoc process; repo does not prove DPA, log retention, or subprocessors.
- Risk Level: Medium.
- Confidence: High for code evidence; Unknown for retention.
- Required Owner Decision: Confirm Supabase DPA/log retention and whether partial IDs/counts affect diagnostics disclosure.

## 4. Shopping/Search/Commerce Provider Findings

### Provider / Flow: Vinted / secondhand search Edge Function

- Purpose: Secondhand marketplace suggestions from scan/style attributes.
- Active Code Path: Yes at client level; deployed Edge Function implementation is UNKNOWN from tracked release files.
- Search Method: `Vinted`, `secondhand`, `search-vinted-secondhand`, and `invoke` searches; payload tracing in `hooks/useKScan.js` and `services/secondhand.js`.
- Repo Evidence: `hooks/useKScan.js` builds a secondhand request from analysis metadata; `services/secondhand.js` invokes Supabase function `search-vinted-secondhand` with query, category, color, brand, size, item type, style, and limit. The local `supabase/functions/search-vinted-secondhand/index.ts` file observed during this pass is untracked, so it is not reliable release source-of-truth.
- Flow Direction: client->server->provider, provider UNKNOWN from tracked release files.
- Data Sent: Image-derived product/search attributes and query terms; no user ID/email in the client payload evidence.
- Raw Image Sent? No repo evidence found.
- Base64 Sent? No repo evidence found.
- Image URL Sent? No repo evidence found.
- Text Prompt/Search Term Sent? Yes.
- User Identifier Sent? No repo evidence found in client payload.
- Device/Advertising Identifier Sent? No repo evidence found.
- Affiliate/Click/Referral Identifier Sent? No repo evidence found.
- Likely Play Data Safety Category: Search history/product interaction data, app activity, possibly generated scan/style metadata.
- Sharing / Service Provider / User-Directed / Sale/Sharing Risk / Unknown: BLOCKED - OWNER REVIEW REQUIRED. Treat third-party shopping/search sharing as unresolved until deployed function/provider terms are confirmed.
- Retention/Training Evidence: UNKNOWN - DO NOT ASSUME. Local untracked code suggests Apify/Vinted may be involved, but release/deployed source-of-truth and provider contract are not verified.
- Risk Level: High.
- Confidence: High for client request fields; Unknown for deployed provider/retention.
- Required Owner Decision: Confirm deployed `search-vinted-secondhand` implementation, exact provider(s), forwarded fields, retention, DPA/terms, logs, and whether user queries/style attributes are disclosed as sharing.

### Provider / Flow: Apify/Vinted implementation observed in untracked local Edge Function

- Purpose: Possible secondhand search backing provider.
- Active Code Path: Unknown - do not assume for release.
- Search Method: Local filesystem inspection after client references pointed to `search-vinted-secondhand`.
- Repo Evidence: `supabase/functions/search-vinted-secondhand/` exists locally but is untracked. The observed local implementation calls Apify with query/search text and filters.
- Flow Direction: server->provider if this is the deployed function.
- Data Sent: Query/search text, filters for category/color/brand/size, and limit.
- Raw Image Sent? No in the observed local code.
- Base64 Sent? No in the observed local code.
- Image URL Sent? No in the observed local code.
- Text Prompt/Search Term Sent? Yes if this implementation is deployed.
- User Identifier Sent? No in the observed local code.
- Device/Advertising Identifier Sent? No in the observed local code.
- Affiliate/Click/Referral Identifier Sent? No in the observed local code.
- Likely Play Data Safety Category: Search history/product interaction data; app activity.
- Sharing / Service Provider / User-Directed / Sale/Sharing Risk / Unknown: UNKNOWN - DO NOT ASSUME for release; provider review required if deployed.
- Retention/Training Evidence: Apify privacy docs state Apify can act as processor under a separate DPA when processing data on customer instructions; repo does not prove a DPA or the deployed implementation.
- Risk Level: High.
- Confidence: Low for release activation; Medium for observed local payload.
- Required Owner Decision: Confirm whether this untracked function matches deployed production and whether Apify/Vinted terms make it service-provider processing or sharing.

### Provider / Flow: KicksCrew via RapidAPI Edge Function

- Purpose: Sneaker description/enrichment for KicksCrew product URLs.
- Active Code Path: Conditional.
- Search Method: `KicksCrew`, `RapidAPI`, and sneaker provider search.
- Repo Evidence: `services/sneakers/providers/kicksCrewRapidApi.ts` invokes `kickscrew-sneaker-description` only for KicksCrew URLs; `supabase/functions/kickscrew-sneaker-description/index.ts` calls RapidAPI host `kickscrew-sneakers-data.p.rapidapi.com`.
- Flow Direction: client->server->provider.
- Data Sent: Product URL.
- Raw Image Sent? No repo evidence found.
- Base64 Sent? No.
- Image URL Sent? No clothing/user image URL; product URL is sent.
- Text Prompt/Search Term Sent? Product URL, not a free-form user prompt.
- User Identifier Sent? No repo evidence found.
- Device/Advertising Identifier Sent? No repo evidence found.
- Affiliate/Click/Referral Identifier Sent? No repo evidence found.
- Likely Play Data Safety Category: Product interaction/search context if active.
- Sharing / Service Provider / User-Directed / Sale/Sharing Risk / Unknown: BLOCKED - PROVIDER REVIEW REQUIRED if active in release.
- Retention/Training Evidence: RapidAPI/provider retention and terms not verified in repo.
- Risk Level: Medium.
- Confidence: High for payload when invoked; Medium for release frequency.
- Required Owner Decision: Confirm whether KicksCrew enrichment is enabled in release, RapidAPI/provider retention, and whether product URL enrichment must be disclosed.

### Provider / Flow: Real-Time Product Search Deals via RapidAPI

- Purpose: Product deal/search results.
- Active Code Path: INACTIVE / NOT IN ACTIVE CODE PATH based on caller search; service and Edge Function exist.
- Search Method: `productSearchDeals`, `product-search-deals`, `RapidAPI`, and caller search.
- Repo Evidence: `services/productSearchDeals.ts` can invoke `product-search-deals`; no active production caller was found outside local/dev helper evidence. Edge Function forwards query/search parameters to RapidAPI host `real-time-product-search.p.rapidapi.com` and logs success including query text.
- Flow Direction: client->server->provider if wired.
- Data Sent: Query/search text, limit, offset, country, language, sort, and condition.
- Raw Image Sent? No repo evidence found.
- Base64 Sent? No.
- Image URL Sent? No repo evidence found.
- Text Prompt/Search Term Sent? Yes if enabled.
- User Identifier Sent? No repo evidence found.
- Device/Advertising Identifier Sent? No repo evidence found.
- Affiliate/Click/Referral Identifier Sent? No repo evidence found.
- Likely Play Data Safety Category: Search history/product interaction data if active.
- Sharing / Service Provider / User-Directed / Sale/Sharing Risk / Unknown: INACTIVE / NOT IN ACTIVE CODE PATH; if enabled later, provider review required.
- Retention/Training Evidence: RapidAPI/provider retention not verified.
- Risk Level: Medium.
- Confidence: Medium.
- Required Owner Decision: Keep inactive for release or review RapidAPI/provider terms and backend query logging before enabling.

### Provider / Flow: Try-On Clothes Pro via RapidAPI

- Purpose: Virtual try-on image processing.
- Active Code Path: INACTIVE / NOT IN ACTIVE CODE PATH based on caller search.
- Search Method: `tryon`, `try-on`, `tryOnClothesPro`, `RapidAPI`, and caller search.
- Repo Evidence: `services/tryOnClothesPro.ts` exists and would invoke `tryon-clothes-pro`; no active production caller was found. Edge Function forwards image strings/form body to RapidAPI host `try-on-clothes-pro.p.rapidapi.com`.
- Flow Direction: client->server->provider if wired.
- Data Sent: Person image, optional top garment image, optional bottom garment image, resolution, and restore-face flag if enabled.
- Raw Image Sent? Yes if enabled.
- Base64 Sent? Unknown; service accepts image string fields.
- Image URL Sent? Unknown; depends caller payload.
- Text Prompt/Search Term Sent? No repo evidence beyond parameters.
- User Identifier Sent? No repo evidence found.
- Device/Advertising Identifier Sent? No repo evidence found.
- Affiliate/Click/Referral Identifier Sent? No.
- Likely Play Data Safety Category: Photos/images and possibly sensitive image content if enabled.
- Sharing / Service Provider / User-Directed / Sale/Sharing Risk / Unknown: INACTIVE / NOT IN ACTIVE CODE PATH. If enabled, BLOCKED - PROVIDER REVIEW REQUIRED before release.
- Retention/Training Evidence: RapidAPI/provider retention not verified.
- Risk Level: High if enabled.
- Confidence: Medium.
- Required Owner Decision: Keep inactive for release or perform a separate image-provider privacy/security review before enabling.

### Provider / Flow: Nike Shoe Details via RapidAPI

- Purpose: Nike product-detail enrichment.
- Active Code Path: INACTIVE / NOT IN ACTIVE CODE PATH.
- Search Method: `Nike`, `nike-shoe-details`, `RapidAPI`, and caller search.
- Repo Evidence: `services/nikeShoeDetails.ts` comments identify the provider as experimental and not wired into production flows; Edge Function calls RapidAPI host `nike-api.p.rapidapi.com` with a Nike product URL.
- Flow Direction: client->server->provider if manually/dev invoked.
- Data Sent: Nike product URL.
- Raw Image Sent? No repo evidence found.
- Base64 Sent? No.
- Image URL Sent? No user/clothing image URL; product URL only.
- Text Prompt/Search Term Sent? Product URL if invoked.
- User Identifier Sent? No repo evidence found.
- Device/Advertising Identifier Sent? No repo evidence found.
- Affiliate/Click/Referral Identifier Sent? No repo evidence found.
- Likely Play Data Safety Category: Product interaction/search context if active.
- Sharing / Service Provider / User-Directed / Sale/Sharing Risk / Unknown: INACTIVE / NOT IN ACTIVE CODE PATH.
- Retention/Training Evidence: RapidAPI/provider retention not verified.
- Risk Level: Low while inactive; Medium if enabled.
- Confidence: Medium.
- Required Owner Decision: Keep inactive or review provider terms before production use.

### Provider / Flow: Optional direct sneaker APIs

- Purpose: Sneaker search/enrichment.
- Active Code Path: Unknown / env-dependent.
- Search Method: Sneaker provider search under `services/sneakers/providers/`.
- Repo Evidence: `sneakerDatabase.ts` requires `SNEAKER_DATABASE_API_KEY`, noted as non-public and undefined in Expo client; `hoseaSneakerApi.ts` requires `EXPO_PUBLIC_HOSEA_API_BASE_URL`; `sneaksApi.ts` requires `EXPO_PUBLIC_SNEAKS_API_BASE_URL` or `SNEAKS_API_BASE_URL`.
- Flow Direction: client->provider-direct or client->configured-service depending env/provider.
- Data Sent: Query/search term.
- Raw Image Sent? No repo evidence found.
- Base64 Sent? No.
- Image URL Sent? No repo evidence found.
- Text Prompt/Search Term Sent? Yes if enabled.
- User Identifier Sent? No repo evidence found.
- Device/Advertising Identifier Sent? No repo evidence found.
- Affiliate/Click/Referral Identifier Sent? No repo evidence found.
- Likely Play Data Safety Category: Search history/product interaction data if active.
- Sharing / Service Provider / User-Directed / Sale/Sharing Risk / Unknown: UNKNOWN - DO NOT ASSUME until release env confirms whether these are disabled.
- Retention/Training Evidence: Provider retention not verified.
- Risk Level: Medium.
- Confidence: Medium for payload, Unknown for env activation.
- Required Owner Decision: Confirm release env values and review terms for any enabled sneaker provider.

### Provider / Flow: User-directed outbound retailer/listing links

- Purpose: Open product, affiliate, retailer, or secondhand listing pages selected by the user.
- Active Code Path: Yes.
- Search Method: `purchaseUrl`, `affiliateUrl`, `productUrl`, `Linking.openURL`, `SecondhandShelf`, `ProductShelf`.
- Repo Evidence: `components/ProductShelf.tsx` opens `affiliateUrl || productUrl || purchaseUrl`; `components/SecondhandShelf.tsx` opens Vinted/listing URLs.
- Flow Direction: user-directed outbound.
- Data Sent: App opens an external URL at user action. No appended app user ID, hashed user ID, click ID, or sub-ID was found in repo evidence.
- Raw Image Sent? No repo evidence found.
- Base64 Sent? No.
- Image URL Sent? No repo evidence found from app payload; the external site receives normal browser/network context outside app control.
- Text Prompt/Search Term Sent? Not by the app during open; provider may infer from URL/search page.
- User Identifier Sent? No repo evidence found.
- Device/Advertising Identifier Sent? No repo evidence found.
- Affiliate/Click/Referral Identifier Sent? `affiliateUrl` field is supported, but no generated affiliate sub-ID/click ID was found.
- Likely Play Data Safety Category: User-directed external navigation; possible product interaction/affiliate review if commercial arrangements exist.
- Sharing / Service Provider / User-Directed / Sale/Sharing Risk / Unknown: User-directed outbound with SALE/SHARING RISK requiring owner confirmation for affiliate/commercial arrangements.
- Retention/Training Evidence: External retailer/listing site behavior is outside repo evidence.
- Risk Level: Medium.
- Confidence: High for outbound behavior; Unknown for commercial arrangements.
- Required Owner Decision: Confirm whether affiliate links, revenue share, sub-IDs, click tracking, or targeted advertising arrangements exist outside repo.

## 5. Analytics / Attribution / Logging Findings

### Provider / Flow: Advertising/analytics/tracking SDKs

- Purpose: N/A in repo evidence.
- Active Code Path: NOT FOUND.
- Search Method: `package.json`, app/config scans, and tracking SDK keyword searches.
- Repo Evidence: No Firebase, AdMob, Segment, Branch, AppsFlyer, Adjust, Amplitude, Mixpanel, PostHog, Sentry, Facebook SDK, or Advertising ID permission/code was found.
- Flow Direction: N/A.
- Data Sent: N/A.
- Raw Image Sent? No.
- Base64 Sent? No.
- Image URL Sent? No.
- Text Prompt/Search Term Sent? No.
- User Identifier Sent? No repo evidence found for analytics SDKs.
- Device/Advertising Identifier Sent? No `AD_ID` permission or Advertising ID code found.
- Affiliate/Click/Referral Identifier Sent? No repo evidence found.
- Likely Play Data Safety Category: Advertising ID likely not collected; owner must sign off.
- Sharing / Service Provider / User-Directed / Sale/Sharing Risk / Unknown: PASS WITH NOTES. No repo evidence of third-party tracking/ads SDKs, but owner must confirm no off-repo analytics/affiliate setup.
- Retention/Training Evidence: N/A.
- Risk Level: Medium because it drives Play declarations.
- Confidence: High for repo/package evidence.
- Required Owner Decision: Confirm no ad SDK, analytics SDK, AAID collection, push-token analytics, affiliate attribution vendor, or off-repo tracking is active.

### Provider / Flow: Client-side debug logging

- Purpose: Development diagnostics.
- Active Code Path: Yes in `__DEV__` branches; no production raw-content client leak found in audited paths.
- Search Method: `console.log`, `console.error`, `logError`, and payload-adjacent search.
- Repo Evidence: `hooks/useKScan.js`, `services/imageUtils.js`, `services/api.js`, and product UI components contain development logs. Evidence found included image URI prefix/lengths, payload lengths, endpoint/status, raw response in dev-only logging, and product fallback diagnostics.
- Flow Direction: client-only/dev logs.
- Data Sent: Local development console output; no third-party analytics SDK found.
- Raw Image Sent? No raw base64 logs found in production paths.
- Base64 Sent? No raw base64 log found; lengths may be logged in dev.
- Image URL Sent? Dev logs may include shortened local URI prefix, not production telemetry.
- Text Prompt/Search Term Sent? No raw chat prompt production log found.
- User Identifier Sent? No production full user ID/email client log found.
- Device/Advertising Identifier Sent? No repo evidence found.
- Affiliate/Click/Referral Identifier Sent? No repo evidence found.
- Likely Play Data Safety Category: Diagnostics if production logging is enabled externally; not supported by repo package evidence.
- Sharing / Service Provider / User-Directed / Sale/Sharing Risk / Unknown: PASS WITH NOTES. No client-side redaction fix was required under the safe-fix rules.
- Retention/Training Evidence: N/A for local dev logs.
- Risk Level: Low.
- Confidence: High for audited repo paths.
- Required Owner Decision: Ensure release builds do not enable `__DEV__` logging and no external log collector is injected.

### Provider / Flow: Backend, Edge Function, Supabase, and Realtime logs

- Purpose: Reliability, abuse prevention, diagnostics, and provider debugging.
- Active Code Path: Yes.
- Search Method: `console`, `log`, `Realtime`, `websocket`, Edge Function inspection, and server payload tracing.
- Repo Evidence: `server.js` logs image receipt size/provider/status and metadata; debug flags may log provider response previews. `stylechat-generate` logs partial IDs and operational counts. `product-search-deals` logs query text if active. Supabase Auth/Edge/Realtime platform logs may retain IP/session metadata; exact retention is not in repo.
- Flow Direction: server-only/service-provider logs.
- Data Sent: Operational logs, counts, status, partial identifiers, query text in some inactive/conditional functions, possible IP/session metadata at provider/platform level.
- Raw Image Sent? No raw image log found in active production code, but backend sends images to AI providers.
- Base64 Sent? No raw base64 log found in active production code; provider debug previews require env review.
- Image URL Sent? Not found in production logs for active image analysis.
- Text Prompt/Search Term Sent? Product search query may be logged in `product-search-deals` if enabled; no raw StyleChat message log found.
- User Identifier Sent? Partial user/session IDs may be logged in StyleChat Edge Function.
- Device/Advertising Identifier Sent? No Advertising ID evidence; IP/session metadata unknown at platform level.
- Affiliate/Click/Referral Identifier Sent? No repo evidence found.
- Likely Play Data Safety Category: Diagnostics, identifiers, approximate location if IP is used/retained for location-like purposes.
- Sharing / Service Provider / User-Directed / Sale/Sharing Risk / Unknown: BLOCKED - OWNER REVIEW REQUIRED for log retention, production debug flags, IP handling, and Supabase DPA status.
- Retention/Training Evidence: Supabase DPA availability was verified, but repo does not prove a signed DPA, log retention settings, or subprocessors.
- Risk Level: High for final Data Safety accuracy.
- Confidence: High for log code evidence; Unknown for provider retention/IP treatment.
- Required Owner Decision: Confirm production debug flags are off, Supabase/Edge/server log retention, IP use, DPA status, and whether diagnostics/approximate location must be disclosed.

## 6. Target Audience Evidence

- Store asset checklist states the app is not designed for children under 13.
- Privacy/data-management code and docs reference `under_13` and `age_13_to_15` sale/sharing protections, which indicates minor-related privacy handling but not child-directed product positioning.
- No evidence was found that the app is intentionally designed for children under 13 or enrolled in a Families/child-directed program.
- Because Gemini API terms state API clients must not be directed toward or likely accessed by individuals under 18, target audience selection is a P0 provider/legal issue if Play audience includes teens.

Recommended conservative conclusion:

- Do not mark K Scan as designed for children under 13 without explicit product/legal approval.
- Do not finalize a 13+ or 16+ Play target audience while Gemini is active until legal/provider review confirms the Gemini API age/client eligibility posture.
- If legal/product selects an adult-only audience, align store listing, privacy copy, and any age-gate/account behavior accordingly.

### Prompt 11A Follow-Up: Owner 18+ Decision Lock

Prompt 11A received a new owner decision after this Prompt 10 audit: the first Android release target audience is 18+ only.

Decision impact:

- The Gemini under-18 API-client compatibility blocker is resolved for the first Android release if Play Console selects 18+ only and the app/store assets are not directed to children or minors.
- Do not select 13-15 or 16-17 for this Android release.
- Do not participate in Google Play Families / Designed for Children for this Android release.
- This target-audience decision does not resolve Gemini unpaid-tier data-use/training/human-review risk.
- This target-audience decision does not resolve OpenRouter production/ZDR uncertainty.
- This target-audience decision does not resolve Supabase logging/DPA/retention uncertainty.

Updated cross-reference: `qa/google-play-ai-provider-decision-brief-2026-06-12.md`.

## 7. Data Safety Implications

Likely or conditional collection/processing based on repo evidence:

- Name: Conditional / owner must verify OAuth scopes and profile fields.
- Email address: Likely collected through Supabase Auth/OAuth.
- User IDs: Likely collected through Supabase Auth/profile records.
- Device IDs: No Advertising ID evidence; provider/server technical identifiers such as IP/session metadata require owner/provider review.
- Advertising IDs: NOT FOUND in repo evidence.
- Approximate location: UNKNOWN - DO NOT ASSUME; depends on whether IP is retained/used by backend/Supabase/providers for region, security, diagnostics, or rate limiting.
- Photos/images: Likely collected/processed; images are sent to Gemini for analysis and stored in Supabase Storage for room/inspiration flows.
- User-generated content: Likely collected; StyleChat messages, dressing room content, room messages/reactions, inspiration items.
- App interactions: Likely collected; usage counters, room/share interactions, quota/burst records.
- Diagnostics: Conditional / owner must verify logs, provider metadata, and retention.
- Crash logs: No crash SDK found; platform/provider logs unknown.
- Search history: Conditional / likely for secondhand/product search context if provider searches are active.
- Purchase history: NOT FOUND; no payment/IAP SDK found.
- Product interaction data: Conditional; outbound links and search/enrichment flows exist.
- Affiliate attribution data: UNKNOWN; `affiliateUrl` support exists but no generated sub-ID/click ID was found.
- AI prompts/messages: Likely collected/processed; StyleChat messages and system prompts are sent to Gemini.

## 8. Sale/Sharing/Targeted Advertising Implications

- No repo evidence found that raw scans, uploaded images, biometric data, or account data are sold.
- No repo evidence found of targeted advertising SDKs, third-party tracking SDKs, Advertising ID collection, or push-token attribution.
- Do not mark sale/sharing as definitively absent until owner confirms affiliate, retailer, analytics, and commercial arrangements outside repo.
- Treat AI image analysis, StyleChat AI processing, and third-party shopping/search provider requests as sharing/provider-review flows until contracts and account settings prove service-provider processing only.
- Treat retailer/listing opens as user-directed outbound navigation, with affiliate/commercial review required because `affiliateUrl` is supported.

## 9. Privacy Policy / Store Listing Alignment Risks

- Do not claim all images stay on device; images are sent to AI providers and some images are stored in Supabase Storage.
- Do not claim AI processing is ephemeral until Gemini/OpenRouter/provider retention, training, abuse-monitoring logs, and account tier are verified.
- Do not claim complete deletion until Supabase Storage cleanup, local cache limitations, and burst usage cleanup are addressed or disclosed.
- Do not claim no third-party shopping/search providers until the deployed `search-vinted-secondhand` implementation and RapidAPI paths are confirmed.
- Do not claim no logs contain user-linked data until backend/Edge/Supabase log retention and debug flags are confirmed.
- Do not finalize a teen-inclusive target audience while Gemini age/client eligibility remains unresolved.

## 10. Safe Fixes Applied

Safe fixes were doc-only.

- Created this provider/data-safety audit report.
- Updated `qa/google-play-data-safety-mapping-draft-2026-06-12.md` to cross-reference this Prompt 10 audit, call out OpenRouter, deployed Vinted/provider uncertainty, backend log review, Gemini target-audience review, and the current HEAD.
- No client-side code redaction was needed based on the audited active production paths.
- No native config, Supabase schema, migrations, Edge Functions, auth flows, deletion processor, or build configuration were modified.

## 11. Open Owner/Provider Questions

P0:

- Confirm Gemini production account tier, DPA, data-use settings, prompt/image retention, abuse-monitoring logs, and whether data is used for model/product improvement.
- Confirm Gemini API age/client eligibility and Play target-audience compatibility, especially if any under-18 audience is selected.
- Confirm whether `USE_OPENROUTER` is false in production. If true, confirm model/provider, privacy settings, input/output logging, training opt-out, provider retention, and disclosure posture.
- Confirm deployed `search-vinted-secondhand` source-of-truth, exact provider(s), forwarded fields, retention, DPA/terms, and logs.
- Confirm RapidAPI/provider terms for KicksCrew and any enabled shopping/search/try-on providers.
- Confirm server, Edge Function, Supabase Auth/Storage/Realtime log retention, production debug flags, IP handling, and DPA status.
- Confirm no Advertising ID, ad SDK, targeted advertising, analytics SDK, push-token attribution, affiliate sub-ID/click tracking, or off-repo tracking exists.
- Confirm final Play target audience and align it with AI provider terms and store/privacy copy.

P1:

- Confirm Supabase Storage object deletion plan before claiming complete deletion.
- Confirm `style_chat_burst_usage` cleanup/cascade plan.
- Confirm full export worker/manual export coverage.
- Confirm website privacy/delete-account copy after final provider decisions.

## 12. Recommended Play Console Answer Posture

- Do not enter final Play Data Safety answers until the P0 owner/provider questions are answered.
- Mark images/photos as collected/processed and not ephemeral unless provider and storage evidence proves otherwise.
- Mark StyleChat messages/user-generated text as collected/processed and provider-review required.
- Treat Gemini/OpenRouter AI flows as sharing/provider review until service-provider processing is proven by account/contract settings.
- Treat shopping/search requests as third-party provider sharing/review until deployed provider implementations and terms are confirmed.
- Mark Advertising ID as likely not collected only after owner confirms no off-repo SDK or tracking setup.
- Mark targeted advertising and sale as not evidenced in repo, but owner confirmation is required because affiliate/commercial arrangements may exist outside code.
- Treat approximate location/IP and diagnostics as UNKNOWN - DO NOT ASSUME until backend/provider log review is complete.
- Use user-directed outbound navigation language for retailer/listing links, with affiliate review caveat.

## 13. Final Release Status

Provider/data-safety audit status: BLOCKED - OWNER REVIEW REQUIRED and BLOCKED - PROVIDER REVIEW REQUIRED before final Play Console Data Safety entry.

Reason: Active AI image analysis and StyleChat flows send user content to Gemini; conditional OpenRouter and shopping/search providers are not fully resolved; deployed Vinted/provider source-of-truth is unknown from tracked release files; backend/Supabase/Edge log retention and IP handling require owner/provider confirmation; target audience must be reconciled with Gemini API age/client terms.

Prompt 11 can proceed only if it is the owner/provider decision and policy-alignment pass. Final Google Play Data Safety submission is NOT READY.
