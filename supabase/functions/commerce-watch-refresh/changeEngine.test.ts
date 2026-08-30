import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { evaluateWatchRefresh, type WatchState } from './changeEngine.ts';

const NOW = '2026-08-30T12:00:00.000Z';

function baseWatch(overrides: Partial<WatchState> = {}): WatchState {
  return {
    currency: 'USD',
    currentPriceAmount: 200,
    targetPriceAmount: null,
    watchIntent: 'just_watching',
    targetReachedAt: null,
    lastStatus: 'available',
    consecutiveFailures: 0,
    ...overrides,
  };
}

Deno.test('no LLM / no external call — pure function over its inputs only', () => {
  // Structural guarantee: the module has no fetch/Deno.env references at all.
  const src = Deno.readTextFileSync(new URL('./changeEngine.ts', import.meta.url));
  if (/\bfetch\(|Deno\.env|Gemini|openai|anthropic/i.test(src)) {
    throw new Error('changeEngine.ts must stay a pure function — no I/O, no model calls');
  }
});

Deno.test('price decrease: same currency, no target — records price_decreased, refreshStatus available', () => {
  const result = evaluateWatchRefresh(
    baseWatch({ currentPriceAmount: 200 }),
    { status: 'resolved', priceAmount: 179, currency: 'USD' },
    { unavailableAfterFailures: 5, observedAt: NOW },
  );
  assertEquals(result.event?.type, 'price_decreased');
  assertEquals(result.newCurrentPriceAmount, 179);
  assertEquals(result.refreshStatus, 'available');
});

Deno.test('same price: no event, refreshStatus unchanged', () => {
  const result = evaluateWatchRefresh(
    baseWatch({ currentPriceAmount: 200 }),
    { status: 'resolved', priceAmount: 200, currency: 'USD' },
    { unavailableAfterFailures: 5, observedAt: NOW },
  );
  assertEquals(result.event, null);
  assertEquals(result.refreshStatus, 'unchanged');
});

Deno.test('buy_under crossing: previous > target, new <= target — exactly one target_price_reached event', () => {
  const result = evaluateWatchRefresh(
    baseWatch({ currentPriceAmount: 200, watchIntent: 'buy_under', targetPriceAmount: 150 }),
    { status: 'resolved', priceAmount: 149, currency: 'USD' },
    { unavailableAfterFailures: 5, observedAt: NOW },
  );
  assertEquals(result.event?.type, 'target_price_reached');
  assertEquals(result.newTargetReachedAt, NOW);
});

Deno.test('target already reached before: further drop records price_decreased, not another target event', () => {
  const result = evaluateWatchRefresh(
    baseWatch({
      currentPriceAmount: 149,
      watchIntent: 'buy_under',
      targetPriceAmount: 150,
      targetReachedAt: '2026-08-01T00:00:00.000Z',
    }),
    { status: 'resolved', priceAmount: 139, currency: 'USD' },
    { unavailableAfterFailures: 5, observedAt: NOW },
  );
  assertEquals(result.event?.type, 'price_decreased');
  assertEquals(result.newTargetReachedAt, '2026-08-01T00:00:00.000Z');
});

Deno.test('strongest event wins: a crossing refresh reports target_price_reached, never also price_decreased', () => {
  const result = evaluateWatchRefresh(
    baseWatch({ currentPriceAmount: 200, watchIntent: 'buy_under', targetPriceAmount: 150 }),
    { status: 'resolved', priceAmount: 120, currency: 'USD' },
    { unavailableAfterFailures: 5, observedAt: NOW },
  );
  assertEquals(result.event?.type, 'target_price_reached');
});

Deno.test('currency mismatch: no price update, no event, no failure increment (§35)', () => {
  const result = evaluateWatchRefresh(
    baseWatch({ currentPriceAmount: 200, currency: 'USD' }),
    { status: 'currency_mismatch', priceAmount: 179, currency: 'EUR' },
    { unavailableAfterFailures: 5, observedAt: NOW },
  );
  assertEquals(result.event, null);
  assertEquals(result.newCurrentPriceAmount, 200);
  assertEquals(result.refreshStatus, 'currency_mismatch');
  assertEquals(result.newConsecutiveFailures, 0);
});

Deno.test('single failed resolve stays "error", never "unavailable" (§40)', () => {
  const result = evaluateWatchRefresh(
    baseWatch({ consecutiveFailures: 0 }),
    { status: 'not_resolved', priceAmount: null, currency: null },
    { unavailableAfterFailures: 5, observedAt: NOW },
  );
  assertEquals(result.newLastStatus, 'error');
  assertEquals(result.event, null);
  assertEquals(result.newConsecutiveFailures, 1);
});

Deno.test('crossing the failure threshold degrades to unavailable exactly once, with one event', () => {
  const atThreshold = evaluateWatchRefresh(
    baseWatch({ consecutiveFailures: 4, lastStatus: 'available' }),
    { status: 'not_resolved', priceAmount: null, currency: null },
    { unavailableAfterFailures: 5, observedAt: NOW },
  );
  assertEquals(atThreshold.newLastStatus, 'unavailable');
  assertEquals(atThreshold.event?.type, 'listing_unavailable');

  // A further failure while already unavailable must not re-fire the event.
  const stillDown = evaluateWatchRefresh(
    baseWatch({ consecutiveFailures: 5, lastStatus: 'unavailable' }),
    { status: 'not_resolved', priceAmount: null, currency: null },
    { unavailableAfterFailures: 5, observedAt: NOW },
  );
  assertEquals(stillDown.event, null);
});

Deno.test('recovery from unavailable emits listing_available_again', () => {
  const result = evaluateWatchRefresh(
    baseWatch({ lastStatus: 'unavailable', consecutiveFailures: 6, currentPriceAmount: 200 }),
    { status: 'resolved', priceAmount: 200, currency: 'USD' },
    { unavailableAfterFailures: 5, observedAt: NOW },
  );
  assertEquals(result.event?.type, 'listing_available_again');
  assertEquals(result.newConsecutiveFailures, 0);
  assertEquals(result.newLastStatus, 'available');
});

Deno.test('KicksCrew product-family-minimum price is compared like any other price — engine never claims "your size"', () => {
  // The engine has no size/variant field at all — this test documents that
  // absence is deliberate, not an oversight: nothing here could special-case
  // a variant even if asked to.
  const result = evaluateWatchRefresh(
    baseWatch({ currentPriceAmount: 100 }),
    { status: 'resolved', priceAmount: 90, currency: 'USD' },
    { unavailableAfterFailures: 5, observedAt: NOW },
  );
  assertEquals('variantId' in result, false);
  assertEquals(result.event?.type, 'price_decreased');
});
