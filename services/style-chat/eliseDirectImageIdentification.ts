// Direct-image identification for Elise (Phase 2B.3).
//
// THE FIX THIS MODULE IS: before Phase 2B.3, `addDirectImage` staged a camera or
// gallery photo with `title: 'Photo'` and `category: 'tops'` HARDCODED and never
// called identification at all. Every photo the user attached — a dress, a shoe,
// a handbag — was recorded and described to Elise as a top. That is worse than a
// missing identity: it is a confident wrong one, and the styling advice was built
// on it.
//
// WHAT REPLACES IT: the prepared derivative goes through `identify_for_style` and
// the real canonical identity comes back. The staging title and category are then
// DERIVED from that identity instead of asserted, and when identification cannot
// produce a category the attachment reports an honest failure state rather than
// inventing one.
//
// FLAG OFF: this module is not reached. `addDirectImage` keeps its exact current
// behaviour, hardcoded category included, because that is what "flag-off preserves
// current behaviour" means — the defect is not fixed by the flag being off, it is
// fixed by the flag being on.

import { Platform } from 'react-native';

import {
  compressSanitizedImageForAnalysis,
  PrivacyPrepareError,
} from '../privacyImageUpload';
import {
  prepareFashionEvidence,
  type PreparedFashionEvidenceObject,
} from '../fashionEvidenceGateway';
import type {
  EliseFashionContextSource,
  EliseFashionContextV2,
  FashionIdentificationPlatform,
} from '../../types/fashionIdentificationV2';
import {
  buildEliseFashionContextV2,
  describeIdentification,
  groundableItems,
} from './eliseFashionContextV2';
import {
  identifyPreparedImageForStyle,
  type EliseCandidatePolicy,
  type EliseIdentificationTransport,
  type EliseIdentifyResult,
} from './eliseIdentifyForStyle';
import {
  beginEliseV2Session,
  createEvidenceId,
  type EliseEntryPathKey,
  type EliseV2SessionFlag,
} from './eliseIdentificationV2';
import { itemStateForIdentifyResult } from './eliseSendContext';

/** The contract platform for this build. */
export function currentIdentificationPlatform(): FashionIdentificationPlatform {
  return Platform.OS === 'android' ? 'android' : 'ios';
}

export type DirectImageIdentificationOutcome =
  | {
      kind: 'identified';
      context: EliseFashionContextV2;
      /** Derived from canonical identity — never a hardcoded default. */
      title: string;
      category: string;
      /** `ready` or `partial`. */
      identificationState: 'ready' | 'partial';
    }
  | {
      kind: 'no_evidence';
      /** Honest terminal state for the attachment chip. */
      identificationState: 'insufficient_evidence' | 'non_fashion' | 'technical_failure';
      message: string;
    }
  | { kind: 'needs_selection'; candidateCount: number }
  | { kind: 'cancelled' }
  /**
   * The backend does not implement V2 — the caller runs its unchanged path.
   *
   * When the orchestrator already performed its one permitted legacy retry,
   * that PAID response rides along so the caller can reuse it instead of
   * billing a third identification for the same bytes. Absent when the flag
   * was off and no network call happened at all.
   */
  | { kind: 'legacy_fallback'; legacyResponse?: EliseIdentifyResult['legacyResponse'] };

const INSUFFICIENT_MESSAGE = 'Could not see enough detail in this photo';
const NON_FASHION_MESSAGE = 'No clothing found in this photo';
const TECHNICAL_MESSAGE = 'Could not analyze this photo';

/**
 * One evidence object per prepared image.
 *
 * The evidence id is minted HERE, once, and the same object is reused across
 * detection and selected-item identification inside
 * `identifyPreparedImageForStyle`. A retake or a replaced selection calls this
 * again and therefore gets a new id, which is correct: those are new evidence.
 */
export async function prepareDirectImageEvidence(input: {
  preparedUri: string;
  source: 'camera' | 'photo_library';
  width?: number;
  height?: number;
}): Promise<PreparedFashionEvidenceObject | null> {
  let base64: string;
  try {
    const compressed = await compressSanitizedImageForAnalysis(input.preparedUri);
    base64 = compressed.base64;
  } catch (error) {
    if (error instanceof PrivacyPrepareError) return null;
    return null;
  }
  return prepareFashionEvidence({
    preparedImage: base64,
    source: input.source === 'camera' ? 'camera' : 'gallery',
    evidenceId: createEvidenceId(),
    ...(input.width !== undefined ? { width: input.width } : {}),
    ...(input.height !== undefined ? { height: input.height } : {}),
  });
}

function contextSourceFor(source: 'camera' | 'photo_library'): EliseFashionContextSource {
  return source === 'camera' ? 'direct_camera' : 'direct_gallery';
}

