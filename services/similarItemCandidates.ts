/**
 * Checkpoint 4.5 — ON-DEVICE candidate selection for the advisory
 * similar-item comparison.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THIS IS NOT A SIMILARITY ENGINE. Read this before adding a weight.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The validated scorer lives in `supabase/functions/product-match/
 * closetSimilarity.ts` and stays there. This module answers exactly one
 * question:
 *
 *     "Of the records this device is holding, which bounded subset should be
 *      sent to that scorer?"
 *
 * It decides WHAT IS COMPARED. It never decides WHETHER TWO THINGS ARE ALIKE.
 * Nothing here produces a confidence, a classification, a reason or a notice,
 * and nothing here is allowed to. If a future change wants to weigh evidence
 * more finely, that change belongs in the backend scorer where it is
 * threshold-governed, versioned and directionally tested — not here, where it
 * would become a second, hidden, untested opinion about similarity.
 *
 * WHY PRUNE ON DEVICE AT ALL
 *
 * Before this checkpoint the client sent whatever candidates it happened to
 * have. A user with a 900-item Closet would either send 900 records (a large
 * payload of their entire wardrobe, for a feature that is advisory) or send an
 * arbitrary prefix of 25 (a bounded payload of the WRONG records). Neither is
 * acceptable, and the backend cannot fix it: by the time the request arrives,
 * the interesting candidates are already gone.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 *   - no image bytes are read, decoded, measured or transmitted; `imageUri` is
 *     a reference the client already holds for local rendering
 *   - no network call, no database read — the caller supplies loaded records
 *   - no mutation of any record, ever
 *   - no persistence
 *
 * CONSERVATIVE BY CONSTRUCTION
 *
 * Client pruning must never drop a record the backend would have flagged. So
 * every rejection rule here is a STRICT SUBSET of a rule the backend already
 * applies (`candidateRetrieval.ts`), and the text normalization used to make
 * those decisions is asserted equal to the backend's in
 * `__tests__/similarItemCandidateParity.test.js`. When in doubt this module
 * keeps a record and lets the validated scorer decide.
 */

/** Bump when a pruning or ordering rule changes. Travels in the report. */
export const CANDIDATE_PRIORITIZATION_VERSION = 'client-candidate-selection/2026-08-03.v1';

export type ClientRecordSource = 'closet' | 'recent_scan';

/**
 * A Closet or Recent Scans record, normalized by the caller's adapter.
 *
 * Deliberately a FLAT, explicit shape rather than the stored record type.
 * Adapters (`similarItemCandidateAdapters.ts`) translate the real stored
 * shapes into this, which keeps two things true: this module has no
 * dependency on either storage schema, and the set of fields that can reach
 * the network is enumerated in one reviewable place.
 */
export type ClientExistingRecord = {
  id: string;
  source: ClientRecordSource;
  label?: string | null;
  /** A local/remote reference the client ALREADY holds. Never fetched here. */
  imageUri?: string | null;
  brand?: string | null;
  model?: string | null;
  canonicalCategory?: string | null;
  subtype?: string | null;
  color?: string | null;
  material?: string | null;
  silhouette?: string | null;
  pattern?: string | null;
  productUrl?: string | null;
  authoritativeId?: string | null;
  imageQuality?: 'ok' | 'poor' | 'missing' | null;
  /**
   * Lifecycle state. Anything other than `active` is excluded from
   * comparison — see `RECORD_STATUS_REJECTIONS`.
   */
  status?: 'active' | 'archived' | 'deleted' | 'pending' | 'failed' | null;
  /** Epoch ms of last update. Used only as a deterministic recency tiebreak. */
  updatedAtMs?: number | null;
  /**
   * When this record is a mirror/projection of another record's underlying
   * item, the id of that underlying item. Lets one physical garment appearing
   * in BOTH lists collapse to a single candidate.
   */
  mirrorOfId?: string | null;
};

/** The scan side of the comparison, as the client knows it. */
export type ClientScanQuery = {
  brand?: string | null;
  visibleBrandText?: string | null;
  model?: string | null;
  canonicalCategory?: string | null;
  subtype?: string | null;
  color?: string | null;
  material?: string | null;
  silhouette?: string | null;
  pattern?: string | null;
  authoritativeId?: string | null;
  productUrl?: string | null;
};

