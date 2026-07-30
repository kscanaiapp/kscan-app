/**
 * The one place a private Dressing Room Elise request is made and controlled.
 *
 * NOT A SECOND REQUEST WRAPPER. Transport is `supabase.functions.invoke` with
 * an AbortController and the repository's established 20-second invoke budget
 * (services/scanIdentification.ts, services/textScanEdge.ts), wired exactly the
 * way scanIdentification wires it — including mirroring an already-aborted
 * external signal, which `addEventListener('abort')` would otherwise ignore.
 *
 * WHAT THE COORDINATOR GUARANTEES:
 *   - at most one Elise request is in flight
 *   - a new request cancels and INVALIDATES the previous one before starting
 *   - a late response is compared against the state it was computed for, and
 *     rejected if anything it depended on has moved
 *   - the request-local alias map dies with the request, on every exit path
 *
 * CANCELLATION IS NOT ENOUGH ON ITS OWN and the design does not pretend it is.
 * An abort stops us waiting; it does not stop a response that already left the
 * server. Every applied result therefore passes the generation check AND the
 * lifecycle comparison in privateDressingRoomEliseProjection.ts.
 *
 * A CANCELLED REQUEST IS NOT AN ERROR. It resolves to a `cancelled` outcome that
 * displays nothing, because the user cancelling their own request has not
 * experienced a failure.
 */

import { supabase } from './supabaseClient';
import { createControlledEliseInvoke } from './privateDressingRoomEliseQaProvider';
import {
  evaluateResponseCurrency,
  isStaleCurrency,
  type EliseLifecycleSnapshot,
  type ElisePlannedRequest,
  type EliseStaleReason,
} from './privateDressingRoomEliseProjection';
import {
  isEliseResponseFailure,
  parsePrivateEliseResponse,
  type PrivateEliseIntent,
  type PrivateEliseResponse,
} from '../types/privateDressingRoomElise';

export const ELISE_FUNCTION_NAME = 'style-outfit-generate';

/** Matches services/scanIdentification.ts#INVOKE_TIMEOUT_MS. */
export const ELISE_INVOKE_TIMEOUT_MS = 20_000;

export type EliseInvoke = (
  name: string,
  options: { body: unknown; signal?: AbortSignal },
) => Promise<{ data: unknown; error: unknown }>;

export type EliseTransportOutcome =
  | { kind: 'response'; response: PrivateEliseResponse }
  | { kind: 'cancelled' }
  /**
   * The deployed backend does not recognise this schema version. Distinct from
   * `failed` because it is not retryable and gets its own copy — an old function
   * answers a Phase 4 body with a legacy error that does not validate, and any
   * non-validating reply is treated as capability-unavailable rather than
   * reinterpreted.
   */
  | { kind: 'capability_unavailable' }
  | { kind: 'failed' };

const defaultInvoke: EliseInvoke = (name, options) =>
  supabase.functions.invoke(name, options as { body: unknown }) as Promise<{
    data: unknown;
    error: unknown;
  }>;

/**
 * The provider factory. THE one place a provider is chosen.
 *
 * Production is the default and the fallback. The controlled QA provider can be
 * selected only when its own dual gate holds — `__DEV__` plus an explicit
 * process-local setting — and outside `__DEV__` its factory can only return
 * null, so a release build has nothing to select but `defaultInvoke`. There is
 * deliberately no environment variable here that could route production traffic
 * anywhere: the decision lives with the QA module, which cannot exist in a
 * release bundle.
 */
export function resolveEliseInvoke(): EliseInvoke {
  const controlled = createControlledEliseInvoke();
  return controlled ?? defaultInvoke;
}

/**
 * Sends one planned request and validates the reply against that plan.
 *
 * The response is checked with the SHARED contract validator, bound to this
 * request's id, intent and alias set. A reply that references an alias this
 * request did not mint fails closed here, before any caller sees it.
 */
export async function sendEliseRequest(input: {
  plan: ElisePlannedRequest;
  intent: PrivateEliseIntent;
  signal?: AbortSignal;
  invoke?: EliseInvoke;
  timeoutMs?: number;
}): Promise<EliseTransportOutcome> {
  const invoke = input.invoke ?? resolveEliseInvoke();
  const timeoutMs = input.timeoutMs ?? ELISE_INVOKE_TIMEOUT_MS;

  const controller = new AbortController();
  const external = input.signal;
  const forwardAbort = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', forwardAbort, { once: true });
  }
  // Already cancelled before we started: spend nothing.
  if (controller.signal.aborted) return { kind: 'cancelled' };

  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const { data, error } = await invoke(ELISE_FUNCTION_NAME, {
      body: input.plan.body,
      signal: controller.signal,
    });

    if (external?.aborted) return { kind: 'cancelled' };
    if (timedOut) return { kind: 'failed' };
    if (error) {
      // A backend that predates this schema version rejects the body outright.
      // We cannot tell that apart from a transport failure by the error alone,
      // so the validating check below is what distinguishes them: nothing that
      // fails to validate is ever applied either way.
      return { kind: 'failed' };
    }

    const parsed = parsePrivateEliseResponse(data, {
      requestId: input.plan.requestId,
      intent: input.intent,
      authorizedRefs: [...input.plan.aliases.keys()],
    });
    if (isEliseResponseFailure(parsed)) {
      return parsed.error === 'unsupported_schema_version' || parsed.error === 'not_an_object'
        ? { kind: 'capability_unavailable' }
        : { kind: 'failed' };
    }
    return { kind: 'response', response: parsed.response };
  } catch {
    // Only caller-driven cancellation is silent. The internal timeout abort is
    // a retryable transport failure and must clear loading with bounded copy.
    return external?.aborted ? { kind: 'cancelled' } : { kind: 'failed' };
  } finally {
    clearTimeout(timeoutId);
    if (external) external.removeEventListener('abort', forwardAbort);
  }
}

