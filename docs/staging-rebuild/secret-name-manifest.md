# Secret-name manifest — K Scan AI Staging rebuild

**Names only. No values appear here, and none were read.** The Supabase CLI
returns SHA-256 digests rather than secret values, so nothing sensitive was
handled. No existing variable was renamed and no configured third-party key was
rotated.

Counts: production 48 secrets, staging 27, 13 shared by name.

## Shared by name (present in both) — no action

`GEMINI_API_KEY`, `KICKSCREW_RAPIDAPI_KEY`, `RAPIDAPI_KEY`,
`SCAN_MULTI_ITEM_ENABLED`, `STYLECHAT_AI_ENABLED`, `STYLECHAT_GEMINI_MODEL`,
`SUPABASE_ANON_KEY`, `SUPABASE_DB_URL`, `SUPABASE_JWKS`,
`SUPABASE_PUBLISHABLE_KEYS`, `SUPABASE_SECRET_KEYS`, `SUPABASE_SERVICE_ROLE_KEY`,
`SUPABASE_URL`.

The five `SUPABASE_*` entries are project-native and already correct for staging.

## Present in production, missing on staging

Blocking status is derived from which deployed Edge Function reads the name
(`Deno.env.get`), not from guesswork.

| Name | Consumer | Required? | Provider | Blocks when absent |
|---|---|---|---|---|
| `APIFY_API_TOKEN` | `search-vinted-secondhand` | required | Apify | Secondhand search. Function deploys and answers, provider call fails. |
| `SECONDHAND_VINTED_ENABLED` | `search-vinted-secondhand` | required | internal flag | Secondhand search stays off. |
| `ELEVENLABS_API_KEY` | `stylist-speech` | required | ElevenLabs | Elise voice. |
| `ELEVENLABS_MODEL_ID`, `ELEVENLABS_OUTPUT_FORMAT`, `ELEVENLABS_FEMALE_VOICE_ID`, `ELEVENLABS_FEMININE_VOICE_ID`, `ELEVENLABS_MALE_VOICE_ID`, `ELEVENLABS_MASCULINE_VOICE_ID` | `stylist-speech` | required | ElevenLabs | Elise voice selection. |
| `ACCOUNT_DELETION_WORKER_SECRET` | `process-account-deletions` | required | internal | Deletion worker authentication. Deletion is deferred this phase. |
| `KSCAN_EMAIL_INTERNAL_SECRET`, `KSCAN_EMAIL_RENDER_URL` | restoration email path | required | internal | Account-restoration email. Deferred with deletion. |
| `SCAN_GEMINI_MODEL`, `SCAN_GEMINI_FALLBACK_MODEL`, `SCAN_IDENTIFY_GEMINI_MODEL`, `SCAN_IDENTIFY_GEMINI_FALLBACK_MODEL`, `TEXTSCAN_GEMINI_MODEL`, `STYLECHAT_GEMINI_FALLBACK_MODEL` | scanner / StyleChat model routing | optional | Google | Falls back to in-code defaults. **See the retired-model hazard below.** |
| `GEMINI_API_KEY_SECONDARY` | model routing failover | optional | Google | No failover key. |
| `ELISE_DRESSING_ROOM_ATTACHMENTS_V1_ENABLED`, `ELISE_GENERATION_SAFETY_V1_ENABLED`, `ELISE_QUOTA_IDEMPOTENCY_V1_ENABLED`, `ELISE_SHARED_ROOM_EVIDENCE_V1_ENABLED` | Elise feature flags | optional | internal | Features default off — staging behaves differently from production. |
| `ASOS_ENABLED`, `ASOS_RAPIDAPI_BASE_URL`, `ASOS_RAPIDAPI_HOST`, `FARFETCH_ENABLED`, `FARFETCH_RAPIDAPI_BASE_URL`, `FARFETCH_RAPIDAPI_HOST`, `KICKSCREW_ENABLED`, `KICKSCREW_RAPIDAPI_BASE_URL`, `KICKSCREW_RAPIDAPI_HOST` | commerce providers | optional | RapidAPI | Those providers stay disabled. |
| `SHOPPING_BRAVE_API_KEY`, `SHOPPING_SERPER_API_KEY` | shopping search | optional | Brave / Serper | Shopping search degraded. |
| `USE_GATEWAY_WIRING` | LLM gateway routing | optional | internal | Gateway routing off. |
| `REVENUECAT_SECRET_API_KEY` | `kplus-activate`, `kplus-reconcile-revenuecat` | optional | RevenueCat | K+ grant remains valid locally; `external_sync_status` stays `failed_retryable`/`pending`, never blocks activation. **Never place in an `EXPO_PUBLIC_*` var or client bundle.** |
| `REVENUECAT_KPLUS_ENTITLEMENT_ID` | `kplus-activate`, `kplus-reconcile-revenuecat` | optional | internal | Defaults to `k_plus` if unset. |
| `REVENUECAT_SYNC_ENABLED` | `kplus-activate`, `kplus-reconcile-revenuecat` | required to enable sync | internal flag | RevenueCat mirror stays off (`external_sync_status = 'not_required'`); local K+ grant is unaffected either way. |
| `KPLUS_RECONCILE_INTERNAL_SECRET` | `kplus-reconcile-revenuecat` | required | internal | Reconciliation sweep endpoint refuses every request (401). |
| `WATCHLIST_WORKER_SECRET` | `commerce-watch-refresh` | required to run the Tier 2 sweep | internal | The refresh sweep is unreachable: `requireWorkerSecret()` refuses without it, so every Watch stays un-refreshed. Absent on BOTH projects today — see `docs/watchlist-tier2-operations.md`. Enabling the sweep additionally requires `app_config.watchlist_worker_enabled`, seeded `false`. |
| `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`, `APPLE_CLIENT_ID`, `APPLE_TOKEN_ENCRYPTION_KEY` | `apple-credential-link`, `apple-revoke-credential` | required | Apple Developer | Confirmed via `supabase secrets list` (names/digests only, EDGE-02, 2026-09-02): present on production (all set together, 2026-08-16), absent on staging. `resolveAppleConfig()` fails soft for `apple-credential-link` (`not_configured`, sign-in unaffected), but `not_configured` is a **blocking** status for `apple-revoke-credential` — on staging, any account that actually holds an `apple_auth_credentials` row (i.e. signed in with Apple and captured a credential) has its deletion permanently retried/dead-lettered at the revocation step rather than completing. Accounts with no stored credential are unaffected (`apple-revoke-credential` returns the non-blocking `no_credential` before ever reading Apple config). Not fixed here — setting a Supabase secret is outside EDGE-02's read-only scope; flagged for owner action. |

