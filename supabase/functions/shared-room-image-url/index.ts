// Edge Function: shared-room-image-url
//
// Returns short-lived signed URLs for shared-room item images.
//
// Privacy contract:
// - Caller provides only the public share token and public item ids.
// - The function independently validates that the token maps to an active,
//   non-revoked, non-expired share BEFORE touching any item data.
// - Item ids are only ever resolved against rows that belong to that exact
//   shared room (dressing_room_id = the room behind the token) - arbitrary
//   item ids for other users' rooms resolve to `null`, never an error, and
//   never reveal whether the id exists elsewhere.
// - Bucket/path are read server-side from the authoritative table (durable
//   columns, falling back to legacy snapshot_payload image metadata) using
//   the service role. They are never accepted from the client and never
//   echoed back to it. The public anon-safe `get_public_room_preview` RPC is
//   intentionally NOT used here - as of migration
//   20260712010000_audit_hardening_ai_stylist_stylechat.sql it correctly
//   redacts imageStorageBucket/imageStoragePath for anon callers, so it can
//   never supply what this function needs. That hardening must not be
//   reverted; this function reads the table directly instead.
// - Only bucket ids on the validation module's ALLOWED_BUCKETS are ever signed.
// - Response shape is `{ imageUrls: Record<itemId, string | null> }` only -
//   no bucket names, paths, owner ids, or credentials.

import {
  encodeStorageObjectPath,
  isApprovedPrivateStorageRef,
  isBucketAllowed,
  isValidShareToken,
  resolveAuthorizedInspirationStorageRefs,
  resolveStorageRefFromRow,
  sanitizeItemIds,
  sanitizeItemRefs,
  sharedRoomItemRefKey,
  type DressingRoomItemStorageRow,
  type InspirationItemStorageRow,
  type InspirationRoomLinkRow,
  type SharedRoomItemRef,
} from './validation.ts';

const ALLOWED_ORIGIN = 'https://kscan.app';
const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24; // 24 hours

const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  Vary: 'Origin',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function env(name: string) {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function restHeaders(serviceRoleKey: string) {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    'Content-Type': 'application/json',
  };
}

type RoomShareRow = {
  room_id: string;
  expires_at: string | null;
};

type DressingRoomRow = { id: string; user_id: string };
type ActiveSharedRoom = { roomId: string; ownerId: string };

/**
 * Resolves a share token to its room id using the service role, applying the
 * exact same activity/expiry rules as public.get_public_room_preview
 * (access_level = view, is_active, not revoked, not expired). Returns null
 * for any reason - malformed, unknown, revoked, or expired - so the caller
 * cannot distinguish these cases from the response.
 */
async function resolveActiveRoomForToken(shareToken: string): Promise<ActiveSharedRoom | null> {
  const supabaseUrl = env('SUPABASE_URL');
  const serviceRoleKey = env('SUPABASE_SERVICE_ROLE_KEY');

  const params = new URLSearchParams({
    select: 'room_id,expires_at',
    share_token: `eq.${shareToken}`,
    access_level: 'eq.view',
    is_active: 'eq.true',
    revoked_at: 'is.null',
    limit: '1',
  });
  // expires_at is null OR expires_at > now(): PostgREST can't express OR across
  // columns in query params cleanly here, so fetch the candidate row and check
  // expiry in code instead of relying on a second server-side condition.
  const res = await fetch(`${supabaseUrl}/rest/v1/room_shares?${params.toString()}`, {
    headers: restHeaders(serviceRoleKey),
  });
  if (!res.ok) return null;

  const rows = (await res.json()) as RoomShareRow[];
  const row = rows[0];
  if (!row) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) return null;

  if (!row.room_id) return null;

  const roomParams = new URLSearchParams({
    select: 'id,user_id',
    id: `eq.${row.room_id}`,
    limit: '1',
  });
  const roomRes = await fetch(`${supabaseUrl}/rest/v1/dressing_rooms?${roomParams.toString()}`, {
    headers: restHeaders(serviceRoleKey),
  });
  if (!roomRes.ok) return null;
  const rooms = (await roomRes.json()) as DressingRoomRow[];
  const room = rooms[0];
  if (!room?.id || !room.user_id) return null;

  return { roomId: room.id, ownerId: room.user_id };
}

