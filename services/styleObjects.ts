import { supabase } from './supabaseClient';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import type {
  DressingRoom,
  DressingRoomItem,
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
const SIGNED_IMAGE_URL_TTL_SECONDS = 60 * 60;

export class UnsupportedStyleObjectItemError extends Error {
  constructor(message = "This item can't be added to a Dressing Room yet.") {
    super(message);
    this.name = 'UnsupportedStyleObjectItemError';
  }
}

function requireAuthUserId(userId?: string | null) {
  if (!userId) {
    throw new Error('Sign in to use Dressing Rooms and Looks.');
  }
  return userId;
}

export function isRemoteImageUrl(value?: string | null) {
  return /^https?:\/\//i.test(String(value || '').trim());
}

function isLocalImageUri(value?: string | null) {
  return /^(file|content|asset):\/\//i.test(String(value || '').trim());
}

function cleanText(value?: string | null) {
  const text = String(value ?? '').trim();
  return text.length > 0 ? text : null;
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
    throw new Error(error.message || 'Could not upload scan image.');
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

export function buildProductMatchSnapshot(source: ProductMatchSnapshotSource) {
  const imageUrl = cleanText(source.imageUrl);
  if (!isRemoteImageUrl(imageUrl)) {
    throw new UnsupportedStyleObjectItemError();
  }

  const productUrl =
    cleanText(source.affiliateUrl) ||
    cleanText(source.productUrl) ||
    cleanText(source.purchaseUrl);
  const price = parsePrice(source.price);
  const title = cleanText(source.title) || cleanText(source.name) || 'Untitled item';
  const brand = cleanText(source.retailer);
  const category = cleanText(source.imageCategory);

  return {
    sourceType: 'product_match',
    sourceId: cleanText(source.id),
    snapshotVersion: SNAPSHOT_VERSION,
    snapshotPayload: {
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
    },
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
  };
}

function safeError(error: any, fallback: string) {
  if (!error) return new Error(fallback);
  return new Error(error.message || fallback);
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
  const { data: items } = await supabase
    .from('dressing_room_items')
    .select('id,dressing_room_id,image_url,storage_bucket,storage_path,sort_order,created_at')
    .in('dressing_room_id', roomIds)
    .order('sort_order', { ascending: true });

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
  const title = cleanText(input.title);
  if (!title) throw new Error('Dressing Room title is required.');

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
  const title = cleanText(input.title);
  if (!title) throw new Error('Dressing Room title is required.');

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
  const snapshot = buildProductMatchSnapshot(source);

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
  if (error) throw safeError(error, 'Unable to add item to Dressing Room.');
  return mapDressingRoomItem(data);
}

export async function addScanImageToDressingRoom(input: {
  dressingRoomId: string;
  userId?: string | null;
  scan: ScanImageSnapshotSource;
}): Promise<DressingRoomItem> {
  const upload = await uploadLocalScanImage({
    userId: input.userId,
    localImageUri: input.scan.localImageUri,
  });
  const metadata = input.scan.metadata ?? {};
  const title =
    cleanText(metadata.category)
      ? `${cleanText(metadata.category)} scan`
      : 'Scanned inspiration';

  const snapshotPayload = {
    snapshotVersion: SNAPSHOT_VERSION,
    sourceType: input.scan.sourceType ?? 'live_scan',
    sourceId: cleanText(input.scan.sourceId),
    title,
    image: {
      storageBucket: upload.bucket,
      storagePath: upload.path,
      width: upload.width,
      height: upload.height,
      contentType: 'image/jpeg',
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

  const { count } = await supabase
    .from('dressing_room_items')
    .select('id', { count: 'exact', head: true })
    .eq('dressing_room_id', input.dressingRoomId);

  const { data, error } = await supabase
    .from('dressing_room_items')
    .insert({
      dressing_room_id: input.dressingRoomId,
      source_type: 'scan_image',
      source_id: cleanText(input.scan.sourceId),
      snapshot_version: SNAPSHOT_VERSION,
      snapshot_payload: snapshotPayload,
      title,
      image_url: null,
      storage_bucket: upload.bucket,
      storage_path: upload.path,
      category: cleanText(metadata.category),
      sort_order: count ?? 0,
    })
    .select('*')
    .single();
  if (error) throw safeError(error, 'Unable to add scan to Dressing Room.');

  const item = mapDressingRoomItem(data);
  const [resolved] = await resolveSignedImageUrlsForItems([item]);
  return resolved;
}

export async function removeDressingRoomItem(itemId: string): Promise<void> {
  const { error } = await supabase.from('dressing_room_items').delete().eq('id', itemId);
  if (error) throw safeError(error, 'Unable to remove item.');
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
  return version === SNAPSHOT_VERSION;
}
