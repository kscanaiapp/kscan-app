import { supabase } from '../supabaseClient';
import { captureActorScope, isActorScopeCurrent } from '../actorScope';
import { getClosetSyncEntry } from '../closet/closetSyncStore';
import { resolveVtoGarmentSlot, toCanonicalVtoCategory } from './vtoEligibility';
import type { ClosetItemProjection } from '../closetItemProjection';
import type { VtoGarmentInput } from '../../types/vto';

export function ownedClosetVtoCategory(item: Pick<ClosetItemProjection, 'category' | 'clothingType' | 'subtype'>): string {
  return toCanonicalVtoCategory([item.subtype, item.clothingType, item.category].filter(Boolean).join(' '));
}

/** UI eligibility is advisory; never substitutes for server ownership/media checks. */
export function canOfferOwnedClosetVto(item: ClosetItemProjection): boolean {
  return !!item.id && !!resolveVtoGarmentSlot(ownedClosetVtoCategory(item));
}

export type OwnedVtoLaunch =
  | { ok: true; garment: VtoGarmentInput }
  | { ok: false; reason: 'account_changed' | 'missing_media' | 'unavailable' | 'unsupported_category' };

/** Existing Closet client_id maps the visible item to its canonical server UUID.
 * Sends no local id as remote identity and creates no commerce or Closet copy.
 */
export async function resolveOwnedClosetVtoInput(item: ClosetItemProjection): Promise<OwnedVtoLaunch> {
  const scope = captureActorScope();
  if (!scope.actorId) return { ok: false, reason: 'account_changed' };
  try {
    // Reuse the existing actor-partitioned sync identity/media evidence. This
    // also keeps the shared K+ upgrade gate reachable after membership lapses
    // and canonical Closet SELECT is consequently denied by RLS. Advisory
    // only: the server still re-reads ownership and readiness for every request.
    const entry = await getClosetSyncEntry(scope.actorId, item.id);
    if (!isActorScopeCurrent(scope)) return { ok: false, reason: 'account_changed' };
    if (entry?.state !== 'pending_delete' && entry?.mediaState === 'ready'
      && typeof entry.serverId === 'string' && UUID.test(entry.serverId)) {
      return buildLaunch(item, entry.serverId, ownedClosetVtoCategory(item));
    }
    const { data: row, error } = await supabase.from('user_closet_items')
      .select('id,user_id,category,clothing_type,subtype,media_status,deleted_at')
      .eq('user_id', scope.actorId).eq('client_id', item.id).is('deleted_at', null).maybeSingle();
    if (!isActorScopeCurrent(scope)) return { ok: false, reason: 'account_changed' };
    if (error) return { ok: false, reason: 'unavailable' };
    if (!row || row.user_id !== scope.actorId || row.deleted_at != null
      || !UUID.test(row.id)) {
      return { ok: false, reason: 'missing_media' };
    }
    const category = ownedClosetVtoCategory({ category: row.category, clothingType: row.clothing_type, subtype: row.subtype });
    if (!resolveVtoGarmentSlot(category)) return { ok: false, reason: 'unsupported_category' };
    if (row.media_status !== 'ready') return { ok: false, reason: 'missing_media' };
    return buildLaunch(item, row.id, category);
  } catch { return { ok: false, reason: isActorScopeCurrent(scope) ? 'unavailable' : 'account_changed' }; }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function buildLaunch(item: ClosetItemProjection, id: string, category: string): OwnedVtoLaunch {
  if (!resolveVtoGarmentSlot(category)) return { ok: false, reason: 'unsupported_category' };
  return { ok: true, garment: {
    source: { type: 'closet_item', closetItemId: id },
    productRef: `closet_item:${id}`, category,
    // Display-only. The transport sends ONLY source, never this local image.
    imageUrl: item.imageUri ?? item.thumbnailUri ?? '',
    ownedMediaReady: true, brand: item.brand, commerceSource: null,
  } };
}
