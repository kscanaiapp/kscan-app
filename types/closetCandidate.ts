// Canonical ClosetCandidate contract (Closet Upgrade Build 1).
//
// WHAT A CANDIDATE IS: a durable, actor-scoped, PRE-COMMIT staging record for
// something the user intends to put in their Closet. It owns its own media, it
// carries classification metadata once identification returns, and it ends at
// `ready_for_review` or `needs_manual_classification`.
//
// WHAT A CANDIDATE IS NOT, and this is the load-bearing invariant of the whole
// build:
//
//     ClosetCandidate record  !=  committed Closet item
//
// The committed Closet stays exactly where it is — services/closetLibrary.js,
// manifest kscan_closet/kscan_closet.json, media under kscan_closet/. This
// contract never becomes authoritative for an owned-inventory item, and nothing
// here may be read as if it were one. Promotion of a candidate into a committed
// Closet item is Build 2 and is deliberately not reachable from Build 1 UI.
//
// DOMAIN BOUNDARY REMINDER: "Closet" names several unrelated systems in this
// repository. This contract belongs to the independent device-local Closet only.
// It is unrelated to `types/ownedClosetItem.ts`, `saved_scans`,
// `inspiration_items`, the free-tier wear/filter projections, StyleChat's
// "Save to Closet & Attach" path, and any AI-Stylist read projection labelled
// `closet_item`. Renaming those is deliberate deferred naming debt, not part of
// this build.

/**
 * Record schema version. Serialization must never depend on a feature flag.
 *
 * v3 adds the PROMOTION TOMBSTONE fields (`promotedClosetItemId`, `promotedAt`).
 * The bump is deliberate rather than an optional-field addition at v2: a record
 * carrying promotion provenance but declaring v2 would be read, reconstructed
 * through an older build's allowlist, and written back with the provenance
 * silently dropped — destroying the only durable evidence that the candidate was
 * already committed. Declaring v3 makes an older build refuse the record instead.
 */
export const CLOSET_CANDIDATE_SCHEMA_VERSION = 3;

/** Highest schema version this build knows how to read. */
export const CLOSET_CANDIDATE_MAX_SUPPORTED_SCHEMA_VERSION = 3;

// ── Vocabularies ─────────────────────────────────────────────────────────────

/**
 * Where a candidate came from.
 *
 * Only `camera` and `gallery` are reachable in Build 1. The rest are declared
 * now because the candidate store is the durable layer every later intake path
 * (mirror extraction, receipt import, retailer URL, share sheet) will reuse, and
 * a source vocabulary that has to grow later would force a schema migration on
 * records that are already on disk.
 */
export const CLOSET_CANDIDATE_SOURCES = [
  'camera',
  'gallery',
  'recent_scan',
  'mirror_extract',
  'receipt_screenshot',
  'forwarded_receipt',
  'retailer_url',
  'share_sheet',
] as const;

export type ClosetCandidateSource = typeof CLOSET_CANDIDATE_SOURCES[number];

/** Sources Build 1 will actually accept at intake. */
export const CLOSET_CANDIDATE_ACTIVE_SOURCES: readonly ClosetCandidateSource[] = [
  'camera',
  'gallery',
];

export const CLOSET_CANDIDATE_STATUSES = [
  'queued',
  'preparing',
  'waiting_for_network',
  'classifying',
  'needs_manual_classification',
  'ready_for_review',
  'duplicate',
  'failed',
  'rejected',
  'saving',
  'saved',
] as const;

export type ClosetCandidateStatus = typeof CLOSET_CANDIDATE_STATUSES[number];

/**
 * Terminal states. A candidate in one of these is RESOLVED: it no longer counts
 * against the unresolved cap and is never automatically requeued.
 *
 * `saved` is terminal-by-promotion (Build 2). `rejected` is terminal-by-user.
 *
 * A `saved` record is the PROMOTION TOMBSTONE. It keeps its batch identity, its
 * batch position and its candidate-owned media so the review surface can keep
 * showing it in place, and so Phase 4 has something to reconcile against when it
 * takes ownership of candidate-media cleanup and startup recovery.
 */
export const CLOSET_CANDIDATE_TERMINAL_STATUSES: readonly ClosetCandidateStatus[] = [
  'saved',
  'rejected',
];

/**
 * The exact-hash algorithm this build implements.
 *
 * `sha256-normalized-v1` means: SHA-256 over the Base64 encoding of the bytes of
 * the CANDIDATE-OWNED normalized JPEG, taken after orientation correction,
 * resize and re-compression. Base64 is a bijection over byte strings, so equal
 * digests mean equal normalized bytes.
 *
 * IT DOES NOT MEAN, and must never be presented as meaning: a visually similar
 * garment, the same real-world product, or the same SKU. Perceptual hashing and
 * embedding similarity are a later dedicated build and are deliberately absent
 * here.
 */
