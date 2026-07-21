# DR-2 Elise integration hostile audit

## Test evidence

- `__tests__/dr2Integration.test.js` — PASS
- `__tests__/dr2PlatformParity.test.js` — PASS
- `__tests__/eliseRoomItemEvidence.test.js` — PASS
- `__tests__/eliseAttachmentRecoverySaga.test.js` — PASS
- `__tests__/eliseE1VisualContext.test.js` — PASS
- `__tests__/eliseE4ClosetIntelligence.test.js` — PASS
- `__tests__/eliseUploadFlowRegression.test.js` — PASS

## Source inspection

- Client attachment builder (`services/styleObjects.ts`) uses stable canonical IDs for `owned_dressing_room_item` and `shared_item` / `shared_room_item` attachment kinds. Local URIs, textScanIds, and imageUri fields are stripped before invoking the edge function (see `toServerSafeActiveContext` and the attachments codepath in `services/style-chat/providers/edgeStyleChatProvider.ts`).
- Attachment surface is gated by feature flags:
  - `ELISE_DRESSING_ROOM_ATTACHMENTS_V1` (default OFF)
  - `ELISE_SHARED_ROOM_EVIDENCE_V1` (default OFF)
  - `ELISE_ADVICE_METADATA_CLIENT_V1` (default OFF)
- Server-side authorization for attachments is enforced by the `stylechat-generate` Edge Function; the client passes only IDs, never client-supplied user IDs or access claims. Non-authorized rooms return `attachments_rejected` / `attachments_unsupported` and the client preserves the draft (SOURCE VERIFIED in edge provider).
- Advice metadata passthrough guarded by `ELISE_ADVICE_METADATA_CLIENT_V1 && isRecord(rawAdvice)` — malformed or absent metadata never crashes the session (SOURCE VERIFIED at edge provider line 502-519).

## Hostile scenarios attempted

| Scenario | Outcome |
| --- | --- |
| Unauthenticated (no session) | Edge Function rejects; client never sees model output |
| Client injects a `userId` in body | Provider does not include a userId key (SOURCE VERIFIED at edge provider line 306-334; test asserts `'userId' in body === false`) |
| Attachment-blind reply from older backend | Provider degrades to `attachments_unsupported` (SOURCE VERIFIED) |
| Network/timeout with attachments | Returns `attachments_unsupported` and preserves draft (SOURCE VERIFIED) |
| Visual collection contract mismatch | Provider returns `visual_collection_unsupported` (SOURCE VERIFIED) |
| Malformed advice metadata | Ignored; not surfaced to caller (SOURCE VERIFIED) |
| Raw purchase URL in attachment | Not passed through to model prompt (attachments carry IDs only) |

## Prompt-injection safety

Message bodies from rooms are never injected as system or developer prompts. Attachment IDs are resolved server-side; only server-selected fields are used. Client contract sends only sessionId, message text, optional weatherLocation, optional styleDnaContext, optional activeContext (redacted), and optional attachments (IDs only). No participant-supplied text becomes privileged context (SOURCE VERIFIED).

## Verdict

DR-2 Elise integration: **PASS (SOURCE + BEHAVIORAL TEST VERIFIED)**.