/**
 * Loads the subset of the requested item ids that actually belong to the
 * given room, along with their durable storage reference. Ids that don't
 * belong to this room are simply absent from the result - never an error,
 * never distinguishable from "doesn't exist at all".
 */
async function loadDressingRoomItemStorageRefs(
  room: ActiveSharedRoom,
  itemIds: string[],
): Promise<Map<string, { bucket: string; path: string }>> {
  const supabaseUrl = env('SUPABASE_URL');
  const serviceRoleKey = env('SUPABASE_SERVICE_ROLE_KEY');

  const params = new URLSearchParams({
    select: 'id,storage_bucket,storage_path,snapshot_payload',
    dressing_room_id: `eq.${room.roomId}`,
    id: `in.(${itemIds.join(',')})`,
  });

  const res = await fetch(`${supabaseUrl}/rest/v1/dressing_room_items?${params.toString()}`, {
    headers: restHeaders(serviceRoleKey),
  });

  const refs = new Map<string, { bucket: string; path: string }>();
  if (!res.ok) return refs;

  const rows = (await res.json()) as DressingRoomItemStorageRow[];
  for (const row of rows) {
    const ref = resolveStorageRefFromRow(row);
    if (ref && isApprovedPrivateStorageRef('dressing_room_item', room.ownerId, ref)) {
      refs.set(row.id.toLowerCase(), ref);
    }
  }
  return refs;
}

/** Loads active inspiration rows only through active links to this room. */
async function loadInspirationItemStorageRefs(
  room: ActiveSharedRoom,
  inspirationIds: string[],
): Promise<Map<string, { bucket: string; path: string }>> {
  const supabaseUrl = env('SUPABASE_URL');
  const serviceRoleKey = env('SUPABASE_SERVICE_ROLE_KEY');
  const linkParams = new URLSearchParams({
    select: 'inspiration_id,user_id,deleted_at',
    room_id: `eq.${room.roomId}`,
    inspiration_id: `in.(${inspirationIds.join(',')})`,
    deleted_at: 'is.null',
  });
  const linkRes = await fetch(
    `${supabaseUrl}/rest/v1/dressing_room_inspiration_items?${linkParams.toString()}`,
    { headers: restHeaders(serviceRoleKey) },
  );
  if (!linkRes.ok) return new Map();
  const links = (await linkRes.json()) as InspirationRoomLinkRow[];
  if (links.length === 0) return new Map();

  const linkedIds = [...new Set(links.map((row) => row.inspiration_id.toLowerCase()))];
  const itemParams = new URLSearchParams({
    select: 'id,user_id,storage_bucket,storage_path,deleted_at',
    id: `in.(${linkedIds.join(',')})`,
    deleted_at: 'is.null',
  });
  const itemRes = await fetch(`${supabaseUrl}/rest/v1/inspiration_items?${itemParams.toString()}`, {
    headers: restHeaders(serviceRoleKey),
  });
  if (!itemRes.ok) return new Map();
  const items = (await itemRes.json()) as InspirationItemStorageRow[];
  return resolveAuthorizedInspirationStorageRefs(room.ownerId, links, items);
}