export const CLOSET_CANDIDATE_CONTENT_HASH_VERSION = 'sha256-normalized-v1' as const;

export type ClosetCandidateContentHashVersion =
  typeof CLOSET_CANDIDATE_CONTENT_HASH_VERSION;

/**
 * Duplicate algorithms Build 1 implements. Both are EXACT signals.
 *
 * `source-lineage-v1`   — this candidate's source is already committed to the
 *                         Closet, matched on the existing promotion lineage id.
 * `sha256-normalized-v1` — byte-identical normalized media.
 */
export const CLOSET_CANDIDATE_DUPLICATE_ALGORITHMS = [
  'source-lineage-v1',
  'sha256-normalized-v1',
] as const;

export type ClosetCandidateDuplicateAlgorithm =
  typeof CLOSET_CANDIDATE_DUPLICATE_ALGORITHMS[number];

// ── Error codes ──────────────────────────────────────────────────────────────

/**
 * The complete, stable candidate error vocabulary.
 *
 * One registry, declared once. `services/closetCandidateErrors.ts` attaches the
 * behaviour (retryable, user copy, telemetry category, resulting transition,
 * recovery action) to each code; nothing else may invent a code, and no raw
 * backend error string is ever surfaced in its place.
 */
export const CLOSET_CANDIDATE_ERROR_CODES = [
  // Intake / capacity
  'candidate_limit_reached',
  'candidate_batch_limit_exceeded',
  'candidate_storage_insufficient',
  // Media
  'candidate_media_unreadable',
  'candidate_media_unsupported',
  'candidate_media_normalization_failed',
  'candidate_hash_failed',
  // Duplicates
  'duplicate_active_candidate',
  'already_in_closet',
  // Store / lifecycle
  'candidate_invalid_transition',
  'candidate_expired',
  'candidate_actor_stale',
  'candidate_actor_required',
  'candidate_request_aborted',
  'candidate_offline',
  // Classification
  'classification_timeout',
  'classification_rate_limited',
  'classification_quota_exhausted',
  'classification_auth_failed',
  'classification_malformed_response',
  // Beyond the specified minimum, and both for a concrete reason.
  //
  // `classification_provider_failed` — the backend answered with a well-formed
  // contract result whose status is `technical_failure`. That is neither a
  // malformed response nor a timeout, and folding it into either would make the
  // telemetry lie about which subsystem failed.
  //
  // `classification_contract_rejected` — the backend rejected the request's
  // contract version or intent. It means the deployed backend predates Closet
  // support, it will not repair itself under retry, and it must never be
  // answered by falling back to the legacy contract (that would run commerce and
  // create a Recent Scan, which Closet intake forbids).
  'classification_provider_failed',
  'classification_contract_rejected',
  'classification_requires_manual_category',
  'classification_interrupted',
  'classification_interrupted_repeatedly',
  // Persistence
  'candidate_store_corrupt',
  'candidate_persist_failed',
  'candidate_cleanup_failed',
  // A record on disk declares a schema version this build cannot read. It is NOT
  // corrupt — a newer build wrote it, and downgrading must not destroy it.
  'candidate_store_future_schema',
  // The manifest could not be read completely (unparseable, or one or more
  // records were skipped). Mutations fail closed on this code rather than
  // rewriting the manifest from the reduced set they were able to read, which
  // would silently delete whatever the read could not interpret.
  'candidate_store_recovery_required',
] as const;

export type ClosetCandidateErrorCode = typeof CLOSET_CANDIDATE_ERROR_CODES[number];

// ── Limits and lifetime ──────────────────────────────────────────────────────

/**
 * Maximum UNRESOLVED candidates per actor. Unresolved is anything not `saved`
 * and not `rejected`.
 *
 * When the cap is reached, intake is REJECTED with `candidate_limit_reached`.
 * Nothing is silently evicted: an eviction policy on a staging queue would throw
 * away work the user explicitly started, and the oldest candidate is exactly the
 * one they are most likely to have forgotten but still want.
 */
export const CLOSET_CANDIDATE_MAX_UNRESOLVED = 40;

/** Fixed 7-day lifetime, stamped once at creation and never extended. */
export const CLOSET_CANDIDATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Automatic-retry budget.
 *
 * `MAX_AUTOMATIC_RETRIES` retries after the first attempt, so at most
 * `MAX_TOTAL_ATTEMPTS` automatic attempts in total. Manual retry remains
 * available until expiration and does not reset createdAt, expiresAt or
 * interruptionCount.
 */
