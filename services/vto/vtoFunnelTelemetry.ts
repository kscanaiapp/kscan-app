/**
 * The VTO customer-funnel emitters.
 *
 * WHY A SEPARATE MODULE. `vtoTelemetry.ts` is the allowlisted SINK and is
 * imported by `services/analytics/analyticsEventRegistry.ts`; it must stay
 * free of any dependency that drags the native adapter (and therefore
 * `react-native`) into the analytics registry. The mode authority is exactly
 * such a dependency. So the vocabulary lives there, the decision lives in
 * `vtoModeAuthority.ts`, and the one place that knows both is here.
 *
 * WHAT LEAVES THE DEVICE. A bounded enum, lower-cased, and nothing else.
 * Every function below is a total mapping from a decision object onto two or
 * three enum tokens; there is no path through this module that can emit a
 * productRef, a product title, an image, a URI, a signed URL, a provider
 * name, an error string, or any actor identifier. The sink's own property
 * allowlist and `SAFE_STRING` scrub are the second gate, not the first.
 */

import { emitVtoEvent } from './vtoTelemetry';
import type { VtoModeDecision } from './vtoModeAuthority';
import type { VtoOrigin } from '../../types/vto';

/** Enum tokens travel lower-cased so the funnel reads consistently against
 *  the existing vocabulary ('commerce_product', 'live', 'ai_photo'). */
function token(value: string | null | undefined): string | null {
  return typeof value === 'string' && value ? value.toLowerCase() : null;
}

/** Fields shared by every funnel event. Deliberately built in ONE place so a
 *  future event cannot quietly acquire a richer payload. */
function decisionPayload(decision: VtoModeDecision): Record<string, string | null> {
  return {
    resolvedMode: token(decision.mode),
    status: token(decision.status),
    reasonCode: token(decision.reasonCode),
    liveReasonCode: token(decision.liveReasonCode),
  };
}

/** VTO_MODE_RESOLVED. Emitted once per resolved product, not per render. */
export function emitVtoModeResolved(decision: VtoModeDecision, origin: VtoOrigin): void {
  emitVtoEvent('vto_mode_resolved', { origin, ...decisionPayload(decision) });
}

/** VTO_ENTRY_SEEN. The denominator of TRY_ON_START_RATE. */
export function emitVtoEntryShown(decision: VtoModeDecision, origin: VtoOrigin): void {
  emitVtoEvent('vto_entry_shown', { origin, ...decisionPayload(decision) });
}

/** VTO_UNAVAILABLE_SHOWN. The coverage roadmap's field measurement. */
export function emitVtoEntryUnavailable(decision: VtoModeDecision, origin: VtoOrigin): void {
  emitVtoEvent('vto_entry_unavailable', { origin, ...decisionPayload(decision) });
}

/** VTO_CAPTURE_COMPLETED. Content-free: it says a clean still was taken, not
 *  what is in it. */
export function emitVtoCaptureCompleted(origin: VtoOrigin): void {
  emitVtoEvent('vto_capture_completed', { origin });
}

/** VTO_HANDOFF_READY. Emitted before any request is made. `ok` distinguishes
 *  a still that passed preflight from one the handoff refused. */
export function emitVtoHandoffReady(origin: VtoOrigin, ok: boolean): void {
  emitVtoEvent('vto_handoff_ready', { origin, eligibility: ok ? 'ready' : 'refused' });
}

/** VTO_SHOP_ACTION, from a try-on result. */
export function emitVtoResultShop(origin: VtoOrigin, mode: string | null): void {
  emitVtoEvent('vto_result_shop', { origin, resolvedMode: token(mode) });
}

/** VTO_WATCH_ACTION, from a try-on result. */
export function emitVtoResultWatch(origin: VtoOrigin, mode: string | null): void {
  emitVtoEvent('vto_result_watch', { origin, resolvedMode: token(mode) });
}
