# Elise Backend Architecture Reference

Date: 2026-07-21
Source baseline: `f73d414745d366c5945fbb776231de6741012888`

## Active Runtime Paths

- StyleChat screen: `app/style-chat/[sessionId].tsx`
- StyleChat hook: `hooks/useStyleChat.ts`
- Production mobile provider: `services/style-chat/providers/edgeStyleChatProvider.ts`
- Production text Edge Function: `supabase/functions/stylechat-generate/index.ts`
- Active speech Edge Function: `supabase/functions/stylist-speech/index.ts`
- Active speech client: `services/avatars/stylistSpeechClient.ts`
- Avatar playback/lifecycle: `services/avatarSpeech.ts`
- Authoritative avatar and voice registry: `constants/stylistIdentity.ts`

`services/style-chat/MockStyleChatProvider.ts` is retained as legacy/test fallback source. It is not selected by `useStyleChat` in production.

## Backend Contracts

Installed StyleChat clients may send only `sessionId` and `message`. Optional fields remain optional:

- `weatherLocation`
- `styleDnaContext`
- `activeContext`
- `attachments`
- `contractVersion`
- `contextHint`
- `sourceMessageId`
- `requestId`

Installed clients require no new mobile field. Unknown optional response fields, including `requestId`, remain safe to ignore.

## Repair Flags

Backend-scoped flags are parsed in `supabase/functions/stylechat-generate/eliseConfig.ts` and default to preserving current behavior unless explicitly enabled:

- `ELISE_CONTEXT_NORMALIZATION_V1_ENABLED`
- `ELISE_GENERATION_SAFETY_V1_ENABLED`
- `ELISE_QUOTA_IDEMPOTENCY_V1_ENABLED`
- `ELISE_SPEECH_RESILIENCE_V1_ENABLED`
- `ELISE_SPEECH_RETRY_ENABLED`
- `ELISE_SPEECH_CIRCUIT_BREAKER_ENABLED`
- `ELISE_TELEMETRY_V1_ENABLED`
- `ELISE_STRUCTURED_GROUNDING_V1_ENABLED`

The existing `STYLECHAT_AI_ENABLED=false` kill switch still disables live Gemini generation.

## Security Boundaries

- Actor identity is derived from the Supabase JWT.
- Session and message ownership are revalidated before generation and speech.
- Visual metadata is untrusted descriptive data and cannot override system instructions.
- Attachment resolution is database-backed and actor-scoped; unauthorized references fail closed.
- Speech requests pass only stable references; text, voice IDs, and provider credentials are server-owned.
- Telemetry must not contain raw user text, prompts, model output, transcripts, images, URLs, tokens, email, or full actor/session IDs.

## External Gates

- Production deployed-source parity was not verified.
- Runtime execution of the new SQL migration was not performed against a local or production database.
- Production provider subtype evidence for ElevenLabs 429 remains an operational evidence gate; the generic classifier is implemented without live provider calls.
