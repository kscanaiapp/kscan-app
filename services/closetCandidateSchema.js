/**
 * ClosetCandidate identifiers, allowlist record construction, and schema
 * migration.
 *
 * WHY MIGRATION INFRASTRUCTURE IN THE FIRST RELEASE: the candidate store is
 * greenfield, so there is nothing to migrate today. But the migration seam has to
 * exist before the first record is written, because the alternative is adding it
 * later against records that were persisted without it — at which point the
 * "before" shape has to be reverse-engineered from whatever shipped.
 *
 * Every function here is PURE and never mutates its input. `migrateClosetCandidateRecord`
 * in particular reconstructs through the allowlist rather than editing the raw
 * value, so a hostile or future record cannot smuggle an unknown key forward
 * simply by existing on disk.
 */

import * as ExpoCrypto from 'expo-crypto';
import {
  CLOSET_CANDIDATE_SCHEMA_VERSION,
  CLOSET_CANDIDATE_MAX_SUPPORTED_SCHEMA_VERSION,
  CLOSET_CANDIDATE_SOURCES,
  CLOSET_CANDIDATE_CONTENT_HASH_VERSION,
  CLOSET_CANDIDATE_DUPLICATE_ALGORITHMS,
  CLOSET_CANDIDATE_TTL_MS,
} from '../types/closetCandidate';
import { isClosetCandidateErrorCode } from './closetCandidateErrors';
import { isClosetCandidateStatus } from './closetCandidateStateMachine';

let candidateIdCounter = 0;
let batchIdCounter = 0;

// ── Identifiers ──────────────────────────────────────────────────────────────

/**
 * Collision-resistant random suffix.
 *
 * Mirrors the secure-random chain already proven in this repository for evidence
 * ids and collaboration idempotency keys (Web Crypto -> expo-crypto -> Math.random),
 * because Hermes may ship without global Web Crypto. The final fallback is
 * deliberately last, not first: neither `Date.now()` alone nor `Math.random()`
 * alone is acceptable, and combining a monotonic timestamp, a process-scoped
 * counter and strong randomness is what survives both a same-millisecond burst
 * and a process restart.
 */
function randomSuffix() {
  try {
    if (typeof ExpoCrypto.getRandomBytes === 'function') {
      const bytes = ExpoCrypto.getRandomBytes(8);
      return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    }
  } catch {
    // fall through
  }
  const rand = () => Math.floor(Math.random() * 0x100000000).toString(36);
  return `${rand()}${rand()}`;
}

export function createClosetCandidateId() {
  candidateIdCounter = (candidateIdCounter + 1) % 0x100000;
  return `candidate_${Date.now().toString(36)}_${candidateIdCounter.toString(36)}_${randomSuffix()}`;
}

/**
 * A batch id is minted ONCE at the intake boundary and passed into every
 * candidate that intake operation creates.
 *
 * A single-photo intake still receives one. Making batching conditional would
 * mean Build 2's batch review has to special-case records that predate it, and a
 * "batch of one" is a coherent thing whereas a null batch id is not.
 */
export function createClosetBatchId() {
  batchIdCounter = (batchIdCounter + 1) % 0x100000;
  return `batch_${Date.now().toString(36)}_${batchIdCounter.toString(36)}_${randomSuffix()}`;
}

// ── Field hygiene ────────────────────────────────────────────────────────────

function cleanText(value, max = 200) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  return text.slice(0, max);
}

function cleanTextArray(value, max = 80, limit = 12) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of value) {
    const text = cleanText(entry, max);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function cleanConfidenceValue(value) {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(1, value));
}

function cleanConfidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  for (const key of ['category', 'subtype', 'brand', 'color', 'material']) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      out[key] = cleanConfidenceValue(value[key]);
    }
  }
  return Object.keys(out).length ? out : null;
}

function cleanIsoDate(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return fallback;
  return new Date(parsed).toISOString();
}

