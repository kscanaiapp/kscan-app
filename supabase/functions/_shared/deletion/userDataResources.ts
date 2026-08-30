// Deno edge-function mirror of lib/account-deletion/user-data-resources.json.
//
// Supabase Edge Function bundling cannot reliably reach outside a function's
// own directory (and Deno deploy does not read the Node repo's JSON file at
// runtime), so the worker keeps its own copy of the registry here instead of
// importing across the Node/Deno boundary. This file MUST list exactly the
// same tables/columns/actions/optional flags as
// lib/account-deletion/user-data-resources.json - __tests__/deletionRegistryParity.test.js
// fails CI if the two drift apart. If you change one, change the other.

export interface UserDataResource {
  table: string;
  column: string | null;
  action: string;
  optional?: boolean;
  count?: boolean;
}

export const SHARED_ROOM_TRANSFER_POLICY = 'transfer_to_earliest_active_participant';

export const REQUIRED_REGISTRY_TABLES: string[] = [
  'user_stylist_preferences',
  'dressing_room_collab_idempotency',
  'shared_room_memberships',
  'outfit_decision_votes',
  'stylechat_quota_events',
  'style_outfit_burst_usage',
  'style_outfit_daily_usage',
];

export const USER_DATA_RESOURCES: UserDataResource[] = [
  { table: 'profiles', column: 'id', action: 'auth_delete_cascade' },
  { table: 'privacy_settings', column: 'user_id', action: 'auth_delete_cascade' },
  { table: 'privacy_export_requests', column: 'user_id', action: 'auth_delete_cascade' },
  { table: 'privacy_correction_requests', column: 'user_id', action: 'auth_delete_cascade' },
  // The deletion_requests FK is ON DELETE SET NULL (not CASCADE): the row is
  // the operational record of the request and must survive the Auth delete.
  { table: 'deletion_requests', column: 'user_id', action: 'survive_auth_delete' },
  { table: 'legal_acceptances', column: 'user_id', action: 'auth_delete_cascade' },
  { table: 'saved_scans', column: 'user_id', action: 'auth_delete_cascade' },
  { table: 'dressing_rooms', column: 'user_id', action: 'auth_delete_cascade' },
  { table: 'dressing_room_items', column: null, action: 'parent_room_cascade', count: false },
  { table: 'dressing_room_inspiration_items', column: 'user_id', action: 'auth_delete_cascade' },
  { table: 'dressing_room_item_reactions', column: 'user_id', action: 'auth_delete_cascade' },
  { table: 'dressing_room_messages', column: 'sender_id', action: 'auth_delete_cascade' },
  { table: 'dressing_room_participants', column: 'user_id', action: 'auth_delete_cascade' },
  { table: 'room_shares', column: 'owner_id', action: 'auth_delete_cascade' },
  { table: 'looks', column: 'user_id', action: 'auth_delete_cascade' },
  { table: 'look_items', column: null, action: 'parent_look_cascade', count: false },
  { table: 'inspiration_items', column: 'user_id', action: 'auth_delete_cascade' },
  { table: 'style_chat_sessions', column: 'user_id', action: 'auth_delete_cascade' },
  { table: 'style_chat_messages', column: 'user_id', action: 'auth_delete_cascade' },
  { table: 'style_memory_events', column: 'user_id', action: 'auth_delete_cascade' },
  { table: 'style_chat_usage', column: 'user_id', action: 'auth_delete_cascade' },
  { table: 'style_chat_daily_usage', column: 'user_id', action: 'auth_delete_cascade' },
  { table: 'scan_identify_usage_daily', column: 'user_id', action: 'auth_delete_cascade' },
  { table: 'content_reports', column: 'reporter_user_id', action: 'auth_delete_cascade', optional: true },
  { table: 'content_reports', column: 'reported_user_id', action: 'auth_delete_set_null', optional: true },
  { table: 'wardrobe_utility_items', column: 'user_id', action: 'auth_delete_cascade', optional: true },
  { table: 'wardrobe_collections', column: 'user_id', action: 'auth_delete_cascade', optional: true },
  { table: 'wardrobe_collection_items', column: 'user_id', action: 'auth_delete_cascade', optional: true },
  { table: 'wardrobe_brand_sizing_notes', column: 'user_id', action: 'auth_delete_cascade', optional: true },
  { table: 'wardrobe_outfit_feedback', column: 'user_id', action: 'auth_delete_cascade', optional: true },
  { table: 'wardrobe_care_notes', column: 'user_id', action: 'auth_delete_cascade', optional: true },
  { table: 'wardrobe_wishlist_intents', column: 'user_id', action: 'auth_delete_cascade', optional: true },
  { table: 'wardrobe_wear_events', column: 'user_id', action: 'auth_delete_cascade', optional: true },
  { table: 'wardrobe_activity_log', column: 'user_id', action: 'auth_delete_cascade', optional: true },
  { table: 'style_chat_burst_usage', column: 'user_id', action: 'direct_delete_before_auth', optional: true },
  { table: 'scan_intelligence_events', column: 'user_id', action: 'direct_delete_before_auth', optional: true },
  // Privacy-rights abuse rate limiter (Issue #47). `user_id` is a bare uuid with
  // no FK to auth.users, so nothing cascades at the Auth delete; purge directly.
  { table: 'privacy_request_rate_limits', column: 'user_id', action: 'direct_delete_before_auth', optional: true },
  { table: 'user_stylist_preferences', column: 'user_id', action: 'auth_delete_cascade', optional: true },
  {
    table: 'dressing_room_collab_idempotency',
    column: 'actor_id',
    action: 'auth_delete_cascade',
    optional: true,
  },
  { table: 'shared_room_memberships', column: 'recipient_user_id', action: 'auth_delete_cascade', optional: true },
  { table: 'outfit_decision_votes', column: 'user_id', action: 'auth_delete_cascade', optional: true },
  { table: 'outfit_decision_groups', column: 'created_by', action: 'auth_delete_set_null', optional: true },
  { table: 'stylechat_quota_events', column: 'user_id', action: 'auth_delete_cascade', optional: true },
  { table: 'style_outfit_burst_usage', column: 'user_id', action: 'auth_delete_cascade', optional: true },
  { table: 'style_outfit_daily_usage', column: 'user_id', action: 'auth_delete_cascade', optional: true },
  {
    table: 'user_device_sessions',
    column: 'user_id',
    action: 'auth_delete_cascade',
  },
  { table: 'user_entitlements', column: 'user_id', action: 'auth_delete_cascade', optional: true },
  { table: 'kplus_activation_events', column: 'user_id', action: 'auth_delete_cascade', optional: true },
  // Build 34 Track B B1A cloud Closet facts (K+ only, staging). ON DELETE
  // CASCADE to auth.users already removes these rows; this entry adds them to
  // the worker's coverage counting and post-purge residual verification.
  // Deletion is intentionally independent of K+ status -- has_active_k_plus()
  // is never consulted by the deletion pipeline.
  { table: 'user_closet_items', column: 'user_id', action: 'auth_delete_cascade', optional: true },
  // Build 34 Track B B4 server-derived Style DNA profile (K+-adjacent, but
  // deletion is independent of K+ status like every other entry here). ON
  // DELETE CASCADE to auth.users already removes this row; this entry adds it
  // to the worker's coverage counting and post-purge residual verification.
  { table: 'user_style_profiles', column: 'user_id', action: 'auth_delete_cascade', optional: true },
];

