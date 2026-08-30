/**
 * VTO request lifecycle.
 *
 * Module-scoped rather than React state, for the same reason
 * services/kplus/kplusEntitlementStore.ts is: a late `finally` handler has to
 * be rejectable after the component that started it has unmounted, and the
 * actor-boundary reset has to run without a React tree.
 *
 * THE STALE RESULT RULE. A completed provider promise does not automatically
 * retain application authority. A result may only be applied when BOTH of
 * these still hold:
 *   - its generation token is still the newest one this store issued, and
 *   - the actor context it captured is still current (services/actorContext).
 * Otherwise it is dropped: it cannot update a new screen, attach to another
 * actor, overwrite a newer request, persist anything, or trigger anything
 * downstream. The request may well finish at the provider -- it just has no
 * say here any more.
 *
 * The actor-epoch half matters specifically because person imagery is
 * involved: a user id alone is not enough (sign out and back in as the same
 * user and the id still matches), which is exactly the case advanceActorEpoch
 * exists to reject.
 */

import { createActorRequest, isActorRequestCurrent } from '../actorContext';
import type {
  VtoFailure,
  VtoGarmentInput,
  VtoGenerationResult,
  VtoGenerationStatus,
  VtoOrigin,
  VtoPersonInput,
} from '../../types/vto';
import { requestVtoGeneration, type VtoGenerateOutcome } from './vtoClient';
import { toCanonicalVtoCategory } from './vtoEligibility';
import { toVtoFailure } from './vtoFailures';
import { buildVtoPersonPayload, releaseVtoPersonInput } from './vtoPersonInput';
import { dimensionBucket, emitVtoEvent } from './vtoTelemetry';

type Listener = () => void;

export interface VtoSnapshot {
  status: VtoGenerationStatus;
  /** Token of the generation this snapshot describes, or null when idle. */
  requestId: string | null;
  origin: VtoOrigin | null;
  person: VtoPersonInput | null;
  garment: VtoGarmentInput | null;
  result: VtoGenerationResult | null;
  failure: VtoFailure | null;
  retryCount: number;
}

export const IDLE_VTO_SNAPSHOT: VtoSnapshot = Object.freeze({
  status: 'idle' as VtoGenerationStatus,
  requestId: null,
  origin: null,
  person: null,
  garment: null,
  result: null,
  failure: null,
  retryCount: 0,
});

let snapshot: VtoSnapshot = IDLE_VTO_SNAPSHOT;
const listeners = new Set<Listener>();

/** Monotonic generation token. Incremented by every start, cancel, reset and
 *  actor transition, so anything issued before the bump is already stale. */
let generation = 0;
let activeController: AbortController | null = null;
/** Cache derivatives owned by the operation currently in the store. Released
 *  whenever the store moves off them, so no person image outlives its use. */
let ownedUris: string[] = [];

function emit(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // A listener must never corrupt the store.
    }
  }
}

function setSnapshot(next: VtoSnapshot): void {
  snapshot = next;
  emit();
}

export function getVtoSnapshot(): VtoSnapshot {
  return snapshot;
}

