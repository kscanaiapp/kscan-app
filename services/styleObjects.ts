import { supabase } from './supabaseClient';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import {
  DRESSING_ROOM_CANONICAL_ITEM_V1,
  DRESSING_ROOM_COMMERCE_PRESERVATION_V1,
  DRESSING_ROOM_DEDUPE_V1,
} from '../constants/featureFlags';
import {
  buildCanonicalSnapshotExtension,
  isLocalImageUri as contractIsLocalImageUri,
  isRemoteImageUrl as contractIsRemoteImageUrl,
  readSnapshotDedupeKey,
  resolveDressingRoomImageSource,
} from './dressingRoomItemContract';
import type {
  DressingRoom,
  DressingRoomItem,
  DressingRoomReactionType,
  DressingRoomInspirationLink,
  InspirationItem,
  ItemReactionCount,
  Look,
  LookDetail,
  LookItem,
  ProductMatchSnapshotSource,
  RoomDetail,
  ScanImageSnapshotSource,
} from '../types/styleObjects';

export const SNAPSHOT_VERSION = 1;
export const STYLE_LIBRARY_IMAGES_BUCKET = 'style-library-images';
export const ROOM_NOTE_MAX_LENGTH = 500;
export const ROOM_TITLE_MAX_LENGTH = 60;
export const INSPIRATION_NOTE_MAX_LENGTH = 200;
const SIGNED_IMAGE_URL_TTL_SECONDS = 60 * 60;
const REACTION_BATCH_SIZE = 100;
const REACTION_LOAD_ERROR = 'Unable to load reactions.';
const REACTION_SAVE_ERROR = 'Unable to save reaction. Please try again.';

export class UnsupportedStyleObjectItemError extends Error {
  constructor(message = "This item can't be added to a Dressing Room yet.") {
    super(message);
    this.name = 'UnsupportedStyleObjectItemError';
  }
}

/**
 * Thrown by uploadAndSaveInspirationToDressingRoom when the image upload and
 * Closet save succeed but attaching the item to the requested room fails.
 * Carries the successfully-saved item so callers can keep it (never discard
 * a successful upload) while still telling the user the room-attach step
 * did not complete.
 */
export class InspirationRoomLinkError extends Error {
  item: InspirationItem;
  constructor(message: string, item: InspirationItem) {
    super(message);
    this.name = 'InspirationRoomLinkError';
    this.item = item;
  }
}

// Verified against the style-library-images Supabase Storage bucket's
// file_size_limit (5242880 bytes / 5 MB). Checked against the normalized
// (post-ImageManipulator) upload payload -- the value that actually
// determines success -- so the user gets a controlled message before the
// network request instead of the raw storage-provider error.
const INSPIRATION_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;

export class InspirationImageTooLargeError extends Error {
  constructor(message = 'This image is too large to upload. Please choose a smaller image.') {
    super(message);
    this.name = 'InspirationImageTooLargeError';
  }
}

function requireAuthUserId(userId?: string | null) {
  if (!userId) {
    throw new Error('Sign in to use Dressing Rooms and Looks.');
  }
  return userId;
}

// Delegates to the canonical Dressing Room item contract so URL/URI
// classification lives in exactly one place (services/dressingRoomItemContract).
export const isRemoteImageUrl = contractIsRemoteImageUrl;
const isLocalImageUri = contractIsLocalImageUri;

function devLog(event: string, details: Record<string, unknown>) {
  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    // Structured, privacy-safe tracing for the Add-to-Dressing-Room pipeline.
    // `details` must only ever carry: entry point / source type, image
    // source kind ('storage' | 'remote' | 'local' | 'none'), pipeline stage,
    // success/failure booleans, and a safe error code (error.code, never
    // error.message). Never include tokens, signed URLs, owner/user ids,
    // dressing room ids, item ids, or storage bucket/path values.
    // eslint-disable-next-line no-console
    console.info(`[DressingRoomAdd] ${event}`, details);
  }
}

function cleanText(value?: string | null) {
  const text = String(value ?? '').trim();
  return text.length > 0 ? text : null;
}

function chunkItems<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function getCurrentSessionUserId() {
  const { data } = await supabase.auth.getSession();
  return data.session?.user?.id ?? null;
}

export function normalizeRoomNoteValue(value?: string | null) {
  const note = String(value ?? '').trim();
  return note.length > 0 ? note : null;
}

function validateRoomNoteValue(value?: string | null) {
  const note = normalizeRoomNoteValue(value);
  if (note && note.length > ROOM_NOTE_MAX_LENGTH) {
    throw new Error(`Room note must be ${ROOM_NOTE_MAX_LENGTH} characters or fewer.`);
  }
  return note;
}

function normalizeRoomTitleValue(value?: string | null): string {
  const title = String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
  if (!title) throw new Error('Dressing Room title is required.');
  if (title.length > ROOM_TITLE_MAX_LENGTH) {
    throw new Error(`Dressing Room title must be ${ROOM_TITLE_MAX_LENGTH} characters or fewer.`);
  }
  return title;
}

function parsePrice(price?: string | null): { amount: string | null; currency: string | null } {
  const raw = cleanText(price);
  if (!raw) return { amount: null, currency: null };

  const amountMatch = raw.replace(/,/g, '').match(/(\d+(?:\.\d{1,2})?)/);
  const amount = amountMatch ? Number(amountMatch[1]).toFixed(2) : null;
  const upper = raw.toUpperCase();
  let currency: string | null = null;
  if (upper.includes('USD') || raw.includes('$')) currency = 'USD';
  else if (upper.includes('GBP') || raw.includes('£')) currency = 'GBP';
  else if (upper.includes('EUR') || raw.includes('€')) currency = 'EUR';

  return { amount, currency };
}

function base64ToArrayBuffer(base64: string) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let clean = base64.replace(/=+$/, '');
  const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let index = 0;

  for (let i = 0; i < clean.length; i += 1) {
    const value = chars.indexOf(clean[i]);
    if (value < 0) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[index] = (buffer >> bits) & 0xff;
      index += 1;
    }
  }

  return bytes.slice(0, index).buffer;
}

function createStoragePath(userId: string) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `${userId}/scans/${suffix}.jpg`;
}