/**
 * Exactly the fields transmitted per candidate. Mirrors the backend's
 * `ExistingItemCandidate` and the `scan-identify` sanitizer allowlist.
 *
 * `subtype`, `status`, `updatedAtMs` and `mirrorOfId` are deliberately NOT
 * here: they are used locally to decide what to send, and the backend has no
 * field for them. Sending them would widen the transmitted payload for no
 * consumer — the opposite of this checkpoint's purpose.
 */
export type TransmittedCandidate = {
  id: string;
  source: ClientRecordSource;
  label?: string;
  imageUri?: string;
  brand?: string;
  model?: string;
  canonicalCategory?: string;
  color?: string;
  material?: string;
  silhouette?: string;
  pattern?: string;
  productUrl?: string;
  authoritativeId?: string;
  imageQuality?: 'ok' | 'poor' | 'missing';
};

export type CandidateRejectionReason =
  /** No usable id, or a source that is not one of the two known lists. */
  | 'unusable_record'
  /** Archived, soft-deleted, or not yet a finished record. */
  | 'record_not_active'
  /** Nothing on this record can be compared to anything on the scan. */
  | 'no_comparable_fields'
  /** Canonical categories are both known and disagree — a backend veto too. */
  | 'category_conflict'
  /** The same underlying item already retained from the other list. */
  | 'duplicate_record'
  /** Eligible, but beyond the transmit cap after prioritization. */
  | 'over_client_cap';

export type CandidateStageTimings = {
  normalizeMs: number;
  pruneMs: number;
  prioritizeMs: number;
  dedupeMs: number;
  totalMs: number;
};

export type ClientCandidateReport = {
  prioritizationVersion: string;
  /** What the caller handed in, per source. */
  recordsLoaded: { closet: number; recent_scan: number; total: number };
  /** Records that entered pruning (i.e. structurally usable). */
  recordsConsidered: number;
  /** Dropped before transmission, by named reason. Never a bare total. */
  recordsRejected: Array<{ reason: CandidateRejectionReason; count: number }>;
  /** Survived every rule, before the cap. */
  recordsRetained: number;
  /** Actually placed in the request. */
  recordsTransmitted: number;
  /** Source mix of what was transmitted — not of what was loaded. */
  sourceCounts: { closet: number; recent_scan: number };
  timings: CandidateStageTimings;
};

export type CandidateSelectionResult = {
  candidates: TransmittedCandidate[];
  report: ClientCandidateReport;
};

// ── configuration ───────────────────────────────────────────────────────────

/**
 * How many candidates reach the wire.
 *
 * WHY 20, AND NOT A ROUND NUMBER PICKED FOR FEEL
 *
 * The backend scores at most `MAX_CANDIDATES_SCORED = 20`
 * (`candidateRetrieval.ts`); the transport sanitizer accepts at most
 * `MAX_EXISTING_ITEMS = 25` (`existingItemCandidates.ts`). A 21st candidate is
 * therefore payload the backend is contractually guaranteed to discard before
 * scoring — strictly wasted bytes, battery and serialization time.
 *
 * So the client cap is set EQUAL to the backend scoring cap, and the reason is
 * structural rather than empirical: it is the largest value that cannot be
 * wasted. Lowering it further is safe (the checkpoint permits ≤) but would
 * start discarding candidates the backend was willing to look at, which is a
 * product decision this checkpoint has no evidence to make.
 *
 * Overridable via `EXPO_PUBLIC_SIMILARITY_CLIENT_CANDIDATE_CAP` for device
 * measurement — see `readCandidateSelectionConfig`.
 */
export const DEFAULT_CLIENT_CANDIDATE_CAP = 20;

/** Hard ceiling on any configured cap: the transport sanitizer's own limit. */
export const TRANSPORT_CANDIDATE_CEILING = 25;

export const CLIENT_CANDIDATE_CAP_ENV = 'EXPO_PUBLIC_SIMILARITY_CLIENT_CANDIDATE_CAP';

export type CandidateSelectionConfig = {
  cap: number;
};

