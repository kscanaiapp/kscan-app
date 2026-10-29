import { evaluateSponsorshipPolicy, type SponsorshipSnapshot, type SponsorshipReason } from './sponsorshipPolicy.ts';
import type { DiscoveryInput } from './contracts.ts';

export const SHADOW_TIMEOUT_MS = 400;
type Aggregate = { event: 'sponsorship_shadow_evaluated'; eligible: boolean; category: string; reason: SponsorshipReason };
export function createShadowEvaluator(deps: { snapshot: (input: DiscoveryInput, signal: AbortSignal) => Promise<SponsorshipSnapshot>; emit: (aggregate: Aggregate) => void; now?: () => number }) {
  return async (input: DiscoveryInput): Promise<void> => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<Aggregate>((resolve) => { timer = setTimeout(() => { controller.abort(); resolve({ event:'sponsorship_shadow_evaluated', eligible:false, category:input.garment.item_type, reason:'timeout' }); }, SHADOW_TIMEOUT_MS); });
    const evaluate = async (): Promise<Aggregate> => {
      try {
        const snapshot = await deps.snapshot(input, controller.signal);
        const decision = evaluateSponsorshipPolicy(input, snapshot.rows, snapshot.partners, snapshot.campaigns, (deps.now ?? Date.now)());
        return { event:'sponsorship_shadow_evaluated', eligible:decision.placements.length>0, category:input.garment.item_type, reason:decision.reason };
      } catch { return { event:'sponsorship_shadow_evaluated', eligible:false, category:input.garment.item_type, reason:'unavailable' }; }
    };
    try { deps.emit(await Promise.race([evaluate(), timeout])); }
    catch { /* telemetry does not propagate */ }
    finally { clearTimeout(timer); controller.abort(); }
  };
}
/** Off means zero scheduling/query/evaluation. Enabled work begins on the next
 * event-loop turn and is owned by EdgeRuntime.waitUntil, never the response. */
export function shadowScheduler(enabled: boolean, waitUntil: ((task: Promise<void>) => void) | undefined, evaluate: (input: DiscoveryInput) => Promise<void>) {
  return (input: DiscoveryInput): void => {
    if (!enabled || !waitUntil) return;
    waitUntil(new Promise<void>((resolve) => { setTimeout(() => { void evaluate(input).catch(() => undefined).finally(resolve); },0); }));
  };
}
