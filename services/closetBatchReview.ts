// The READ-ONLY ordered batch-review projection (Closet Upgrade Build 2, Phase 2).
//
// WHAT THIS IS: one deterministic, actor-scoped view over candidate records that
// already exist. The review screen reads THIS instead of interpreting raw manifest
// records, so grouping, ordering, status vocabulary and eligibility are decided in
// one testable place rather than re-derived by every component that renders a row.
//
// WHAT THIS IS NOT, and the invariant the whole phase rests on:
//
//     projection  !=  a third persistence store
//
// Nothing here writes. Not the candidate manifest, not candidate media, not the
// committed Closet, not AsyncStorage. It takes records in and returns a new object
// graph; the source records are never mutated. `batchId` and `batchPosition` are
// READ, never minted, never repaired, never migrated for presentation — a legacy
// record is grouped as it is, not rewritten so it sorts more conveniently.
//
// STILL NO WRITES IN PHASE 3. Promotion added a caller, not a second writer: the
// coordinator in services/closetCandidatePromotion.js owns the committed write and
// the candidate tombstone, and this module only READS what that produced. It shows
// a promoted candidate because the record on disk says `saved`, and it shows the
// transient "Adding to Closet" card because the caller passed in which candidate
// the running operation is on — never because it inferred either.

import {
  type ClosetCandidate,
  type ClosetCandidateStatus,
} from '../types/closetCandidate';
import { statusUIMetadata } from './closetCandidateStateMachine';
import { closetCandidateErrorMessage, isUserRetryable } from './closetCandidateErrors';
import {
  getClosetCandidateReviewEligibility,
  type ClosetCandidateSelectionBlockedReason,
} from './closetCandidateReviewEligibility';
import {
  CLOSET_PROMOTION_ACTIVE_LABEL,
  CLOSET_PROMOTION_PENDING_LABEL,
} from './closetCandidatePromotionContract';

// ── Vocabulary ───────────────────────────────────────────────────────────────

/**
 * Contextual actions a review row may offer.
 *
 * Deliberately short, and deliberately without an edit affordance for
 * `ready_for_review`: `manuallyClassifyClosetCandidate` accepts exactly one source
 * status (`needs_manual_classification`) and rejects everything else with
 * `candidate_invalid_transition`. Offering "Edit details" on a ready candidate
 * would either fail every time or require a second correction path in the service
 * layer, which is not this phase's scope.
 */
/**
 * DUPLICATE ASSIST (Build 29, section 14).
 *
 * `same_item` and `different_item` resolve a potential duplicate. The detection
 * that produces one already exists — an exact normalized-byte match against the
 * committed Closet, written as `duplicateMatch` with the record created directly
 * in the `duplicate` status — and the state machine already documents both
 * outcomes as legal edges (`duplicate -> rejected`, and `duplicate -> queued`,
 * described there as "the 'Add anyway' edge ... not reachable in Build 1").
 *
 * What was missing was only the user's say. Until now a duplicate offered
 * `remove` and nothing else, and review eligibility blocked it as
 * `duplicate_unresolved` — a state with no affordance that could resolve it.
 *
 * NO SIMILARITY ENGINE IS INTRODUCED HERE, and none is needed: the signal is
 * already computed. The user's decision is authoritative; nothing merges on the
 * strength of the match alone.
 */
export const CLOSET_BATCH_REVIEW_ACTIONS = [
  'add_details',
  'retry',
  'remove',
  'same_item',
  'different_item',
] as const;

export type ClosetBatchReviewAction = typeof CLOSET_BATCH_REVIEW_ACTIONS[number];

/** Neutral copy for a candidate that predates batched intake. Never "legacy". */
export const CLOSET_BATCH_REVIEW_UNBATCHED_LABEL = 'Previous item';

/**
 * Why a duplicate is not selectable, in plain language.
 *
 * Says WHAT happened and nothing about HOW it was decided. The match is an exact
 * byte comparison over normalized media, and a digest, a byte length or the word
 * "hash" tells the user nothing they can act on while leaking how the store works.
 */
export const CLOSET_BATCH_REVIEW_DUPLICATE_MESSAGE =
  'This photo matches an item already in your Closet.';

/** A candidate past its lifetime. Shown instead of the status it was last in. */
export const CLOSET_BATCH_REVIEW_EXPIRED_LABEL = 'Expired';

