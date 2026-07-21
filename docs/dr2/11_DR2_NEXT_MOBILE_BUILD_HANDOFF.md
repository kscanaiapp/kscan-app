# DR-2 Next Mobile Build Handoff

## Do not build in this task
No APK/AAB/IPA/TestFlight. Source complete for next planned build.

## Client files
- `types/styleChatAttachments.ts` — builders `buildOwnedDressingRoomItemAttachment`, `buildSharedRoomItemAttachment`
- `types/ownedClosetItem.ts` — source type extensions
- `types/eliseAdvice.ts` — optional metadata
- `services/style-chat/providers/edgeStyleChatProvider.ts` — adviceMetadata flag gate
- `services/style-chat/styleChatAttachmentStore.ts` — shared draft key
- `constants/featureFlags.ts` — three DR-2 client flags (default OFF)
- `hooks/useStyleChat.ts` — existing `sendScopeVersion` stale-response protection

## Flags (all default OFF)
Client Expo:
- `EXPO_PUBLIC_ELISE_DRESSING_ROOM_ATTACHMENTS_V1`
- `EXPO_PUBLIC_ELISE_SHARED_ROOM_EVIDENCE_V1`
- `EXPO_PUBLIC_ELISE_ADVICE_METADATA_CLIENT_V1`
- plus DR-1 dressing-room flags and SAVED_SCAN_CLOUD_IMAGES_V1

Edge env:
- Six E-4 flags + `ELISE_DRESSING_ROOM_ATTACHMENTS_V1_ENABLED` + `ELISE_SHARED_ROOM_EVIDENCE_V1_ENABLED` + `ELISE_ADVICE_METADATA_CLIENT_V1_ENABLED`

## Action refs
- Owned: `dressing_room_item:<uuid>`
- Shared: `shared_room_item:<uuid>`
- Saved Scan / inspiration unchanged

## Platform notes
- Android: `content://`, `file://` local only — never wire authority.
- iOS: `ph://`, `file://` local only — never wire authority.
- Accessibility / telemetry: no new PII keys; allowlists preserved.
- Physical QA required after next build with flags ON in non-production.
