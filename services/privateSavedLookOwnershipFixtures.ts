import type { ClosetItemProjection } from './closetItemProjection';
import type { OwnershipClosetProjection, PrivateOwnershipState } from './privateSavedLookOwnership';
import type { PrivateSavedLookV1 } from '../types/privateSavedLook';

const ACTOR_A = 'actor-a';
const BASE_ITEM: ClosetItemProjection = {
  id: 'closet-top-1',
  title: 'Navy silk blouse',
  notes: null,
  origin: null,
  imageUri: null,
  thumbnailUri: null,
  createdAt: null,
  updatedAt: null,
  displaySummary: 'Tops - Blouse - Silk blouse - Navy',
  taxonomyUnknown: false,
  category: 'Tops',
  clothingType: 'Blouse',
  subtype: 'Silk blouse',
  brand: 'K Scan Atelier',
  primaryColor: 'Navy',
  secondaryColors: [],
  material: ['Silk'],
  size: null,
};

function saved(overrides: Partial<PrivateSavedLookV1> = {}): PrivateSavedLookV1 {
  return {
    schemaVersion: 1,
    id: 'saved-look-fixture',
    actorId: ACTOR_A,
    source: 'dressing_room',
    sourceSessionId: 'session-1',
    sourceCompositionId: 'composition-1',
    sourceLookId: 'look-1',
    sourceInputFingerprint: 'fingerprint-1',
    name: null,
    occasion: 'Work',
    anchorSlot: 'top',
    slots: [{
      slotKey: 'top',
      closetItemId: BASE_ITEM.id,
      wasOwnedAtSave: true,
      snapshot: {
        category: BASE_ITEM.category,
        clothingType: BASE_ITEM.clothingType,
        subtype: BASE_ITEM.subtype,
        brand: BASE_ITEM.brand,
        primaryColor: BASE_ITEM.primaryColor,
        secondaryColors: [],
        material: ['Silk'],
      },
    }],
    createdAt: '2026-07-30T12:00:00.000Z',
    updatedAt: '2026-07-30T12:00:00.000Z',
    ...overrides,
  };
}

export type OwnershipFixture = {
  name: string;
  actorId: string;
  savedLook: PrivateSavedLookV1;
  closet: OwnershipClosetProjection[];
  expectedState: PrivateOwnershipState;
  expectedMatchedItemId: string | null;
  expectedDiagnosticReason: string;
  expectedCommerceSuppression: boolean;
  expectedActions: string[];
};

export const PRIVATE_OWNERSHIP_FIXTURES: OwnershipFixture[] = [
  {
    name: 'exact ID and same slot', actorId: ACTOR_A, savedLook: saved(), closet: [BASE_ITEM],
    expectedState: 'exact_owned', expectedMatchedItemId: BASE_ITEM.id,
    expectedDiagnosticReason: 'same semantic slot', expectedCommerceSuppression: true,
    expectedActions: ['shop_anyway'],
  },
  {
    name: 'no ID but strong taxonomy match', actorId: ACTOR_A,
    savedLook: saved({ slots: [{ ...saved().slots[0], closetItemId: null, wasOwnedAtSave: false }] }),
    closet: [{ ...BASE_ITEM, id: 'closet-top-2' }], expectedState: 'probable_owned',
    expectedMatchedItemId: 'closet-top-2', expectedDiagnosticReason: 'primary color',
    expectedCommerceSuppression: true, expectedActions: ['shop_anyway'],
  },
  {
    name: 'same slot with different color', actorId: ACTOR_A,
    savedLook: saved({ slots: [{ ...saved().slots[0], closetItemId: null, wasOwnedAtSave: false }] }),
    closet: [{ ...BASE_ITEM, id: 'closet-top-3', primaryColor: 'Ivory' }],
    expectedState: 'similar_owned', expectedMatchedItemId: 'closet-top-3',
    expectedDiagnosticReason: 'attributes differ', expectedCommerceSuppression: false,
    expectedActions: ['find_alternative', 'shop_anyway'],
  },
  {
    name: 'no candidate', actorId: ACTOR_A,
    savedLook: saved({ slots: [{ ...saved().slots[0], closetItemId: null, wasOwnedAtSave: false }] }),
    closet: [{ ...BASE_ITEM, id: 'closet-bottom-1', category: 'Bottoms', clothingType: 'Trousers', subtype: 'Trousers' }],
    expectedState: 'not_owned', expectedMatchedItemId: null,
    expectedDiagnosticReason: 'No exact', expectedCommerceSuppression: false,
    expectedActions: ['find_alternative'],
  },
  {
    name: 'empty Closet', actorId: ACTOR_A,
    savedLook: saved({ slots: [{ ...saved().slots[0], closetItemId: null, wasOwnedAtSave: false }] }),
    closet: [], expectedState: 'not_owned', expectedMatchedItemId: null,
    expectedDiagnosticReason: 'No exact', expectedCommerceSuppression: false,
    expectedActions: ['find_alternative'],
  },
  {
    name: 'insufficient taxonomy', actorId: ACTOR_A,
    savedLook: saved({ slots: [{ ...saved().slots[0], closetItemId: null, wasOwnedAtSave: false,
      snapshot: { ...saved().slots[0].snapshot, category: null, clothingType: null, subtype: null } }] }),
    closet: [], expectedState: 'unknown', expectedMatchedItemId: null,
    expectedDiagnosticReason: 'lacks enough', expectedCommerceSuppression: false,
    expectedActions: ['find_alternative'],
  },
  {
    name: 'deleted Closet record', actorId: ACTOR_A, savedLook: saved(), closet: [],
    expectedState: 'deleted_reference', expectedMatchedItemId: null,
    expectedDiagnosticReason: 'no longer exists', expectedCommerceSuppression: false,
    expectedActions: ['find_alternative'],
  },
  {
    name: 'same ID reclassified', actorId: ACTOR_A, savedLook: saved(),
    closet: [{ ...BASE_ITEM, title: 'Black oxford', category: 'Footwear', clothingType: 'Shoes', subtype: 'Oxford shoe' }],
    expectedState: 'incompatible_edit', expectedMatchedItemId: BASE_ITEM.id,
    expectedDiagnosticReason: 'different slot', expectedCommerceSuppression: false,
    expectedActions: ['find_alternative'],
  },
  {
    name: 'cross actor candidate ignored', actorId: ACTOR_A,
    savedLook: saved({ slots: [{ ...saved().slots[0], closetItemId: null, wasOwnedAtSave: false }] }),
    closet: [{ ...BASE_ITEM, id: 'foreign-top', actorId: 'actor-b' }],
    expectedState: 'not_owned', expectedMatchedItemId: null,
    expectedDiagnosticReason: 'No exact', expectedCommerceSuppression: false,
    expectedActions: ['find_alternative'],
  },
];