/**
 * Where a candidate sits relative to a promotion operation.
 *
 *   idle      not part of any running operation
 *   pending   submitted, waiting its turn — NOT saving, and never rendered as if
 *             it were; the operation has not touched it yet
 *   active    the ONE candidate the serialized queue is working on right now
 *   promoted  durable: the record says `saved` and carries a committed item id
 *
 * Only `promoted` comes from the record. `pending` and `active` are OVERLAY state
 * supplied by the running operation and are never persisted — a durable in-flight
 * status would survive a crash as a candidate stuck mid-promotion with no sweep to
 * release it until Phase 4 adds one.
 */
export const CLOSET_BATCH_PROMOTION_STATES = ['idle', 'pending', 'active', 'promoted'] as const;

export type ClosetBatchPromotionState = typeof CLOSET_BATCH_PROMOTION_STATES[number];

/** Why an expired candidate can only be removed. */
export const CLOSET_BATCH_REVIEW_EXPIRED_MESSAGE =
  'This photo waited too long for review. Add it again to try once more.';

export type ClosetBatchReviewItem = {
  candidateId: string;
  /** The record's own batch id. `null` only for a record that has no usable one. */
  batchId: string | null;
  /** Immutable picker position. `null` for pre-batch records; never fabricated. */
  batchPosition: number | null;
  thumbnailUri: string | null;
  imageUri: string | null;

  displayCategory: string | null;
  displayType: string | null;
  displaySubtype: string | null;
  displayColor: string | null;
  displayBrand: string | null;
  /** Taxonomy joined for display, or null when nothing has been classified yet. */
  displaySummary: string | null;

  status: ClosetCandidateStatus;
  /** User-facing status copy, owned by the state machine. Never a raw status. */
  statusLabel: string;
  /** Registry copy for a failure. Never a raw backend string. */
  statusMessage: string | null;

  expired: boolean;
  selectionEligible: boolean;
  selectionBlockedReason: ClosetCandidateSelectionBlockedReason | null;
  availableActions: readonly ClosetBatchReviewAction[];

  /** Idle / pending / active / promoted. See CLOSET_BATCH_PROMOTION_STATES. */
  promotionState: ClosetBatchPromotionState;
  /** The committed Closet item this candidate became, once it has become one. */
  committedClosetItemId: string | null;
};

export type ClosetBatchReviewGroup = {
  /** Stable UI identity for the group. Equals `batchId` whenever one exists. */
  groupId: string;
  batchId: string | null;
  batchCreatedAt: string | null;
  /** True for a single pre-batch record shown as its own review group. */
  isUnbatchedGroup: boolean;
  /** Neutral heading for an unbatched group, else null. */
  groupLabel: string | null;

  totalCount: number;
  processingCount: number;
  readyCount: number;
  needsDetailsCount: number;
  waitingCount: number;
  retryableFailureCount: number;
  unresolvableFailureCount: number;
  duplicateCount: number;
  expiredCount: number;
  /** Candidates in this batch that are already committed Closet items. */
  promotedCount: number;

  eligibleCount: number;
  selectedEligibleCount: number;

  items: readonly ClosetBatchReviewItem[];
};

export type ClosetBatchReviewProjection = {
  /**
   * The actor this projection was computed FOR, stamped so a late result can be
   * rejected rather than rendered under whoever is signed in when it arrives.
   */
  actorId: string | null;
  actorEpoch: number | null;
  activeGroupId: string | null;
  groups: readonly ClosetBatchReviewGroup[];
  activeGroup: ClosetBatchReviewGroup | null;
};

