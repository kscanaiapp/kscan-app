const EVENTS = new Set(['black_owned_shelf_displayed','black_owned_product_impression','black_owned_product_selected','black_owned_save','black_owned_shop','black_owned_checkout_handoff']);
type Sink = (event: string, payload: Record<string,string|number|boolean|null>) => void;
let sink: Sink | null = null;
export function setBlackOwnedDiscoveryAnalyticsSink(next: Sink | null): void { sink = next; }
/** Only numeric counters and fixed organic-lane attribution leave this module.
 * Purchases require a future authorized merchant confirmation path. */
export function trackBlackOwnedDiscovery(event: string, values: { count?: number; position?: number } = {}): void {
  if (!sink || !EVENTS.has(event)) return;
  const payload: Record<string,string|number> = { lane: 'black_owned', placement_type: 'organic' };
  for (const key of ['count','position'] as const) {
    const value = values[key];
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 160) payload[key] = value;
  }
  try { sink(event,payload); } catch { /* analytics never fails commerce */ }
}
