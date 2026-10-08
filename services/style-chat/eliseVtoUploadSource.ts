// Elise contextual Virtual Try-On — the bridge to the device-local garment.
//
// The pure policy lives in eliseVtoOffer.ts and the opaque-id store in
// eliseVtoOfferBindings.ts. This module is where those two meet the existing
// authorities, and it adds none of its own:
//
//   which garment is which     the send snapshot + eliseVtoOffer's policy
//   what the garment is        the canonical identity already on the draft
//   whether VTO can show it    services/vto/vtoEligibility + the remote row
//   the garment itself         the Closet candidate store (actor-scoped, 7-day)
//   entitlement, consent,
//   quota, provider, result    untouched: decided later, by their own owners
//
// TWO MOMENTS.
//
//   AFTER ELISE REPLIES   prepareEliseVtoOffer decides whether ONE garment of
//                         that send may carry an offer, and if so records a
//                         device-local binding and returns the block to append.
//                         Offerability is about the GARMENT. It never asks
//                         whether the customer has K+: a Free customer sees the
//                         offer too, and it is their way into K+.
//
//   ON EVERY TAP          resolveEliseVtoOfferLaunch re-reads the binding under
//                         the current account and re-checks the candidate
//                         against the fingerprint the offer was created for.
//                         Any difference means the offer is stale. It is never
//                         reinterpreted, re-identified or swapped for another
//                         garment.
//
// Reading the garment's bytes is a third, separate moment: it happens only
// inside an explicit generation, through the loader handed to the VTO store.
// Showing an offer, tapping it, meeting the K+ gate, cancelling the photo
// picker or declining consent reads no image and sends nothing.

import * as Crypto from 'expo-crypto';
// /legacy, like every Closet media module: the async file contract the
// candidate store itself reads through.
import * as FileSystem from 'expo-file-system/legacy';

import { VTO_UI_ENABLED } from '../../constants/featureFlags';
import { CLOSET_CANDIDATE_CONTENT_HASH_VERSION, type ClosetCandidate } from '../../types/closetCandidate';
import {
  VTO_GARMENT_CONTENT_HASH_VERSION,
  VTO_GARMENT_PAYLOAD_MAX_CHARS,
  VTO_USER_SUPPLIED_GARMENT_SOURCE_TYPE,
  type VtoGarmentInput,
  type VtoInlineGarmentLoader,
  type VtoInlineGarmentPayload,
} from '../../types/vto';
import { createActorRequest } from '../actorContext';
import { captureActorScope, isActorScopeCurrent } from '../actorScope';
import { getClosetCandidate } from '../closetCandidateLibrary';
import { evaluateVtoEligibility, toCanonicalVtoCategory } from '../vto/vtoEligibility';
import { getVtoRemoteConfig } from '../vto/vtoFeatureControl';
import { validateEliseFashionContextV2 } from './eliseFashionContextV2';
import {
  buildEliseVtoOfferBlock,
  correlateEliseDirectImageGarments,
  ELISE_VTO_OFFER_COPY,
  selectEliseVtoOfferGarment,
  type EliseVtoContextItem,
  type EliseVtoOfferBlock,
  type EliseVtoSnapshotDraft,
} from './eliseVtoOffer';
import {
  createEliseVtoOfferBinding,
  eliseVtoFingerprintKey,
  findEliseVtoOfferBinding,
  resolveEliseVtoOfferBinding,
  type EliseVtoOfferBinding,
  type EliseVtoOfferFingerprint,
} from './eliseVtoOfferBindings';

const INLINE_GARMENT_PREFIX = 'data:image/jpeg;base64,';
const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/;

/** Why an offer cannot launch. Bounded, content-free, safe for telemetry. */
export type EliseVtoUnavailableReason =
  | 'binding_missing'
  | 'candidate_missing'
  | 'fingerprint_changed'
  | 'media_missing'
  | 'account_changed';

/**
 * The fingerprint of a candidate AS IT IS NOW, or null when it cannot have one.
 *
 * Four things pin the interpretation: which candidate, which bytes, which
 * category the existing VTO canonicalizer assigns it, and which classification
 * produced that category. The hash is an integrity and correlation signal. It
 * is not evidence that anyone owns the garment.
 */