export type ClosetBatchReviewProjectionInput = {
  actorId: string | null;
  actorEpoch?: number | null;
  candidates: readonly Partial<ClosetCandidate>[] | null | undefined;
  activeBatchId?: string | null;
  selectedCandidateIds?: Iterable<string> | null;
  nowMs?: number;
  /**
   * The RUNNING promotion operation, if any. Read-only overlay: nothing here is
   * persisted, and an operation belonging to another actor or another batch is
   * simply not passed in by the caller that owns the operation.
   */
  promotion?: {
    activeCandidateId?: string | null;
    pendingCandidateIds?: Iterable<string> | null;
  } | null;
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function normalizeId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isExpiredAt(candidate: { expiresAt?: unknown }, nowMs: number): boolean {
  const at = Date.parse(typeof candidate?.expiresAt === 'string' ? candidate.expiresAt : '');
  if (!Number.isFinite(at)) return true;
  return at <= nowMs;
}

/** Category / type / subtype / colour, in that order, skipping what is absent. */
function summarize(parts: readonly (string | null)[]): string | null {
  const present = parts.filter((part): part is string => typeof part === 'string' && !!part);
  return present.length ? present.join(' · ') : null;
}

/**
 * Which affordances this row may offer.
 *
 * Derived from the state machine's UI metadata and the error registry — the two
 * authorities that already exist. Nothing here re-decides what a status permits.
 */
function resolveActions(
  status: ClosetCandidateStatus,
  errorCode: unknown,
  expired: boolean,
  promotionState: ClosetBatchPromotionState,
): readonly ClosetBatchReviewAction[] {
  // A promoted candidate offers NOTHING. It cannot be retried (terminal), cannot
  // be edited, and must not be removed: the tombstone is what proves the committed
  // item came from it, and deleting it is Phase 4's decision to make, not a button.
  //
  // The ACTIVE candidate offers nothing either, for the length of its own
  // operation only. Retry or remove landing mid-promotion would race a write that
  // is already past its last cancellation checkpoint.
  if (promotionState === 'promoted' || promotionState === 'active') {
    return Object.freeze([] as ClosetBatchReviewAction[]);
  }

  // An expired record can only be discarded. Every mutation except deletion is
  // refused by the store with `candidate_expired`, so offering retry or manual
  // details here would be an affordance that provably fails.
  if (expired) return Object.freeze(['remove'] as ClosetBatchReviewAction[]);

  const meta = statusUIMetadata(status);
  const actions: ClosetBatchReviewAction[] = [];

  // A potential duplicate asks the user, and offers ONLY that question. Mixing
  // it with the ordinary affordances would let the row be resolved without the
  // decision ever being made, which is the state Build 1 was stuck in.
  if (status === 'duplicate') {
    return Object.freeze(['same_item', 'different_item'] as ClosetBatchReviewAction[]);
  }
  // The manual editor accepts exactly one source status. Build 1's rule, unchanged.
  if (meta.canEditMetadata && status === 'needs_manual_classification') {
    actions.push('add_details');
  }
  // Status says the state ALLOWS retry; the registry says whether retrying this
  // particular failure could help. Both must agree before it is offered.
  if (meta.canRetry && (!errorCode || isUserRetryable(errorCode))) actions.push('retry');
  if (meta.canReject) actions.push('remove');
  return Object.freeze(actions);
}

/**
 * THE batch display order, exported so promotion cannot invent a second one.
 *
 * batchPosition ascending; a record with no position sorts AFTER every positioned
 * one, then by createdAt, then by candidateId. Never by URI or filename, which
 * encode nothing about picker order. The promotion coordinator processes items in
 * exactly this order, so "the third card" and "the third promotion" are the same
 * item — a separate comparator there is precisely how those two drift apart.
 */
export function compareClosetBatchOrder(
  a: { batchPosition?: unknown; createdAt?: unknown; candidateId?: unknown },
  b: { batchPosition?: unknown; createdAt?: unknown; candidateId?: unknown },
): number {
  const pa = typeof a?.batchPosition === 'number' && Number.isFinite(a.batchPosition)
    ? a.batchPosition
    : null;
  const pb = typeof b?.batchPosition === 'number' && Number.isFinite(b.batchPosition)
    ? b.batchPosition
    : null;
  if (pa !== null && pb !== null && pa !== pb) return pa - pb;
  if (pa !== null && pb === null) return -1;
  if (pa === null && pb !== null) return 1;
  const ca = String(a?.createdAt ?? '');
  const cb = String(b?.createdAt ?? '');
  if (ca !== cb) return ca.localeCompare(cb);
  return String(a?.candidateId ?? '').localeCompare(String(b?.candidateId ?? ''));
}

function toIterableSet(ids: Iterable<string> | null | undefined): Set<string> {
  const set = new Set<string>();
  if (!ids) return set;
  for (const id of ids) {
    const normalized = normalizeId(id);
    if (normalized) set.add(normalized);
  }
  return set;
}

// ── Projection ───────────────────────────────────────────────────────────────

/**
 * Group the active actor's candidates into ordered review groups.
 *
 * ORDERING, and why each rule is what it is:
 *
 *   groups — newest first, by the EARLIEST createdAt in the group (a batch was
 *            created when its first candidate landed). Ties break on groupId
 *            descending, so the order is total and never depends on input order.
 *
 *   items  — batchPosition ascending. A record with no position sorts AFTER every
 *            positioned one and then by createdAt, then candidateId — never by
 *            URI or filename, which encode nothing about picker order.
 *
 * `rejected` RECORDS ARE OMITTED; `saved` ONES ARE NOT. A rejected candidate is
 * something the user discarded and does not want to see again. A promoted one is
 * the opposite: it is the visible outcome of the action they just took, it keeps
 * its original batch position so the group does not reflow underneath them, and it
 * survives a restart because the projection reads it from the record rather than
 * from the operation that produced it. It is inert — unselectable, no actions.
 */
export function getClosetBatchReviewProjection(
  input: ClosetBatchReviewProjectionInput,
): ClosetBatchReviewProjection {
  const actorId = normalizeId(input?.actorId);
  const actorEpoch =
    typeof input?.actorEpoch === 'number' && Number.isFinite(input.actorEpoch)
      ? input.actorEpoch
      : null;
  const nowMs = typeof input?.nowMs === 'number' ? input.nowMs : Date.now();
  const selected = toIterableSet(input?.selectedCandidateIds);
  const source = Array.isArray(input?.candidates) ? input.candidates : [];
  const activePromotionId = normalizeId(input?.promotion?.activeCandidateId);
  const pendingPromotionIds = toIterableSet(input?.promotion?.pendingCandidateIds);

  const buckets = new Map<
    string,
    { batchId: string | null; records: Partial<ClosetCandidate>[] }
  >();

  for (const record of source) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
    const candidateId = normalizeId(record.candidateId);
    if (!candidateId) continue;
    // ACTOR SCOPE IS A HARD FILTER, not a styling decision. Two actors' records
    // never share a group, and a foreign record is not merely unselectable here —
    // it is absent.
    if (normalizeId(record.ownerId) !== actorId) continue;
    if (record.status === 'rejected') continue;

    const batchId = normalizeId(record.batchId);
    // A record with no usable batch id becomes its own group keyed on its
    // candidate id. That key is UI identity ONLY and is never written back —
    // persisting a fabricated batch id would invent history the record does not
    // have.
    const groupId = batchId ?? `candidate:${candidateId}`;
    const bucket = buckets.get(groupId);
    if (bucket) bucket.records.push(record);
    else buckets.set(groupId, { batchId, records: [record] });
  }

  const groups: ClosetBatchReviewGroup[] = [];

  for (const [groupId, bucket] of buckets) {
    const ordered = bucket.records.slice().sort(compareClosetBatchOrder);

    let batchCreatedAt: string | null = null;
    let processingCount = 0;
    let readyCount = 0;
    let needsDetailsCount = 0;
    let waitingCount = 0;
    let retryableFailureCount = 0;
    let unresolvableFailureCount = 0;
    let duplicateCount = 0;
    let expiredCount = 0;
    let promotedCount = 0;
    let eligibleCount = 0;
    let selectedEligibleCount = 0;

    const items: ClosetBatchReviewItem[] = ordered.map((record) => {
      const createdAt = text(record.createdAt);
      if (createdAt && (batchCreatedAt === null || createdAt < batchCreatedAt)) {
        batchCreatedAt = createdAt;
      }

      const status = statusUIMetadata(record.status);
      const expired = isExpiredAt(record, nowMs);
      const eligibility = getClosetCandidateReviewEligibility(record, { actorId, nowMs });
      const rawStatus = record.status as ClosetCandidateStatus;
      const candidateId = String(record.candidateId);

      // PROMOTION STATE IS RESOLVED ONCE, HERE, and everything else reads it.
      // The durable answer wins: a record that is already `saved` is promoted no
      // matter what a late progress event or a stale overlay claims, which is what
      // makes a terminal promoted card impossible to reverse.
      const committedClosetItemId = text(record.promotedClosetItemId);
      const promotionState: ClosetBatchPromotionState =
        rawStatus === 'saved'
          ? 'promoted'
          : candidateId === activePromotionId
            ? 'active'
            : pendingPromotionIds.has(candidateId)
              ? 'pending'
              : 'idle';
      const promoted = promotionState === 'promoted';

      if (promoted) promotedCount += 1;
      else if (expired) expiredCount += 1;
      else if (rawStatus === 'duplicate') duplicateCount += 1;
      else if (rawStatus === 'ready_for_review') readyCount += 1;
      else if (rawStatus === 'needs_manual_classification') needsDetailsCount += 1;
      else if (rawStatus === 'waiting_for_network') waitingCount += 1;
      else if (rawStatus === 'failed') {
        if (!record.errorCode || isUserRetryable(record.errorCode)) retryableFailureCount += 1;
        else unresolvableFailureCount += 1;
      } else processingCount += 1;

      // A promoted candidate is not selectable because the predicate already says
      // so (`saved` is terminal). The ACTIVE one is withheld here instead: its
      // record is still `ready_for_review` and genuinely still selectable — it is
      // this operation, not its state, that makes offering a checkbox wrong.
      const selectionEligible = eligibility.selectable && promotionState !== 'active';
      if (selectionEligible) {
        eligibleCount += 1;
        if (selected.has(candidateId)) selectedEligibleCount += 1;
      }

      const displayCategory = text(record.category);
      const displayType = text(record.clothingType);
      const displaySubtype = text(record.subtype);
      const displayColor = text(record.primaryColor);

      return {
        candidateId,
        batchId: normalizeId(record.batchId),
        batchPosition:
          typeof record.batchPosition === 'number' && Number.isFinite(record.batchPosition)
            ? record.batchPosition
            : null,
        thumbnailUri: text(record.candidateThumbnailUri),
        imageUri: text(record.candidateImageUri),
        displayCategory,
        displayType,
        displaySubtype,
        displayColor,
        displayBrand: text(record.brand),
        displaySummary: summarize([displayCategory, displayType, displaySubtype, displayColor]),
        status: rawStatus,
        // A promoted card says where the item IS, even after its draft lifetime
        // has lapsed: "Expired" on something that is sitting in the user's Closet
        // would be simply false.
        statusLabel: promoted
          ? status.progressLabel
          : promotionState === 'active'
            ? CLOSET_PROMOTION_ACTIVE_LABEL
            : promotionState === 'pending'
              ? CLOSET_PROMOTION_PENDING_LABEL
              : expired
                ? CLOSET_BATCH_REVIEW_EXPIRED_LABEL
                : status.progressLabel,
        statusMessage: promoted || promotionState === 'active' || promotionState === 'pending'
          ? null
          : expired
            ? CLOSET_BATCH_REVIEW_EXPIRED_MESSAGE
            : rawStatus === 'duplicate'
              ? CLOSET_BATCH_REVIEW_DUPLICATE_MESSAGE
              // Registry copy only. A raw backend error string is never displayed.
              : record.errorCode
                ? closetCandidateErrorMessage(record.errorCode)
                : null,
        expired,
        selectionEligible,
        selectionBlockedReason: selectionEligible ? null : eligibility.blockedReason,
        availableActions: resolveActions(rawStatus, record.errorCode, expired, promotionState),
        promotionState,
        committedClosetItemId,
      };
    });

    // A single record that carries no picker position is a pre-batch candidate.
    // It is shown as its own review group under neutral copy rather than being
    // merged with unrelated history into an artificial batch.
    const isUnbatchedGroup = items.length === 1 && items[0].batchPosition === null;

    groups.push({
      groupId,
      batchId: bucket.batchId,
      batchCreatedAt,
      isUnbatchedGroup,
      groupLabel: isUnbatchedGroup ? CLOSET_BATCH_REVIEW_UNBATCHED_LABEL : null,
      totalCount: items.length,
      processingCount,
      readyCount,
      needsDetailsCount,
      waitingCount,
      retryableFailureCount,
      unresolvableFailureCount,
      duplicateCount,
      expiredCount,
      promotedCount,
      eligibleCount,
      selectedEligibleCount,
      items: Object.freeze(items),
    });
  }

  groups.sort((a, b) => {
    const ca = a.batchCreatedAt ?? '';
    const cb = b.batchCreatedAt ?? '';
    if (ca !== cb) return cb.localeCompare(ca);
    return b.groupId.localeCompare(a.groupId);
  });

  const requestedActiveId = normalizeId(input?.activeBatchId);
  const activeGroup =
    (requestedActiveId ? groups.find((group) => group.groupId === requestedActiveId) : null) ??
    // Deterministic restart fallback: the newest group. Active-batch navigation
    // state is not persisted, and nothing about candidate durability depends on it.
    groups[0] ??
    null;

  return {
    actorId,
    actorEpoch,
    activeGroupId: activeGroup ? activeGroup.groupId : null,
    groups: Object.freeze(groups),
    activeGroup,
  };
}

