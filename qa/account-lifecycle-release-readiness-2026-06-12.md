# Account Lifecycle Release Readiness - 2026-06-12

Scope: Android release candidate `release/android-1.0.0` at `84ae32929fc1bcfec3792124b779a127c5468848`.

Runtime pending-deletion UX smoke: not executed.

Passwords/secrets included in this note: no.

## Baseline

- Branch verified: `release/android-1.0.0`.
- Local HEAD verified: `84ae32929fc1bcfec3792124b779a127c5468848`.
- Remote `origin/release/android-1.0.0` verified at same commit.
- Tracked status before edits: clean.
- Untracked QA/runtime artifacts: ignored, not deleted, not staged.
- Required history present: `9c25708`, `79ae784`, `84ae329`.

## Account Lifecycle UX

- Deletion request intake path: `app/privacy.tsx` calls `submitAccountDeletionRequest()`, which invokes `handle-user-deletion`.
- Pending-deletion state source: `PrivacyPreferencesContext` exposes `profile.account_status` and `profile.account_locked_at` from `fetchProfile()`.
- Routing behavior: `services/routingGuard.js` treats `pending_deletion` or any `account_locked_at` value as limited account state and redirects non-Privacy routes to `/privacy`.
- Visible status: Privacy renders `privacy-pending-deletion-banner` for pending-deletion profiles.
- Safe sign-out: Privacy exposes a sign-out button; this pass added `pending-deletion-sign-out-button` for QA targeting.
- Deletion confirmation: request success/already-pending is shown in a native alert before sign-out.
- No cancellation, unlock, or destructive mobile-client override was found or added.

## Export / Correction Requests

- `requestDataExport()`: present and reachable from Privacy.
- `requestCorrection()`: present and reachable from Privacy.
- Export behavior: request/manifest intake only; no full export worker verified in this pass.
- Correction behavior: request intake for support/operator review.

## Deletion Processor

Processor status: IMPLEMENTED MANUAL PROCESSOR.

`scripts/process-deletion-request.js` is dry-run by default, marks the request processing, locks the profile, then calls `supabase.auth.admin.deleteUser(user_id)`. Public rows with `auth.users(id) on delete cascade` are expected to cascade. The processor does not enumerate every table in its dry-run counts and does not remove Supabase Storage objects.

## Deletion Coverage Matrix

| Data Surface | Table/Storage | Collected | Linked to User | Intake Cover | Processor Cover | Export Cover | Safe to Claim Complete Deletion | Follow-up |
|--------------|---------------|-----------|----------------|--------------|-----------------|--------------|---------------------------------|-----------|
| Supabase auth user | `auth.users` | yes | yes | yes | yes, manual auth delete | unclear | no | Keep manual 30-day processing wording. |
| Profiles/privacy preferences | `profiles`, `privacy_settings` | yes | yes | yes | yes, FK cascade | partial/intake | no | Verify export worker before claiming complete export. |
| Deletion/export/correction records | `deletion_requests`, `privacy_export_requests`, `privacy_correction_requests` | yes | yes | yes | yes, FK cascade | request records only | no | Keep support/audit record outside deleted app rows as needed. |
| Scans/library local data | app sandbox `kscan_library` files | yes | local device | no server intake | not implemented for device local files | no | no | User can delete in app or uninstall; document local cache limitation. |
| Cloud scan images for rooms | `style-library-images/{userId}/scans/...` | yes when user adds scan to room | yes by path/row | yes | row cascade only; storage object removal not verified | unclear | no | Add storage cleanup to deletion processor before complete deletion claim. |
| Generated scan/fashion metadata | local saved scan JSON; room item snapshots | yes | local/account depending surface | partial | account rows cascade; local cache not processed | partial/manifest only | no | Map local vs cloud metadata in export worker. |
| StyleChat sessions/messages | `style_chat_sessions`, `style_chat_messages` | yes | yes | yes | yes, FK cascade | unclear | no | Add to processor count/export manifest verification. |
| Style Memory | `style_memory_events`, in-memory cache | yes/derived | yes | yes | DB cascade yes; process cache clears on sign-out only | unclear | no | Verify no persistent summaries outside `style_memory_events`. |
| StyleChat usage counters | `style_chat_usage`, `style_chat_daily_usage`, `style_chat_burst_usage` | yes | yes | yes | monthly/daily cascade yes; burst table no FK, 1-day amortized cleanup only | unclear | no | Add burst table FK or explicit processor delete. |
| Dressing Rooms / Looks | `dressing_rooms`, `dressing_room_items`, `looks`, `look_items` | yes | yes | yes | yes, FK/cascade paths | unclear | no | Add to processor dry-run counts/export manifest. |
| Room messages/reactions | `dressing_room_messages`, `dressing_room_item_reactions` | yes | yes | yes | yes, FK/cascade paths | unclear | no | Add to processor dry-run counts/export manifest. |
| Public share tokens/previews | `room_shares`, public preview RPC | yes when user shares | yes | yes | yes, FK/cascade paths | unclear | no | Verify public preview unavailable after account deletion in runtime. |
| Inspiration uploads | `inspiration_items`, `dressing_room_inspiration_items`, storage paths | yes | yes | yes | row cascade yes; storage object removal not verified | unclear | no | Add hard-delete/storage cleanup before complete deletion claim. |
| Storage paths/files | Supabase `storage.objects` in `style-library-images` | yes | yes by folder path | partial | not verified/not implemented in processor | unclear | no | Processor must remove `{userId}/` storage objects. |
| AsyncStorage/session/local prefs | Supabase auth storage, privacy local store, feature freeze cache | yes | device local | partial | not server-side | no | no | Deletion request removes privacy local key after confirmation; other local caches depend on sign-out/uninstall. |

