// watchCurrency.ts — WL-01: unambiguous currency identity for a Watch.
//
// WHY THIS EXISTS. A Watch stores ONE currency and the change engine compares
// numbers within it. The only control preventing a cross-currency comparison is
// `currency_mismatch`, and it was unreachable for most of the currencies the two
// watch adapters can actually emit.
//
// Both adapters format their price with
// `Intl.NumberFormat('en-US', { style: 'currency', currency: CODE })`
// (farfetch3Provider.ts / kicksCrewProvider.ts). In that locale the currency
// part is NOT a bare sigil for most codes:
//
//     USD "$"      EUR "€"      GBP "£"      JPY "¥"
//     CAD "CA$"    AUD "A$"     NZD "NZ$"    HKD "HK$"
//     MXN "MX$"    BRL "R$"     CNY "CN¥"    TWD "NT$"
//     SGD "SGD"    CHF "CHF"    SEK "SEK"    ...
//
// `parseOfferPrice` (canonicalCommerce.ts) decides currency with a substring
// scan over { $, £, €, ¥ }, first match wins. So "CA$1,299.99" contains "$" and
// reads as USD; "CN¥1,299.99" contains "¥" and reads as JPY; "CHF 1,299.99"
// matches nothing and reads as null — and watchRefreshObservation then fell back
// to `?? watch.currency`, i.e. it ASSUMED the currency it was supposed to be
// checking. A watch created while the provider answered in USD and refreshed
// while it answered in CAD therefore compared 650 CAD against 500 USD as if both
// were USD: `price_decreased`, and with a target armed, a `target_price_reached`
// push announcing a price drop that never happened (§22, §72, §94).
//
// THE FIX. Ask Intl for the answer instead of guessing at sigils. The prefix
// table below is DERIVED at module load from the same formatter the adapters
// use, so it cannot drift from its producers, and matching is longest-first so
// "CA$" wins over "$". Anything this cannot identify resolves to null, and the
// caller must treat null as "unknown", never as "the currency I already had".
//
// This is deliberately Watchlist-local. parseOfferPrice is shared with commerce
// ranking, where a mislabelled currency is a display concern; here it decides
// whether a customer is told a price fell. The narrow repair belongs on the
// side that carries the consequence.

/** ISO codes the two watch adapters can plausibly be answered in. */
const CANDIDATE_CURRENCIES: readonly string[] = [
  'USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'NZD', 'HKD', 'SGD', 'MXN',
  'BRL', 'CHF', 'SEK', 'DKK', 'NOK', 'CNY', 'KRW', 'PLN', 'CZK', 'AED',
  'SAR', 'ZAR', 'TRY', 'INR', 'ILS', 'TWD', 'THB', 'MYR', 'PHP', 'IDR',
];

/**
 * [displayPrefix, isoCode] pairs, longest prefix first.
 *
 * Built from Intl rather than hand-written precisely so that a runtime whose
 * CLDR data differs from the author's assumptions still agrees with the
 * formatter that produced the string being parsed.
 */
function buildCurrencyPrefixTable(): ReadonlyArray<readonly [string, string]> {
  const seen = new Map<string, string>();
  for (const code of CANDIDATE_CURRENCIES) {
    let symbol: string;
    try {
      symbol = new Intl.NumberFormat('en-US', { style: 'currency', currency: code })
        .formatToParts(1)
        .filter((part) => part.type === 'currency')
        .map((part) => part.value)
        .join('');
    } catch {
      continue;
    }
    if (!symbol) continue;
    // First writer wins for a shared sigil, and CANDIDATE_CURRENCIES lists the
    // unprefixed majors first, so "$" stays USD while "CA$"/"A$" keep their own
    // longer, unambiguous entries.
    if (!seen.has(symbol)) seen.set(symbol, code);
  }
  return [...seen.entries()]
    .map(([symbol, code]) => [symbol, code] as const)
    .sort((a, b) => b[0].length - a[0].length);
}

const CURRENCY_PREFIXES = buildCurrencyPrefixTable();

/** Whole-word ISO matchers, compiled once rather than per observation. */
const ISO_MATCHERS: ReadonlyArray<readonly [RegExp, string]> = CANDIDATE_CURRENCIES.map(
  (code) => [new RegExp(`(^|[^A-Z])${code}([^A-Z]|$)`), code] as const,
);

/**
 * The ISO currency a price string is denominated in, or null when it cannot be
 * identified with confidence.
 *
 * Resolution order:
 *   1. an explicit ISO code appearing as a whole word ("1299.99 USD");
 *   2. the longest matching Intl display prefix ("CA$" before "$").
 *
 * Never guesses. A null result means "unknown", and every caller must treat
 * that as a refusal to compare, not as agreement with whatever it expected.
 */
export function resolveObservedCurrency(priceText: unknown): string | null {
  if (typeof priceText !== 'string') return null;
  const text = priceText.trim();
  if (!text) return null;

  // Whole-word so "CHF" cannot match inside an unrelated token, and so the
  // fallback branch of the adapters' formatPrice ("1299.99 CAD") is read
  // correctly rather than falling through to the "$"-family prefix scan.
  const upper = text.toUpperCase();
  for (const [matcher, code] of ISO_MATCHERS) {
    if (matcher.test(upper)) return code;
  }

  for (const [symbol, code] of CURRENCY_PREFIXES) {
    if (text.includes(symbol)) return code;
  }

  return null;
}

/**
 * True when an observed price string is denominated in exactly the currency the
 * Watch is held in. Unknown is NOT a match — that is the whole point.
 */
export function observationMatchesWatchCurrency(
  priceText: unknown,
  watchCurrency: string,
): boolean {
  const observed = resolveObservedCurrency(priceText);
  return observed !== null && observed === watchCurrency;
}