export function fingerprintEliseUploadCandidate(
  candidate: ClosetCandidate | null | undefined,
): EliseVtoOfferFingerprint | null {
  if (!candidate || typeof candidate.candidateId !== 'string' || !candidate.candidateId) return null;
  const contentHash = typeof candidate.contentHash === 'string' ? candidate.contentHash : '';
  if (!CONTENT_HASH_PATTERN.test(contentHash)) return null;
  // The one scheme the server recomputes. Any other is not comparable.
  if (
    candidate.contentHashVersion !== CLOSET_CANDIDATE_CONTENT_HASH_VERSION
    || candidate.contentHashVersion !== VTO_GARMENT_CONTENT_HASH_VERSION
  ) {
    return null;
  }
  const classificationVersion =
    typeof candidate.classificationVersion === 'string' ? candidate.classificationVersion.trim() : '';
  if (!classificationVersion) return null;
  const canonicalCategory = toCanonicalVtoCategory(candidate.category);
  if (!canonicalCategory) return null;
  return {
    candidateId: candidate.candidateId,
    contentHash,
    contentHashVersion: candidate.contentHashVersion,
    canonicalCategory,
    classificationVersion,
  };
}

/** The candidate, read through the existing actor-scoped, expiry-enforcing
 *  authority. A missing, expired or foreign candidate is simply not returned. */
async function loadCurrentCandidate(candidateId: string): Promise<ClosetCandidate | null> {
  try {
    const loaded = await getClosetCandidate(createActorRequest(), candidateId);
    return loaded && loaded.ok === true && loaded.candidate ? (loaded.candidate as ClosetCandidate) : null;
  } catch {
    return null;
  }
}

async function candidateMediaExists(candidate: ClosetCandidate): Promise<boolean> {
  const uri = candidate.candidateImageUri;
  if (typeof uri !== 'string' || !uri) return false;
  try {
    const info = await FileSystem.getInfoAsync(uri);
    return info?.exists === true;
  } catch {
    return false;
  }
}

/** Encoded length of the inline payload for `byteLength` bytes, prefix included. */
function encodedGarmentChars(byteLength: number): number {
  return INLINE_GARMENT_PREFIX.length + Math.ceil(byteLength / 3) * 4;
}

function validatedItems(draft: EliseVtoSnapshotDraft): readonly EliseVtoContextItem[] | null {
  if (draft.fashionContext == null) return null;
  const validated = validateEliseFashionContextV2(draft.fashionContext);
  return validated.kind === 'ok' ? (validated.context.items as EliseVtoContextItem[]) : null;
}

export interface PrepareEliseVtoOfferInput {
  sessionId: string;
  /** The immutable send snapshot's drafts, in the order they were sent. */
  drafts: readonly EliseVtoSnapshotDraft[];
  /** The merged fashion context that actually went to Elise for this turn. */
  sentContext: unknown;
  focusedDraftId?: string | null;
  /** True only when the customer chose the focused draft themselves. */
  focusExplicit?: boolean;
}

/**
 * Decides whether this turn's reply may carry a contextual Try It On offer.
 *
 * Returns the block to append, or null. Null is the answer whenever anything is
 * missing, ambiguous or unreadable — there is no partial offer and no guess:
 *
 *   - nobody is signed in, or this build does not carry VTO;
 *   - the remote VTO control is off or could not be read;
 *   - no direct image correlates to exactly one sent, groundable context item;
 *   - none is a category the existing VTO eligibility authority accepts;
 *   - several are, and the customer did not explicitly focus one of them;
 *   - the candidate is gone, expired, unhashed, unclassified or has no media;
 *   - the candidate's category no longer agrees with what Elise was told;
 *   - the image is too large to travel inside the garment payload bound;
 *   - this conversation already has an offer for this exact fingerprint;
 *   - the device-local binding could not be saved.
 *
 * K+ is deliberately NOT consulted. Nothing is read from the image and nothing
 * is sent anywhere: this only inspects records already on the device.
 */