function cleanNonNegativeInt(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

function cleanBatchPosition(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

function cleanDuplicateMatch(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const algorithmVersion = CLOSET_CANDIDATE_DUPLICATE_ALGORITHMS.includes(
    value.algorithmVersion,
  )
    ? value.algorithmVersion
    : null;
  // A duplicate match with no algorithm is not a claim we can defend, so it is
  // dropped rather than recorded with a guessed algorithm.
  if (!algorithmVersion) return null;
  const confidence = cleanConfidenceValue(value.confidence);
  return {
    candidateId: cleanText(value.candidateId, 120),
    closetItemId: cleanText(value.closetItemId, 120),
    confidence: confidence === null ? 1 : confidence,
    reasons: cleanTextArray(value.reasons, 80, 6),
    algorithmVersion,
  };
}

// ── Allowlist record construction ────────────────────────────────────────────

/**
 * EXPLICIT ALLOWLIST RECORD BUILDER.
 *
 * Every persisted field is enumerated here. The draft is NEVER spread, so an
 * unknown key — a commerce payload, a signed URL, a provider blob, a Base64
 * image, a future upstream field — is dropped by construction rather than by
 * remembering to delete it. Never replace this with a spread-then-delete.
 *
 * Ownership, identifiers and lifetime are authoritative here and are NOT taken
 * from the draft: `ownerId` comes from the resolved write authority, and
 * `createdAt` / `expiresAt` are stamped once so a metadata edit cannot extend a
 * candidate's life.
 */
export function buildClosetCandidateRecord(draft, ownerId, now, options = {}) {
  const source = CLOSET_CANDIDATE_SOURCES.includes(draft?.sourceType)
    ? draft.sourceType
    : 'gallery';

  const createdAt = cleanIsoDate(options.createdAt, now);
  const expiresAt = cleanIsoDate(
    options.expiresAt,
    new Date(Date.parse(createdAt) + CLOSET_CANDIDATE_TTL_MS).toISOString(),
  );

  return {
    schemaVersion: CLOSET_CANDIDATE_SCHEMA_VERSION,

    candidateId: cleanText(options.candidateId, 120) || createClosetCandidateId(),
    batchId: cleanText(options.batchId, 120) || createClosetBatchId(),
    batchPosition: cleanBatchPosition(options.batchPosition),
    ownerId: typeof ownerId === 'string' && ownerId.trim() ? ownerId.trim() : null,

    sourceType: source,
    sourceId: cleanText(draft?.sourceId, 300),
    sourceLineageId: cleanText(draft?.sourceLineageId, 300),

    // External picker and camera URIs are intentionally never persisted in a
    // candidate manifest. Candidate-owned media is the only durable source.
    originalImageUri: null,
    candidateImageUri: cleanText(draft?.candidateImageUri, 2000),
    candidateThumbnailUri: cleanText(draft?.candidateThumbnailUri, 2000),

    title: cleanText(draft?.title, 200),
    brand: cleanText(draft?.brand, 120),
    category: cleanText(draft?.category, 80),
    clothingType: cleanText(draft?.clothingType, 80),
    subtype: cleanText(draft?.subtype, 80),
    primaryColor: cleanText(draft?.primaryColor, 60),
    secondaryColors: cleanTextArray(draft?.secondaryColors, 60, 8),
    material: cleanTextArray(draft?.material, 60, 8),
    size: cleanText(draft?.size, 40),
    notes: cleanText(draft?.notes, 500),

    confidence: cleanConfidence(draft?.confidence),
    classificationVersion: cleanText(draft?.classificationVersion, 80),

    contentHash: cleanText(draft?.contentHash, 128),
    contentHashVersion:
      draft?.contentHashVersion === CLOSET_CANDIDATE_CONTENT_HASH_VERSION
        ? CLOSET_CANDIDATE_CONTENT_HASH_VERSION
        : null,
    normalizedByteLength:
      typeof draft?.normalizedByteLength === 'number' &&
      Number.isFinite(draft.normalizedByteLength) &&
      draft.normalizedByteLength >= 0
        ? Math.floor(draft.normalizedByteLength)
        : null,

    duplicateMatch: cleanDuplicateMatch(draft?.duplicateMatch),

    status: isClosetCandidateStatus(draft?.status) ? draft.status : 'queued',

    attemptCount: cleanNonNegativeInt(draft?.attemptCount),
    automaticRetryCount: cleanNonNegativeInt(draft?.automaticRetryCount),
    interruptionCount: cleanNonNegativeInt(draft?.interruptionCount),

    errorCode: isClosetCandidateErrorCode(draft?.errorCode) ? draft.errorCode : null,
    lastAttemptAt: typeof draft?.lastAttemptAt === 'string'
      ? cleanIsoDate(draft.lastAttemptAt, null)
      : null,

    createdAt,
    updatedAt: cleanIsoDate(options.updatedAt, now),
    expiresAt,
  };
}

// ── Migration ────────────────────────────────────────────────────────────────

/**
 * v0 -> v1.
 *
 * v0 is "a record already on disk that carries no schemaVersion". No such record
 * can exist yet, because v1 is the first shipped schema. The function is real
 * rather than a stub so the mechanism is exercised by test: the first time a v2
 * arrives, the chain it plugs into must already be known to work.
 */
export function migrateCandidateV0ToV1(raw) {
  // Reconstructed, not mutated. Defaults are applied by the allowlist builder.
  return {
    ...raw,
    schemaVersion: 1,
  };
}

/** v1 -> v2: Build 1 records retain a stable null batch-order fallback. */
export function migrateCandidateV1ToV2(raw) {
  return {
    ...raw,
    schemaVersion: 2,
    batchPosition: cleanBatchPosition(raw?.batchPosition),
  };
}

const MIGRATIONS = Object.freeze({
  0: migrateCandidateV0ToV1,
  1: migrateCandidateV1ToV2,
});

/**
 * Read one persisted record safely.
 *
 * Fails CLOSED and never throws:
 *   - a non-object, or a record with no usable candidateId, is rejected
 *   - an unsupported FUTURE schemaVersion is rejected rather than guessed at,
 *     because interpreting a newer record with older rules is how fields get
 *     silently dropped and then written back missing
 *   - anything unexpected during migration is reported as a stable code
 *
 * A rejected record is SKIPPED by the store, never repaired in place and never
 * deleted here — deleting the user's data on a read path is not a recovery.
 */
export function migrateClosetCandidateRecord(rawRecord) {
  try {
    if (!rawRecord || typeof rawRecord !== 'object' || Array.isArray(rawRecord)) {
      return { ok: false, errorCode: 'candidate_store_corrupt' };
    }

    const declared = rawRecord.schemaVersion;
    let version =
      typeof declared === 'number' && Number.isFinite(declared) && declared >= 0
        ? Math.floor(declared)
        : 0;

    // A NEWER build wrote this record. It is not corrupt and it is not ours to
    // rewrite: reporting it distinctly is what lets the store refuse to persist a
    // reduced record set that would delete it.
    if (version > CLOSET_CANDIDATE_MAX_SUPPORTED_SCHEMA_VERSION) {
      return { ok: false, errorCode: 'candidate_store_future_schema' };
    }

    const migratedFrom = version;
    let working = rawRecord;
    while (version < CLOSET_CANDIDATE_SCHEMA_VERSION) {
      const step = MIGRATIONS[version];
      if (typeof step !== 'function') {
        return { ok: false, errorCode: 'candidate_store_corrupt' };
      }
      working = step(working);
      const next =
        typeof working?.schemaVersion === 'number' ? Math.floor(working.schemaVersion) : NaN;
      // A migration that does not advance the version would loop forever.
      if (!Number.isFinite(next) || next <= version) {
        return { ok: false, errorCode: 'candidate_store_corrupt' };
      }
      version = next;
    }

    const candidateId = cleanText(working?.candidateId, 120);
    const batchId = cleanText(working?.batchId, 120);
    // Identity is not something a reader may mint. A record with no id cannot be
    // addressed, transitioned, deduped or deleted, so it is not a record.
    if (!candidateId || !batchId) {
      return { ok: false, errorCode: 'candidate_store_corrupt' };
    }

    const createdAt = cleanIsoDate(working.createdAt, null);
    const expiresAt = cleanIsoDate(working.expiresAt, null);
    if (!createdAt || !expiresAt) {
      return { ok: false, errorCode: 'candidate_store_corrupt' };
    }

    // Reconstruct through the allowlist: unknown keys present on the raw record
    // are dropped here rather than carried forward.
    const record = buildClosetCandidateRecord(
      working,
      typeof working.ownerId === 'string' && working.ownerId.trim()
        ? working.ownerId.trim()
        : null,
      cleanIsoDate(working.updatedAt, createdAt),
      {
        candidateId,
        batchId,
        batchPosition: working.batchPosition,
        createdAt,
        expiresAt,
        updatedAt: working.updatedAt,
      },
    );

    return { ok: true, record, migratedFrom };
  } catch {
    return { ok: false, errorCode: 'candidate_store_corrupt' };
  }
}

/**
 * Validate and normalize a MANUAL classification submission.
 *
 * Pure, and separated from the write on purpose: validation that runs inside the
 * store would have to reject a half-applied patch, whereas a rejection here means
 * nothing was ever handed to the store and the candidate is provably unchanged.
 *
 * CATEGORY IS THE ONLY REQUIRED FIELD. It is what the backend failed to produce
 * and what `hasUsableTaxonomy` needs before a candidate may reach review. Brand,
 * material, size, product name, retailer, SKU and price are deliberately NOT
 * collected: Build 1 is a wardrobe intake, not a commerce record, and asking for
 * them would turn a one-tap fix into a form.
 *
 * The bounds match `buildClosetCandidateRecord` exactly. Duplicating a shorter
 * limit here would silently truncate what the store would otherwise have kept.
 */
export function normalizeManualClassificationInput(fields) {
  const category = cleanText(fields?.category, 80);
  if (!category) {
    return { ok: false, errorCode: 'classification_requires_manual_category' };
  }

  // Only the five taxonomy fields are extracted — everything else in the input,
  // protected fields included, is simply never forwarded. Protected fields stay
  // untouchable twice over: they cannot leave this function, and
  // `updateClosetCandidate` rejects any patch that names one regardless.
  return {
    ok: true,
    fields: {
      category,
      clothingType: cleanText(fields?.clothingType, 80),
      subtype: cleanText(fields?.subtype, 80),
      primaryColor: cleanText(fields?.primaryColor, 60),
      secondaryColors: cleanTextArray(fields?.secondaryColors, 60, 8),
    },
  };
}

/** Test seam only. Not used by production code. */
export const __closetCandidateSchemaInternals = {
  cleanText,
  cleanTextArray,
  cleanConfidence,
  cleanDuplicateMatch,
  cleanBatchPosition,
  MIGRATIONS,
};