// ── Selection reconciliation ─────────────────────────────────────────────────

/**
 * The next selection set: whatever is still eligible in the ACTIVE group.
 *
 * This is the only place selection is filtered, and it filters through the one
 * authoritative predicate by way of the projection's own `selectionEligible`. A
 * stale id — deleted, expired, duplicated, regressed out of review-ready, or now
 * belonging to somebody else — is dropped here rather than lingering invisibly in
 * the set and being counted.
 */
export function reconcileClosetBatchSelection(
  selectedCandidateIds: Iterable<string> | null | undefined,
  projection: ClosetBatchReviewProjection | null | undefined,
): string[] {
  const selected = toIterableSet(selectedCandidateIds);
  if (selected.size === 0) return [];
  const group = projection?.activeGroup;
  if (!group) return [];
  return group.items
    .filter((item) => item.selectionEligible && selected.has(item.candidateId))
    .map((item) => item.candidateId);
}

/** Every eligible id in the active group, in display order. */
export function selectableClosetBatchCandidateIds(
  projection: ClosetBatchReviewProjection | null | undefined,
): string[] {
  const group = projection?.activeGroup;
  if (!group) return [];
  return group.items.filter((item) => item.selectionEligible).map((item) => item.candidateId);
}

// ── Post-intake focus ────────────────────────────────────────────────────────

