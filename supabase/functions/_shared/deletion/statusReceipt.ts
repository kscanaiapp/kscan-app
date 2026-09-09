/**
 * Deletion-status receipt — the post-auth capability for observing ONE
 * deletion lifecycle's terminal outcome.
 *
 * WHY THIS EXISTS. Deletion intake deliberately destroys the caller's ability
 * to authenticate: it revokes sessions, bans the Auth user for the grace
 * window, and the purge worker eventually deletes the Auth identity outright.
 * A client therefore cannot use a Supabase session to ask "did my deletion
 * actually complete?" — by the time the answer exists, the credential that
 * would have authorised the question is gone. This capability is the answer:
 * an opaque bearer secret that identifies exactly one lifecycle row and
 * nothing else.
 *
 * WHY IT IS NOT THE RESTORATION TOKEN. The restoration token can REVERSE a
 * deletion, is single-use, and is delivered by email. Reusing it as a status
 * credential would put restoration authority into a value the client keeps on
 * disk for the entire grace period, and would make a read amplify into a write.
 * This is a separate capability domain: read-only, and incapable of
 * restoring, deleting, or reaching any account data.
 *
 * DELIBERATELY ZERO IMPORTS. `deletion-status` imports this module and nothing
 * else from the deletion subsystem. Pulling in `common.ts` would drag
 * `auth.admin.*` into a `verify_jwt = false` public endpoint's bundle closure
 * and inflate its governed privilege footprint for no behavioural gain. Keep
 * this file dependency-free.
 *
 * Format and hashing mirror `generateRestorationToken` / `hashRestorationToken`
 * in `common.ts` — same 32-byte / base64url / SHA-256-hex conventions — so the
 * project has one cryptographic idiom rather than two.
 */

/**
 * Version prefix. Present so a future format change is self-describing rather
 * than a silent reinterpretation of existing stored hashes.
 */
export const STATUS_RECEIPT_PREFIX = 'ksdel_v1_';

/** 32 bytes = 256 bits of entropy, matching the restoration token's strength. */
export const STATUS_RECEIPT_BYTES = 32;

/**
 * 32 bytes encoded as unpadded base64url is exactly 43 characters. Requiring
 * that exact length is what makes "at least 256 bits" a structural property of
 * the format rather than a statistical guess about the supplied value: a
 * correctly generated receipt cannot be shorter, and a value that is shorter
 * cannot be a correctly generated receipt.
 */
const RECEIPT_BODY_LENGTH = 43;
const RECEIPT_BODY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Exact total length. Anything longer is rejected before any work is done. */
export const STATUS_RECEIPT_LENGTH = STATUS_RECEIPT_PREFIX.length + RECEIPT_BODY_LENGTH;

/** Generates a fresh capability. The raw value is never persisted or logged. */
export function generateStatusReceipt(): string {
  const bytes = new Uint8Array(STATUS_RECEIPT_BYTES);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  const body = btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
  return `${STATUS_RECEIPT_PREFIX}${body}`;
}

/**
 * Structural validation only.
 *
 * This deliberately does NOT attempt to estimate randomness: entropy is a
 * property of how a value was generated, not of how it looks, and any
 * statistical test here would both reject valid receipts and accept
 * low-entropy ones. The format itself carries the requirement — a value that
 * matches is 43 base64url characters wide, which a correctly generated
 * receipt fills with 256 bits.
 *
 * The exact-length check also bounds the work done on hostile input before the
 * value ever reaches a hash or a query.
 */
export function isValidStatusReceipt(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length !== STATUS_RECEIPT_LENGTH) return false;
  if (!value.startsWith(STATUS_RECEIPT_PREFIX)) return false;
  return RECEIPT_BODY_PATTERN.test(value.slice(STATUS_RECEIPT_PREFIX.length));
}

/**
 * SHA-256, lowercase hex. Only this value is ever persisted.
 *
 * A hash rather than reversible encryption: the server never needs to recover
 * the receipt, only to recognise one presented by a caller, so keeping any
 * means of recovering it would be storing a secret for no purpose.
 */
export async function hashStatusReceipt(receipt: string): Promise<string> {
  const data = new TextEncoder().encode(receipt);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
