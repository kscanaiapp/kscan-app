import { isPrivateSlot } from '../types/privateDressingRoomComposition';
import type { PrivateSavedLookSlotV1, PrivateSavedLookV1 } from '../types/privateSavedLook';
import {
  MISSING_PIECE_INTENTS,
  type MissingPieceIntent,
  type MissingPieceQueryV1,
  type MissingPieceResultV1,
  type SavedLookReturnContextV1,
} from '../types/privateSavedLookHandoff';

/**
 * USER-FACING copy for the missing-piece handoff screen.
 *
 * These were 'STRUCTURED MISSING-PIECE HANDOFF READY' and 'EXTERNAL COMMERCE
 * DEFERRED' — internal phase vocabulary rendered directly as the screen's
 * heading and subheading. They described our build process to a user who was
 * trying to find a piece for an outfit.
 *
 * The engineering meaning is unchanged and is now stated in this comment rather
 * than on the screen: the structured query is built and validated locally, and
 * no external retailer call is made in this phase.
 */
export const MISSING_PIECE_HANDOFF_STATUS = "Let's find this piece" as const;
export const EXTERNAL_COMMERCE_STATUS =
  'Shopping for this piece is coming soon.' as const;

function text(value: unknown, max = 120): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function list(value: readonly string[] | null | undefined): string[] {
  return (value ?? []).map((entry) => text(entry, 80)).filter((entry): entry is string => !!entry).slice(0, 8);
}

export function isMissingPieceIntent(value: unknown): value is MissingPieceIntent {
  return typeof value === 'string' && (MISSING_PIECE_INTENTS as readonly string[]).includes(value);
}

export function buildMissingPieceQuery(input: {
  savedLook: PrivateSavedLookV1;
  slot: PrivateSavedLookSlotV1;
  intent: MissingPieceIntent;
  brandPreference?: string | null;
  pricePreference?: { min?: number | null; max?: number | null; currency: string } | null;
  fit?: string | null;
  silhouette?: string | null;
}): MissingPieceQueryV1 | null {
  if (!input.savedLook || !isPrivateSlot(input.slot?.slotKey) || !isMissingPieceIntent(input.intent)) {
    return null;
  }
  const preference = input.pricePreference;
  const currency = text(preference?.currency, 8);
  const pricePreference = preference && currency
    ? {
        min: typeof preference.min === 'number' && preference.min >= 0 ? preference.min : null,
        max: typeof preference.max === 'number' && preference.max >= 0 ? preference.max : null,
        currency,
      }
    : null;
  return {
    schemaVersion: 1,
    slot: input.slot.slotKey,
    category: text(input.slot.snapshot.category),
    clothingType: text(input.slot.snapshot.clothingType),
    subtype: text(input.slot.snapshot.subtype),
    primaryColor: text(input.slot.snapshot.primaryColor),
    secondaryColors: list(input.slot.snapshot.secondaryColors),
    material: list(input.slot.snapshot.material),
    occasion: text(input.savedLook.occasion),
    fit: text(input.fit),
    silhouette: text(input.silhouette),
    brandPreference: text(input.brandPreference),
    pricePreference,
    intent: input.intent,
  };
}

export function validateMissingPieceResult(value: unknown): MissingPieceResultV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const slot = isPrivateSlot(raw.slot) ? raw.slot : null;
  const category = text(raw.category);
  const clothingType = text(raw.clothingType);
  const subtype = text(raw.subtype);
  const complete = !!slot && !!category && (!!clothingType || !!subtype) && !!text(raw.destinationUrl, 2000);
  const material = Array.isArray(raw.material) ? list(raw.material as string[]) : [];
  return {
    schemaVersion: 1,
    completeness: complete ? 'complete' : 'incomplete',
    slot,
    category,
    clothingType,
    subtype,
    primaryColor: text(raw.primaryColor),
    material,
    brand: text(raw.brand),
    providerProductRef: text(raw.providerProductRef, 240),
    retailer: text(raw.retailer, 160),
    price: typeof raw.price === 'number' && raw.price >= 0 ? raw.price : null,
    currency: text(raw.currency, 8),
    destinationUrl: text(raw.destinationUrl, 2000),
    confidence:
      raw.confidence === 'high' || raw.confidence === 'medium' || raw.confidence === 'low'
        ? raw.confidence
        : 'unknown',
  };
}

export function buildSavedLookReturnContext(input: {
  savedLookId: string;
  slotKey: unknown;
  returnRoute: string;
  now?: string;
}): SavedLookReturnContextV1 | null {
  const savedLookId = text(input.savedLookId, 240);
  const returnRoute = text(input.returnRoute, 500);
  const createdAt = input.now ?? new Date().toISOString();
  if (!savedLookId || !returnRoute || !isPrivateSlot(input.slotKey) || !Number.isFinite(Date.parse(createdAt))) {
    return null;
  }
  return { savedLookId, slotKey: input.slotKey, returnRoute, createdAt };
}

/** Controlled local adapter only; it never performs network or retailer routing. */
export async function runControlledMissingPieceHandoff(
  query: MissingPieceQueryV1,
): Promise<{ query: MissingPieceQueryV1; result: MissingPieceResultV1 }> {
  return {
    query,
    result: {
      schemaVersion: 1,
      completeness: 'incomplete',
      slot: query.slot,
      category: query.category,
      clothingType: query.clothingType,
      subtype: query.subtype,
      primaryColor: query.primaryColor,
      material: [...query.material],
      brand: query.brandPreference,
      providerProductRef: null,
      retailer: null,
      price: null,
      currency: null,
      destinationUrl: null,
      confidence: 'unknown',
    },
  };
}