/**
 * Resolves the cap, clamped to `[1, TRANSPORT_CANDIDATE_CEILING]`.
 *
 * Clamped rather than trusted: a mistyped override that sent 500 candidates
 * would be rejected wholesale by the sanitizer (`existingItems exceeds 25`),
 * turning a tuning typo into a silently disabled feature.
 */
export function readCandidateSelectionConfig(
  env: Record<string, string | undefined> = typeof process !== 'undefined' ? process.env : {},
): CandidateSelectionConfig {
  const raw = env[CLIENT_CANDIDATE_CAP_ENV];
  const parsed = raw === undefined ? NaN : Number(raw);
  if (!Number.isFinite(parsed)) return { cap: DEFAULT_CLIENT_CANDIDATE_CAP };
  const floored = Math.floor(parsed);
  if (floored < 1) return { cap: 1 };
  if (floored > TRANSPORT_CANDIDATE_CEILING) return { cap: TRANSPORT_CANDIDATE_CEILING };
  return { cap: floored };
}

// ── normalization ───────────────────────────────────────────────────────────
//
// A deliberately SMALL mirror of the backend's `identity.ts`. Only the two
// primitives the pruning rules need are duplicated, and
// `__tests__/similarItemCandidateParity.test.js` runs both implementations
// over a shared corpus to prove they agree. Duplicating the whole of
// `identity.ts` (including the colour-synonym table) was rejected: the more
// surface is copied, the more can drift, and pruning does not need colour
// normalization — colour is a scoring signal, not a rejection rule.

const PUNCTUATION = /[‘’“”'"`´,.;:!?()[\]{}<>+*/\\|@#$%^&~=_]/g;
const WHITESPACE = /\s+/g;

/** Lowercase, strip punctuation, collapse whitespace. Mirrors `normalizeText`. */
export function normalizeCandidateText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .toLowerCase()
    .replace(/[‐-―]/g, '-')
    .replace(PUNCTUATION, ' ')
    .replace(WHITESPACE, ' ')
    .trim();
}

/** Normalized text as a hyphenated slug. Mirrors `slugify`. */
export function slugifyCandidateText(value: unknown): string {
  const normalized = normalizeCandidateText(value).replace(/-+/g, ' ').replace(WHITESPACE, ' ').trim();
  if (!normalized) return '';
  return normalized.replace(WHITESPACE, '-');
}

// ── pruning rules ───────────────────────────────────────────────────────────

/**
 * Statuses excluded from comparison, and why each one.
 *
 * `archived` / `deleted`: the user has already put this out of sight. Raising
 * it in an advisory notice re-surfaces a decision they made, and offering
 * `delete_existing_item` against it is the highest-risk action in the whole
 * feature aimed at the least useful target. (The client action layer also
 * blocks this — see `similarItemActions.ts` `existingItemArchived` — but the
 * cheapest place to prevent it is by never sending the record.)
 *
 * `pending` / `failed`: an unfinished intake record. Its attributes are
 * provisional or absent, so comparing against it produces a notice about a
 * record the user has not yet accepted as real.
 *
 * An ABSENT status is treated as active: most stored shapes predate any
 * lifecycle field, and defaulting to "exclude" would silently disable the
 * feature for every legacy record.
 */
const EXCLUDED_STATUSES = new Set(['archived', 'deleted', 'pending', 'failed']);

const COMPARABLE_FIELDS: ReadonlyArray<keyof ClientExistingRecord> = [
  'brand', 'model', 'canonicalCategory', 'color', 'material', 'silhouette', 'pattern',
  'authoritativeId', 'productUrl',
];

function hasAnyComparableField(record: ClientExistingRecord): boolean {
  return COMPARABLE_FIELDS.some((field) => normalizeCandidateText(record[field]).length > 0);
}

/**
 * The same structural rule the backend applies as a hard veto: both sides
 * declare a canonical category and they disagree.
 *
 * Applied here too so the record never occupies a slot in the bounded set.
 * Strictly conservative — when either side is unknown, the record is KEPT.
 */
function hasCategoryConflict(query: ClientScanQuery, record: ClientExistingRecord): boolean {
  const queryCategory = slugifyCandidateText(query.canonicalCategory);
  const recordCategory = slugifyCandidateText(record.canonicalCategory);
  return queryCategory.length > 0 && recordCategory.length > 0 && queryCategory !== recordCategory;
}

