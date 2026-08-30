/**
 * Build 34 / K+ Wardrobe Concierge V1 -- C4 image resolution (sections 39/40).
 *
 * RESOLUTION ORDER, AND WHY IT IS THIS ORDER
 * ------------------------------------------
 *   1. LOCAL Closet image, found by clientId          (section 39)
 *   2. Already-downloaded private restore cache        (no network)
 *   3. Existing private Storage, via the EXISTING
 *      signed-URL authority, for a device that has
 *      facts but not yet media                         (section 40)
 *   4. No image -> a text/category card                (section 40)
 *
 * Local first because the image is already on the device in the ordinary case,
 * and because nothing should go to the network to draw a chat bubble. The cloud
 * step exists for exactly one situation the product creates on purpose:
 * cross-device Closet restore syncs FACTS before MEDIA, so a new device can
 * legitimately know it owns an item whose picture has not arrived yet.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ----------------------------------
 * No new bucket, no new upload path, no new signed-URL code, no public URL, no
 * raw unsanitized image. Step 3 delegates to `hydrateClosetRestoreMedia`, the
 * media authority Track B already ships -- same private bucket, same
 * short-lived signed URL, same on-disk cache. This module contributes ordering
 * and a fallback state, not infrastructure.
 *
 * NO IMAGE EVER REACHES THE MODEL. Everything here runs on the client, after
 * generation, purely to draw a card.
 */

/** What a renderer should do for one card's image slot. */
export type ConciergeImageState =
  /** A displayable local file URI was found. */
  | { status: 'ready'; uri: string }
  /** Resolution has not finished. Renderers show a neutral placeholder. */
  | { status: 'pending' }
  /**
   * No image is available and none is coming. The card renders as text +
   * category. This is a NORMAL state, not an error -- never a broken image.
   */
  | { status: 'unavailable' };

export const CONCIERGE_IMAGE_PENDING: ConciergeImageState = { status: 'pending' };
export const CONCIERGE_IMAGE_UNAVAILABLE: ConciergeImageState = { status: 'unavailable' };

/**
 * The seam both platforms depend on (section 38 lists the image-resolution
 * INTERFACE as shared C4 work).
 *
 * Declaring it as an interface rather than importing the concrete filesystem
 * and Supabase modules directly is what keeps this layer testable without a
 * device, and what lets a platform substitute its own local lookup without
 * forking the Concierge model.
 */
export interface ConciergeImageSource {
  /**
   * Local image URI for a Closet item, by its canonical server row id.
   * Returns null when this device has no local copy.
   */
  resolveLocalUri(clientId: string): Promise<string | null>;
  /**
   * Pull the item's media down from the EXISTING private Closet store, if the
   * caller is permitted and the object exists. Optional: when absent, step 3 is
   * skipped and resolution falls straight to 'unavailable'.
   */
  hydrateFromPrivateStore?(clientId: string): Promise<string | null>;
}

/**
 * Resolve one card's image.
 *
 * Never throws. Every failure -- a missing file, a denied read, a network
 * error, a corrupt cache -- collapses to 'unavailable', because the correct
 * customer outcome for all of them is identical: show the text card. Surfacing
 * these differently would mean showing an error for something that is not the
 * user's problem and that they cannot act on.
 */
export async function resolveConciergeImage(
  source: ConciergeImageSource,
  clientId: string | null,
): Promise<ConciergeImageState> {
  if (!clientId) return CONCIERGE_IMAGE_UNAVAILABLE;

  try {
    const local = await source.resolveLocalUri(clientId);
    if (local) return { status: 'ready', uri: local };
  } catch {
    // Fall through: a local lookup failure is not a reason to skip the cloud
    // step, which may still have the image.
  }

  if (!source.hydrateFromPrivateStore) return CONCIERGE_IMAGE_UNAVAILABLE;

  try {
    const hydrated = await source.hydrateFromPrivateStore(clientId);
    if (hydrated) return { status: 'ready', uri: hydrated };
  } catch {
    // Deliberate: see the contract note above.
  }

  return CONCIERGE_IMAGE_UNAVAILABLE;
}

/**
 * Resolve several cards at once, returning a clientId -> state map.
 *
 * Bounded and de-duplicated: a look group repeating an item resolves it once,
 * and a malformed payload cannot turn into an unbounded fan-out of storage
 * reads. Cards without a clientId are simply absent from the map, which a
 * renderer reads as 'unavailable'.
 */
export async function resolveConciergeImages(
  source: ConciergeImageSource,
  clientIds: Array<string | null>,
  maxItems = 16,
): Promise<Record<string, ConciergeImageState>> {
  const unique = [...new Set(clientIds.filter((id): id is string => Boolean(id)))].slice(
    0,
    maxItems,
  );
  const entries = await Promise.all(
    unique.map(async (id) => [id, await resolveConciergeImage(source, id)] as const),
  );
  return Object.fromEntries(entries);
}
