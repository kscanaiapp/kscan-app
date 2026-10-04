export const KPLUS_OFFER_CODE_HMAC_SECRET_ENV = 'KPLUS_OFFER_CODE_HMAC_SECRET_B64';

export const OFFER_REDEMPTION_RESULTS = [
  'SUCCESS',
  'INVALID',
  'EXPIRED',
  'ALREADY_USED',
  'NOT_ELIGIBLE',
  'UNAVAILABLE',
  'ERROR',
] as const;

export type OfferRedemptionResult = (typeof OFFER_REDEMPTION_RESULTS)[number];

export function normalizeOfferCodeForDigest(raw: string): string {
  return raw.normalize('NFKC').trim().toUpperCase();
}

export function decodeOfferCodeHmacSecret(encoded: string | null | undefined): Uint8Array {
  const value = encoded?.trim();
  if (!value) throw new Error(`missing ${KPLUS_OFFER_CODE_HMAC_SECRET_ENV}`);

  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new Error(`invalid ${KPLUS_OFFER_CODE_HMAC_SECRET_ENV}`);
  }

  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytes.byteLength < 32) {
    throw new Error(`${KPLUS_OFFER_CODE_HMAC_SECRET_ENV} must decode to at least 32 bytes`);
  }
  return bytes;
}

export async function digestOfferCode(raw: string, secret: Uint8Array): Promise<string> {
  const normalized = normalizeOfferCodeForDigest(raw);
  // Materialize an ArrayBuffer-backed copy. Deno's WebCrypto types reject a
  // Uint8Array whose generic buffer could be SharedArrayBuffer.
  const keyBytes = Uint8Array.from(secret);
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(normalized));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function sanitizeOfferRedemptionResult(value: unknown): OfferRedemptionResult {
  return (OFFER_REDEMPTION_RESULTS as readonly unknown[]).includes(value)
    ? value as OfferRedemptionResult
    : 'ERROR';
}
