/**
 * Scan Result Object + Style Memory contract (Part 1 — Foundation).
 *
 * Turns a scan-identify result into structured fashion metadata plus a
 * result-card-ready object that can later be saved, shared, and compared.
 *
 * PRIVACY (hard rule): Style Memory stores structured fashion metadata and safe
 * catalog/product references ONLY. It must never carry the raw scan image, an
 * unmasked user photo, a local camera URI, faces, background people, license
 * plates, geolocation, or any biometric/PII signal. Catalog/product image URLs
 * are allowed because they come from retailer/catalog match data — not from the
 * user's raw capture.
 *
 * This file is a frontend/data model only. Part 1 adds NO persistence, NO
 * Supabase table, and NO Dressing Room duplication. See
 * docs/scan-result-style-memory.md.
 *
 * NOTE on naming: a separate "Style Memory" layer already exists under
 * services/style-chat/styleMemoryTypes.ts — that one models StyleChat
 * *preference signals*. `StyleMemoryItem` here is a distinct scan-result card
 * model. They are intentionally separate concepts.
 */

import type { RankedScanProduct } from './scanIdentification';

/** Where a scan originated. */
export type ScanResultSource = 'camera' | 'upload' | 'room' | 'unknown';

/** Confidence buckets for display + explainability. */
export type ScanConfidenceLabel = 'high' | 'medium' | 'low' | 'exploratory';

/** Named signals we may be missing for a confident identity. */
export type ScanMissingSignal =
  | 'brand'
  | 'exact product name'
  | 'product image'
  | 'material'
  | 'color'
  | 'category';

/**
 * Privacy posture for a stored scan result. `rawImageStored` and
 * `cloudPhotoStorage` are typed as the literal `false` so the type system
 * itself forbids a caller from ever flipping them on.
 */
export type ScanResultPrivacy = {
  piiMasked: boolean;
  rawImageStored: false;
  cloudPhotoStorage: false;
  notes: string;
};

/** Structured fashion metadata extracted from a scan. */
export type ScanItemAttributes = {
  category: string;
  subcategory: string;
  silhouette: string;
  color: string;
  material: string;
  pattern: string;
  fit: string;
  occasionTags: string[];
  styleTags: string[];
  /** Numeric model confidence 0..1 when available, else null. */
  confidence: number | null;
};

/** Result-card visual fields. heroImageUrl is catalog-sourced only. */
export type ScanResultVisual = {
  cardTitle: string;
  cardSubtitle: string;
  /** Safe catalog/product image URL, or null. NEVER a raw/local scan image. */
  heroImageUrl: string | null;
  palette: string[];
  badges: string[];
};

/** Save/share/compare memory state for this result. */
export type ScanResultMemory = {
  saved: boolean;
  comparedWithIds: string[];
  sharePayloadReady: boolean;
  notes?: string;
  userTags: string[];
};

/** Why a match was surfaced and what would raise confidence. */
export type ScanResultExplainability = {
  whyThisMatched: string;
  missingSignals: ScanMissingSignal[];
  confidenceLabel: ScanConfidenceLabel;
};

/**
 * The full Scan Result Object. Matches reuse the existing
 * {@link RankedScanProduct} contract — no parallel product type.
 */
export type ScanResultObject = {
  id: string;
  createdAt: string;
  userId: string | null;
  source: ScanResultSource;
  privacy: ScanResultPrivacy;
  item: ScanItemAttributes;
  visual: ScanResultVisual;
  matches: RankedScanProduct[];
  memory: ScanResultMemory;
  explainability: ScanResultExplainability;
};

/**
 * View model the result card UI can render directly. Derived purely from a
 * {@link ScanResultObject}. Part 1 does not render this anywhere.
 */
export type ResultCardViewModel = {
  title: string;
  subtitle: string;
  heroImageUrl: string | null;
  badges: string[];
  confidenceLabel: ScanConfidenceLabel;
  primaryMatch: RankedScanProduct | null;
  matchCount: number;
  saveEnabled: boolean;
  shareEnabled: boolean;
  compareEnabled: boolean;
  privacyCaption: string;
};

/**
 * A metadata-only memory item. In Part 2 this is what a Save action would
 * persist by WRAPPING the existing Dressing Room save path —
 * `savedToDressingRoomId` links to that item once saved. Part 1 never persists.
 */
export type StyleMemoryItem = {
  id: string;
  scanResultId: string;
  createdAt: string;
  item: ScanItemAttributes;
  visual: ScanResultVisual;
  matches: RankedScanProduct[];
  userTags: string[];
  notes: string;
  savedToDressingRoomId?: string | null;
  source: 'scan';
  privacy: ScanResultPrivacy;
};

/** Pure metadata comparison between two scan results. */
export type ScanComparisonResult = {
  similarityScore: number;
  sharedCategories: string[];
  sharedColors: string[];
  sharedMaterials: string[];
  sharedStyleTags: string[];
  sharedOccasionTags: string[];
  differences: string[];
  summary: string;
};

/**
 * Safe, share-ready projection of a scan result. Excludes userId, privacy,
 * memory notes, and anything PII / raw-image related.
 */
export type ShareReadyPayload = {
  id: string;
  createdAt: string;
  item: ScanItemAttributes;
  visual: ScanResultVisual;
  matches: RankedScanProduct[];
};
