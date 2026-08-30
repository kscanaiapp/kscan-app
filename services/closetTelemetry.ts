// Narrow structured logging adapter for the Closet candidate layer.
//
// THIS IS NOT AN ANALYTICS SDK, and no analytics vendor is added by this build.
// It is a bounded, allowlisted event sink with one default sink (a dev console
// line) and an injectable seam so tests and any future owner-approved transport
// can replace it without touching a call site.
//
// TWO ALLOWLISTS, NOT ONE. The event name must be known, AND every property must
// be a known key whose value survives a strict scrub. A blocklist of forbidden
// fields would have to anticipate every future field name; an allowlist drops an
// unanticipated one by construction.
//
// NEVER EMITTED, and asserted absent by test: raw image bytes, Base64, local or
// remote URIs, filenames, asset ids, user-entered titles, brand or product
// descriptions, actor ids in plaintext, emails, access tokens, backend prompts,
// and raw backend responses.
//
// BUSINESS LOGIC MUST NOT DEPEND ON THIS. Every function here swallows its own
// failures and returns void: a telemetry fault is never allowed to fail an
// intake, a classification, or a cleanup.

export const CLOSET_CANDIDATE_EVENTS = [
  'closet_candidate_created',
  'closet_candidate_media_prepared',
  'closet_candidate_duplicate_detected',
  'closet_candidate_classification_started',
  'closet_candidate_classified',
  'closet_candidate_manual_classification_required',
  'closet_candidate_waiting_for_network',
  'closet_candidate_classification_failed',
  'closet_candidate_retry_started',
  'closet_candidate_request_aborted',
  'closet_candidate_expired',
  'closet_candidate_cleanup_completed',
  'closet_candidate_cleanup_failed',
  // Build 2.5 Phase 0B. Emitted once per stageMirrorSelfieGarmentCrops call —
  // see services/closetMirrorStaging.ts. Deliberately the only Mirror event
  // this phase adds: capture, validation, person-detection and segmentation
  // stages do not exist yet and must not acquire telemetry ahead of themselves.
  'mirror_selfie_crops_staged',
  // Build 2.5 Step 3. The local extraction pipeline, which runs entirely on
  // device and never uploads a pixel. These events describe SHAPE and OUTCOME
  // only: how many people were found, how many crops came out, roughly how long
  // it took, and what the user did next. No coordinate, no dimension, no URI,
  // no session id and no crop key is emissible — see the property allowlist and
  // the SAFE_STRING scrub below, which reject all of them by shape.
  'mirror_selfie_source_selected',
  'mirror_selfie_validation_completed',
  'mirror_selfie_extraction_completed',
  'mirror_selfie_extraction_cancelled',
  'mirror_selfie_crop_review_completed',
  // Build 2.5 Step 4. The extraction-selection -> candidate-staging coordinator
  // (services/mirror/mirrorCandidateIntegration.ts). Describes SHAPE and
  // OUTCOME only — how many crops, how many groups, how many settled which way,
  // roughly how long it took. No session id, no crop key, no candidate id, no
  // batch id: the property allowlist and the SAFE_STRING scrub below reject all
  // of them by shape, same as every other Mirror event.
  'mirror_candidate_staging_started',
  'mirror_candidate_staging_completed',
  'mirror_candidate_staging_partial',
  'mirror_candidate_staging_cancelled',
  // Build 34 / Track B / Phase B2B — outbound Closet cloud sync
  // (services/closet/closetSyncEngine.ts). SHAPE AND OUTCOME ONLY: whether a
  // pass ran, how many items it looked at in coarse buckets, and how each item
  // resolved. Deliberately NOT emissible here, and rejected by the property
  // allowlist and SAFE_STRING scrub below even if a caller tried: the local
  // client_id, the server item id, the owner/user id, any Storage path, any
  // signed URL, any access token, and any item title/brand/notes.
  'closet_sync_started',
  'closet_facts_synced',
  'closet_media_synced',
  'closet_media_blocked',
  'closet_sync_retry',
  'closet_sync_failed',
  'closet_sync_conflict',
  'closet_sync_tombstoned',
  // Build 34 / Track B / Phase B2C — inbound cross-device Closet restore
  // (services/closet/closetRestoreEngine.ts). SHAPE AND OUTCOME ONLY, same
  // discipline as the B2B events above: no client_id, no server item id, no
  // owner/user id, no Storage path, no signed URL, no item title/brand/notes.
  'closet_restore_started',
  'closet_restore_page',
  'closet_restore_completed',
  'closet_restore_conflict',
  'closet_restore_media_missing',
  'closet_restore_failed',
] as const;

export type ClosetCandidateEvent = typeof CLOSET_CANDIDATE_EVENTS[number];

/**
 * The complete property allowlist.
 *
 * Every entry is an enum, a boolean, a coarse bucket, or a bounded contract code.
 * There is deliberately no free-text property: a single free-text field is all it
 * takes for a caller to pass a brand name, a title, or an exception message that
 * quotes a request body.
 */