async function uploadLocalScanImage(input: {
  userId?: string | null;
  localImageUri?: string | null;
}) {
  const userId = requireAuthUserId(input.userId);
  const localImageUri = cleanText(input.localImageUri);
  if (!isLocalImageUri(localImageUri)) {
    throw new Error('No local scan image is available to upload.');
  }

  const fileInfo = await FileSystem.getInfoAsync(localImageUri);
  if (!fileInfo.exists) {
    throw new Error('This scan image is no longer available on this device.');
  }

  const prepared = await ImageManipulator.manipulateAsync(
    localImageUri,
    [{ resize: { width: 1440 } }],
    { compress: 0.86, format: ImageManipulator.SaveFormat.JPEG, base64: true },
  );

  if (!prepared.base64) {
    throw new Error('Could not prepare this scan image for upload.');
  }

  const storagePath = createStoragePath(userId);
  const body = base64ToArrayBuffer(prepared.base64);
  const { error } = await supabase.storage
    .from(STYLE_LIBRARY_IMAGES_BUCKET)
    .upload(storagePath, body, {
      contentType: 'image/jpeg',
      cacheControl: '3600',
      upsert: false,
    });

  if (error) {
    throw new Error('Could not upload scan image.');
  }

  return {
    bucket: STYLE_LIBRARY_IMAGES_BUCKET,
    path: storagePath,
    width: prepared.width ?? null,
    height: prepared.height ?? null,
  };
}

async function createSignedStorageUrl(bucket?: string | null, path?: string | null) {
  if (!bucket || !path) return null;
  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(path, SIGNED_IMAGE_URL_TTL_SECONDS);
  if (error) return null;
  return data?.signedUrl ?? null;
}

async function resolveSignedImageUrlsForItems<T extends { imageUrl?: string | null; storageBucket?: string | null; storagePath?: string | null }>(
  items: T[],
): Promise<T[]> {
  return Promise.all(
    items.map(async (item) => {
      if (item.imageUrl || !item.storageBucket || !item.storagePath) return item;
      const signedUrl = await createSignedStorageUrl(item.storageBucket, item.storagePath);
      return signedUrl ? { ...item, imageUrl: signedUrl } : item;
    }),
  );
}

export function buildProductMatchSnapshot(
  source: ProductMatchSnapshotSource,
  options?: { dressingRoomId?: string | null },
) {
  // Resolve fields accepting BOTH camelCase and snake_case so the snapshot
  // builder accepts exactly what ProductShelf considers saveable: its
  // eligibility gate (getProductImageUrl/getPurchaseUrl/getProductTitle) reads
  // both shapes. Without this, a catalog row carrying only `image_url` (no
  // `imageUrl` alias) would pass the UI gate yet throw here.
  const imageUrl =
    cleanText(source.imageUrl) ||
    cleanText(source.image_url) ||
    cleanText(source.thumbnail) ||
    cleanText(source.thumbnailUrl) ||
    cleanText(source.image_src) ||
    cleanText(source.product_image_url);
  if (!isRemoteImageUrl(imageUrl)) {
    throw new UnsupportedStyleObjectItemError();
  }

  const productUrl =
    cleanText(source.affiliateUrl) ||
    cleanText(source.productUrl) ||
    cleanText(source.purchaseUrl) ||
    cleanText(source.product_url) ||
    cleanText(source.purchase_url) ||
    cleanText(source.url) ||
    cleanText(source.link);
  const price = parsePrice(source.price);
  const title =
    cleanText(source.title) ||
    cleanText(source.name) ||
    cleanText(source.displayName) ||
    cleanText(source.product_name) ||
    'Untitled item';
  const brand = cleanText(source.retailer) || cleanText(source.brand);
  const category =
    cleanText(source.imageCategory) ||
    cleanText(source.category) ||
    cleanText(source.canonical_category);

  const snapshotPayload: Record<string, unknown> = {
    snapshotVersion: SNAPSHOT_VERSION,
    sourceType: 'product_match',
    sourceId: cleanText(source.id),
    title,
    brand,
    category,
    imageUrl,
    productUrl,
    price: {
      amount: price.amount,
      currency: price.currency,
      display: cleanText(source.price),
    },
    metadata: {},
  };

  if (DRESSING_ROOM_CANONICAL_ITEM_V1 || DRESSING_ROOM_COMMERCE_PRESERVATION_V1 || DRESSING_ROOM_DEDUPE_V1) {
    const commerceSource =
      (source as ProductMatchSnapshotSource & { purchaseOptions?: unknown; products?: unknown })
    const extension = buildCanonicalSnapshotExtension({
      dressingRoomId: options?.dressingRoomId ?? '',
      sourceType: 'product_match',
      sourceId: cleanText(source.id),
      kind: 'catalog_product',
      providerProductId: cleanText(source.id),
      creationSource: 'product_match',
      commerceSource: {
        purchaseOptions: commerceSource.purchaseOptions,
        products: commerceSource.products,
        // Single-product path: also fold the primary product itself.
        recommendedProducts: [source],
      },
      includeCommerce: DRESSING_ROOM_COMMERCE_PRESERVATION_V1,
      includeDedupe: DRESSING_ROOM_DEDUPE_V1,
    });
    if (DRESSING_ROOM_CANONICAL_ITEM_V1 || DRESSING_ROOM_DEDUPE_V1) {
      snapshotPayload.canonical = extension;
    }
    if (DRESSING_ROOM_COMMERCE_PRESERVATION_V1 && extension.purchaseOptions) {
      snapshotPayload.purchaseOptions = extension.purchaseOptions;
    }
  }

  return {
    sourceType: 'product_match',
    sourceId: cleanText(source.id),
    snapshotVersion: SNAPSHOT_VERSION,
    snapshotPayload,
    title,
    imageUrl,
    brand,
    category,
    priceAmount: price.amount,
    currency: price.currency,
    productUrl,
  };
}

