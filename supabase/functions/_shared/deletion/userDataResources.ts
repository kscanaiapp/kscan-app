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
  { table: 'user_stylist_preferences', column: 'user_id', action: 'auth_delete_cascade', optional: true },
  {
    table: 'dressing_room_collab_idempotency',
    column: 'actor_id',
    action: 'auth_delete_cascade',
    optional: true,
  },
  { table: 'shared_room_memberships', column: 'recipient_user_id', action: 'auth_delete_cascade', optional: true },
  { table: 'outfit_decision_votes', column: 'user_id', action: 'auth_delete_cascade', optional: true },
  { table: 'stylechat_quota_events', column: 'user_id', action: 'auth_delete_cascade', optional: true },
  { table: 'style_outfit_burst_usage', column: 'user_id', action: 'auth_delete_cascade', optional: true },
  { table: 'style_outfit_daily_usage', column: 'user_id', action: 'auth_delete_cascade', optional: true },
  {
    table: 'user_device_sessions',
    column: 'user_id',
    action: 'auth_delete_cascade',
  },
];

export interface StorageResourceTemplate {
  bucket: string;
  prefixTemplates: string[];
}

export const STORAGE_RESOURCE_TEMPLATES: StorageResourceTemplate[] = [
  { bucket: 'style-library-images', prefixTemplates: ['{userId}/scans', '{userId}/inspirations'] },
];

export const STORAGE_RESOURCES = STORAGE_RESOURCE_TEMPLATES.map((resource) => ({
  bucket: resource.bucket,
  prefixesForUser: (userId: string) =>
    resource.prefixTemplates.map((template) => template.replaceAll('{userId}', userId)),
}));