export interface StorageResourceTemplate {
  bucket: string;
  prefixTemplates: string[];
}

// {userId}/saved-scans matches services/savedScanMedia.ts's upload path
// (style-library-images/{userId}/saved-scans/{savedScanId}.jpg). Previously
// absent here (though already present in the JSON-backed worker registry),
// so the automated worker never purged saved-scan images on account deletion.
//
// {userId}/closet is Build 34 Track B B1C cloud Closet media
// (style-library-images/{userId}/closet/{closetItemId}-primary.jpg and
// -thumb.jpg). Both objects sit DIRECTLY under this prefix on purpose: the
// enumerator below (listPrefixPaths / listStoragePrefix) is not recursive and
// does not filter on metadata, so a nested {closetItemId}/ sub-folder would
// yield an undeletable folder path and orphan the media permanently.
export const STORAGE_RESOURCE_TEMPLATES: StorageResourceTemplate[] = [
  { bucket: 'style-library-images', prefixTemplates: ['{userId}/scans', '{userId}/inspirations', '{userId}/saved-scans', '{userId}/closet'] },
];

export const STORAGE_RESOURCES = STORAGE_RESOURCE_TEMPLATES.map((resource) => ({
  bucket: resource.bucket,
  prefixesForUser: (userId: string) =>
    resource.prefixTemplates.map((template) => template.replaceAll('{userId}', userId)),
}));
