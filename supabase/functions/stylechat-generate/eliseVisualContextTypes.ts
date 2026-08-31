/**
 * E-1 — Typed Visual-Context Continuity
 * Internal backend contract. Client never sends this version.
 */

export const ELISE_VISUAL_CONTEXT_INTERNAL_VERSION = 'elise_visual_context_v1' as const;

export type EliseRequestSource =
  | 'camera'
  | 'upload'
  | 'text_scan'
  | 'recent_scan'
  | 'closet'
  | 'dressing_room'
  | 'shared_room'
  | 'commerce'
  | 'mixed'
  | 'unknown_legacy';

export type EliseEvidenceSourceType =
  | 'current_scan'
  | 'selected_scan_item'
  | 'text_scan'
  | 'recent_scan'
  /**
   * INT-KPLUS-001: the ONLY source type that may carry actorRelationship
   * 'owned'. Backed by a live public.user_closet_items row belonging to the
   * current actor -- the canonical Closet authority.
   */
  | 'user_closet_item'
  /**
   * A saved scan surfaced through the legacy `closet_item` transport. The user
   * scanned/saved it; they do not necessarily own it.
   */
  | 'saved_scan'
  /** A cloud inspiration upload. Saved, never owned. */
  | 'inspiration_item'
  /**
   * LEGACY transport label only. Retained so existing clients keep resolving,
   * but it is never the RESOLVED source type: the server re-labels it as
   * user_closet_item / saved_scan / inspiration_item according to the row it
   * actually found. It must never independently establish ownership.
   */
  | 'closet_item'
  | 'owned_room_item'
  | 'shared_room_item'
  | 'commerce_product'
  | 'uploaded_image'
  | 'unknown_legacy';

export type EliseActorRelationship =
  /**
   * Reserved for a live public.user_closet_items row owned by the current
   * actor. Saved scans, inspiration uploads, shared items and commerce results
   * are NEVER 'owned' (INT-KPLUS-001).
   */
  | 'owned'
  /** Saved/kept by the actor (inspiration uploads) but not owned. */
  | 'saved'
  | 'shared'
  | 'scanned'
  | 'uploaded'
  | 'discovered'
  | 'unknown';

export type EliseEvidenceTrust =
  | 'server_verified'
  | 'client_metadata'
  | 'model_inferred'
  | 'legacy_unverified';

export type EliseImageReferenceType =
  | 'storage_object'
  | 'ephemeral_signed_url'
  | 'inline_image'
  | 'remote_product_image'
  | 'none';

export type EliseContextWarningCode =
  | 'UNKNOWN_SOURCE'
  | 'MALFORMED_EVIDENCE'
  | 'INVALID_CONFIDENCE'
  | 'FIELD_TRUNCATED'
  | 'ARRAY_TRUNCATED'
  | 'EVIDENCE_LIMIT_REACHED'
  | 'CONTEXT_LIMIT_REACHED'
  | 'UNAUTHORIZED_REFERENCE'
  | 'RESOURCE_NOT_FOUND'
  | 'INVALID_RESOURCE_RELATIONSHIP'
  | 'EXPIRED_IMAGE_REFERENCE'
  | 'UNSUPPORTED_IMAGE_REFERENCE'
  | 'OPTIONAL_RESOURCE_UNAVAILABLE'
  | 'DUPLICATE_EVIDENCE'
  | 'INVALID_FOCUS';

export interface EliseContextWarning {
  code: EliseContextWarningCode;
  evidenceId?: string | null;
}

export interface EliseVisualEvidence {
  evidenceId: string;
  sourceType: EliseEvidenceSourceType;
  actorRelationship: EliseActorRelationship;
  trust: EliseEvidenceTrust;

  sourceId: string | null;
  sessionId: string | null;
  scanId: string | null;
  itemId: string | null;
  roomId: string | null;

  title: string | null;
  summary: string | null;
  category: string | null;
  subcategory: string | null;

  colors: string[];
  materials: string[];
  silhouette: string | null;
  styleAttributes: string[];
  textureAttributes: string[];
  occasionAttributes: string[];

  brand: string | null;
  confidence: number | null;

  imageReferenceType: EliseImageReferenceType;
  canonicalStorageReference: string | null;

  commerce: {
    productId: string | null;
    retailerId: string | null;
    retailerName: string | null;
    purchaseUrlPresent: boolean;
  } | null;
}

export interface EliseNormalizationSummary {
  receivedCount: number;
  acceptedCount: number;
  droppedCount: number;
  rejectedCount: number;
  truncatedCount: number;
  duplicateCount: number;
  warnings: EliseContextWarning[];
}

export interface EliseVisualContextEnvelope {
  internalContractVersion: typeof ELISE_VISUAL_CONTEXT_INTERNAL_VERSION;
  requestSource: EliseRequestSource;
  focusedEvidenceId: string | null;
  evidence: EliseVisualEvidence[];
  normalization: EliseNormalizationSummary;
}

/** Bounds — prompt-safe and deterministic. */
export const ELISE_CONTEXT_BOUNDS = {
  maxEvidence: 6,
  maxTotalContextChars: 6_000,
  maxTitleChars: 160,
  maxSummaryChars: 500,
  maxCategoryChars: 80,
  maxBrandChars: 80,
  maxFieldChars: 80,
  maxIdChars: 80,
  maxColors: 8,
  maxMaterials: 8,
  maxStyleAttributes: 8,
  maxTextureAttributes: 8,
  maxOccasionAttributes: 8,
  maxArrayItemChars: 80,
} as const;

export type EliseResourceResolution =
  | {
    status: 'verified';
    actorRelationship: EliseActorRelationship;
    sourceType: EliseEvidenceSourceType;
    trust: EliseEvidenceTrust;
    canonicalIds: {
      scanId?: string;
      itemId?: string;
      roomId?: string;
      sourceId?: string;
      storageBucket?: string | null;
      storagePath?: string | null;
    };
    metadata?: Partial<{
      title: string | null;
      category: string | null;
      colors: string[];
      materials: string[];
      silhouette: string | null;
      brand: string | null;
    }>;
  }
  | { status: 'not_found' }
  | { status: 'unauthorized' }
  | { status: 'invalid_reference' }
  | { status: 'unavailable' };
