import { supabase } from './supabaseClient';

const FUNCTION_NAME = 'shared-room-image-url';

export type SharedRoomImageUrlsResult = {
  imageUrls: Record<string, string | null>;
};

/**
 * Resolves signed image URLs for shared-room items that have no public HTTPS
 * imageUrl.
 *
 * Sends only the public share token and the public item ids to the Edge
 * Function. The function validates that the token is active, looks up each
 * item's private storage path, and signs only the objects that belong to the
 * shared room.
 */
export async function resolveSharedRoomImageUrls(
  shareToken: string,
  itemIds: string[],
  signal?: AbortSignal,
): Promise<Record<string, string | null>> {
  if (!shareToken || itemIds.length === 0) return {};

  try {
    const { data, error } = await supabase.functions.invoke<SharedRoomImageUrlsResult>(
      FUNCTION_NAME,
      {
        body: { shareToken, itemIds },
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