async function loadSharedRoomItemStorageRefs(
  room: ActiveSharedRoom,
  itemRefs: SharedRoomItemRef[],
): Promise<Map<string, { bucket: string; path: string }>> {
  const dressingRoomIds = itemRefs
    .filter((ref) => ref.sourceType === 'dressing_room_item')
    .map((ref) => ref.sourceId);
  const inspirationIds = itemRefs
    .filter((ref) => ref.sourceType === 'inspiration_item')
    .map((ref) => ref.sourceId);

  const [dressingRoomRefs, inspirationRefs] = await Promise.all([
    dressingRoomIds.length > 0
      ? loadDressingRoomItemStorageRefs(room, dressingRoomIds)
      : Promise.resolve(new Map<string, { bucket: string; path: string }>()),
    inspirationIds.length > 0
      ? loadInspirationItemStorageRefs(room, inspirationIds)
      : Promise.resolve(new Map<string, { bucket: string; path: string }>()),
  ]);

  const refs = new Map<string, { bucket: string; path: string }>();
  for (const ref of itemRefs) {
    const source = ref.sourceType === 'dressing_room_item' ? dressingRoomRefs : inspirationRefs;
    const storageRef = source.get(ref.sourceId);
    if (storageRef) refs.set(sharedRoomItemRefKey(ref), storageRef);
  }
  return refs;
}

/**
 * Creates a signed URL for a private storage object using the service role.
 * Only ever called for a bucket on the allowlist.
 */
async function createSignedImageUrl(bucket: string, path: string): Promise<string | null> {
  if (!isBucketAllowed(bucket)) return null;

  const supabaseUrl = env('SUPABASE_URL');
  const serviceRoleKey = env('SUPABASE_SERVICE_ROLE_KEY');

  const signRes = await fetch(
    `${supabaseUrl}/storage/v1/object/sign/${encodeStorageObjectPath(bucket, path)}`,
    {
      method: 'POST',
      headers: restHeaders(serviceRoleKey),
      body: JSON.stringify({ expiresIn: SIGNED_URL_TTL_SECONDS }),
    },
  );

  if (!signRes.ok) return null;

  const signJson = (await signRes.json()) as { signedURL?: string | null } | null;
  const signedPath = signJson?.signedURL;
  if (!signedPath) return null;

  // Supabase returns a relative signed path; build the absolute URL.
  return `${supabaseUrl}/storage/v1${signedPath}`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  try {
    const body = (await req.json()) as {
      shareToken?: unknown;
      itemRefs?: unknown;
      itemIds?: unknown;
    };

    if (!isValidShareToken(body?.shareToken)) {
      return json({ error: 'Invalid share token or item ids' }, 400);
    }

    // Build 15 sends typed refs. A legacy build-14 itemIds request remains a
    // dressing_room_item request with the exact same response keys as before.
    const isLegacyRequest = body.itemRefs === undefined;
    const itemRefs = isLegacyRequest
      ? sanitizeItemIds(body.itemIds).map((sourceId) => ({
          sourceType: 'dressing_room_item' as const,
          sourceId: sourceId.toLowerCase(),
        }))
      : sanitizeItemRefs(body.itemRefs);
    if (itemRefs.length === 0) {
      return json({ error: 'Invalid share token or item ids' }, 400);
    }

    const room = await resolveActiveRoomForToken(body.shareToken);
    if (!room) {
      // Generic response: does not distinguish unknown vs. revoked vs. expired.
      return json({ imageUrls: {} }, 404);
    }

    const refs = await loadSharedRoomItemStorageRefs(room, itemRefs);

    const imageUrls: Record<string, string | null> = {};
    await Promise.all(
      itemRefs.map(async (itemRef) => {
        const typedKey = sharedRoomItemRefKey(itemRef);
        const responseKey = isLegacyRequest ? itemRef.sourceId : typedKey;
        const ref = refs.get(typedKey);
        imageUrls[responseKey] = ref ? await createSignedImageUrl(ref.bucket, ref.path) : null;
      }),
    );

    return json({ imageUrls });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unexpected error';
    if (message.startsWith('Missing ')) {
      return json({ error: message }, 500);
    }
    return json({ error: 'Unable to resolve images' }, 500);
  }
});