// ── Coordinator ──────────────────────────────────────────────────────────────

export type EliseActiveRequest = {
  generation: number;
  intent: PrivateEliseIntent;
  requestId: string;
};

export type EliseAcceptance =
  | { accepted: true; response: PrivateEliseResponse; plan: ElisePlannedRequest }
  | { accepted: false; reason: EliseStaleReason | 'unknown_generation' };

/**
 * Owns generations, the abort controller and the alias map.
 *
 * Deliberately a factory rather than a module singleton: two Dressing Room
 * mounts must not be able to see each other's aliases, and module-level mutable
 * state is exactly how that leaks.
 */
export function createEliseRequestCoordinator() {
  let generation = 0;
  let active: EliseActiveRequest | null = null;
  let controller: AbortController | null = null;
  let plans = new Map<number, ElisePlannedRequest>();
  let snapshots = new Map<number, EliseLifecycleSnapshot>();
  let mounted = true;

  /** Drops everything a generation owns. Called on every terminal path. */
  function release(target: number): void {
    plans.delete(target);
    snapshots.delete(target);
    if (active?.generation === target) {
      active = null;
      controller = null;
    }
  }

  return {
    /** Cancels and invalidates any in-flight request. Safe to call repeatedly. */
    cancel(): void {
      if (controller) controller.abort();
      // The generation moves even when nothing was in flight, so a response
      // already on the wire can never match after a cancel.
      generation += 1;
      const previous = active?.generation;
      if (previous !== undefined) release(previous);
      active = null;
      controller = null;
    },

    /**
     * Starts a new request, cancelling the previous one FIRST.
     *
     * Returns the generation and the signal to hand to sendEliseRequest.
     */
    begin(input: {
      plan: ElisePlannedRequest;
      intent: PrivateEliseIntent;
      snapshot: EliseLifecycleSnapshot;
    }): { generation: number; signal: AbortSignal } {
      if (controller) controller.abort();
      // The superseded request's alias map dies HERE, not when its response
      // eventually arrives — being replaced is one of the ways a request ends,
      // and a map that outlives its request is a map that can still be read.
      const previous = active?.generation;
      if (previous !== undefined) release(previous);

      generation += 1;
      const next = generation;
      controller = new AbortController();
      active = { generation: next, intent: input.intent, requestId: input.plan.requestId };
      plans.set(next, input.plan);
      snapshots.set(next, input.snapshot);
      return { generation: next, signal: controller.signal };
    },

    /**
     * May this response mutate application state?
     *
     * Releases the generation either way: an accepted response has been consumed
     * and a rejected one must never be reconsidered, so the alias map goes in
     * both cases.
     */
    accept(input: {
      generation: number;
      response: PrivateEliseResponse;
      now: EliseLifecycleSnapshot;
      compareActiveLook?: boolean;
    }): EliseAcceptance {
      // Generation currency FIRST, so a superseded response reports why it was
      // refused even though its alias map was already released at begin().
      // Generations only ever increase, so one ABOVE the current counter was
      // never issued by this coordinator — that is a foreign generation, not a
      // stale one, and the two deserve different diagnoses.
      if (input.generation > generation) {
        return { accepted: false, reason: 'unknown_generation' };
      }
      if (input.generation !== generation) {
        return { accepted: false, reason: 'superseded' };
      }
      const plan = plans.get(input.generation);
      const atRequest = snapshots.get(input.generation);
      if (!plan || !atRequest) {
        return { accepted: false, reason: 'unknown_generation' };
      }
      const currency = evaluateResponseCurrency({
        requestGeneration: input.generation,
        currentGeneration: generation,
        routeMounted: mounted,
        atRequest,
        now: input.now,
        compareActiveLook: input.compareActiveLook,
      });
      release(input.generation);
      if (isStaleCurrency(currency)) return { accepted: false, reason: currency.reason };
      return { accepted: true, response: input.response, plan };
    },

    /** Route unmount / session discard / flag off. Terminal for this instance. */
    dispose(): void {
      mounted = false;
      if (controller) controller.abort();
      generation += 1;
      active = null;
      controller = null;
      plans = new Map();
      snapshots = new Map();
    },

    isBusy(): boolean {
      return active !== null;
    },

    activeIntent(): PrivateEliseIntent | null {
      return active?.intent ?? null;
    },

    /** Test seam. Never used to read aliases outside an accept(). */
    __generation(): number {
      return generation;
    },
  };
}

export type EliseRequestCoordinator = ReturnType<typeof createEliseRequestCoordinator>;
