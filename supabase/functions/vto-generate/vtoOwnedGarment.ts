import { env, isValidUuid, rest } from '../_shared/deletion/common.ts';

export type OwnedVtoGarment = {
  productRef: string; imageUrl: string; category: string;
  /** Stable private reference for hashing, never a rotating signed URL. */
  mediaIdentity: string;
  source: { type: 'closet_item'; closetItemId: string };
};
export type OwnedVtoResolution =
  | { ok: true; garment: OwnedVtoGarment }
  | { ok: false; code: 'invalid_garment_input' | 'provider_unavailable' };

async function signOwnedMedia(bucket: string, path: string): Promise<string | null> {
  const base = env('SUPABASE_URL');
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  const encoded = [bucket, ...path.split('/')].map(encodeURIComponent).join('/');
  const response = await fetch(`${base}/storage/v1/object/sign/${encoded}`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: 120 }),
  });
  if (!response.ok) return null;
  const body = await response.json();
  const signedPath = body?.signedURL;
  if (typeof signedPath !== 'string' || !signedPath.startsWith(`/object/sign/${encoded}?`)) return null;
  return `${base}/storage/v1${signedPath}`;
}

/** No caller URL, bucket, path, category, or ownership claim is consumed. */
export async function resolveOwnedVtoGarment(
  actorId: string, itemId: unknown,
  deps: { rest?: typeof rest; sign?: typeof signOwnedMedia } = {},
): Promise<OwnedVtoResolution> {
  if (!isValidUuid(actorId) || typeof itemId !== 'string' || !isValidUuid(itemId)) {
    return { ok: false, code: 'invalid_garment_input' };
  }
  try {
    const response = await (deps.rest ?? rest)(
      `user_closet_items?select=id,user_id,category,clothing_type,subtype,storage_bucket,storage_path,media_status,deleted_at&id=eq.${itemId}&user_id=eq.${actorId}&deleted_at=is.null&limit=1`,
    );
    if (!response.ok) return { ok: false, code: 'provider_unavailable' };
    const rows = await response.json();
    const row = Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
    const bucket = 'style-library-images';
    const path = `${actorId}/closet/${itemId}-primary.jpg`;
    if (!row || row.id !== itemId || row.user_id !== actorId || row.deleted_at != null
      || row.media_status !== 'ready' || row.storage_bucket !== bucket || row.storage_path !== path) {
      return { ok: false, code: 'invalid_garment_input' };
    }
    const imageUrl = await (deps.sign ?? signOwnedMedia)(bucket, path);
    if (!imageUrl) return { ok: false, code: 'invalid_garment_input' };
    const category = [row.subtype, row.clothing_type, row.category]
      .filter(v => typeof v === 'string' && v.trim()).join(' ');
    return { ok: true, garment: {
      productRef: `closet_item:${itemId}`, imageUrl, category, mediaIdentity: `${bucket}/${path}`,
      source: { type: 'closet_item', closetItemId: itemId },
    } };
  } catch { return { ok: false, code: 'provider_unavailable' }; }
}
