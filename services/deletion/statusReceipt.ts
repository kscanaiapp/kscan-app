/**
 * Deletion-status capability — the CLIENT half of the Repair 06 contract.
 *
 * The format here is derived from canonical backend authority
 * `rebuild/backend-authority-v2` @ 323a3c86, file
 * `supabase/functions/_shared/deletion/statusReceipt.ts`, not from memory. Any
 * divergence would be silent: a receipt this device generates but the server's
 * validator rejects turns into a 400 at intake, and a receipt the server would
 * accept but this validator rejects strands a lifecycle the user cannot observe.
 *
 * WHY THE CLIENT CREATES IT. Deletion intake revokes the caller's sessions and
 * bans the Auth user for the whole grace window, and the purge worker later
 * deletes the Auth identity outright. If the capability were minted server-side
 * and returned in the response, a response lost in transit would strand the
 * device permanently: no session to retry with, and no copy of the only value
 * that can ever resolve the lifecycle. Generating it here, and persisting it
 * BEFORE the request goes out, is what makes the outcome observable at all.
 *
 * THE RAW VALUE IS A BEARER SECRET. It lives only in the platform keychain (see
 * pendingDeletionStore) and in the JSON body of exactly two requests. It is
 * never logged, never placed in a URL or query string, never handed to
 * analytics, and never written to AsyncStorage.
 */

import * as ExpoCrypto from 'expo-crypto';

/** Version prefix, mirroring STATUS_RECEIPT_PREFIX on the backend. */
export const STATUS_RECEIPT_PREFIX = 'ksdel_v1_';

/** 32 bytes = 256 bits, matching STATUS_RECEIPT_BYTES on the backend. */
export const STATUS_RECEIPT_BYTES = 32;

/** 32 bytes as unpadded base64url is exactly 43 characters. */
const RECEIPT_BODY_LENGTH = 43;
const RECEIPT_BODY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Exact total length: 9 + 43 = 52. */
export const STATUS_RECEIPT_LENGTH = STATUS_RECEIPT_PREFIX.length + RECEIPT_BODY_LENGTH;

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * Thrown when no cryptographically secure source of randomness is reachable.
 *
 * This FAILS CLOSED rather than degrading. A receipt is the sole credential
 * that will later authorise irreversible destruction of this account's local
 * data; a predictable one is worse than no deletion-status tracking at all,
 * because it is a guessable key into another user's lifecycle. There is
 * deliberately no `Math.random()` path, no timestamp path, and no
 * device-identifier path anywhere in this module.
 */
export class InsecureRandomnessError extends Error {
  constructor() {
    super('No cryptographically secure randomness source is available.');
    this.name = 'InsecureRandomnessError';
  }
}

type RandomSource = {
  getRandomValues?: (array: Uint8Array) => Uint8Array;
  getRandomBytes?: (byteCount: number) => Uint8Array;
};

/**
 * 32 CSPRNG bytes, from the first available secure source.
 *
 * Order is "platform Web Crypto, then expo-crypto", the same precedence the
 * existing id helpers in this project use (services/fashionEvidenceGateway.ts,
 * services/privateDressingRoomInteractionSchema.ts) — minus their
 * `Math.random()` tail, which is acceptable for a collision-resistant id and
 * is not acceptable for a bearer capability.
 */
function secureRandomBytes(deps: { crypto?: RandomSource; expoCrypto?: RandomSource } = {}): Uint8Array {
  const webCrypto =
    deps.crypto ??
    (globalThis as { crypto?: RandomSource }).crypto;
  if (webCrypto && typeof webCrypto.getRandomValues === 'function') {
    return webCrypto.getRandomValues(new Uint8Array(STATUS_RECEIPT_BYTES));
  }

  const expo = deps.expoCrypto ?? (ExpoCrypto as unknown as RandomSource);
  if (expo && typeof expo.getRandomValues === 'function') {
    return expo.getRandomValues(new Uint8Array(STATUS_RECEIPT_BYTES));
  }
  if (expo && typeof expo.getRandomBytes === 'function') {
    const bytes = expo.getRandomBytes(STATUS_RECEIPT_BYTES);
    if (bytes && bytes.length === STATUS_RECEIPT_BYTES) return bytes;
  }

  throw new InsecureRandomnessError();
}

/**
 * Unpadded base64url. Written out rather than routed through `btoa`, which is
 * not guaranteed on every React Native runtime this app ships to and would
 * force a binary-string round trip for no benefit.
 */
function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : undefined;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : undefined;

    out += BASE64URL_ALPHABET[b0 >> 2];
    out += BASE64URL_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 === undefined) break;
    out += BASE64URL_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 === undefined) break;
    out += BASE64URL_ALPHABET[b2 & 0x3f];
  }
  return out;
}

/**
 * Generates a fresh capability. 256 bits of CSPRNG entropy behind the versioned
 * prefix, in the exact shape the backend validator accepts.
 *
 * @throws {InsecureRandomnessError} when no secure source exists. Callers must
 * let this abort the deletion flow rather than substituting a weaker value.
 */
export function generateStatusReceipt(
  deps: { crypto?: RandomSource; expoCrypto?: RandomSource } = {},
): string {
  const receipt = `${STATUS_RECEIPT_PREFIX}${toBase64Url(secureRandomBytes(deps))}`;
  // Structural self-check: a generator that silently produced a value the
  // server would reject is a stranded lifecycle, so it fails here instead.
  if (!isValidStatusReceipt(receipt)) throw new InsecureRandomnessError();
  return receipt;
}

/**
 * Structural validation, byte-for-byte the backend's rule.
 *
 * Deliberately makes no attempt to estimate randomness: entropy is a property
 * of how a value was produced, not of how it looks. The exact-length check is
 * what makes "256 bits" structural rather than statistical.
 */
export function isValidStatusReceipt(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length !== STATUS_RECEIPT_LENGTH) return false;
  if (!value.startsWith(STATUS_RECEIPT_PREFIX)) return false;
  return RECEIPT_BODY_PATTERN.test(value.slice(STATUS_RECEIPT_PREFIX.length));
}
