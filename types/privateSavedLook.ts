import type { PrivateDressingRoomSlot } from './privateDressingRoomComposition';

export const PRIVATE_SAVED_LOOK_SCHEMA_VERSION = 1 as const;
export const PRIVATE_SAVED_LOOK_SOURCE = 'dressing_room' as const;

export type PrivateSavedLookSlotSnapshotV1 = {
  category: string | null;
  clothingType: string | null;
  subtype: string | null;
  brand: string | null;
  primaryColor: string | null;
  secondaryColors: string[];
  material: string[];
};

export type PrivateSavedLookSlotV1 = {
  slotKey: PrivateDressingRoomSlot;
  closetItemId: string | null;
  wasOwnedAtSave: boolean;
  snapshot: PrivateSavedLookSlotSnapshotV1;
};

export type PrivateSavedLookV1 = {
  schemaVersion: typeof PRIVATE_SAVED_LOOK_SCHEMA_VERSION;
  id: string;
  actorId: string;
  source: typeof PRIVATE_SAVED_LOOK_SOURCE;
  sourceSessionId: string;
  sourceCompositionId: string;
  sourceLookId: string;
  sourceInputFingerprint: string;
  name: string | null;
  occasion: string | null;
  anchorSlot: PrivateDressingRoomSlot | null;
  slots: PrivateSavedLookSlotV1[];
  createdAt: string;
  updatedAt: string;
};

export type PrivateSavedLookErrorCode =
  | 'missing_actor_context'
  | 'stale_actor_context'
  | 'saved_look_store_unreadable'
  | 'saved_look_store_corrupt'
  | 'saved_look_store_future_schema'
  | 'saved_look_persist_failed'
  | 'saved_look_invalid_input'
  | 'saved_look_not_found';
