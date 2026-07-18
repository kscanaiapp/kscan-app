import { supabase } from './supabaseClient';

const FUNCTION_NAME = 'shared-room-image-url';

export type SharedRoomImageUrlsResult = {
  imageUrls: Record<string, string | null>;
};

export type SharedRoomImageSourceType = 'dressing_room_item' | 'inspiration_item';

export type SharedRoomImageRef = {
  sourceType: SharedRoomImageSourceType;
  sourceId: string;
};

export function getSharedRoomImageKey(ref: SharedRoomImageRef): string {
  return `${ref.sourceType}:${ref.sourceId}`;
}

/**
 * Resolves signed image URLs for shared-room items that have no public HTTPS
 * imageUrl.
 *
 * Sends only the public share token and typed public item references to the
 * Edge Function. The function validates that the token is active, looks up
 * each item's private storage path, and signs only objects that belong to the
 * shared room. Bucket/path never enter this client contract.
 */
export async function resolveSharedRoomImageUrls(
  shareToken: string,
  itemRefs: SharedRoomImageRef[],
  signal?: AbortSignal,
): Promise<Record<string, string | null>> {
  if (!shareToken || itemRefs.length === 0) return {};

  try {
    const { data, error } = await supabase.functions.invoke<SharedRoomImageUrlsResult>(
      FUNCTION_NAME,
      {
        body: { shareToken, itemRefs },
        signal,
      },
    );

    if (error) {
      if (typeof __DEV__ !== 'undefined' && __DEV__) {
        console.error('[shared-room-image] Edge function error:', error);
      }
      return {};
    }

    return data?.imageUrls || {};
  } catch (err: unknown) {
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
      console.error('[shared-room-image] Resolver threw:', err);
    }
    return {};
  }
}