export async function prepareEliseVtoOffer(
  input: PrepareEliseVtoOfferInput,
): Promise<EliseVtoOfferBlock | null> {
  try {
    if (!VTO_UI_ENABLED || !input.sessionId) return null;
    const scope = captureActorScope();
    if (!scope.actorId) return null;

    const sent = validateEliseFashionContextV2(input.sentContext);
    if (sent.kind !== 'ok') return null;

    // The existing feature control. An unreadable row reads as disabled.
    const config = await getVtoRemoteConfig();
    if (!isActorScopeCurrent(scope) || !config || config.enabled !== true) return null;

    // "Would the existing eligibility authority accept this, entitlement aside?"
    // Asked of that authority itself, so the offer can never drift from the rule
    // the control and the server enforce.
    const isOfferableCategory = (category: string): boolean =>
      evaluateVtoEligibility({
        category,
        imageUrl: null,
        productRef: VTO_USER_SUPPLIED_GARMENT_SOURCE_TYPE,
        inlineMediaReady: true,
        featureEnabled: config.enabled,
        hasEntitlement: true,
        supportedCategories: config.supportedCategories,
      }).eligible === true;

    const garments = correlateEliseDirectImageGarments({
      drafts: input.drafts,
      sentItems: sent.context.items as EliseVtoContextItem[],
      itemsOf: validatedItems,
      isOfferableCategory,
    });
    const selection = selectEliseVtoOfferGarment({
      garments,
      focusedDraftId: input.focusedDraftId ?? null,
      focusExplicit: input.focusExplicit === true,
    });
    if (selection.kind !== 'offer') return null;

    const candidate = await loadCurrentCandidate(selection.garment.candidateId);
    if (!isActorScopeCurrent(scope) || !candidate) return null;
    const fingerprint = fingerprintEliseUploadCandidate(candidate);
    if (!fingerprint) return null;
    // The candidate must still be the garment Elise was told about. If the two
    // disagree, there is no single interpretation to offer.
    if (fingerprint.canonicalCategory !== toCanonicalVtoCategory(selection.garment.category)) return null;
    if (!isOfferableCategory(fingerprint.canonicalCategory)) return null;
    if (
      typeof candidate.normalizedByteLength === 'number'
      && encodedGarmentChars(candidate.normalizedByteLength) > VTO_GARMENT_PAYLOAD_MAX_CHARS
    ) {
      return null;
    }
    if (!(await candidateMediaExists(candidate)) || !isActorScopeCurrent(scope)) return null;

    // At most one automatic offer per garment fingerprint per conversation.
    const existing = await findEliseVtoOfferBinding({ sessionId: input.sessionId, fingerprint });
    if (existing || !isActorScopeCurrent(scope)) return null;

    const binding = await createEliseVtoOfferBinding({
      sessionId: input.sessionId,
      fingerprint,
      expiresAt: candidate.expiresAt,
    });
    if (!binding || !isActorScopeCurrent(scope)) return null;
    return buildEliseVtoOfferBlock(binding.localBindingId);
  } catch {
    // An offer is optional. Failing to make one must never cost the reply.
    return null;
  }
}

type VerifiedBinding =
  | { ok: true; binding: EliseVtoOfferBinding; candidate: ClosetCandidate }
  | { ok: false; reason: EliseVtoUnavailableReason };

/**
 * The revalidation every tap, and every generation, goes through.
 *
 * The binding is read under the CURRENT account, the candidate is reloaded
 * through the candidate authority, and the candidate's present fingerprint must
 * equal the stored one field for field. A candidate that was reclassified from
 * one supported category to another is still a different interpretation, and
 * the old offer does not follow it.
 */
async function verifyEliseVtoOfferBinding(localBindingId: unknown): Promise<VerifiedBinding> {
  const scope = captureActorScope();
  if (!scope.actorId) return { ok: false, reason: 'account_changed' };

  const binding = await resolveEliseVtoOfferBinding(localBindingId);
  if (!isActorScopeCurrent(scope)) return { ok: false, reason: 'account_changed' };
  if (!binding) return { ok: false, reason: 'binding_missing' };

  const candidate = await loadCurrentCandidate(binding.candidateId);
  if (!isActorScopeCurrent(scope)) return { ok: false, reason: 'account_changed' };
  if (!candidate) return { ok: false, reason: 'candidate_missing' };

  const current = fingerprintEliseUploadCandidate(candidate);
  if (!current || eliseVtoFingerprintKey(current) !== eliseVtoFingerprintKey(binding)) {
    return { ok: false, reason: 'fingerprint_changed' };
  }
  if (!(await candidateMediaExists(candidate))) return { ok: false, reason: 'media_missing' };
  if (!isActorScopeCurrent(scope)) return { ok: false, reason: 'account_changed' };
  return { ok: true, binding, candidate };
}

/**
 * What a rendered offer needs to know before anyone taps it: whether the id on
 * the message resolves to a binding for the current account on this device,
 * and which canonical category it was created for.
 *
 * Storage only. It reads no candidate and no image, and it is not the
 * revalidation -- that happens on every tap, in resolveEliseVtoOfferLaunch.
 * Null means "not here": another device, another account, a reinstall, or a
 * candidate past its lifetime.
 */
