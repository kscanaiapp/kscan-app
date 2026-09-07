/**
 * Currency evidence normalization for the deployable Scanner commerce closure.
 *
 * Keep this module inside the Edge Function tree: Supabase deploys that tree as
 * a self-contained Deno module graph, while the mobile formatter owns its own
 * presentation helper under services/dressingRoomCommerce.ts.
 */
const ISO_4217_CURRENCY_CODES = new Set([
  'AED', 'AFN', 'ALL', 'AMD', 'ANG', 'AOA', 'ARS', 'AUD', 'AWG', 'AZN',
  'BAM', 'BBD', 'BDT', 'BGN', 'BHD', 'BIF', 'BMD', 'BND', 'BOB', 'BRL',
  'BSD', 'BTN', 'BWP', 'BYN', 'BZD', 'CAD', 'CDF', 'CHF', 'CLP', 'CNY',
  'COP', 'CRC', 'CUC', 'CUP', 'CVE', 'CZK', 'DJF', 'DKK', 'DOP', 'DZD',
  'EGP', 'ERN', 'ETB', 'EUR', 'FJD', 'FKP', 'GBP', 'GEL', 'GHS', 'GIP',
  'GMD', 'GNF', 'GTQ', 'GYD', 'HKD', 'HNL', 'HRK', 'HTG', 'HUF', 'IDR',
  'ILS', 'INR', 'IQD', 'IRR', 'ISK', 'JMD', 'JOD', 'JPY', 'KES', 'KGS',
  'KHR', 'KMF', 'KPW', 'KRW', 'KWD', 'KYD', 'KZT', 'LAK', 'LBP', 'LKR',
  'LRD', 'LSL', 'LYD', 'MAD', 'MDL', 'MGA', 'MKD', 'MMK', 'MNT', 'MOP',
  'MRU', 'MUR', 'MVR', 'MWK', 'MXN', 'MYR', 'MZN', 'NAD', 'NGN', 'NIO',
  'NOK', 'NPR', 'NZD', 'OMR', 'PAB', 'PEN', 'PGK', 'PHP', 'PKR', 'PLN',
  'PYG', 'QAR', 'RON', 'RSD', 'RUB', 'RWF', 'SAR', 'SBD', 'SCR', 'SDG',
  'SEK', 'SGD', 'SHP', 'SLE', 'SLL', 'SOS', 'SRD', 'SSP', 'STN', 'SVC',
  'SYP', 'SZL', 'THB', 'TJS', 'TMT', 'TND', 'TOP', 'TRY', 'TTD', 'TWD',
  'TZS', 'UAH', 'UGX', 'USD', 'UYU', 'UZS', 'VES', 'VND', 'VUV', 'WST',
  'XAF', 'XCD', 'XCG', 'XDR', 'XOF', 'XPF', 'XSU', 'YER', 'ZAR', 'ZMW',
  'ZWG', 'ZWL',
]);

/** Return a normalized, known ISO 4217 code; never invent one. */
export function normalizeCommerceCurrency(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return ISO_4217_CURRENCY_CODES.has(code) ? code : null;
}

/**
 * Read an explicit ISO code embedded in an authoritative provider display
 * string. Symbols are intentionally not converted: "$" is a display symbol,
 * not proof that an amount is USD.
 */
export function currencyCodeFromDisplayPrice(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  for (const token of value.match(/[A-Za-z]{3}/g) ?? []) {
    const currency = normalizeCommerceCurrency(token);
    if (currency) return currency;
  }
  return null;
}
