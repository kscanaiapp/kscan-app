// watchRefreshObservation.ts — K5-C3: governed listing re-read.
//
// Owns exactly one thing: turn a Watch's (source, canonical_url) back into a
// fresh WatchObservation. Reuses the two existing URL-enrichment adapters
// verbatim (§32: "Do NOT duplicate provider networking code") — no new
// provider client, no MODE B evidence replay (V1 watch eligibility is
// narrowed to these two providers specifically so that fallback is never
// needed — see watchlistCapability.ts).
//
// AUTOMATED OBSERVATION SAFETY (§33): this module only ever calls the
// existing *server-side* enrichFarfetchProductByUrl / enrichKicksCrewProductByUrl
// functions. Both are pure backend HTTP calls to the RapidAPI enrichment
// hosts — neither opens a browser destination, fires a click/affiliate
// telemetry event, or touches services/commerceDestination.ts (the module
// that exists specifically to turn a URL into a USER-facing destination).
// There is no code path from this file to any affiliate/click surface, so
// "automated refresh never looks like a user click" is true by construction,
// not by a flag this module has to remember to set.

import { enrichFarfetchProductByUrl } from '../scan-identify/farfetch3Provider.ts';
import { enrichKicksCrewProductByUrl } from '../scan-identify/kicksCrewProvider.ts';
import { parseOfferPrice } from '../scan-identify/canonicalCommerce.ts';
import type { WatchObservation } from './changeEngine.ts';

export type RefreshMetadata = {
  provider: string;
  latencyMs: number;
  errorCode?: string;
};

export interface RefreshOutcome {
  observation: WatchObservation;
  metadata: RefreshMetadata;
}

/**
 * Re-reads one listing by its governed source + canonical_url. Never throws
 * — any provider failure normalizes to `status: 'not_resolved'`, which the
 * change engine treats as "could not confirm right now", never as "gone"
 * (§40).
 */
export async function refreshWatchObservation(
  watch: { source: string; canonicalUrl: string; currency: string },
): Promise<RefreshOutcome> {
  const started = Date.now();

  if (watch.source !== 'farfetch' && watch.source !== 'kickscrew') {
    // Defense in depth: create_user_commerce_watch only ever stores a
    // source from WATCH_PROVIDER_REGISTRY, so this should be unreachable.
    // Treated as a provider-unavailable observation, never as "not listed".
    return {
      observation: { status: 'not_resolved', priceAmount: null, currency: null },
      metadata: { provider: watch.source, latencyMs: 0, errorCode: 'unsupported_provider' },
    };
  }

  const result = watch.source === 'farfetch'
    ? await enrichFarfetchProductByUrl(watch.canonicalUrl)
    : await enrichKicksCrewProductByUrl(watch.canonicalUrl);

  const latencyMs = Date.now() - started;

  if (!result.product) {
    return {
      observation: { status: 'not_resolved', priceAmount: null, currency: null },
      metadata: { provider: watch.source, latencyMs, errorCode: result.errorType ?? 'unknown' },
    };
  }

  const parsed = parseOfferPrice(result.product.price);
  if (parsed.value === null) {
    // A product came back but with no readable price — cannot compare, so
    // this is a failed observation for change-detection purposes, not a
    // reason to claim unavailability (the listing plainly still resolved).
    return {
      observation: { status: 'not_resolved', priceAmount: null, currency: null },
      metadata: { provider: watch.source, latencyMs, errorCode: 'unparseable_price' },
    };
  }

  const observedCurrency = parsed.currency ?? watch.currency;
  if (observedCurrency !== watch.currency) {
    return {
      observation: { status: 'currency_mismatch', priceAmount: parsed.value, currency: observedCurrency },
      metadata: { provider: watch.source, latencyMs },
    };
  }

  return {
    observation: { status: 'resolved', priceAmount: parsed.value, currency: observedCurrency },
    metadata: { provider: watch.source, latencyMs },
  };
}
