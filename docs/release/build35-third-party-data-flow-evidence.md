# Third-party processing inventory — PARTIAL

This is a source-discovery checklist, not a verified processor attestation. No claim about retention, model training, geography, production use or deletion propagation is made without evidence.

| Candidate | Source surface to audit | Expected categories to verify (not payload certification) | Status |
|---|---|---|---|
| Gemini | scan-identify; stylechat-generate; style-outfit-generate | Submitted images/text/structured wardrobe context | Text invocation and consent defect traced; remaining payload/consent paths NOT AUDITED |
| ElevenLabs | stylist-speech; services/avatarSpeech.ts | Spoken assistant text; timing/audio | NOT AUDITED |
| Supabase | services/supabaseClient.ts; Edge/RPC/storage | Auth, account records, media | Function inventory read only; RLS/storage NOT AUDITED |
| RevenueCat / StoreKit / Play Billing | services/kplus; native SDK dependencies | App-user identity, purchase/entitlement data | NOT AUDITED; no price changes or purchases |
| PostHog | services/analytics/posthogClient.core.ts and posthogIdentitySync.ts | Explicit event properties, actor ID, lifecycle | Source reviewed in part; ingestion/config NOT VERIFIED |
| AILabTools/RapidAPI | vto-generate/providers | Person/garment photos and generated output | NOT AUDITED; no masking claim |
| Serper / Brave / retailer adapters / Shopify | scan-identify commerce provider adapters | Fashion queries, product identifiers/destinations | NOT AUDITED |
| Open-Meteo | weather / Packing | Destination/rounded coordinates and dates | NOT AUDITED |
| APNs / FCM | watchlist worker / push registration | Device token and alert metadata | NOT AUDITED |
| Resend or actual email provider | deletion/restoration | Email and restoration capability | NOT AUDITED |
| Expo/EAS | release config / OTA / notifications | Build/runtime metadata | No build generated; NOT AUDITED |

For every row, current Production use, exact payload, direct identifiers, transport/authentication, storage/retention, deletion propagation, consent, failure handling, logs/analytics and responsible legal disclosure still need boundary-level evidence unless stated otherwise. No real customer content accessed. Discovery request source projects structured attributes/market/product IDs/URLs only; focused tests assert raw photo/chat fields are excluded. This does not prove all image processing paths private.
