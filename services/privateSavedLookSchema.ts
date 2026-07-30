import type { ClosetItemProjection } from './closetItemProjection';
import type { EffectiveLook } from './privateDressingRoomEffectiveLook';
import {
  PRIVATE_SLOT_DISPLAY_ORDER,
  isPrivateSlot,
  type PrivateDressingRoomSlot,
} from '../types/privateDressingRoomComposition';
import {
  PRIVATE_SAVED_LOOK_SCHEMA_VERSION,
  PRIVATE_SAVED_LOOK_SOURCE,
  type PrivateSavedLookSlotSnapshotV1,
  type PrivateSavedLookSlotV1,
  type PrivateSavedLookV1,
} from '../types/privateSavedLook';

const TEXT_LIMIT = 240;
const ID_LIMIT = 240;
const LIST_LIMIT = 8;

function text(value: unknown, max = TEXT_LIMIT): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function list(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > LIST_LIMIT) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const item = text(entry, 80);
    if (!item) return null;
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function timestamp(value: unknown): string | null {
  const parsed = text(value, 40);
  return parsed && Number.isFinite(Date.parse(parsed)) ? parsed : null;
}

function emptySnapshot(): PrivateSavedLookSlotSnapshotV1 {
  return {
    category: null,
    clothingType: null,
    subtype: null,
    brand: null,
    primaryColor: null,
    secondaryColors: [],
    material: [],
  };
}

function snapshotFrom(item: ClosetItemProjection | null): PrivateSavedLookSlotSnapshotV1 {
  if (!item) return emptySnapshot();
  return {
    category: item.category,
    clothingType: item.clothingType,
    subtype: item.subtype,
    brand: item.brand,
    primaryColor: item.primaryColor,
    secondaryColors: [...item.secondaryColors],
    material: [...item.material],
  };
}

export function savedLookIdempotencyKey(input: {
  sourceSessionId: string;
  sourceCompositionId: string;
  sourceLookId: string;
  sourceInputFingerprint: string;
}): string {
  return [
    input.sourceSessionId,
    input.sourceCompositionId,
    input.sourceLookId,
    input.sourceInputFingerprint,
  ].join('|');
}

export function buildPrivateSavedLook(input: {
  id: string;
  actorId: string;
  sourceSessionId: string;
  sourceCompositionId: string;
  sourceInputFingerprint: string;
  look: EffectiveLook;
  closetItems: readonly ClosetItemProjection[];
  occasion?: string | null;
  anchorClosetItemId?: string | null;
  name?: string | null;
  now: string;
}): PrivateSavedLookV1 | null {
  const id = text(input.id, ID_LIMIT);
  const actorId = text(input.actorId, ID_LIMIT);
  const sourceSessionId = text(input.sourceSessionId, ID_LIMIT);
  const sourceCompositionId = text(input.sourceCompositionId, ID_LIMIT);
  const sourceLookId = text(input.look?.lookId, ID_LIMIT);
  const sourceInputFingerprint = text(input.sourceInputFingerprint, ID_LIMIT);
  const now = timestamp(input.now);
  if (!id || !actorId || !sourceSessionId || !sourceCompositionId || !sourceLookId ||
      !sourceInputFingerprint || !now || !Array.isArray(input.look?.items)) {
    return null;
  }

  const closetById = new Map(input.closetItems.map((item) => [item.id, item]));
  const effectiveBySlot = new Map(input.look.items.map((item) => [item.slot, item]));
  const missing = new Set(input.look.missingSlots ?? []);
  const slots: PrivateSavedLookSlotV1[] = [];

  for (const slotKey of PRIVATE_SLOT_DISPLAY_ORDER) {
    const effective = effectiveBySlot.get(slotKey);
    if (!effective && !missing.has(slotKey)) continue;
    const closetItemId = effective?.closetItemId ?? null;
    const closetItem = closetItemId ? closetById.get(closetItemId) ?? null : null;
    slots.push({
      slotKey,
      closetItemId,
      wasOwnedAtSave: closetItem !== null,
      snapshot: snapshotFrom(closetItem),
    });
  }
  if (slots.length === 0) return null;

  const anchorSlot = slots.find(
    (slot) => slot.closetItemId === (input.anchorClosetItemId ?? null),
  )?.slotKey ?? null;

  return {
    schemaVersion: PRIVATE_SAVED_LOOK_SCHEMA_VERSION,
    id,
    actorId,
    source: PRIVATE_SAVED_LOOK_SOURCE,
    sourceSessionId,
    sourceCompositionId,
    sourceLookId,
    sourceInputFingerprint,
    name: text(input.name, 80),
    occasion: text(input.occasion, 80),
    anchorSlot,
    slots,
    createdAt: now,
    updatedAt: now,
  };
}

