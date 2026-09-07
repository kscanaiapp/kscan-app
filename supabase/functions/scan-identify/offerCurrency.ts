/**
 * Offer currency truth (RP-110).
 *
 * One rule, one implementation, for every provider that mints a displayable
 * price string: an amount is only ever rendered in a currency the PROVIDER
 * actually declared. Before this module each provider carried its own
 * `str(currency) || 'USD'` fallback, so a listing whose payload simply omitted
 * a currency code was published to the app as `$29.99` — a fabricated claim
 * about what the item costs, and one the client had no way to distinguish from
 * a genuinely USD-priced listing.
 *
 * Nothing here infers a currency. Not from locale, not from the request's
 * market context, not from the retailer's country or domain: an unknown
 * currency stays unknown, and the amount is published bare rather than dressed
 * in a symbol nobody supplied.
 */

/** The only currency shape a provider payload may be trusted to have declared. */
const ISO_4217 = /^[A-Za-z]{3}$/;

/**
 * The provider's declared currency as a canonical ISO-4217 code, or null.
 *
 * Bounded and total: anything that is not a three-letter code — free text, a
 * symbol, an empty string, a number, an object — is not a currency declaration
 * and is rejected rather than passed through to a formatter that would throw
 * or, worse, be believed.
 */
export function normalizeCurrencyCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!ISO_4217.test(trimmed)) return null;
  return trimmed.toUpperCase();
}

/**
 * Render an amount truthfully.
 *
 * Known currency  -> that currency's own formatting (`$29.99`, `€29.99`).
 * Unknown currency -> the bare amount (`29.99`). No symbol, no code, no guess.
 *
 * Returns undefined for a non-positive or non-finite amount, matching the
 * existing provider convention that a zero/absent price is simply no price.
 */
export function formatOfferPrice(amount: unknown, currency: unknown): string | undefined {
  const value =
    typeof amount === 'number' && Number.isFinite(amount)
      ? amount
      : typeof amount === 'string'
        ? parseFloat(amount.trim())
        : NaN;
  if (!Number.isFinite(value) || value <= 0) return undefined;

  const code = normalizeCurrencyCode(currency);
  if (!code) return value.toFixed(2);

  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: code }).format(value);
  } catch {
    // A syntactically valid but unrecognised code: still the provider's claim,
    // so it is reported rather than replaced with a currency we prefer.
    return `${code} ${value.toFixed(2)}`;
  }
}
