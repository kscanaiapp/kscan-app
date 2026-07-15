/**
 * Canonical Dressing Room item image-source contract.
 *
 * A candidate item may carry up to three independent signals for its image:
 *   1. `localUri` - a device-local file/content URI (only valid on-device,
 *                    never durable, never sent to the server as-is).
 *   2. `storageBucket` + `storagePath` - a durable, private Supabase Storage
 *                    reference. This is the source of truth once an image
 *                    has been uploaded; it survives app reinstalls and is
 *                    what gets persisted to `dressing_room_items`.
 *   3. `imageUrl` - an already-public, renderable `https://`/`http://` URL
 *                    (e.g. a retailer product image). Never a signed URL -
 *                    signed URLs are resolved at render time, not stored.
 *
 * `imageUrl: null` does NOT mean "no image" if a durable storage reference is
 * present - callers must resolve through this module rather than checking
 * `imageUrl` (or `localUri`) directly, which is the bug this module fixes.
 */

export type DressingRoomImageCandidate = {
  localUri?: string | null;
  storageBucket?: string | null;
  storagePath?: string | null;
  imageUrl?: string | null;
};

export type DressingRoomImageSource =
  | { kind: 'storage'; storageBucket: string; storagePath: string }
  | { kind: 'remote'; imageUrl: string }
  | { kind: 'local'; localUri: string }
  | { kind: 'none' };

export function isRemoteImageUrl(value?: string | null): boolean {
  return /^https?:\/\//i.test(String(value ?? '').trim());
}

export function isLocalImageUri(value?: string | null): boolean {
  return /^(file|content|asset|ph):\/\//i.test(String(value ?? '').trim());
}

/**
 * Resolves the single best usable image source for a Dressing Room item
 * candidate, in durability order: an existing private storage reference is
 * preferred (no re-upload needed), then a public remote URL, then a
 * device-local file that would need to be uploaded.
 */
export function resolveDressingRoomImageSource(
  candidate: DressingRoomImageCandidate,
): DressingRoomImageSource {
  const storageBucket = candidate.storageBucket?.trim() || null;
  const storagePath = candidate.storagePath?.trim() || null;
  if (storageBucket && storagePath) {
    return { kind: 'storage', storageBucket, storagePath };
  }

  const imageUrl = candidate.imageUrl?.trim() || null;
  if (imageUrl && isRemoteImageUrl(imageUrl)) {
    return { kind: 'remote', imageUrl };
  }

  const localUri = candidate.localUri?.trim() || null;
  if (localUri && isLocalImageUri(localUri)) {
    return { kind: 'local', localUri };
  }

  return { kind: 'none' };
}

export function hasUsableDressingRoomImageSource(candidate: DressingRoomImageCandidate): boolean {
  return resolveDressingRoomImageSource(candidate).kind !== 'none';
}

/**
 * User-facing explanation for why an item currently cannot be added, given it
 * has no usable image source. Used to keep the Add action visible-but-disabled
 * (with an explanation) instead of silently disappearing.
 */
export function describeMissingImageReason(): string {
  return "This item's image isn't available right now, so it can't be added yet.";
}