**Model-name hazard.** `STYLECHAT_GEMINI_MODEL` is set on both projects, but the
`*_GEMINI_MODEL` family is exactly where a retired model id causes a 404 at call
time rather than at deploy time. Any staging value must be checked against
currently-served Gemini models before the emulator funnel runs.

## Present on staging, absent in production

Left in place; none conflict with the production contract.

`GEMINI_MODEL`, `MODELSLAB_API_KEY`, `MODELSLAB_TRYON_ENABLED`,
`POSHMARK_RAPIDAPI_HOST`, `POSHMARK_RAPIDAPI_KEY`, `PRODUCT_MATCH_ENABLED`,
`PRODUCT_MATCH_INTERNAL_SECRET`, `RAPIDAPI_FASHION_DETECTION_HOST`,
`RAPIDAPI_FASHION_DETECTION_KEY`, `SCAN_MULTI_ITEM_SELECTION_CONTRACT_ENABLED`,
`SCAN_PRODUCT_MATCH_ENABLED`, `SCAN_SIMILAR_ITEM_FLAG_ENABLED`,
`STYLECHAT_BURST_LIMIT_PER_MINUTE`, `XIMILAR_TOKEN`.

## Names read by Edge Function source

For cross-checking that the two lists above are complete:

| Function | `Deno.env.get` names |
|---|---|
| `scan-identify` | `GEMINI_API_KEY`, `SCAN_MULTI_ITEM_ENABLED`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `stylechat-generate` | `GEMINI_API_KEY`, `SUPABASE_ANON_KEY`, `SUPABASE_URL` |
| `style-outfit-generate` | `GEMINI_API_KEY`, `SUPABASE_ANON_KEY`, `SUPABASE_URL` |
| `stylist-speech` | `SUPABASE_ANON_KEY`, `SUPABASE_PUBLISHABLE_KEYS`, `SUPABASE_URL` |
| `search-vinted-secondhand` | `APIFY_API_TOKEN`, `APIFY_VINTED_ACTOR_ID`, `APIFY_VINTED_INPUT_TEMPLATE`, `APIFY_VINTED_TIMEOUT_SECS`, `SECONDHAND_VINTED_ENABLED` |
| `product-search-deals`, `nike-shoe-details`, `kickscrew-sneaker-description`, `tryon-clothes-pro` | `RAPIDAPI_KEY` |
| `process-account-deletions` | `DELETION_WORKER_DRY_RUN` |
| `apple-credential-link` | `APPLE_CLIENT_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`, `APPLE_TEAM_ID`, `APPLE_TOKEN_ENCRYPTION_KEY`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `apple-revoke-credential` | `APPLE_CLIENT_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`, `APPLE_TEAM_ID`, `APPLE_TOKEN_ENCRYPTION_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `staging-health` | `KSCAN_DEPLOY_VERSION` |
| `kplus-activate` | `REVENUECAT_KPLUS_ENTITLEMENT_ID`, `REVENUECAT_SECRET_API_KEY`, `REVENUECAT_SYNC_ENABLED`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `kplus-reconcile-revenuecat` | `KPLUS_RECONCILE_INTERNAL_SECRET`, `REVENUECAT_KPLUS_ENTITLEMENT_ID`, `REVENUECAT_SECRET_API_KEY`, `REVENUECAT_SYNC_ENABLED`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `_shared` | `ACCOUNT_RESTORATION_BASE_URL`, `KSCAN_ENVIRONMENT`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |

`APIFY_VINTED_ACTOR_ID`, `APIFY_VINTED_INPUT_TEMPLATE`, `APIFY_VINTED_TIMEOUT_SECS`,
`DELETION_WORKER_DRY_RUN`, `KSCAN_DEPLOY_VERSION`, `ACCOUNT_RESTORATION_BASE_URL`
and `KSCAN_ENVIRONMENT` are read by source but set on **neither** project, so
each falls back to its in-code default on both. Not a staging parity gap.