export function subscribeToVto(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Invalidates every in-flight generation and aborts the live request. */
function invalidate(): number {
  generation += 1;
  if (activeController) {
    activeController.abort();
    activeController = null;
  }
  return generation;
}

function releaseOwnedMedia(): void {
  const uris = ownedUris;
  ownedUris = [];
  if (uris.length > 0) void releaseVtoPersonInput(...uris);
}

/**
 * Clears all VTO state and deletes the person-image derivatives this
 * operation created.
 *
 * Called synchronously (before any await) from
 * resetActorScopedRuntimeState on sign-out and on every detected actor
 * boundary crossing. A person photo, and any visualization made from it,
 * must never survive into the next actor on this device.
 */
export function resetVtoRequestState(): void {
  invalidate();
  releaseOwnedMedia();
  setSnapshot(IDLE_VTO_SNAPSHOT);
}

/** Records an explicitly chosen person image, replacing (and deleting) any
 *  previous one. Selection alone starts nothing. */
export function setVtoPersonInput(person: VtoPersonInput, garment: VtoGarmentInput, origin: VtoOrigin): void {
  invalidate();
  const previous = ownedUris;
  ownedUris = [person.sanitizedUri];
  if (previous.length > 0) void releaseVtoPersonInput(...previous);
  emitVtoEvent('vto_person_selected', {
    origin,
    inputBucket: dimensionBucket(person.width, person.height),
  });
  setSnapshot({
    ...IDLE_VTO_SNAPSHOT,
    status: 'ready',
    origin,
    person,
    garment,
  });
}

export function cancelVtoGeneration(): void {
  const current = snapshot;
  invalidate();
  if (current.status === 'preparing' || current.status === 'generating' || current.status === 'validating_result') {
    emitVtoEvent('vto_request_cancelled', { origin: current.origin ?? undefined });
    setSnapshot({ ...current, status: 'cancelled', failure: null, result: null });
  }
}

/**
 * Closes the VTO sheet WITHOUT ending the session: any in-flight generation
 * is torn down (aborted, its result loses authority under the stale-result
 * rule same as always), but the chosen person photo and its cache files
 * survive. Reopening the sheet -- for the same product or a different one --
 * finds the photo still there instead of asking the user to pick it again.
 *
 * This is the correct handler for "the sheet closed": a navigation away, the
 * unmount that follows `sheetVisible={false}`, or the user tapping Close.
 * None of those are "I am done with this session" -- only an actor
 * transition or the explicit {@link resetVtoRequestState} clear are.
 */
export function leaveVtoSurface(): void {
  const current = snapshot;
  const wasBusy =
    current.status === 'preparing' || current.status === 'generating' || current.status === 'validating_result';
  invalidate();
  if (!wasBusy) return; // idle/ready/success/failed/cancelled are left exactly as they are.
  emitVtoEvent('vto_request_cancelled', { origin: current.origin ?? undefined });
  setSnapshot({
    ...current,
    status: current.person ? 'ready' : 'idle',
    result: null,
    failure: null,
  });
}

/**
 * Reuses the session's existing person photo for a NEW garment context (a
 * different product's Try It On), without re-selecting or re-sanitizing
 * anything. Returns 'no_session' when there is no photo to reuse -- the
 * caller falls back to the ordinary guidance/selection flow in that case.
 *
 * Any result/failure left over from a PREVIOUS garment is dropped here: a
 * generation made for product A must never render as if it belonged to
 * product B just because the sheet reused the same photo.
 */
export function attachSessionPerson(
  garment: VtoGarmentInput,
  origin: VtoOrigin,
): 'attached' | 'no_session' {
  const current = snapshot;
  if (!current.person) return 'no_session';
  invalidate();
  setSnapshot({
    ...IDLE_VTO_SNAPSHOT,
    status: 'ready',
    origin,
    person: current.person,
    garment,
  });
  return 'attached';
}

export interface StartVtoOptions {
  garment: VtoGarmentInput;
  origin: VtoOrigin;
  devScenario?: string;
  /** Injected in tests. */
  generate?: typeof requestVtoGeneration;
  buildPayload?: typeof buildVtoPersonPayload;
}

/**
 * Runs one generation.
 *
 * Duplicate-tap safety is structural, not a debounce: a second call
 * increments the token and aborts the first, so two taps can never leave two
 * live generations racing to write the same state. The older one loses
 * authority the instant the newer one starts.
 */
export async function startVtoGeneration(options: StartVtoOptions): Promise<void> {
  const current = snapshot;
  const person = current.person;
  if (!person) {
    setSnapshot({
      ...current,
      status: 'failed',
      failure: toVtoFailure('invalid_person_input'),
    });
    return;
  }

  const supersededInFlight =
    current.status === 'preparing' || current.status === 'generating' || current.status === 'validating_result';

  const token = invalidate();
  const actorRequest = createActorRequest();
  const controller = new AbortController();
  activeController = controller;
  const requestId = `vtoreq_${token}_${actorRequest.requestId}`;

  if (supersededInFlight) {
    emitVtoEvent('vto_request_superseded', { origin: options.origin });
  }

  const isCurrent = () => token === generation && isActorRequestCurrent(actorRequest);
  const generate = options.generate ?? requestVtoGeneration;
  const buildPayload = options.buildPayload ?? buildVtoPersonPayload;

  setSnapshot({
    ...current,
    status: 'preparing',
    requestId,
    origin: options.origin,
    garment: options.garment,
    result: null,
    failure: null,
  });

  emitVtoEvent('vto_request_start', {
    origin: options.origin,
    // The CANONICAL token, never the raw category text: a retailer's free-form
    // string is content, and the allowlist would drop it anyway.
    category: toCanonicalVtoCategory(options.garment.category),
    retryCount: current.retryCount,
    inputBucket: dimensionBucket(person.width, person.height),
  });

  const payload = await buildPayload(person);
  if (!isCurrent()) {
    if (payload.ok) void releaseVtoPersonInput(payload.transientUri);
    return;
  }
  if (!payload.ok) {
    applyFailure(token, actorRequest, requestId, options.origin, 'invalid_person_input');
    return;
  }
  // The compressed derivative is a second cache file; the store owns it too
  // so it cannot outlive the operation.
  ownedUris = [...new Set([...ownedUris, payload.transientUri])];

  setSnapshot({ ...getVtoSnapshot(), status: 'generating' });

  const outcome: VtoGenerateOutcome | null = await generate({
    requestId,
    origin: options.origin,
    garment: options.garment,
    personDataUri: payload.dataUri,
    signal: controller.signal,
    devScenario: options.devScenario,
  }).catch(() => null);

  // THE STALE RESULT RULE, enforced at the single point a result could land.
  if (!isCurrent()) return;

  if (!outcome) {
    applyFailure(token, actorRequest, requestId, options.origin, 'unknown');
    return;
  }

  // `=== false` rather than `!outcome.ok`: this project's tsconfig does not
  // enable strictNullChecks, and the explicit comparison is what narrows a
  // discriminated union under it (the same idiom kplusClient/kplusEntitlementStore use).
  if (outcome.ok === false) {
    applyFailure(token, actorRequest, requestId, options.origin, outcome.code);
    return;
  }

  setSnapshot({ ...getVtoSnapshot(), status: 'validating_result' });
  if (!isCurrent()) return;

  const result: VtoGenerationResult = {
    requestId,
    provider: outcome.provider,
    dataUri: outcome.dataUri,
    mediaType: outcome.mediaType,
    width: outcome.width,
    height: outcome.height,
    isAiVisualization: true,
    latencyMs: outcome.latencyMs,
  };

  emitVtoEvent('vto_request_success', {
    origin: options.origin,
    provider: outcome.provider,
    latencyMs: outcome.latencyMs,
    outputBucket: dimensionBucket(outcome.width, outcome.height),
    retryCount: getVtoSnapshot().retryCount,
  });

  activeController = null;
  setSnapshot({ ...getVtoSnapshot(), status: 'success', result, failure: null });
}

function applyFailure(
  token: number,
  actorRequest: ReturnType<typeof createActorRequest>,
  requestId: string,
  origin: VtoOrigin,
  code: string,
): void {
  if (token !== generation || !isActorRequestCurrent(actorRequest)) return;
  const failure = toVtoFailure(code);
  activeController = null;
  if (failure.code === 'cancelled') {
    emitVtoEvent('vto_request_cancelled', { origin });
    setSnapshot({ ...getVtoSnapshot(), status: 'cancelled', requestId, result: null, failure: null });
    return;
  }
  emitVtoEvent('vto_request_failure', { origin, failureCode: failure.code });
  setSnapshot({ ...getVtoSnapshot(), status: 'failed', requestId, result: null, failure });
}

/** A deliberate second attempt. Retry is never automatic: a generation costs
 *  real money and sends the user's photo again, so it happens only because a
 *  person asked for it. */
export async function retryVtoGeneration(options: StartVtoOptions): Promise<void> {
  const current = getVtoSnapshot();
  emitVtoEvent('vto_retry', { origin: options.origin, retryCount: current.retryCount + 1 });
  setSnapshot({ ...current, retryCount: current.retryCount + 1 });
  await startVtoGeneration(options);
}

export const __vtoStoreInternals = {
  getGeneration: () => generation,
  hasActiveController: () => activeController !== null,
  getOwnedUris: () => [...ownedUris],
};
