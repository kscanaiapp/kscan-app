// Receipt & Purchase Intelligence V1 — sensitive-text scrubbing.
//
// The extraction contract has no field for contact, payment or account data,
// and the prompt instructs the model never to transcribe it. This module is
// the deterministic control behind that instruction: every free-text value that
// crosses the wire or reaches review is passed through it, so a model that
// copies a card fragment into a title anyway cannot carry it any further.
//
// BLOCK-RPI-26: payment-card fragments never enter Receipt Intelligence
// persisted or analytics state. Even last-four digits are removed.
//
// THIS FILE HAS NO IMPORTS ON PURPOSE. The Edge Function carries a byte-for-byte
// copy of the scrubbing core (supabase/functions/purchase-import-extract/
// sensitive.ts), because Deno and the React Native bundle cannot share a module
// here. __tests__/purchaseImportParity.test.js runs both copies over one table
// and fails the moment they disagree.
//
// WHAT IT DOES NOT CLAIM: regex scrubbing is not PII removal. It removes the
// shapes it names. The required user crop (services/purchaseImport/
// purchaseImportImage.ts) is the primary minimization boundary; this is the
// second one.

// BEGIN SHARED SCRUB CORE (keep identical to the Edge Function copy)

/** Luhn check over a digit string. */
export function passesLuhn(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** GS1 check-digit validation for GTIN-8/12/13/14. */
export function isValidGtin(value: string): boolean {
  if (!/^\d+$/.test(value)) return false;
  if (![8, 12, 13, 14].includes(value.length)) return false;
  const digits = value.split('').map((c) => c.charCodeAt(0) - 48);
  const check = digits.pop() as number;
  let sum = 0;
  // Weights alternate 3,1 starting from the digit nearest the check digit.
  for (let i = digits.length - 1, w = 3; i >= 0; i -= 1, w = w === 3 ? 1 : 3) {
    sum += digits[i] * w;
  }
  return (10 - (sum % 10)) % 10 === check;
}

/** True when a run of 13-19 digits (spaces/dashes allowed) is a plausible full card number. */
export function looksLikeCardNumber(text: string): boolean {
  const digits = text.replace(/[\s-]/g, '');
  return /^\d{13,19}$/.test(digits) && passesLuhn(digits);
}

const SCRUB_PATTERNS: ReadonlyArray<RegExp> = [
  // Email addresses.
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
  // Masked card fragments: "**** 1234", "XXXX-1234", "•••• 1234", "#### 1234".
  /(?:[*xX•#]\s?){2,}[\s-]*\d{2,6}/g,
  // "ending in 1234", "ends with 1234", "last 4: 1234".
  /\b(?:ending|ends)\s+(?:in|with)\s*[:#]?\s*\d{2,6}\b/gi,
  /\blast\s*(?:4|four)\s*(?:digits)?\s*[:#]?\s*\d{2,6}\b/gi,
  // A card brand or payment word followed closely by digits.
  /\b(?:visa|mastercard|master\s?card|amex|american\s+express|discover|maestro|debit|credit|card|acct|account|paypal|apple\s+pay|google\s+pay)\b[^\n\d]{0,16}\d{2,19}\b/gi,
  // Order, tracking, confirmation, loyalty and similar reference numbers. The
  // reference must contain a digit, so "Customer favorite tee" survives.
  /\b(?:order|tracking|confirmation|conf|invoice|transaction|trans|txn|auth(?:orization)?|approval|loyalty|member(?:ship)?|rewards?|customer)\s*(?:no\.?|number|num|#|id|code)?\s*[:#]?\s*(?=[A-Z0-9-]*\d)[A-Z0-9][A-Z0-9-]{3,}/gi,
  // Phone numbers (North American and international shapes).
  /(?:\+\d{1,3}[\s.-]?)?\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g,
  // Street addresses: a house number followed by an unambiguous street-type
  // word. Abbreviations that are also receipt garment shorthand ("DR" dress,
  // "PL" plaid, "ST" stretch) and fashion names ("Court", "Way") are
  // deliberately absent: scrubbing a garment line is its own data loss.
  /\b\d{1,6}\s+(?:[A-Za-z0-9.'-]+\s+){1,5}(?:street|avenue|ave|road|boulevard|blvd|lane|terrace|parkway|pkwy|highway|hwy)\b\.?/gi,
];

/**
 * Removes contact, payment and account shapes from one free-text value.
 * Returns null when nothing meaningful is left.
 */
export function scrubSensitiveText(value: unknown, maxLength = 200): string | null {
  if (typeof value !== 'string') return null;
  let text = value.replace(/[\u0000-\u001f\u007f]/g, ' ');
  // Full card numbers first, so a later pattern cannot leave half of one behind.
  text = text.replace(/\b(?:\d[\s-]?){12,18}\d\b/g, (match) =>
    looksLikeCardNumber(match) ? ' ' : match,
  );
  for (const pattern of SCRUB_PATTERNS) {
    text = text.replace(pattern, ' ');
  }
  text = text.replace(/\s{2,}/g, ' ').trim();
  if (!text || !/[\p{L}\p{N}]/u.test(text)) return null;
  return text.slice(0, maxLength).trim() || null;
}

/**
 * Validates an identifier field (SKU, retailer product reference). An
 * identifier is kept only when it is a plain token. A URL, anything with
 * whitespace, and any digit run that could be a card number are all refused.
 */
export function sanitizeIdentifier(value: unknown, maxLength = 40): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text.length < 3 || text.length > maxLength) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(text)) return null;
  if (/:\/\/|^www\./i.test(text)) return null;
  const digits = text.replace(/[^0-9]/g, '');
  if (digits.length >= 13 && digits.length <= 19 && digits.length === text.replace(/[-.]/g, '').length && passesLuhn(digits)) {
    return null;
  }
  return text;
}

// END SHARED SCRUB CORE
