/**
 * Build 34 / K+ Wardrobe Concierge V1 -- the concrete image source (C4).
 *
 * Binds the shared `ConciergeImageSource` seam to the authorities the app
 * already ships. Everything it touches predates this train:
 *
 *   closetLibrary.loadCloset          local Closet records + their imageUri
 *   closetSyncStore                   clientId <-> serverId, per owner
 *   closetRestoreMedia                the EXISTING private-media authority
 *
 * THE ID PROBLEM, AND WHY THE SIDECAR IS THE ANSWER
 * -------------------------------------------------
 * The server sends `displayFacts.clientId`, which is the AUTHORITATIVE ROW ID
 * (`user_closet_items.id`) -- the only stable identity a server can send.
 * Local Closet records are keyed by their own device-local id instead. The
 * closet sync sidecar is the existing, per-owner mapping between the two, so
 * resolution goes serverId -> local clientId -> local record -> imageUri.
 *
 * Doing it the other way (matching on title or category) would silently attach
 * one garment's photo to another garment's card, which is exactly the class of
 * error this feature cannot afford.
 */

import { loadCloset } from '../closetLibrary';
import { listClosetSyncEntries } from '../closet/closetSyncStore';
import {
  buildClosetRestoreMediaCachePaths,
  hydrateClosetRestoreMedia,
} from '../closet/closetRestoreMedia';
import { buildClosetMediaPaths } from '../closetMedia';
import type { ConciergeImageSource } from './conciergeImageResolver';

type FileSystemLike = {
  getInfoAsync(uri: string): Promise<{ exists?: boolean; size?: number }>;
};

/**
 * Build an image source scoped to ONE account.
 *
 * `ownerId` is required and never inferred. A Concierge card must resolve
 * against the signed-in actor's Closet and no other, so an account switch
 * produces a NEW source rather than a re-scoped one -- there is no path by
 * which a cached mapping outlives the account it belongs to.
 */
export function createConciergeClosetImageSource(input: {
  ownerId: string;
  /** Injected so the resolver is testable off-device. */
  fileSystem: FileSystemLike;
  /**
   * Cross-device media fallback (section 40). Off by default: a device that
   * already holds its Closet media never needs it, and enabling it
   * unconditionally would put a storage read behind every chat bubble.
   */
  allowPrivateStoreFallback?: boolean;
}): ConciergeImageSource {
  const { ownerId, fileSystem } = input;

  /**
   * serverId -> local clientId, from the sync sidecar.
   *
   * Rebuilt per source instance rather than cached module-wide: a module-level
   * cache would survive an account switch, and handing one account's mapping to
   * another is the single worst failure this file can have.
   */
  let mappingPromise: Promise<Map<string, string>> | null = null;

  async function serverIdToClientId(): Promise<Map<string, string>> {
    if (!mappingPromise) {
      mappingPromise = (async () => {
        const map = new Map<string, string>();
        try {
          const entries = await listClosetSyncEntries(ownerId);
          for (const [clientId, entry] of Object.entries(entries)) {
            if (entry?.serverId) map.set(entry.serverId, clientId);
          }
        } catch {
          // An unreadable sidecar means "nothing is known about any item",
          // which degrades to text cards -- never to a wrong image.
        }
        return map;
      })();
    }
    return mappingPromise;
  }

  async function fileExists(uri: string | null | undefined): Promise<boolean> {
    if (!uri) return false;
    try {
      const info = await fileSystem.getInfoAsync(uri);
      // A zero-byte file is a failed or interrupted write, not an image. Treat
      // it as absent so the card falls back rather than rendering a blank.
      return Boolean(info?.exists) && (info.size === undefined || info.size > 0);
    } catch {
      return false;
    }
  }

  return {
    async resolveLocalUri(serverItemId: string): Promise<string | null> {
      // Step 1: the ordinary case -- this device created the item and still
      // holds its picture.
      const mapping = await serverIdToClientId();
      const localId = mapping.get(serverItemId);
      if (localId) {
        try {
          const items = await loadCloset(ownerId);
          const match = (items as Array<Record<string, unknown>>).find(
            (item) => item?.id === localId,
          );
          const uri = typeof match?.imageUri === 'string' ? match.imageUri : null;
          if (await fileExists(uri)) return uri;
        } catch {
          // Fall through to the restore cache.
        }
      }

      // Step 2: media this device already pulled down during a cross-device
      // restore. Deterministic path, no network, keyed by the SERVER id.
      try {
        const paths = buildClosetRestoreMediaCachePaths(ownerId, serverItemId);
        if (await fileExists(paths.primary)) return paths.primary;
        if (await fileExists(paths.thumbnail)) return paths.thumbnail;
      } catch {
        // Fall through.
      }

      return null;
    },

    // Step 3 is present only when the caller opted in. Section 40's
    // requirements are met by delegation, not reimplementation: the existing
    // private bucket, the existing short-lived signed URL, the existing cache
    // write. This module adds no media infrastructure of its own.
    ...(input.allowPrivateStoreFallback
      ? {
        async hydrateFromPrivateStore(serverItemId: string): Promise<string | null> {
          // Paths come from buildClosetMediaPaths, the SAME authority the
          // database enforces via the user_closet_items_media_*_path_derived
          // CHECK constraints. Hand-writing the layout here would let this file
          // and the schema drift, and a drifted path is an unresolvable image
          // that looks like a permissions problem.
          const paths = buildClosetMediaPaths(ownerId, serverItemId);
          const result = await hydrateClosetRestoreMedia({
            ownerId,
            serverItemId,
            primaryStoragePath: paths.primary,
            thumbnailStoragePath: paths.thumbnail,
          });
          if (!result.ok) return null;
          return result.primaryUri ?? result.thumbnailUri ?? null;
        },
      }
      : {}),
  };
}
