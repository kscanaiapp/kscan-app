/**
 * Scan Result → Dressing Room save bridge (Part 2 activation).
 *
 * Wraps the EXISTING Dressing Room save path (`addProductToDressingRoom` in
 * services/styleObjects.ts). It does NOT create a parallel save/memory system,
 * a new table, or a new RPC. It only adapts a `ScanResultObject`'s primary
 * product match into the shape the existing path already accepts, reusing the
 * pure `normalizeForSnapshot` helper.
 *
 * PRIVACY: only safe catalog/product fields are forwarded. The image source is
 * resolved by `normalizeForSnapshot`, which accepts ONLY `https?://` URLs — so
 * a raw/local/captured scan image URI (`file://…`, content URIs, etc.) can never
 * become the saved image. The raw scan-image persistence path
 * (`addScanImageToDressingRoom`, which uploads a local image) is intentionally
 * NOT imported or called here.
 *
 * METADATA NOTE: the existing snapshot type (`ProductMatchSnapshotSource` /
 * `buildProductMatchSnapshot`) is strict — it has a fixed field set and hardcodes
 * `snapshotPayload.metadata = {}`, so extra StyleMemory metadata cannot be
 * attached without a schema/type change. We therefore persist only the standard
 * product match and keep the `StyleMemoryItem` metadata in-memory, linked by
 * `savedToDressingRoomId`. (METADATA_PERSISTENCE_DEFERRED_SCHEMA_STRICT.)
 */

import { normalizeForSnapshot } from '../src/utils/productSnapshot';
import { createStyleMemoryItem } from './scanResultObject';
import { addProductToDressingRoom } from './styleObjects';
import type { RankedScanProduct } from '../types/scanIdentification';
import type { ScanResultObject, StyleMemoryItem } from '../types/scanResultObject';
import type { ProductMatchSnapshotSource, DressingRoomItem } from '../types/styleObjects';

/** Thrown/returned when there is no safe, saveable catalog match on the result. */
export const NO_SAFE_PRODUCT_MATCH_TO_SAVE = 'NO_SAFE_PRODUCT_MATCH_TO_SAVE';

export type SaveScanResultInput = {
  dressingRoomId: string;
  scanResultObject: ScanResultObject;
  userTags?: string[];
  notes?: string;
};

export type SaveScanResultDeps = {
  addProductToDressingRoom: (
    dressingRoomId: string,
    source: ProductMatchSnapshotSource,
  ) => Promise<DressingRoomItem>;
};

export type SaveScanResultOutcome = {
  item: DressingRoomItem;
  styleMemoryItem: StyleMemoryItem;
};

/** Pick the primary (top-ranked / first) product match. */
export function selectPrimaryMatch(
  scanResultObject: ScanResultObject | null | undefined,
): RankedScanProduct | null {
  const matches = scanResultObject && Array.isArray(scanResultObject.matches)
    ? scanResultObject.matches
    : [];
  for (const match of matches) {
    if (match && typeof match === 'object') return match;
  }
  return null;
}

/**
 * Build the exact source object `addProductToDressingRoom` expects from the
 * primary match, using the existing `normalizeForSnapshot`. Returns `null` when
 * there is no safe remote catalog image or no title — the two conditions the
 * existing eligibility gate (`canAddProductToDressingRoom`) requires.
 */
export function buildDressingRoomSaveSource(
  scanResultObject: ScanResultObject | null | undefined,
): ProductMatchSnapshotSource | null {
  const primary = selectPrimaryMatch(scanResultObject);
  if (!primary) return null;

  const normalized = normalizeForSnapshot(primary as Record<string, unknown>);
  // normalizeForSnapshot resolves imageUrl via firstRemoteUrl (https only); a
  // local/raw/captured URI is rejected and surfaces as null here.
  if (!normalized.imageUrl || !normalized.title) return null;

  return normalized as unknown as ProductMatchSnapshotSource;
}

/**
 * Save a scan result's primary product match through the existing Dressing Room
 * path. Returns the created Dressing Room item plus an in-memory
 * `StyleMemoryItem` whose `savedToDressingRoomId` links to it.
 *
 * Rejects with `NO_SAFE_PRODUCT_MATCH_TO_SAVE` when there is no safe match.
 * `deps` is injectable purely for testing; production callers use the default.
 */
export async function saveScanResultToDressingRoom(
  input: SaveScanResultInput,
  deps: SaveScanResultDeps = { addProductToDressingRoom },
): Promise<SaveScanResultOutcome> {
  const { dressingRoomId, scanResultObject } = input;

  const source = buildDressingRoomSaveSource(scanResultObject);
  if (!source) {
    throw new Error(NO_SAFE_PRODUCT_MATCH_TO_SAVE);
  }

  const item = await deps.addProductToDressingRoom(dressingRoomId, source);

  const styleMemoryItem = createStyleMemoryItem(scanResultObject, {
    savedToDressingRoomId: item?.id ?? null,
    userTags: input.userTags,
    notes: input.notes,
  });

  return { item, styleMemoryItem };
}