function mapDressingRoom(row: any): DressingRoom {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    description: row.description,
    roomNote: row.room_note,
    coverImageUrl: row.cover_image_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapDressingRoomItem(row: any): DressingRoomItem {
  return {
    id: row.id,
    dressingRoomId: row.dressing_room_id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    snapshotVersion: row.snapshot_version,
    snapshotPayload: row.snapshot_payload ?? {},
    title: row.title,
    imageUrl: row.image_url,
    storageBucket: row.storage_bucket,
    storagePath: row.storage_path,
    brand: row.brand,
    category: row.category,
    priceAmount: row.price_amount == null ? null : String(row.price_amount),
    currency: row.currency,
    productUrl: row.product_url,
    notes: row.notes,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapLook(row: any): Look {
  return {
    id: row.id,
    userId: row.user_id,
    dressingRoomId: row.dressing_room_id,
    title: row.title,
    description: row.description,
    coverImageUrl: row.cover_image_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    dressingRoomTitle: row.dressing_rooms?.title ?? null,
    // AI Stylist expansion columns; legacy databases/rows return undefined/null.
    source: row.source ?? null,
    occasion: row.occasion ?? null,
    dressCode: row.dress_code ?? null,
    setting: row.setting ?? null,
    contextNote: row.context_note ?? null,
    explanation: row.explanation ?? null,
    promptVersion: row.prompt_version ?? null,
    contractVersion: row.contract_version ?? null,
  };
}

function mapLookItem(row: any): LookItem {
  return {
    id: row.id,
    lookId: row.look_id,
    sourceDressingRoomItemId: row.source_dressing_room_item_id,
    snapshotVersion: row.snapshot_version,
    snapshotPayload: row.snapshot_payload ?? {},
    title: row.title,
    imageUrl: row.image_url,
    storageBucket: row.storage_bucket,
    storagePath: row.storage_path,
    brand: row.brand,
    category: row.category,
    productUrl: row.product_url,
    itemRole: row.item_role,
    sortOrder: row.sort_order,
    layoutPayload: row.layout_payload,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sourceType: row.source_type ?? null,
    sourceSavedScanId: row.source_saved_scan_id ?? null,
    sourceInspirationItemId: row.source_inspiration_item_id ?? null,
  };
}

function safeError(_error: any, fallback: string) {
  return new Error(fallback);
}

export async function listDressingRooms(): Promise<DressingRoom[]> {
  const { data, error } = await supabase
    .from('dressing_rooms')
    .select('*')
    .order('updated_at', { ascending: false });
  if (error) throw safeError(error, 'Unable to load Dressing Rooms.');

  const rooms = (data ?? []).map(mapDressingRoom);
  if (rooms.length === 0) return rooms;

  const roomIds = rooms.map((room) => room.id);
  const { data: items, error: itemsError } = await supabase
    .from('dressing_room_items')
    .select('id,dressing_room_id,image_url,storage_bucket,storage_path,sort_order,created_at')
    .in('dressing_room_id', roomIds)
    .order('sort_order', { ascending: true });

  if (itemsError) throw safeError(itemsError, 'Unable to load Dressing Room items.');

  const byRoom = new Map<string, { count: number; cover: string | null }>();
  const coverRows = await resolveSignedImageUrlsForItems((items ?? []).map((item: any) => ({
    ...item,
    storageBucket: item.storage_bucket,
    storagePath: item.storage_path,
  })));

  coverRows.forEach((item: any) => {
    const current = byRoom.get(item.dressing_room_id) ?? { count: 0, cover: null };
    current.count += 1;
    if (!current.cover && (item.image_url || item.imageUrl)) current.cover = item.image_url || item.imageUrl;
    byRoom.set(item.dressing_room_id, current);
  });

  return rooms.map((room) => ({
    ...room,
    itemCount: byRoom.get(room.id)?.count ?? 0,
    coverFallbackUrl: byRoom.get(room.id)?.cover ?? null,
  }));
}

export async function createDressingRoom(input: {
  userId?: string | null;
  title: string;
  description?: string | null;
}): Promise<DressingRoom> {
  const userId = requireAuthUserId(input.userId);
  const title = normalizeRoomTitleValue(input.title);

  const { data, error } = await supabase
    .from('dressing_rooms')
    .insert({
      user_id: userId,
      title,
      description: cleanText(input.description),
    })
    .select('*')
    .single();
  if (error) throw safeError(error, 'Unable to create Dressing Room.');
  return mapDressingRoom(data);
}

export async function updateDressingRoom(
  roomId: string,
  input: { title: string; description?: string | null },
): Promise<DressingRoom> {
  const title = normalizeRoomTitleValue(input.title);

  const { data, error } = await supabase
    .from('dressing_rooms')
    .update({ title, description: cleanText(input.description) })
    .eq('id', roomId)
    .select('*')
    .single();
  if (error) throw safeError(error, 'Unable to update Dressing Room.');
  return mapDressingRoom(data);
}

export async function updateDressingRoomNote(
  roomId: string,
  note: string | null,
): Promise<string | null> {
  const normalizedNote = validateRoomNoteValue(note);

  const { data, error } = await supabase
    .from('dressing_rooms')
    .update({ room_note: normalizedNote })
    .eq('id', roomId)
    .select('room_note')
    .single();

  if (error) {
    const message = String(error.message || '');
    if (message.includes('500 characters or fewer')) {
      throw new Error(`Room note must be ${ROOM_NOTE_MAX_LENGTH} characters or fewer.`);
    }
    throw new Error('Could not save note.');
  }

  return normalizeRoomNoteValue(data?.room_note);
}

export async function deleteDressingRoom(roomId: string): Promise<void> {
  const { error } = await supabase.from('dressing_rooms').delete().eq('id', roomId);
  if (error) throw safeError(error, 'Unable to delete Dressing Room.');
}

export async function createOrGetRoomShare(roomId: string): Promise<string> {
  const { data, error } = await supabase.rpc('create_or_get_room_share', {
    p_room_id: roomId,
  });
  if (error) throw safeError(error, 'Unable to create shared room link.');

  const token = typeof data === 'string' ? data.trim() : '';
  if (!token) throw new Error('Unable to create shared room link.');
  return token;
}

export async function revokeRoomShare(roomId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('revoke_room_share', {
    p_room_id: roomId,
  });
  if (error) throw safeError(error, 'Unable to disable shared room link.');
  return Boolean(data);
}

export async function getDressingRoomDetail(roomId: string): Promise<RoomDetail> {
  const { data: roomRow, error: roomError } = await supabase
    .from('dressing_rooms')
    .select('*')
    .eq('id', roomId)
    .single();
  if (roomError) throw safeError(roomError, 'Unable to load Dressing Room.');

  const { data: itemRows, error: itemError } = await supabase
    .from('dressing_room_items')
    .select('*')
    .eq('dressing_room_id', roomId)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });
  if (itemError) throw safeError(itemError, 'Unable to load Dressing Room items.');

  const items = await resolveSignedImageUrlsForItems((itemRows ?? []).map(mapDressingRoomItem));

  return {
    room: mapDressingRoom(roomRow),
    items,
  };
}

export async function addProductToDressingRoom(
  dressingRoomId: string,
  source: ProductMatchSnapshotSource,
): Promise<DressingRoomItem> {
  devLog('add:start', { entryPoint: 'product_match' });
  const snapshot = buildProductMatchSnapshot(source, { dressingRoomId });
  devLog('add:normalized', { entryPoint: 'product_match', imageSourceKind: 'remote' });

  if (DRESSING_ROOM_DEDUPE_V1) {
    const existing = await findExistingRoomItemByDedupe(dressingRoomId, snapshot.snapshotPayload);
    if (existing) {
      devLog('add:dedupe_hit', { entryPoint: 'product_match' });
      return existing;
    }
  }

  const { count } = await supabase
    .from('dressing_room_items')
    .select('id', { count: 'exact', head: true })
    .eq('dressing_room_id', dressingRoomId);

  const { data, error } = await supabase
    .from('dressing_room_items')
    .insert({
      dressing_room_id: dressingRoomId,
      source_type: snapshot.sourceType,
      source_id: snapshot.sourceId,
      snapshot_version: snapshot.snapshotVersion,
      snapshot_payload: snapshot.snapshotPayload,
      title: snapshot.title,
      image_url: snapshot.imageUrl,
      brand: snapshot.brand,
      category: snapshot.category,
      price_amount: snapshot.priceAmount,
      currency: snapshot.currency,
      product_url: snapshot.productUrl,
      sort_order: count ?? 0,
    })
    .select('*')
    .single();
  if (error) {
    devLog('add:insert_failed', { entryPoint: 'product_match', code: error.code ?? null });
    throw safeError(error, 'Unable to add item to Dressing Room.');
  }
  devLog('add:insert_succeeded', { entryPoint: 'product_match', success: true });
  return mapDressingRoomItem(data);
}

async function findExistingRoomItemByDedupe(
  dressingRoomId: string,
  snapshotPayload: Record<string, unknown>,
): Promise<DressingRoomItem | null> {
  const dedupeKey = readSnapshotDedupeKey(snapshotPayload);
  if (!dedupeKey) return null;
  const { data, error } = await supabase
    .from('dressing_room_items')
    .select('*')
    .eq('dressing_room_id', dressingRoomId)
    .order('created_at', { ascending: true })
    .limit(40);
  if (error || !Array.isArray(data)) return null;
  for (const row of data) {
    const mapped = mapDressingRoomItem(row);
    if (readSnapshotDedupeKey(mapped.snapshotPayload) === dedupeKey) return mapped;
  }
  // Fallback: same source_type + source_id when present
  const sourceType = typeof snapshotPayload.sourceType === 'string' ? snapshotPayload.sourceType : null;
  const sourceId = typeof snapshotPayload.sourceId === 'string' ? snapshotPayload.sourceId : null;
  if (sourceType && sourceId) {
    const hit = data.find(
      (row) => row.source_type === sourceType && String(row.source_id ?? '').toLowerCase() === sourceId.toLowerCase(),
    );
    if (hit) return mapDressingRoomItem(hit);
  }
  return null;
}

/**
 * Adds a scan-backed item to a Dressing Room.
 *
 * Reuses an existing durable storage reference when the caller already has
 * one (e.g. re-adding an item whose image was previously uploaded) instead of
 * re-uploading. Only uploads when the only available source is a device-local
 * URI. Throws a clear, user-facing error up front if the item has no usable
 * image source at all, rather than persisting a null/unusable reference.
 */
export async function addScanImageToDressingRoom(input: {
  dressingRoomId: string;
  userId?: string | null;
  scan: ScanImageSnapshotSource;
}): Promise<DressingRoomItem> {
  devLog('add:start', { entryPoint: 'scan_image' });

  const imageSource = resolveDressingRoomImageSource({
    localUri: input.scan.localImageUri,
    storageBucket: input.scan.storageBucket,
    storagePath: input.scan.storagePath,
    imageUrl: input.scan.imageUrl,
  });

  if (imageSource.kind === 'none') {
    devLog('add:no_usable_image_source', { entryPoint: 'scan_image' });
    throw new UnsupportedStyleObjectItemError(
      "This scan doesn't have a usable image yet, so it can't be added to a Dressing Room.",
    );
  }

  devLog('add:normalized', { entryPoint: 'scan_image', imageSourceKind: imageSource.kind });

  let resolvedImageUrl: string | null = null;
  let storageBucket: string | null = null;
  let storagePath: string | null = null;
  let imageWidth: number | null = null;
  let imageHeight: number | null = null;

  if (imageSource.kind === 'storage') {
    // Already durably stored (e.g. re-adding a previously uploaded item) - no re-upload.
    storageBucket = imageSource.storageBucket;
    storagePath = imageSource.storagePath;
  } else if (imageSource.kind === 'remote') {
    resolvedImageUrl = imageSource.imageUrl;
  } else {
    devLog('add:upload_start', { entryPoint: 'scan_image' });
    const upload = await uploadLocalScanImage({
      userId: input.userId,
      localImageUri: imageSource.localUri,
    });
    storageBucket = upload.bucket;
    storagePath = upload.path;
    imageWidth = upload.width;
    imageHeight = upload.height;
    devLog('add:upload_succeeded', { entryPoint: 'scan_image' });
  }

  const metadata = input.scan.metadata ?? {};
  const title =
    cleanText(metadata.category)
      ? `${cleanText(metadata.category)} scan`
      : 'Scanned inspiration';

  const snapshotPayload: Record<string, unknown> = {
    snapshotVersion: SNAPSHOT_VERSION,
    sourceType: input.scan.sourceType ?? 'live_scan',
    sourceId: cleanText(input.scan.sourceId),
    title,
    image: {
      storageBucket,
      storagePath,
      width: imageWidth,
      height: imageHeight,
      contentType: storageBucket ? 'image/jpeg' : null,
    },
    result: cleanText(input.scan.result),
    metadata: {
      category: cleanText(metadata.category),
      color: cleanText(metadata.color),
      silhouette: cleanText(metadata.silhouette),
      itemType: cleanText(metadata.itemType),
      brand: cleanText(metadata.brand),
      size: cleanText(metadata.size),
      capturedAt: cleanText(input.scan.createdAt),
    },
  };

  if (DRESSING_ROOM_CANONICAL_ITEM_V1 || DRESSING_ROOM_COMMERCE_PRESERVATION_V1 || DRESSING_ROOM_DEDUPE_V1) {
    const scanWithCommerce = input.scan as ScanImageSnapshotSource & {
      purchaseOptions?: unknown;
      products?: unknown;
      recommendedProducts?: unknown;
      scanId?: string | null;
      selectedItemId?: string | null;
      savedScanId?: string | null;
      backendVersion?: string | null;
    };
    const extension = buildCanonicalSnapshotExtension({
      dressingRoomId: input.dressingRoomId,
      sourceType: input.scan.sourceType ?? 'live_scan',
      sourceId: cleanText(input.scan.sourceId),
      scanId: cleanText(scanWithCommerce.scanId),
      selectedItemId: cleanText(scanWithCommerce.selectedItemId),
      savedScanId: cleanText(scanWithCommerce.savedScanId) ?? (
        input.scan.sourceType === 'style_library_scan' ? cleanText(input.scan.sourceId) : null
      ),
      backendVersion: cleanText(scanWithCommerce.backendVersion),
      creationSource: input.scan.sourceType ?? 'live_scan',
      storageBucket,
      storagePath,
      commerceSource: {
        purchaseOptions: scanWithCommerce.purchaseOptions,
        products: scanWithCommerce.products,
        recommendedProducts: scanWithCommerce.recommendedProducts,
      },
      includeCommerce: DRESSING_ROOM_COMMERCE_PRESERVATION_V1,
      includeDedupe: DRESSING_ROOM_DEDUPE_V1,
    });
    if (DRESSING_ROOM_CANONICAL_ITEM_V1 || DRESSING_ROOM_DEDUPE_V1) {
      snapshotPayload.canonical = extension;
    }
    if (DRESSING_ROOM_COMMERCE_PRESERVATION_V1 && extension.purchaseOptions) {
      snapshotPayload.purchaseOptions = extension.purchaseOptions;
    }
  }

  if (DRESSING_ROOM_DEDUPE_V1) {
    const existing = await findExistingRoomItemByDedupe(input.dressingRoomId, snapshotPayload);
    if (existing) {
      devLog('add:dedupe_hit', { entryPoint: 'scan_image' });
      return existing;
    }
  }

  const { count } = await supabase
    .from('dressing_room_items')
    .select('id', { count: 'exact', head: true })
    .eq('dressing_room_id', input.dressingRoomId);

  devLog('add:insert_start', { entryPoint: 'scan_image', imageSourceKind: imageSource.kind });

  const { data, error } = await supabase
    .from('dressing_room_items')
    .insert({
      dressing_room_id: input.dressingRoomId,
      source_type: 'scan_image',
      source_id: cleanText(input.scan.sourceId),
      snapshot_version: SNAPSHOT_VERSION,
      snapshot_payload: snapshotPayload,
      title,
      image_url: resolvedImageUrl,
      storage_bucket: storageBucket,
      storage_path: storagePath,
      category: cleanText(metadata.category),
      sort_order: count ?? 0,
    })
    .select('*')
    .single();
  if (error) {
    devLog('add:insert_failed', { entryPoint: 'scan_image', code: error.code ?? null });
    throw safeError(error, 'Unable to add scan to Dressing Room.');
  }
  devLog('add:insert_succeeded', { entryPoint: 'scan_image', success: true });

  const item = mapDressingRoomItem(data);
  const [resolved] = await resolveSignedImageUrlsForItems([item]);
  devLog('add:refresh_resolved', { entryPoint: 'scan_image', hasRenderableImage: Boolean(resolved.imageUrl) });
  return resolved;
}

export async function removeDressingRoomItem(itemId: string): Promise<void> {
  const { error } = await supabase.from('dressing_room_items').delete().eq('id', itemId);
  if (error) throw safeError(error, 'Unable to remove item.');
}

export async function getItemReactionCounts(itemIds: string[]): Promise<ItemReactionCount[]> {
  const normalizedItemIds = Array.from(new Set(itemIds.map((itemId) => String(itemId).trim()).filter(Boolean)));
  if (normalizedItemIds.length === 0) return [];

  try {
    const batches = chunkItems(normalizedItemIds, REACTION_BATCH_SIZE);
    const results = await Promise.all(
      batches.map(async (batch) => {
        const { data, error } = await supabase.rpc('get_item_reaction_counts', {
          p_item_ids: batch,
        });
        if (error) throw error;
        return (data ?? []) as ItemReactionCount[];
      }),
    );
    return results.flat();
  } catch {
    throw new Error(REACTION_LOAD_ERROR);
  }
}

export async function getMyItemReaction(
  itemIds: string[],
): Promise<Record<string, DressingRoomReactionType | null>> {
  const normalizedItemIds = Array.from(new Set(itemIds.map((itemId) => String(itemId).trim()).filter(Boolean)));
  const emptyMap = Object.fromEntries(normalizedItemIds.map((itemId) => [itemId, null])) as Record<
    string,
    DressingRoomReactionType | null
  >;

  if (normalizedItemIds.length === 0) return {};

  const currentUserId = await getCurrentSessionUserId();
  if (!currentUserId) return emptyMap;

  try {
    const batches = chunkItems(normalizedItemIds, REACTION_BATCH_SIZE);
    const results = await Promise.all(
      batches.map(async (batch) => {
        const { data, error } = await supabase
          .from('dressing_room_item_reactions')
          .select('item_id,reaction_type')
          .eq('user_id', currentUserId)
          .in('item_id', batch);
        if (error) throw error;
        return data ?? [];
      }),
    );

    const reactionMap = { ...emptyMap };
    results.flat().forEach((row: any) => {
      const itemId = String(row.item_id || '').trim();
      if (!itemId) return;
      reactionMap[itemId] = row.reaction_type as DressingRoomReactionType;
    });
    return reactionMap;
  } catch {
    throw new Error(REACTION_LOAD_ERROR);
  }
}

export async function setItemReaction(
  itemId: string,
  reactionType: DressingRoomReactionType,
): Promise<void> {
  const normalizedItemId = String(itemId || '').trim();
  const currentUserId = requireAuthUserId(await getCurrentSessionUserId());

  if (!normalizedItemId) {
    throw new Error(REACTION_SAVE_ERROR);
  }

  const { error } = await supabase
    .from('dressing_room_item_reactions')
    .upsert(
      {
        item_id: normalizedItemId,
        user_id: currentUserId,
        reaction_type: reactionType,
      },
      { onConflict: 'item_id,user_id' },
    );

  if (error) {
    throw new Error(REACTION_SAVE_ERROR);
  }
}

export async function removeItemReaction(itemId: string): Promise<void> {
  const normalizedItemId = String(itemId || '').trim();
  const currentUserId = requireAuthUserId(await getCurrentSessionUserId());

  if (!normalizedItemId) {
    throw new Error(REACTION_SAVE_ERROR);
  }

  const { error } = await supabase
    .from('dressing_room_item_reactions')
    .delete()
    .eq('item_id', normalizedItemId)
    .eq('user_id', currentUserId);

  if (error) {
    throw new Error(REACTION_SAVE_ERROR);
  }
}

export async function listLooks(): Promise<Look[]> {
  const { data, error } = await supabase
    .from('looks')
    .select('*,dressing_rooms(title)')
    .order('updated_at', { ascending: false });
  if (error) throw safeError(error, 'Unable to load Looks.');

  const looks = (data ?? []).map(mapLook);
  if (looks.length === 0) return looks;

  const lookIds = looks.map((look) => look.id);
  const { data: items } = await supabase
    .from('look_items')
    .select('id,look_id,image_url,storage_bucket,storage_path,sort_order')
    .in('look_id', lookIds)
    .order('sort_order', { ascending: true });

  const byLook = new Map<string, { count: number; cover: string | null }>();
  const coverRows = await resolveSignedImageUrlsForItems((items ?? []).map((item: any) => ({
    ...item,
    storageBucket: item.storage_bucket,
    storagePath: item.storage_path,
  })));

  coverRows.forEach((item: any) => {
    const current = byLook.get(item.look_id) ?? { count: 0, cover: null };
    current.count += 1;
    if (!current.cover && (item.image_url || item.imageUrl)) current.cover = item.image_url || item.imageUrl;
    byLook.set(item.look_id, current);
  });

  return looks.map((look) => ({
    ...look,
    itemCount: byLook.get(look.id)?.count ?? 0,
    coverFallbackUrl: byLook.get(look.id)?.cover ?? null,
  }));
}

export async function createLookFromDressingRoomItems(input: {
  dressingRoomId: string;
  title: string;
  description?: string | null;
  itemIds: string[];
}): Promise<Look> {
  const title = cleanText(input.title);
  if (!title) throw new Error('Look title is required.');
  if (!Array.isArray(input.itemIds) || input.itemIds.length === 0) {
    throw new Error('Select at least one item to create a Look.');
  }

  const { data, error } = await supabase.rpc('create_look_from_dressing_room_items', {
    p_dressing_room_id: input.dressingRoomId,
    p_title: title,
    p_description: cleanText(input.description),
    p_item_ids: input.itemIds,
  });
  if (error) throw safeError(error, 'Unable to create Look.');
  // Supabase wraps composite-returning RPCs in an array even for RETURNS <type>.
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error('Unable to create Look: no data returned.');
  return mapLook(row);
}

export async function getLookDetail(lookId: string): Promise<LookDetail> {
  const { data: lookRow, error: lookError } = await supabase
    .from('looks')
    .select('*,dressing_rooms(title)')
    .eq('id', lookId)
    .single();
  if (lookError) throw safeError(lookError, 'Unable to load Look.');

  const { data: itemRows, error: itemError } = await supabase
    .from('look_items')
    .select('*')
    .eq('look_id', lookId)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });
  if (itemError) throw safeError(itemError, 'Unable to load Look items.');

  const items = await resolveSignedImageUrlsForItems((itemRows ?? []).map(mapLookItem));

  return {
    look: mapLook(lookRow),
    items,
  };
}