Deletion coverage: UNVERIFIED / FOLLOW-UP REQUIRED for storage objects, local file cache, burst usage rows, export worker coverage, and processor dry-run coverage of newer tables.

## StyleChat Deletion Coverage

- Sessions/messages: covered by `auth.users(id) on delete cascade`.
- Style Memory events: covered by `auth.users(id) on delete cascade`.
- Cached memory summaries: in-memory only; invalidated on auth sign-out in the client, but not a server erasure concern.
- Monthly/daily usage: covered by `auth.users(id) on delete cascade`.
- Burst usage: not covered by auth cascade; table has `user_id` but no FK and relies on amortized cleanup of rows older than one day.
- Edge Function logs: redacted metadata observed; provider/runtime retention not verified here.
- Release risk: medium. Avoid claiming complete StyleChat deletion until burst usage and log retention are explicitly addressed.

## Dressing Rooms / Shared Rooms Deletion Coverage

- Rooms/items/looks/look items: covered by cascade paths.
- Room messages: covered by cascade paths and not exposed in public previews.
- Reactions: covered by cascade paths.
- Public share tokens/previews: `room_shares` cascades from room and owner; public preview should become unavailable after deletion, but runtime was not executed.
- Private storage images/signed URL paths: rows cascade, storage objects are not removed by the current processor.
- Account-deletion share cleanup: row cleanup covered by cascade; storage cleanup not implemented.
- Release risk: medium. Token cleanup appears covered by DB cascade, but private image object cleanup remains a release follow-up.

## UGC / Moderation Posture

- StyleChat messages are private to the authenticated user through user-scoped RLS and session ownership checks.
- Dressing Room content is private by default and shared by user action through token-based room previews.
- Public room previews are token-based and limited to preview-safe fields.
- No persistent public feed was verified.
- No in-app report/block feature verified in this pass. Support/privacy request paths should be used for beta handling. Add in-app reporting to post-beta backlog if public sharing expands.
- Support path present in app links: `https://kscan.app/support`.

## Privacy / Data Safety Alignment Notes

- Do not claim all data is deleted immediately.
- Do not claim deletion is fully automated; current processing is a manual service-role script with a 30-day operations path.
- Do not claim complete deletion for Supabase Storage until object cleanup is implemented and tested.
- Do not claim local device files are server-deleted; local saved scans remain device-local and are removed by in-app deletion or uninstall.
- Do not claim StyleChat burst usage has complete account-deletion coverage until the table has a cascade FK or explicit processor cleanup.
- Stale doc alignment note: `docs/apple-app-store-submission-runbook.md` still says StyleChat, Dressing Rooms, Sign in with Apple, and Google Sign-In are "not included"; that statement is stale for this RC and should not be reused for Google Play/Data Safety language.
- Data Safety finalization remains deferred.
- Website repo untouched.

## Release Decision

ACCOUNT LIFECYCLE RELEASE READINESS STATUS: PASS WITH NOTES - SAFE TO PROCEED, BUT DELETION COVERAGE FOLLOW-UP REQUIRED