export const CLOSET_CANDIDATE_MAX_AUTOMATIC_RETRIES = 2;
export const CLOSET_CANDIDATE_MAX_TOTAL_ATTEMPTS = 3;

/**
 * Interrupted-classification budget.
 *
 * A candidate found in `classifying` after a process restart was interrupted.
 * The first interruption requeues; the SECOND fails it permanently. This is the
 * crash-loop brake: an image that reliably kills the process would otherwise be
 * requeued on every launch and make the app unstartable.
 */
export const CLOSET_CANDIDATE_MAX_INTERRUPTIONS = 2;

/** Maximum concurrent in-flight classifications, across all candidates. */
export const CLOSET_CANDIDATE_MAX_CONCURRENT_CLASSIFICATIONS = 2;

// ── Record ───────────────────────────────────────────────────────────────────

export type ClosetCandidateConfidence = {
  category?: number | null;
  subtype?: number | null;
  brand?: number | null;
  color?: number | null;
  material?: number | null;
};

export type ClosetCandidateDuplicateMatch = {
  /** Set when the collision is with another unresolved candidate. */
  candidateId?: string | null;
  /** Set when the collision is with a COMMITTED Closet item. */
  closetItemId?: string | null;
  confidence: number;
  reasons: string[];
  algorithmVersion: ClosetCandidateDuplicateAlgorithm;
};

/**
 * One staged candidate.
 *
 * `originalImageUri` is the PICKER-OWNED source. It is recorded for provenance
 * and is never deleted by candidate cleanup — the candidate owns
 * `candidateImageUri` / `candidateThumbnailUri` and only ever unlinks those.
 */
export type ClosetCandidate = {
  schemaVersion: typeof CLOSET_CANDIDATE_SCHEMA_VERSION;

  candidateId: string;
  batchId: string;
  /** Immutable picker-order position. Legacy Build 1 records use null. */
  batchPosition: number | null;
  ownerId: string | null;

  sourceType: ClosetCandidateSource;
  sourceId?: string | null;
  /** Promotion lineage, shaped exactly like services/closetPromotion.js emits. */
  sourceLineageId?: string | null;

  /** External picker/camera URIs are never persisted as durable candidate state. */
  originalImageUri: string | null;
  candidateImageUri: string | null;
  candidateThumbnailUri: string | null;

  title?: string | null;
  brand?: string | null;
  category?: string | null;
  clothingType?: string | null;
  subtype?: string | null;
  primaryColor?: string | null;
  secondaryColors?: string[];
  material?: string[];
  size?: string | null;
  notes?: string | null;

  confidence?: ClosetCandidateConfidence | null;
  /** The contract version the classification came from, e.g. the V2 marker. */
  classificationVersion?: string | null;

  contentHash?: string | null;
  contentHashVersion?: ClosetCandidateContentHashVersion | null;
  normalizedByteLength?: number | null;

  duplicateMatch?: ClosetCandidateDuplicateMatch | null;

  status: ClosetCandidateStatus;

  attemptCount: number;
  automaticRetryCount: number;
  interruptionCount: number;

  errorCode?: ClosetCandidateErrorCode | null;
  lastAttemptAt?: string | null;

  /**
   * PROMOTION TOMBSTONE (Build 2, Phase 3). Set exactly once, by the candidate
   * store's finalization primitive, AFTER the committed Closet item has been
   * written and read back. Never patchable, never accepted from a component, and
   * never set by a generic transition — see CLOSET_CANDIDATE_PROTECTED_FIELDS.
   *
   * `promotedClosetItemId` is what makes a promoted candidate answerable without
   * consulting the committed manifest, and it is what the batch projection shows
   * as "Added to Closet" after a restart.
   */
  promotedClosetItemId?: string | null;
  promotedAt?: string | null;

  createdAt: string;
  updatedAt: string;
  expiresAt: string;
};

/**
 * UI presentation derived from status.
 *
 * DERIVED, never persisted: a stored copy would drift from the status it claims
 * to describe the moment a transition happens outside the surface that wrote it.
 */
export type ClosetCandidateStatusUIMetadata = {
  progressLabel: string;
  isActionable: boolean;
  canRetry: boolean;
  canEditMetadata: boolean;
  canReject: boolean;
};

export type ClosetCandidateMigrationResult =
  | { ok: true; record: ClosetCandidate; migratedFrom: number }
  | { ok: false; errorCode: ClosetCandidateErrorCode };