export async function updateLook(
  lookId: string,
  input: { title: string; description?: string | null },
): Promise<Look> {
  const title = cleanText(input.title);
  if (!title) throw new Error('Look title is required.');

  const { data, error } = await supabase
    .from('looks')
    .update({ title, description: cleanText(input.description) })
    .eq('id', lookId)
    .select('*,dressing_rooms(title)')
    .single();
  if (error) throw safeError(error, 'Unable to update Look.');
  return mapLook(data);
}

export async function deleteLook(lookId: string): Promise<void> {
  const { error } = await supabase.from('looks').delete().eq('id', lookId);
  if (error) throw safeError(error, 'Unable to delete Look.');
}

export function canRenderSnapshotVersion(version?: number | null) {
  return version === SNAPSHOT_VERSION || version === OWNED_ITEM_SNAPSHOT_VERSION;
}

// ── Owned-item Looks (AI Stylist expansion) ───────────────────────────────────
// Snapshot version 2 is used by owned-item (manual/AI) Look items; snapshots
// are built server-side inside the atomic RPCs and never duplicate binaries.

export const OWNED_ITEM_SNAPSHOT_VERSION = 2;
export const LOOK_MIN_ITEMS = 2;
export const LOOK_MAX_ITEMS = 6;

export type OwnedLookItemInput = {
  sourceType: 'saved_scan' | 'inspiration_item';
  sourceId: string;
  role?: string | null;
};

