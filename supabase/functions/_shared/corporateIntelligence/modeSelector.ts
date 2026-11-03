/**
 * Corporate Intelligence v2 -- deterministic task / communication-mode selection (CI-02).
 *
 * PURE and TRANSPORT-INDEPENDENT: no I/O, no clock, no randomness, no model call. The result is a function of
 * TRUSTED SERVER STATE ONLY: the route the request originated from, a server-resolved advice intent, the discovery
 * engine's status, and a server-attached error class. It never reads customer text, customer tone or any mode a
 * model asks for -- those inputs do not exist on the type, and extra keys on a runtime object are ignored.
 *
 * NOT WIRED into any Edge Function (enforced by boundaries.test.ts).
 */
import { TASK_VERB_POLICY, type CommunicationMode, type PresentationRegister, type Surface, type TaskVerb } from './contracts.ts';

export type TrustedRoute = 'stylechat' | 'scan_result' | 'discovery' | 'privacy_center' | 'unknown';

export interface TrustedTaskState {
  /** Server route/surface that originated the request. Never derived from model or customer text. */
  route: TrustedRoute;
  /** Server-resolved advice intent (e.g. compatibility / wardrobe-gap), not a model label. */
  adviceIntentResolved?: 'analysis' | 'none';
  discoveryStatus?: 'ready' | 'empty' | 'unavailable';
  /** Stable server error class attached to the request; absent means no grounded recovery state. */
  groundedErrorClass?: string;
}

/** Only these server error classes may put a request into service recovery. A customer saying "it's broken" is not one. */
export const GROUNDED_ERROR_CLASSES: ReadonlySet<string> = new Set([
  'RATE_LIMIT',
  'PROVIDER_TIMEOUT',
  'PROVIDER_UNAVAILABLE',
  'CATALOG_UNAVAILABLE',
]);

export type ModeSelection =
  | { ok: true; taskVerb: TaskVerb; mode: CommunicationMode; register: PresentationRegister }
  | { ok: false; reason: 'unknown_task' | 'ungrounded_error' };

const SURFACE_FOR_ROUTE: Readonly<Record<Exclude<TrustedRoute, 'unknown'>, Surface>> = Object.freeze({
  stylechat: 'stylechat',
  scan_result: 'scan_results',
  discovery: 'discovery_shelf',
  privacy_center: 'status',
});

export function surfaceForRoute(route: unknown): Surface | null {
  return typeof route === 'string' && Object.prototype.hasOwnProperty.call(SURFACE_FOR_ROUTE, route)
    ? SURFACE_FOR_ROUTE[route as keyof typeof SURFACE_FOR_ROUTE]
    : null;
}

export function selectCommunicationMode(state: TrustedTaskState): ModeSelection {
  if (state === null || typeof state !== 'object') return { ok: false, reason: 'unknown_task' };
  const finish = (taskVerb: TaskVerb): ModeSelection => ({
    ok: true,
    taskVerb,
    mode: TASK_VERB_POLICY[taskVerb].mode,
    register: TASK_VERB_POLICY[taskVerb].registers[0],
  });
  if (state.groundedErrorClass !== undefined) {
    return typeof state.groundedErrorClass === 'string' && GROUNDED_ERROR_CLASSES.has(state.groundedErrorClass)
      ? finish('grounded_error_recovery')
      : { ok: false, reason: 'ungrounded_error' };
  }
  switch (state.route) {
    case 'stylechat':
      return finish(state.adviceIntentResolved === 'analysis' ? 'stylechat_analysis' : 'stylechat_conversation');
    case 'scan_result':
      return finish('scan_result_summary');
    case 'discovery':
      if (state.discoveryStatus === 'empty') return finish('discovery_empty_state');
      if (state.discoveryStatus === 'unavailable') return finish('grounded_error_recovery');
      if (state.discoveryStatus === 'ready') return finish('merchant_discovery_explanation');
      return { ok: false, reason: 'unknown_task' };
    case 'privacy_center':
      return finish('privacy_trust_question');
    default:
      return { ok: false, reason: 'unknown_task' };
  }
}