// ── prioritization ──────────────────────────────────────────────────────────

/**
 * Coarse priority TIERS, strongest first.
 *
 * Deliberately a small ordered ladder of boolean facts rather than a weighted
 * score. A weighted score would be a second similarity engine — untested,
 * unversioned against the thresholds, and capable of disagreeing with the real
 * scorer about which candidate is strongest. A tier ladder can only ever
 * REORDER what the backend will then judge; it cannot express an opinion the
 * backend does not already hold.
 *
 * Lower number = higher priority.
 */
export const PRIORITY_TIERS = {
  /** A caller-normalized identifier agrees. The strongest fact available. */
  AUTHORITATIVE_ID: 0,
  /** Same canonical product page. */
  PRODUCT_URL: 1,
  /** Same brand and a shared model family. */
  BRAND_AND_MODEL: 2,
  /** Same brand, same category. */
  BRAND_AND_CATEGORY: 3,
  /** Same category and subtype. */
  CATEGORY_AND_SUBTYPE: 4,
  /** Same category only. */
  CATEGORY: 5,
  /** Eligible, but nothing above matched. */
  RESIDUAL: 6,
} as const;

function sharesModelFamily(a: unknown, b: unknown): boolean {
  const left = normalizeCandidateText(a).split(' ').filter(Boolean);
  const right = new Set(normalizeCandidateText(b).split(' ').filter(Boolean));
  if (left.length === 0 || right.size === 0) return false;
  const hits = left.filter((token) => right.has(token)).length;
  // Majority overlap, matching the backend's `sharedModelTokens` intent.
  return hits >= Math.ceil(left.length / 2);
}

/** The tier a record occupies against this scan. Pure, deterministic. */
export function priorityTierOf(query: ClientScanQuery, record: ClientExistingRecord): number {
  const queryId = normalizeCandidateText(query.authoritativeId);
  const recordId = normalizeCandidateText(record.authoritativeId);
  if (queryId && recordId && queryId === recordId) return PRIORITY_TIERS.AUTHORITATIVE_ID;

  const queryUrl = normalizeCandidateText(query.productUrl);
  const recordUrl = normalizeCandidateText(record.productUrl);
  if (queryUrl && recordUrl && queryUrl === recordUrl) return PRIORITY_TIERS.PRODUCT_URL;

  const queryBrand = normalizeCandidateText(query.visibleBrandText || query.brand);
  const recordBrand = normalizeCandidateText(record.brand);
  const sameBrand = Boolean(queryBrand) && queryBrand === recordBrand;

  const queryCategory = slugifyCandidateText(query.canonicalCategory);
  const recordCategory = slugifyCandidateText(record.canonicalCategory);
  const sameCategory = Boolean(queryCategory) && queryCategory === recordCategory;

  if (sameBrand && sharesModelFamily(query.model, record.model)) return PRIORITY_TIERS.BRAND_AND_MODEL;
  if (sameBrand && sameCategory) return PRIORITY_TIERS.BRAND_AND_CATEGORY;

  const querySubtype = slugifyCandidateText(query.subtype);
  const recordSubtype = slugifyCandidateText(record.subtype);
  if (sameCategory && querySubtype.length > 0 && querySubtype === recordSubtype) {
    return PRIORITY_TIERS.CATEGORY_AND_SUBTYPE;
  }
  if (sameCategory) return PRIORITY_TIERS.CATEGORY;
  return PRIORITY_TIERS.RESIDUAL;
}

/**
 * Source preference, applied only as a tiebreak WITHIN a tier.
 *
 * Closet first: a Closet item is a curated statement of ownership, whereas
 * Recent Scans is a log that includes retries and rejected scans. This mirrors
 * the backend's threshold asymmetry, but note it is only an ORDERING here —
 * it never causes a Recent Scans record to be dropped.
 */
const SOURCE_RANK: Record<ClientRecordSource, number> = { closet: 0, recent_scan: 1 };

// ── selection ───────────────────────────────────────────────────────────────