function validateOwnedLookItems(items: OwnedLookItemInput[]) {
  if (!Array.isArray(items) || items.length < LOOK_MIN_ITEMS) {
    throw new Error(`Select at least ${LOOK_MIN_ITEMS} items for a Look.`);
  }
  if (items.length > LOOK_MAX_ITEMS) {
    throw new Error(`A Look can hold up to ${LOOK_MAX_ITEMS} items.`);
  }
  const keys = new Set(items.map((item) => `${item.sourceType}:${item.sourceId}`));
  if (keys.size !== items.length) {
    throw new Error('Each item can only appear once in a Look.');
  }
  for (const item of items) {
    if (item.sourceType !== 'saved_scan' && item.sourceType !== 'inspiration_item') {
      throw new Error('This item cannot be added to a Look yet.');
    }
    if (!item.sourceId || typeof item.sourceId !== 'string') {
      throw new Error('This item cannot be added to a Look yet.');
    }
  }
}

function toOwnedItemsPayload(items: OwnedLookItemInput[]) {
  return items.map((item) => ({
    sourceType: item.sourceType,
    sourceId: item.sourceId,
    role: cleanText(item.role) ?? null,
  }));
}

/**
 * Atomically creates a manual or AI Look from owned-closet items via the
 * create_look_from_owned_items RPC. Server validates ownership/availability of
 * every source row and builds bounded snapshots; a partial insert never leaves
 * an empty Look.
 */
