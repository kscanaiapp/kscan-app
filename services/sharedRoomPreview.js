/**
 * Normalizes the public shared-room preview payload into the canonical shape
 * used by the mobile shared-room screen.
 *
 * Tolerates BOTH the external API normalized names (`token`, `title`) AND the
 * raw Supabase RPC names (`shareToken`, `roomTitle`) so the screen keeps
 * working regardless of which layer generated the response.
 *
 * Deliberately does NOT read or forward any private-storage fields (bucket,
 * path) from the raw payload, even if present. Private storage resolution is
 * the sole responsibility of the shared-room-image-url Edge Function
 * (service role, token/room-scoped). The public preview client only ever
 * works with `imageUrl` (public HTTPS) or a signed URL returned by that
 * function; it must never carry a bucket/path field, even a null one, since
 * that would suggest the client resolves private storage itself.
 */

function normalizeItem(rawItem) {
  if (!rawItem || typeof rawItem !== 'object') {
    return {
      id: null,
      imageUrl: null,
      imageWidth: null,
      imageHeight: null,
      category: null,
      color: null,
      silhouette: null,
      title: null,
    };
  }

  return {
    id: rawItem.id ?? null,
    imageUrl: rawItem.imageUrl ?? null,
    imageWidth: rawItem.imageWidth ?? null,
    imageHeight: rawItem.imageHeight ?? null,
    category: rawItem.category ?? null,
    color: rawItem.color ?? null,
    silhouette: rawItem.silhouette ?? null,
    title: rawItem.title ?? null,
  };
}

function normalizeSharedRoomPreview(raw) {
  const input = raw?.preview ?? raw ?? null;
  if (!input || typeof input !== 'object') {
    return null;
  }

  const hasIdentity = Boolean(input.token || input.shareToken);
  const hasItemsArray = Array.isArray(input.items);
  if (!hasIdentity && !hasItemsArray) {
    return null;
  }

  const rawItems = hasItemsArray ? input.items : [];
  const items = rawItems.map(normalizeItem);
  const itemCount = typeof input.itemCount === 'number' ? input.itemCount : items.length;

  return {
    token: input.token || input.shareToken || '',
    title: input.title ?? input.roomTitle ?? '',
    note: input.note ?? null,
    itemCount,
    sharedAt: input.sharedAt ?? null,
    coverImageUrl: input.coverImageUrl ?? null,
    allowImport: input.allowImport ?? false,
    maxItemsReturned: typeof input.maxItemsReturned === 'number' ? input.maxItemsReturned : items.length,
    isCapped: input.isCapped ?? false,
    nextCursor: input.nextCursor ?? null,
    items,
  };
}

module.exports = {
  normalizeSharedRoomPreview,
};
