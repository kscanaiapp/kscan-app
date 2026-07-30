import type { PrivateDressingRoomSlot } from './privateDressingRoomComposition';

export const MISSING_PIECE_INTENTS = [
  'find_missing_piece',
  'shop_anyway',
  'replace_item',
  'upgrade_piece',
  'alternate_color',
  'different_brand',
] as const;

export type MissingPieceIntent = (typeof MISSING_PIECE_INTENTS)[number];

export type MissingPieceQueryV1 = {
  schemaVersion: 1;
  slot: PrivateDressingRoomSlot;
  category: string | null;
  clothingType: string | null;
  subtype: string | null;
  primaryColor: string | null;
  secondaryColors: string[];
  material: string[];
  occasion: string | null;
  fit: string | null;
  silhouette: string | null;
  brandPreference: string | null;
  pricePreference: { min: number | null; max: number | null; currency: string } | null;
  intent: MissingPieceIntent;
};

export type MissingPieceResultV1 = {
  schemaVersion: 1;
  completeness: 'complete' | 'incomplete';
  slot: PrivateDressingRoomSlot | null;
  category: string | null;
  clothingType: string | null;
  subtype: string | null;
  primaryColor: string | null;
  material: string[];
  brand: string | null;
  providerProductRef: string | null;
  retailer: string | null;
  price: number | null;
  currency: string | null;
  destinationUrl: string | null;
  confidence: 'high' | 'medium' | 'low' | 'unknown';
};

export type SavedLookReturnContextV1 = {
  savedLookId: string;
  slotKey: PrivateDressingRoomSlot;
  returnRoute: string;
  createdAt: string;
};