export async function createLookFromOwnedItems(input: {
  title: string;
  description?: string | null;
  source: 'manual' | 'ai';
  occasion?: string | null;
  dressCode?: string | null;
  setting?: string | null;
  contextNote?: string | null;
  explanation?: string | null;
  promptVersion?: string | null;
  contractVersion?: string | null;
  items: OwnedLookItemInput[];
}): Promise<Look> {
  const title = cleanText(input.title);
  if (!title) throw new Error('Look title is required.');
  validateOwnedLookItems(input.items);

  const { data, error } = await supabase.rpc('create_look_from_owned_items', {
    p_title: title,
    p_description: cleanText(input.description),
    p_source: input.source,
    p_occasion: cleanText(input.occasion),
    p_dress_code: cleanText(input.dressCode),
    p_setting: cleanText(input.setting),
    p_context_note: cleanText(input.contextNote),
    p_explanation: cleanText(input.explanation),
    p_prompt_version: cleanText(input.promptVersion),
    p_contract_version: cleanText(input.contractVersion),
    p_items: toOwnedItemsPayload(input.items),
  });
  if (error) throw safeError(error, 'Unable to save this Look.');
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error('Unable to save this Look.');
  return mapLook(row);
}

/**
 * Atomically updates an owned-item Look's metadata and replaces its items via
 * the update_look_owned_items RPC. Dressing Room-derived Looks keep their
 * existing edit path (updateLook) and cannot be edited here.
 */
