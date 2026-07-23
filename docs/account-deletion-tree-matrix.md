# Account Deletion Tree Matrix

Last updated: 2026-07-22

Canonical registry: `lib/account-deletion/user-data-resources.json`

## Lifecycle classification key

| Class | Meaning |
|---|---|
| Soft-deactivated | Retained during 30-day restoration window; user blocked |
| Deleted at final purge | Removed when Auth user is deleted or by explicit pre-auth delete |
| Intentionally preserved | Non-PII / legal / operational ledger evidence |
| Anonymized | Identifiers minimized (`user_id` null, hashed token cleared) |

## Matrix

| Data object | Owner key | Dependency | Deactivation | Restoration | Final purge | Retention basis |
|---|---|---|---|---|---|---|
| Auth user (`auth.users`) | id | root | Soft-deactivated (sessions revoked) | Auth access restored; must sign in again | Deleted | — |
| Auth sessions / refresh tokens | user_id | Auth | Soft-deactivated: all revoked immediately | Not silently reactivated | Deleted with Auth | Security |
| Device/session registry (if present via Auth) | user_id | Auth | Revoked | Re-auth required | Deleted | Security |
| `profiles` | id | Auth | Soft-deactivated (`account_status=pending_deletion`) | Status → active | Auth cascade delete | — |
| `privacy_settings` | user_id | Auth | Soft-deactivated | Restored | Auth cascade | — |
| `privacy_export_requests` | user_id | Auth | Soft-deactivated | Restored | Auth cascade | — |
| `privacy_correction_requests` | user_id | Auth | Soft-deactivated | Restored | Auth cascade | — |
| `legal_acceptances` | user_id | Auth | Soft-deactivated | Restored | Auth cascade | Product history removed with user |
| `saved_scans` / Recent Scans | user_id | Auth | Soft-deactivated | Restored | Auth cascade | — |
| `dressing_rooms` (owned) | user_id | Auth | Soft-deactivated; share links stay live | Ownership restored | Transfer to earliest active participant else cascade | Collab continuity |
| `dressing_room_items` | room | parent room | Soft-deactivated | Restored with room | Parent cascade / transfer | — |
| `dressing_room_inspiration_items` | user_id | Auth | Soft-deactivated | Restored | Auth cascade | — |
| `dressing_room_item_reactions` | user_id | Auth | Soft-deactivated | Restored | Auth cascade | — |
| `dressing_room_messages` | sender_id | Auth | Soft-deactivated | Restored | Auth cascade | — |
| `dressing_room_participants` | user_id | Auth | Soft-deactivated | Restored | Auth cascade | — |
| `room_shares` | owner_id | Auth | Soft-deactivated; links remain usable by others | Restored | Auth cascade | Binding product decision |
| `shared_room_memberships` | recipient_user_id | Auth | Soft-deactivated | Restored | Auth cascade | — |
| `dressing_room_collab_idempotency` | actor_id | Auth | Soft-deactivated | Restored | Auth cascade | — |
| `outfit_decision_votes` | user_id | Auth | Soft-deactivated | Restored | Auth cascade | — |
| `looks` / `look_items` | user_id / look | Auth | Soft-deactivated | Restored | Auth cascade | — |
| `inspiration_items` | user_id | Auth | Soft-deactivated | Restored | Auth cascade | — |
| StyleChat / Elise sessions & messages | user_id | Auth | Soft-deactivated | Restored | Auth cascade | — |
| `style_memory_events` | user_id | Auth | Soft-deactivated | Restored | Auth cascade | — |
| StyleChat / scan usage counters | user_id | Auth | Soft-deactivated | Restored | Auth cascade / direct delete | Abuse metering |
| `stylechat_quota_events` | user_id | Auth | Soft-deactivated | Restored | Auth cascade | — |
| `style_outfit_*_usage` | user_id | Auth | Soft-deactivated | Restored | Auth cascade | — |
| `user_stylist_preferences` / Style DNA prefs | user_id | Auth | Soft-deactivated | Restored | Auth cascade | — |
| Wardrobe utility tables | user_id | Auth | Soft-deactivated | Restored | Auth cascade (optional) | — |
| `scan_intelligence_events` | user_id | — | Soft-deactivated | Restored | Direct delete before Auth | — |
| `style_chat_burst_usage` | user_id | — | Soft-deactivated | Restored | Direct delete before Auth | — |
| `content_reports` (reporter) | reporter_user_id | Auth | Soft-deactivated | Restored | Auth cascade | Safety |
| `content_reports` (reported) | reported_user_id | Auth | Soft-deactivated | Restored | SET NULL anonymize | Safety evidence |
| Storage `style-library-images` `{userId}/scans|inspirations` | path prefix | Storage | Soft-deactivated (objects retained) | Restored | Objects removed at purge | Includes listed objects under prefixes |
| Waitlist records | email (non-Auth) | external | Not part of Auth deletion tree | N/A | Not deleted by account purge | Marketing/waitlist separate |
| Subscription / payment refs | provider | external | Soft-deactivated access only | Access restored; billing state unchanged by deletion worker | **External gate** — no automated Stripe purge in this tree | Legal/accounting |
| `deletion_requests` | user_id → SET NULL | lifecycle | Soft-deactivated row | Status → restored; token cleared | Status → purged; `user_id` null; token cleared | Operational + audit |
| `deletion_state_transitions` | request_id / subject_ref | ledger | Append-only | Append restore events | Append purge events; retained | Intentionally preserved non-PII audit |
| Security / fraud logs (provider) | external | external | Retained | Retained | Retained per provider policy | Legal/security |

## Intentionally not restored / not auto-purged

- Old Auth sessions after restoration (user must authenticate again)
- Payment/subscription cancellation at payment provider (external gate)
- Waitlist signup rows keyed only by email
- Historical Storage paths are not rewritten during grace
- Append-only deletion ledger rows

## Verification evidence

- Registry + seven-table coverage tests
- Worker dry-run plan includes every registry table node + storage enumeration
- Migration `20260722191013_account_deletion_lifecycle`