export async function peekEliseVtoOffer(
  localBindingId: unknown,
): Promise<{ canonicalCategory: string } | null> {
  try {
    const binding = await resolveEliseVtoOfferBinding(localBindingId);
    return binding ? { canonicalCategory: binding.canonicalCategory } : null;
  } catch {
    return null;
  }
}

export type EliseVtoOfferLaunch =
  | {
      ok: true;
      garment: VtoGarmentInput;
      garmentTitle: string;
      /** Reads the garment's bytes inside an explicit generation, and only then. */
      loadInlineGarment: VtoInlineGarmentLoader;
    }
  | { ok: false; reason: EliseVtoUnavailableReason };

/**
 * Resolves a tapped offer into something the shared VTO launcher can open.
 *
 * Nothing here reads the image, starts a request, or looks at K+. The result
 * says only "this is still the garment the offer was created for"; whether the
 * customer may try it on is the shared eligibility hook's and the K+ reader's
 * answer, taken afterwards and re-taken by the server.
 */
export async function resolveEliseVtoOfferLaunch(localBindingId: unknown): Promise<EliseVtoOfferLaunch> {
  let verified: VerifiedBinding;
  try {
    verified = await verifyEliseVtoOfferBinding(localBindingId);
  } catch {
    return { ok: false, reason: 'candidate_missing' };
  }
  if (verified.ok === false) return { ok: false, reason: verified.reason };
  const { binding, candidate } = verified;

  const title = typeof candidate.title === 'string' ? candidate.title.trim() : '';
  const garment: VtoGarmentInput = {
    source: {
      type: VTO_USER_SUPPLIED_GARMENT_SOURCE_TYPE,
      contentHash: binding.contentHash,
      contentHashVersion: VTO_GARMENT_CONTENT_HASH_VERSION,
    },
    inlineMediaReady: true,
    // Client-side identity for the result guard and for anything the customer
    // chooses to save. Built from the OPAQUE binding id on purpose: a Dressing
    // Room save persists this value, and it must not carry the candidate id or
    // the content hash off the device.
    productRef: `${VTO_USER_SUPPLIED_GARMENT_SOURCE_TYPE}:${binding.localBindingId}`,
    // Display only, and local. The transport never sends this.
    imageUrl: candidate.candidateThumbnailUri ?? candidate.candidateImageUri ?? '',
    category: binding.canonicalCategory,
    brand: null,
    commerceSource: null,
  };

  const loadInlineGarment: VtoInlineGarmentLoader = () =>
    loadEliseUploadGarmentPayload(binding.localBindingId, binding.contentHash);

  return {
    ok: true,
    garment,
    garmentTitle: title || ELISE_VTO_OFFER_COPY.garmentTitleFallback,
    loadInlineGarment,
  };
}

/**
 * Reads the candidate-owned normalized JPEG for one explicit generation.
 *
 * The binding and the candidate are verified AGAIN here, because time has
 * passed since the tap: a photo was chosen and consent was asked. Then the
 * bytes are read once, their hash is recomputed on the device, and they are
 * returned only if that hash is still the fingerprint's. The server recomputes
 * it once more from what it receives.
 *
 * The returned data URI is handed straight to the transport by the VTO store.
 * It is never written anywhere, never logged, and never kept after the call.
 */
export async function loadEliseUploadGarmentPayload(
  localBindingId: string,
  expectedContentHash: string,
): Promise<VtoInlineGarmentPayload> {
  try {
    const scope = captureActorScope();
    const verified = await verifyEliseVtoOfferBinding(localBindingId);
    if (verified.ok === false || verified.binding.contentHash !== expectedContentHash) return { ok: false };

    const uri = verified.candidate.candidateImageUri;
    if (typeof uri !== 'string' || !uri) return { ok: false };
    const base64 = await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType?.Base64 ?? 'base64',
    });
    if (!isActorScopeCurrent(scope)) return { ok: false };
    if (typeof base64 !== 'string' || !base64) return { ok: false };
    if (INLINE_GARMENT_PREFIX.length + base64.length > VTO_GARMENT_PAYLOAD_MAX_CHARS) return { ok: false };

    // Hashed exactly as the candidate store hashed it: SHA-256 over the Base64
    // text of the normalized file.
    const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, base64);
    if (!isActorScopeCurrent(scope)) return { ok: false };
    if (typeof digest !== 'string' || digest.trim().toLowerCase() !== expectedContentHash) return { ok: false };

    return { ok: true, dataUri: `${INLINE_GARMENT_PREFIX}${base64}` };
  } catch {
    return { ok: false };
  }
}