export async function updateLookOwnedItems(input: {
  lookId: string;
  title: string;
  description?: string | null;
  occasion?: string | null;
  dressCode?: string | null;
  setting?: string | null;
  contextNote?: string | null;
  items: OwnedLookItemInput[];
}): Promise<Look> {
  const title = cleanText(input.title);
  if (!title) throw new Error('Look title is required.');
  validateOwnedLookItems(input.items);

  const { data, error } = await supabase.rpc('update_look_owned_items', {
    p_look_id: input.lookId,
    p_title: title,
    p_description: cleanText(input.description),
    p_occasion: cleanText(input.occasion),
    p_dress_code: cleanText(input.dressCode),
    p_setting: cleanText(input.setting),
    p_context_note: cleanText(input.contextNote),
    p_items: toOwnedItemsPayload(input.items),
  });
  if (error) throw safeError(error, 'Unable to update this Look.');
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error('Unable to update this Look.');
  return mapLook(row);
}

// ── Inspiration Uploads ────────────────────────────────────────────────────────

function createInspirationStoragePath(userId: string) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `${userId}/inspirations/${suffix}.jpg`;
}

export function normalizeInspirationNote(value?: string | null): string | null {
  const note = String(value ?? '').trim();
  if (!note) return null;
  if (note.length > INSPIRATION_NOTE_MAX_LENGTH) {
    throw new Error(`Note must be ${INSPIRATION_NOTE_MAX_LENGTH} characters or fewer.`);
  }
  return note;
}

function mapInspirationItem(row: any): InspirationItem {
  return {
    id: row.id,
    userId: row.user_id,
    storageBucket: row.storage_bucket,
    storagePath: row.storage_path,
    source: row.source,
    originalFilename: row.original_filename ?? null,
    contentType: row.content_type ?? null,
    fileSizeBytes: row.file_size_bytes ?? null,
    width: row.width ?? null,
    height: row.height ?? null,
    note: row.note ?? null,
    imageUrl: null,
    createdAt: row.created_at,
    deletedAt: row.deleted_at ?? null,
    // Phase 2 additive styling metadata; absent columns read as null.
    category: row.category ?? null,
    color: row.color ?? null,
    pattern: row.pattern ?? null,
    material: row.material ?? null,
    silhouette: row.silhouette ?? null,
    garmentRole: row.garment_role ?? null,
  };
}

async function resolveSignedUrlsForInspirationItems(items: InspirationItem[]): Promise<InspirationItem[]> {
  return Promise.all(
    items.map(async (item) => {
      const signedUrl = await createSignedStorageUrl(item.storageBucket, item.storagePath);
      return signedUrl ? { ...item, imageUrl: signedUrl } : item;
    }),
  );
}

async function compressAndUploadInspirationImage(input: {
  userId: string;
  localUri: string;
  storagePath: string;
}): Promise<{ width: number | null; height: number | null }> {
  const prepared = await ImageManipulator.manipulateAsync(
    input.localUri,
    [{ resize: { width: 2048 } }],
    { compress: 0.82, format: ImageManipulator.SaveFormat.JPEG, base64: true },
  );

  if (!prepared.base64) {
    throw new Error('Could not prepare image for upload.');
  }

  const body = base64ToArrayBuffer(prepared.base64);

  if (body.byteLength > INSPIRATION_UPLOAD_MAX_BYTES) {
    throw new InspirationImageTooLargeError();
  }

  const { error } = await supabase.storage
    .from(STYLE_LIBRARY_IMAGES_BUCKET)
    .upload(input.storagePath, body, {
      contentType: 'image/jpeg',
      cacheControl: '3600',
      upsert: false,
    });

  if (error) {
    throw new Error('Could not upload image. Please try again.');
  }

  return { width: prepared.width ?? null, height: prepared.height ?? null };
}