function entryPathFor(source: 'camera' | 'photo_library'): EliseEntryPathKey {
  return source === 'camera' ? 'direct_camera' : 'direct_gallery';
}

/**
 * Turns an orchestrator result into a staging-ready outcome.
 *
 * The title and category come from the canonical identity. When the identity has
 * no category at all the outcome is a FAILURE, not a fallback to a default: a
 * saved record whose category was guessed is a wrong record, and it would then be
 * indistinguishable from a correctly categorized one forever after.
 */
export function outcomeFromIdentifyResult(
  result: EliseIdentifyResult,
  source: 'camera' | 'photo_library',
): DirectImageIdentificationOutcome {
  if (result.state === 'cancelled') return { kind: 'cancelled' };
  if (result.state === 'legacy_fallback') {
    return {
      kind: 'legacy_fallback',
      ...(result.legacyResponse !== undefined ? { legacyResponse: result.legacyResponse } : {}),
    };
  }
  if (result.state === 'needs_selection') {
    return { kind: 'needs_selection', candidateCount: result.candidates.length };
  }

  const itemState = itemStateForIdentifyResult(result.state);
  if (itemState === 'insufficient_evidence') {
    return { kind: 'no_evidence', identificationState: itemState, message: INSUFFICIENT_MESSAGE };
  }
  if (itemState === 'non_fashion') {
    return { kind: 'no_evidence', identificationState: itemState, message: NON_FASHION_MESSAGE };
  }
  if (itemState !== 'ready' && itemState !== 'partial') {
    return {
      kind: 'no_evidence',
      identificationState: 'technical_failure',
      message: TECHNICAL_MESSAGE,
    };
  }

  const identification = result.identifications[0];
  if (!identification) {
    return {
      kind: 'no_evidence',
      identificationState: 'technical_failure',
      message: TECHNICAL_MESSAGE,
    };
  }

  const category = typeof identification.item?.category === 'string'
    ? identification.item.category.trim()
    : '';
  const subtype = typeof identification.item?.subtype === 'string'
    ? identification.item.subtype.trim()
    : '';
  if (!category && !subtype) {
    // Nothing to file this under. Guessing would write a wrong saved record.
    return {
      kind: 'no_evidence',
      identificationState: 'insufficient_evidence',
      message: INSUFFICIENT_MESSAGE,
    };
  }

  const context = buildEliseFashionContextV2({
    source: contextSourceFor(source),
    items: [{ sourceIndex: 0, state: itemState, identification }],
  });
  if (!context) {
    return {
      kind: 'no_evidence',
      identificationState: 'technical_failure',
      message: TECHNICAL_MESSAGE,
    };
  }

  // Described from the PROJECTION the context actually carries, not from the raw
  // canonical result — so the chip label and what Elise is told cannot diverge.
  const described = describeIdentification(groundableItems(context)[0]?.identification);
  return {
    kind: 'identified',
    context,
    // Title precedence: the full null-safe description, then subtype, then
    // category. Every branch is a real observed value.
    title: (described || subtype || category).slice(0, 80),
    category: (category || subtype).slice(0, 80),
    identificationState: itemState,
  };
}

/**
 * Identify one prepared direct-attachment image for styling.
 *
 * `policy` is `item` for the direct composer paths: they analyze ONE garment, so
 * several detected candidates require an explicit user choice rather than a
 * silent pick.
 */
export async function identifyDirectImageForStyle(input: {
  preparedUri: string;
  source: 'camera' | 'photo_library';
  width?: number;
  height?: number;
  requestId: string;
  sessionFlag?: EliseV2SessionFlag;
  policy?: EliseCandidatePolicy;
  signal?: AbortSignal;
  transport?: EliseIdentificationTransport;
  isCurrent?: () => boolean;
}): Promise<DirectImageIdentificationOutcome> {
  const sessionFlag = input.sessionFlag ?? beginEliseV2Session();
  if (!sessionFlag.enabled) return { kind: 'legacy_fallback' };

  const evidence = await prepareDirectImageEvidence({
    preparedUri: input.preparedUri,
    source: input.source,
    ...(input.width !== undefined ? { width: input.width } : {}),
    ...(input.height !== undefined ? { height: input.height } : {}),
  });
  if (!evidence) {
    return {
      kind: 'no_evidence',
      identificationState: 'technical_failure',
      message: TECHNICAL_MESSAGE,
    };
  }

  const result = await identifyPreparedImageForStyle({
    evidence,
    entryPath: entryPathFor(input.source),
    platform: currentIdentificationPlatform(),
    requestId: input.requestId,
    sessionFlag,
    policy: input.policy ?? 'item',
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.transport ? { transport: input.transport } : {}),
    ...(input.isCurrent ? { isCurrent: input.isCurrent } : {}),
  });

  return outcomeFromIdentifyResult(result, input.source);
}