/**
 * Which batch a completed intake should focus, or null to leave the current one.
 *
 * FOCUS FOLLOWS DURABILITY, not optimism. A batch is focused only when the intake
 * durably created at least one record IN THAT BATCH:
 *
 *   created            — a new record in this batch                    → focus
 *   duplicate_of_closet— a new record in this batch, staged `duplicate`→ focus
 *   deduped_candidate  — resolved to a PRE-EXISTING record that may well belong to
 *                        an older batch                               → no focus
 *   already_in_closet  — nothing was created at all                   → no focus
 *   rejected / capacity— nothing was created at all                   → no focus
 *
 * Classification is irrelevant here: a batch is focusable the moment its records
 * exist, and waiting for identification would leave the user staring at the intake
 * modal's aftermath with no sign their photos landed.
 */
export function resolveClosetBatchFocus(outcome: unknown): string | null {
  if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) return null;
  const result = outcome as {
    batchId?: unknown;
    createdCandidateIds?: unknown;
    sourceOutcomes?: unknown;
  };
  const batchId = normalizeId(result.batchId);
  if (!batchId) return null;

  if (Array.isArray(result.createdCandidateIds) && result.createdCandidateIds.length > 0) {
    return batchId;
  }
  if (Array.isArray(result.sourceOutcomes)) {
    for (const entry of result.sourceOutcomes) {
      if (!entry || typeof entry !== 'object') continue;
      const kind = (entry as { kind?: unknown }).kind;
      const candidateId = normalizeId((entry as { candidateId?: unknown }).candidateId);
      if (kind === 'duplicate_of_closet' && candidateId) return batchId;
    }
  }
  return null;
}

// ── Accessibility ────────────────────────────────────────────────────────────

/**
 * The spoken description of one review row.
 *
 * Built here rather than in the component so it is asserted directly by test, and
 * so taxonomy, status and selection state can never drift apart across platforms.
 * State is always carried by WORDS — never by colour alone.
 */
export function describeClosetBatchReviewItem(
  item: ClosetBatchReviewItem | null | undefined,
  options: { selected?: boolean } = {},
): string {
  if (!item) return 'Item unavailable';
  const parts: string[] = [item.displaySummary ?? 'Unidentified item', item.statusLabel];
  if (item.selectionEligible) {
    parts.push(options.selected === true ? 'selected' : 'not selected');
  }
  return parts.join(', ');
}