export async function uploadAndSaveInspiration(input: {
  userId?: string | null;
  localUri: string;
  note?: string | null;
}): Promise<InspirationItem> {
  const userId = requireAuthUserId(input.userId);
  const note = normalizeInspirationNote(input.note);
  const storagePath = createInspirationStoragePath(userId);

  const { width, height } = await compressAndUploadInspirationImage({
    userId,
    localUri: input.localUri,
    storagePath,
  });

  const { data, error: dbError } = await supabase
    .from('inspiration_items')
    .insert({
      user_id: userId,
      storage_bucket: STYLE_LIBRARY_IMAGES_BUCKET,
      storage_path: storagePath,
      source: 'upload',
      content_type: 'image/jpeg',
      width,
      height,
      note,
    })
    .select('*')
    .single();

  if (dbError) {
    await supabase.storage.from(STYLE_LIBRARY_IMAGES_BUCKET).remove([storagePath]).catch(() => {});
    throw new Error('Could not save inspiration. Please try again.');
  }

  const item = mapInspirationItem(data);
  const [resolved] = await resolveSignedUrlsForInspirationItems([item]);
  return resolved;
}

export async function uploadAndSaveInspirationToDressingRoom(input: {
  userId?: string | null;
  roomId: string;
  localUri: string;
  note?: string | null;
}): Promise<InspirationItem> {
  const userId = requireAuthUserId(input.userId);
  const note = normalizeInspirationNote(input.note);

  const { data: roomRow } = await supabase
    .from('dressing_rooms')
    .select('id')
    .eq('id', input.roomId)
    .single();

  if (!roomRow) {
    throw new Error('Dressing Room not found or access denied.');
  }

  const storagePath = createInspirationStoragePath(userId);
  const { width, height } = await compressAndUploadInspirationImage({
    userId,
    localUri: input.localUri,
    storagePath,
  });

  const { data: inspirationRow, error: insertError } = await supabase
    .from('inspiration_items')
    .insert({
      user_id: userId,
      storage_bucket: STYLE_LIBRARY_IMAGES_BUCKET,
      storage_path: storagePath,
      source: 'upload',
      content_type: 'image/jpeg',
      width,
      height,
      note,
    })
    .select('*')
    .single();

  if (insertError) {
    await supabase.storage.from(STYLE_LIBRARY_IMAGES_BUCKET).remove([storagePath]).catch(() => {});
    throw new Error('Could not save inspiration. Please try again.');
  }

  const { error: linkError } = await supabase
    .from('dressing_room_inspiration_items')
    .insert({
      room_id: input.roomId,
      inspiration_id: inspirationRow.id,
      user_id: userId,
    });

  if (linkError) {
    // The image upload and closet save already succeeded at this point — a
    // failure to attach the item to this specific room must never destroy
    // that successful upload. Keep the closet row and its storage object,
    // and surface a distinguishable partial-success error so the caller can
    // tell the user the item is safe in their Closet even though it could
    // not be attached here.
    const savedItem = mapInspirationItem(inspirationRow);
    const [resolvedSavedItem] = await resolveSignedUrlsForInspirationItems([savedItem]);
    throw new InspirationRoomLinkError(
      'Saved to your Closet, but could not attach to this Dressing Room.',
      resolvedSavedItem,
    );
  }

  const item = mapInspirationItem(inspirationRow);
  const [resolved] = await resolveSignedUrlsForInspirationItems([item]);
  return resolved;
}

export async function listInspirationItems(): Promise<InspirationItem[]> {
  const { data, error } = await supabase
    .from('inspiration_items')
    .select('*')
    .is('deleted_at', null)
    .order('created_at', { ascending: false });
  if (error) throw safeError(error, 'Unable to load inspiration uploads.');

  const items = (data ?? []).map(mapInspirationItem);
  return resolveSignedUrlsForInspirationItems(items);
}

export async function listDressingRoomInspirationItems(roomId: string): Promise<InspirationItem[]> {
  const { data, error } = await supabase
    .from('dressing_room_inspiration_items')
    .select('*, inspiration_items(*)')
    .eq('room_id', roomId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });
  if (error) throw safeError(error, 'Unable to load room inspiration.');

  const items = (data ?? [])
    .filter((row: any) => row.inspiration_items && !row.inspiration_items.deleted_at)
    .map((row: any) => mapInspirationItem(row.inspiration_items));
  return resolveSignedUrlsForInspirationItems(items);
}

export async function deleteInspirationItem(inspirationId: string): Promise<void> {
  const { error } = await supabase
    .from('inspiration_items')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', inspirationId);
  if (error) throw safeError(error, 'Unable to delete inspiration.');
}

export async function removeInspirationFromDressingRoom(roomId: string, inspirationId: string): Promise<void> {
  const { error } = await supabase
    .from('dressing_room_inspiration_items')
    .update({ deleted_at: new Date().toISOString() })
    .eq('room_id', roomId)
    .eq('inspiration_id', inspirationId);
  if (error) throw safeError(error, 'Unable to remove inspiration from room.');
}

// Attaches an EXISTING Closet/Inspiration item (already stored) to a Dressing
// Room. The stored image is reused - no re-upload is performed. Ownership is
// enforced by RLS: the link row must have user_id = auth.uid() and the target
// room must belong to the caller. The upsert revives a previously removed
// (soft-deleted) link so re-adding an item is idempotent.
export async function addInspirationToDressingRoom(input: {
  roomId: string;
  inspirationId: string;
  userId?: string | null;
}): Promise<void> {
  const userId = requireAuthUserId(input.userId);
  const roomId = String(input.roomId || '').trim();
  const inspirationId = String(input.inspirationId || '').trim();
  if (!roomId || !inspirationId) {
    throw new Error('Missing Dressing Room or Closet item.');
  }

  const { data: roomRow } = await supabase
    .from('dressing_rooms')
    .select('id')
    .eq('id', roomId)
    .single();
  if (!roomRow) {
    throw new Error('Dressing Room not found or access denied.');
  }

  const { error } = await supabase
    .from('dressing_room_inspiration_items')
    .upsert(
      {
        room_id: roomId,
        inspiration_id: inspirationId,
        user_id: userId,
        deleted_at: null,
      },
      { onConflict: 'room_id,inspiration_id' },
    );
  if (error) throw safeError(error, 'Unable to add item to Dressing Room.');
}

// Satisfies DressingRoomInspirationLink type reference without unused-import error
export type { DressingRoomInspirationLink };