export type CandidateSelectionInput = {
  query: ClientScanQuery;
  closetRecords: ClientExistingRecord[];
  recentScanRecords: ClientExistingRecord[];
  config?: CandidateSelectionConfig;
  /** Injectable clock. Real `Date.now` in production; fixed in tests. */
  now?: () => number;
};

function emptyReport(
  cap: number,
  loaded: { closet: number; recent_scan: number },
  timings: CandidateStageTimings,
  rejected: Array<{ reason: CandidateRejectionReason; count: number }> = [],
): ClientCandidateReport {
  void cap;
  return {
    prioritizationVersion: CANDIDATE_PRIORITIZATION_VERSION,
    recordsLoaded: { ...loaded, total: loaded.closet + loaded.recent_scan },
    recordsConsidered: 0,
    recordsRejected: rejected,
    recordsRetained: 0,
    recordsTransmitted: 0,
    sourceCounts: { closet: 0, recent_scan: 0 },
    timings,
  };
}

/**
 * Builds the bounded candidate set for one scan.
 *
 * NEVER THROWS. A malformed record is rejected with a named reason rather
 * than raised: this runs inside a scan the user is waiting on, and the whole
 * feature is advisory. The caller's fallback for any failure here is "send no
 * candidates", which degrades to exactly the pre-Checkpoint-3 behaviour.
 */
export function selectComparisonCandidates(
  input: CandidateSelectionInput,
): CandidateSelectionResult {
  const now = input.now ?? (() => Date.now());
  const startedAt = now();
  const cap = (input.config ?? readCandidateSelectionConfig()).cap;

  const closetRecords = Array.isArray(input.closetRecords) ? input.closetRecords : [];
  const recentScanRecords = Array.isArray(input.recentScanRecords) ? input.recentScanRecords : [];
  const loaded = { closet: closetRecords.length, recent_scan: recentScanRecords.length };

  const rejected: Record<CandidateRejectionReason, number> = {
    unusable_record: 0,
    record_not_active: 0,
    no_comparable_fields: 0,
    category_conflict: 0,
    duplicate_record: 0,
    over_client_cap: 0,
  };

  // ── stage: normalize ──────────────────────────────────────────────────────
  const normalizeStartedAt = now();
  const considered: ClientExistingRecord[] = [];
  for (const record of [...closetRecords, ...recentScanRecords]) {
    if (!record || typeof record !== 'object') {
      rejected.unusable_record += 1;
      continue;
    }
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    if (!id || (record.source !== 'closet' && record.source !== 'recent_scan')) {
      rejected.unusable_record += 1;
      continue;
    }
    considered.push(record);
  }
  const normalizeMs = now() - normalizeStartedAt;

  // ── stage: prune ──────────────────────────────────────────────────────────
  const pruneStartedAt = now();
  const surviving: ClientExistingRecord[] = [];
  for (const record of considered) {
    const status = normalizeCandidateText(record.status);
    if (status && EXCLUDED_STATUSES.has(status)) {
      rejected.record_not_active += 1;
      continue;
    }
    if (!hasAnyComparableField(record)) {
      rejected.no_comparable_fields += 1;
      continue;
    }
    if (hasCategoryConflict(input.query, record)) {
      rejected.category_conflict += 1;
      continue;
    }
    surviving.push(record);
  }
  const pruneMs = now() - pruneStartedAt;

  // ── stage: prioritize ─────────────────────────────────────────────────────
  //
  // Sorted before dedupe so that when one physical item appears in both lists
  // the STRONGER-tiered copy is the one kept, rather than whichever list was
  // iterated first.
  const prioritizeStartedAt = now();
  const ranked = surviving
    .map((record) => ({ record, tier: priorityTierOf(input.query, record) }))
    .sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      const sourceDelta = SOURCE_RANK[a.record.source] - SOURCE_RANK[b.record.source];
      if (sourceDelta !== 0) return sourceDelta;
      const aUpdated = typeof a.record.updatedAtMs === 'number' ? a.record.updatedAtMs : 0;
      const bUpdated = typeof b.record.updatedAtMs === 'number' ? b.record.updatedAtMs : 0;
      if (aUpdated !== bUpdated) return bUpdated - aUpdated;
      // Final tiebreak on id so the whole ordering is total and deterministic:
      // the same inputs must always produce the same request.
      return a.record.id.localeCompare(b.record.id);
    });
  const prioritizeMs = now() - prioritizeStartedAt;

  // ── stage: dedupe ─────────────────────────────────────────────────────────
  //
  // One garment can legitimately exist in both lists (scanned, then saved).
  // Sending both wastes a slot and would produce two notices for one physical
  // item — which reads as the system being confused rather than thorough.
  //
  // Identity is `mirrorOfId` when present, else the record's own id. That
  // collapses a Recent Scans record onto the Closet item it became, and also
  // collapses a literal id collision across the two lists.
  const dedupeStartedAt = now();
  const seenIdentities = new Set<string>();
  const retained: ClientExistingRecord[] = [];
  for (const entry of ranked) {
    const identity = normalizeCandidateText(entry.record.mirrorOfId) || entry.record.id;
    if (seenIdentities.has(identity)) {
      rejected.duplicate_record += 1;
      continue;
    }
    seenIdentities.add(identity);
    retained.push(entry.record);
  }
  const dedupeMs = now() - dedupeStartedAt;

  // ── cap ───────────────────────────────────────────────────────────────────
  const transmitted = retained.slice(0, cap);
  rejected.over_client_cap = Math.max(0, retained.length - transmitted.length);

  const candidates = transmitted.map(toTransmittedCandidate);
  const sourceCounts = {
    closet: candidates.filter((c) => c.source === 'closet').length,
    recent_scan: candidates.filter((c) => c.source === 'recent_scan').length,
  };

  const recordsRejected = (Object.entries(rejected) as Array<[CandidateRejectionReason, number]>)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => ({ reason, count }));

  return {
    candidates,
    report: {
      prioritizationVersion: CANDIDATE_PRIORITIZATION_VERSION,
      recordsLoaded: { ...loaded, total: loaded.closet + loaded.recent_scan },
      recordsConsidered: considered.length,
      recordsRejected,
      recordsRetained: retained.length,
      recordsTransmitted: candidates.length,
      sourceCounts,
      timings: {
        normalizeMs,
        pruneMs,
        prioritizeMs,
        dedupeMs,
        totalMs: now() - startedAt,
      },
    },
  };
}