export const CLOSET_CANDIDATE_EVENT_PROPERTIES = [
  'sourceType',
  'status',
  'previousStatus',
  'errorCode',
  'algorithmVersion',
  'outcome',
  'scope',
  'resultStatus',
  'resolutionLevel',
  'entryPath',
  'platform',
  'requestMode',
  'attemptBucket',
  'countBucket',
  'latencyBucket',
  'candidateCountBucket',
  'hasThumbnail',
  'freeSpaceKnown',
  'automatic',
  'mediaFailed',
  'aborted',
  // Build 2.5 Phase 0B — mirror_selfie_crops_staged only. Bounded counts, never
  // a raw crop count above the 8-item batch cap and never the extraction
  // session id, a crop key, a candidate id or a batch id.
  'cropCountBucket',
  'createdCount',
  'duplicateCount',
  'rejectedCount',
  'batchLimitReached',
  // Build 2.5 Step 3 — local extraction only. Every one is a coarse bucket or a
  // boolean.
  //
  // NOTE ON BUCKET SPELLING: the scrub below rejects `+`, so the open-ended
  // buckets are written `2_plus` / `9_plus`, never `2+` / `9+`. A `+` here would
  // not fail loudly — it would be silently dropped, and the bucket would vanish
  // at exactly the interesting end of the distribution.
  'personCountBucket',
  'sourceCountBucket',
  'selectedCountBucket',
  'reviewCountBucket',
  'durationBucket',
  'extractionSupported',
  'personSelectionRequired',
  // Build 2.5 Step 4 — mirror_candidate_staging_* only. Every value below is a
  // coarse bucket or an enum, never a raw count above the partition size.
  'groupCountBucket',
  'successCountBucket',
  'failureCountBucket',
] as const;

export type ClosetCandidateEventProperty =
  typeof CLOSET_CANDIDATE_EVENT_PROPERTIES[number];

export type ClosetCandidateEventPayload = Partial<
  Record<ClosetCandidateEventProperty, string | number | boolean | null>
>;

export type ClosetTelemetrySink = (
  event: ClosetCandidateEvent,
  payload: ClosetCandidateEventPayload,
) => void;

const EVENT_SET = new Set<string>(CLOSET_CANDIDATE_EVENTS);
const PROPERTY_SET = new Set<string>(CLOSET_CANDIDATE_EVENT_PROPERTIES);

/**
 * Bounded scrub applied to every value that survives the key allowlist.
 *
 * Strings are capped at 64 characters and must match a conservative
 * `[A-Za-z0-9_.:-]` shape. That pattern cannot express a `file://`, `content://`
 * or `ph://` URI, a Windows path, a bare filename with an extension, an email, or
 * a query string — the same allowlist-by-shape reasoning the evidence-id format
 * uses. Numbers must be finite. Everything else is dropped.
 */
const SAFE_STRING = /^[A-Za-z0-9_.:-]{1,64}$/;

function scrub(value: unknown): string | number | boolean | null | undefined {
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') return SAFE_STRING.test(value) ? value : undefined;
  return undefined;
}

function devSink(event: ClosetCandidateEvent, payload: ClosetCandidateEventPayload): void {
  // Dev only. A production console line is still a log line, and this module has
  // no durable queue by design (see the note on offline queuing below).
  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    // eslint-disable-next-line no-console
    console.log('[closetTelemetry]', event, payload);
  }
}

let sink: ClosetTelemetrySink = devSink;

/**
 * Replace the sink. Test seam, and the single integration point if an
 * owner-approved transport is ever added.
 *
 * NO DURABLE OFFLINE QUEUE IS BUILT HERE. There is no existing reusable
 * offline-queue pattern in this repository to follow, and inventing one for
 * telemetry would create a second persistence surface with its own corruption,
 * growth and privacy characteristics — for data that, by construction, nothing
 * depends on.
 */
export function setClosetTelemetrySink(next: ClosetTelemetrySink | null): void {
  sink = typeof next === 'function' ? next : devSink;
}

export function resetClosetTelemetrySink(): void {
  sink = devSink;
}

/**
 * Emit one bounded event. Unknown event names and unknown properties are dropped
 * silently; a telemetry mistake must never become a runtime error on a path that
 * is already handling a failure.
 */
export function emitClosetCandidateEvent(
  event: string,
  payload: Record<string, unknown> = {},
): void {
  try {
    if (!EVENT_SET.has(event)) return;
    const safe: ClosetCandidateEventPayload = {};
    for (const [key, value] of Object.entries(payload ?? {})) {
      if (!PROPERTY_SET.has(key)) continue;
      const scrubbed = scrub(value);
      if (scrubbed === undefined) continue;
      (safe as Record<string, unknown>)[key] = scrubbed;
    }
    sink(event as ClosetCandidateEvent, safe);
  } catch {
    /* telemetry never propagates */
  }
}

/** Test seam only. Not used by production code. */
export const __closetTelemetryInternals = { scrub, SAFE_STRING };
