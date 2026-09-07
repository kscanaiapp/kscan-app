'use strict';

/**
 * Exact identifier normalization (spec section 13).
 *
 * Deliberately conservative: this module normalizes FORMAT (separators,
 * case, leading zeros where the GS1 standard defines equivalence) - it never
 * infers or guesses a missing identifier, and it never treats two
 * differently-typed identifiers (e.g. a UPC-12 and an EAN-13 that are not
 * zero-pad equivalent) as automatically comparable without the explicit
 * padding rule below.
 *
 * GTIN family background (why zero-padding to 14 is safe): GS1 defines
 * GTIN-8/12/13/14 as the same identifier space, left-padded with zeros to a
 * fixed width. A UPC-12 "036000291452" and its EAN-13 form
 * "0036000291452" and GTIN-14 form "00000036000291452" identify the same
 * trade item. Comparing by left-padding both sides to 14 digits is the
 * standard equivalence rule, not an aggressive transform.
 */

function onlyDigits(value) {
  return typeof value === 'string' ? value.replace(/[^0-9]/g, '') : '';
}

/**
 * Validate a GTIN-8/12/13/14 check digit (mod-10, GS1 algorithm applied from
 * the rightmost digit). Returns false for anything that isn't a plausible
 * GTIN length or fails the checksum - this is what makes a GTIN match
 * "validated" per spec section 12 ("matching validated GTIN").
 */
function isValidGtinCheckDigit(digits) {
  if (!/^[0-9]{8}$|^[0-9]{12,14}$/.test(digits)) return false;
  const digitsArr = digits.split('').map(Number);
  const checkDigit = digitsArr.pop();
  let sum = 0;
  // GS1 rule: from the rightmost digit (excluding the check digit), weight
  // alternates 3,1,3,1... starting with 3 on the digit immediately left of
  // the check digit.
  for (let i = digitsArr.length - 1, weightIsThree = true; i >= 0; i -= 1, weightIsThree = !weightIsThree) {
    sum += digitsArr[i] * (weightIsThree ? 3 : 1);
  }
  const computedCheck = (10 - (sum % 10)) % 10;
  return computedCheck === checkDigit;
}

/**
 * Normalize a GTIN/UPC/EAN-shaped string to its canonical GTIN-14 form.
 * Returns { normalized: string, valid: boolean, rawLength: number } or null
 * if the input has no digits at all.
 */
function normalizeGtin(raw) {
  const digits = onlyDigits(raw);
  if (!digits) return null;
  const valid = isValidGtinCheckDigit(digits);
  const normalized = digits.padStart(14, '0');
  return { normalized, valid, rawLength: digits.length };
}

/** Two GTIN-shaped strings are the same trade item iff both validate and their zero-padded GTIN-14 forms match. */
function gtinsMatch(rawA, rawB) {
  const a = normalizeGtin(rawA);
  const b = normalizeGtin(rawB);
  if (!a || !b || !a.valid || !b.valid) return false;
  return a.normalized === b.normalized;
}

/**
 * Normalize a manufacturer style code / MPN / SKU: trim, collapse internal
 * whitespace, uppercase, strip punctuation that is purely a separator
 * (spaces, hyphens, underscores, dots, slashes) - but never strip alphanumerics.
 * This is intentionally more aggressive than GTIN normalization because
 * these codes have no external checksum standard to lean on; punctuation
 * variance ("AB-1234", "AB1234", "ab 1234") is the dominant real-world
 * source of false non-matches for the same code, not a source of false
 * matches, so collapsing it here is safe per spec section 13's "prove
 * equivalence rules" bar.
 */
function normalizeCode(raw) {
  if (typeof raw !== 'string') return null;
  const stripped = raw
    .normalize('NFKC')
    .trim()
    .toUpperCase()
    .replace(/[\s\-_./]+/g, '');
  return stripped.length ? stripped : null;
}

function codesMatch(rawA, rawB) {
  const a = normalizeCode(rawA);
  const b = normalizeCode(rawB);
  if (!a || !b) return false;
  return a === b;
}

/**
 * Compute the GS1 check digit for an n-digit GTIN base (n = 7, 11, or 12).
 * Used only by the corpus generator to synthesize VALID GTINs deterministically
 * (never by the resolver, which only ever validates, never fabricates).
 */
function computeGtinCheckDigit(baseDigits) {
  const arr = baseDigits.split('').map(Number);
  let sum = 0;
  for (let i = arr.length - 1, weightIsThree = true; i >= 0; i -= 1, weightIsThree = !weightIsThree) {
    sum += arr[i] * (weightIsThree ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

/** Deterministically generate a VALID 13-digit GTIN (EAN-13-shaped) from an rng. */
function generateValidGtin13(rng) {
  let base = '';
  for (let i = 0; i < 12; i += 1) base += rng.int(0, 9);
  return base + computeGtinCheckDigit(base);
}

module.exports = {
  onlyDigits,
  isValidGtinCheckDigit,
  normalizeGtin,
  gtinsMatch,
  normalizeCode,
  codesMatch,
  computeGtinCheckDigit,
  generateValidGtin13,
};