/**
 * Projects a local record onto exactly the transmitted shape.
 *
 * Field-by-field rather than a spread, for the same reason
 * `projectIdentificationToQuery` is: a spread would forward every local field
 * — status, timestamps, mirror linkage, and anything a future storage change
 * adds — to a service that documents a fixed allowlist. Naming each field is
 * what keeps the transmitted payload a decision rather than an accident.
 *
 * Empty values are OMITTED rather than sent as null, which measurably shrinks
 * the request for sparse records and matches the sanitizer's own behaviour of
 * dropping empty strings.
 */
function toTransmittedCandidate(record: ClientExistingRecord): TransmittedCandidate {
  const candidate: TransmittedCandidate = { id: record.id.trim(), source: record.source };
  const put = (key: keyof TransmittedCandidate, value: unknown, max: number): void => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (!trimmed) return;
    (candidate as Record<string, unknown>)[key] = trimmed.slice(0, max);
  };
  put('label', record.label, 160);
  put('imageUri', record.imageUri, 2048);
  put('brand', record.brand, 80);
  put('model', record.model, 120);
  put('canonicalCategory', record.canonicalCategory, 60);
  put('color', record.color, 60);
  put('material', record.material, 60);
  put('silhouette', record.silhouette, 60);
  put('pattern', record.pattern, 60);
  put('productUrl', record.productUrl, 2048);
  put('authoritativeId', record.authoritativeId, 128);
  if (record.imageQuality === 'ok' || record.imageQuality === 'poor' || record.imageQuality === 'missing') {
    candidate.imageQuality = record.imageQuality;
  }
  return candidate;
}

/**
 * Serialized size of the candidate array, in bytes.
 *
 * Reported so payload growth is a measured number rather than an assumption.
 * Uses the same JSON the request body will carry.
 */
export function candidatePayloadBytes(candidates: TransmittedCandidate[]): number {
  const json = JSON.stringify(candidates ?? []);
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(json).length;
  // RN always has TextEncoder; this branch only guards exotic test runtimes.
  return json.length;
}