function parseSnapshot(value: unknown): PrivateSavedLookSlotSnapshotV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const secondaryColors = list(raw.secondaryColors);
  const material = list(raw.material);
  if (!secondaryColors || !material) return null;
  for (const key of ['category', 'clothingType', 'subtype', 'brand', 'primaryColor']) {
    if (raw[key] !== null && text(raw[key], 120) === null) return null;
  }
  return {
    category: text(raw.category, 120),
    clothingType: text(raw.clothingType, 120),
    subtype: text(raw.subtype, 120),
    brand: text(raw.brand, 120),
    primaryColor: text(raw.primaryColor, 120),
    secondaryColors,
    material,
  };
}

function parseSlot(value: unknown): PrivateSavedLookSlotV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!isPrivateSlot(raw.slotKey) || typeof raw.wasOwnedAtSave !== 'boolean') return null;
  const closetItemId = raw.closetItemId === null ? null : text(raw.closetItemId, ID_LIMIT);
  if (raw.closetItemId !== null && !closetItemId) return null;
  const snapshot = parseSnapshot(raw.snapshot);
  if (!snapshot) return null;
  return { slotKey: raw.slotKey, closetItemId, wasOwnedAtSave: raw.wasOwnedAtSave, snapshot };
}

export type SavedLookValidation = {
  ok: boolean;
  record: PrivateSavedLookV1 | null;
  futureSchema: boolean;
};

export function validatePrivateSavedLook(value: unknown): SavedLookValidation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, record: null, futureSchema: false };
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.schemaVersion === 'number' && raw.schemaVersion > PRIVATE_SAVED_LOOK_SCHEMA_VERSION) {
    return { ok: false, record: null, futureSchema: true };
  }
  if (raw.schemaVersion !== PRIVATE_SAVED_LOOK_SCHEMA_VERSION || raw.source !== PRIVATE_SAVED_LOOK_SOURCE) {
    return { ok: false, record: null, futureSchema: false };
  }

  const id = text(raw.id, ID_LIMIT);
  const actorId = text(raw.actorId, ID_LIMIT);
  const sourceSessionId = text(raw.sourceSessionId, ID_LIMIT);
  const sourceCompositionId = text(raw.sourceCompositionId, ID_LIMIT);
  const sourceLookId = text(raw.sourceLookId, ID_LIMIT);
  const sourceInputFingerprint = text(raw.sourceInputFingerprint, ID_LIMIT);
  const createdAt = timestamp(raw.createdAt);
  const updatedAt = timestamp(raw.updatedAt);
  if (!id || !actorId || !sourceSessionId || !sourceCompositionId || !sourceLookId ||
      !sourceInputFingerprint || !createdAt || !updatedAt || !Array.isArray(raw.slots) ||
      raw.slots.length === 0 || raw.slots.length > PRIVATE_SLOT_DISPLAY_ORDER.length) {
    return { ok: false, record: null, futureSchema: false };
  }
  if (raw.name !== null && text(raw.name, 80) === null) return { ok: false, record: null, futureSchema: false };
  if (raw.occasion !== null && text(raw.occasion, 80) === null) return { ok: false, record: null, futureSchema: false };
  if (raw.anchorSlot !== null && !isPrivateSlot(raw.anchorSlot)) return { ok: false, record: null, futureSchema: false };

  const slots: PrivateSavedLookSlotV1[] = [];
  const seen = new Set<PrivateDressingRoomSlot>();
  for (const value of raw.slots) {
    const slot = parseSlot(value);
    if (!slot || seen.has(slot.slotKey)) return { ok: false, record: null, futureSchema: false };
    seen.add(slot.slotKey);
    slots.push(slot);
  }

  return {
    ok: true,
    futureSchema: false,
    record: {
      schemaVersion: PRIVATE_SAVED_LOOK_SCHEMA_VERSION,
      id,
      actorId,
      source: PRIVATE_SAVED_LOOK_SOURCE,
      sourceSessionId,
      sourceCompositionId,
      sourceLookId,
      sourceInputFingerprint,
      name: text(raw.name, 80),
      occasion: text(raw.occasion, 80),
      anchorSlot: raw.anchorSlot as PrivateDressingRoomSlot | null,
      slots,
      createdAt,
      updatedAt,
    },
  };
}

export function renamePrivateSavedLook(
  record: PrivateSavedLookV1,
  name: string | null,
  now: string,
): PrivateSavedLookV1 | null {
  const updatedAt = timestamp(now);
  if (!updatedAt) return null;
  return { ...record, name: text(name, 80), updatedAt };
}
