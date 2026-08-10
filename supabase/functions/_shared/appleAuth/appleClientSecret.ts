/**
 * Apple client-secret JWT generation.
 *
 * Apple does not accept a static client secret. Every call to /auth/token and
 * /auth/revoke must carry a freshly signed ES256 JWT proving possession of the
 * team's Sign in with Apple private key. See Apple's "Creating a client secret":
 * https://developer.apple.com/documentation/accountorganizationaldatasharing/creating-a-client-secret
 *
 *   header   alg = ES256, kid = the 10-character Key ID
 *   payload  iss = the 10-character Team ID
 *            iat = now
 *            exp = on or after which the secret expires; Apple rejects anything
 *                  more than 15777000 seconds (six months) ahead of ITS clock
 *            aud = https://appleid.apple.com
 *            sub = the same App ID / Services ID used as client_id
 *
 * We mint a short-lived secret per request rather than caching a long one. It
 * costs one P-256 signature, keeps the window small if a secret ever leaked
 * through a log, and removes any chance of drifting past Apple's ceiling.
 *
 * The private key is read from the environment and never leaves this module:
 * it is not returned, not logged, and not persisted.
 */

/** Apple's fixed audience for every client secret. */
export const APPLE_AUDIENCE = 'https://appleid.apple.com';

/** Apple's documented hard ceiling for `exp - iat`, in seconds (six months). */
export const APPLE_MAX_CLIENT_SECRET_LIFETIME_SECONDS = 15777000;

/** How long our secrets actually live. Far below Apple's ceiling on purpose. */
export const CLIENT_SECRET_LIFETIME_SECONDS = 300;

export type AppleSigningConfig = {
  /** 10-character Apple Team ID — becomes the `iss` claim. */
  teamId: string;
  /** 10-character Key ID for the .p8 — becomes the `kid` header. */
  keyId: string;
  /**
   * The client identifier. For a NATIVE iOS app this is the app's bundle
   * identifier (App ID), not a web Services ID. Becomes both `sub` and the
   * `client_id` form field.
   */
  clientId: string;
  /** PKCS#8 PEM contents of the .p8 private key. */
  privateKeyPem: string;
};

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function encodeJsonSegment(value: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

/**
 * Decode a PKCS#8 PEM body to DER.
 *
 * Apple hands out the .p8 with real newlines. Secret managers frequently
 * normalise those to literal "\n", and copy/paste often loses them entirely,
 * so we accept all three shapes rather than failing on formatting. Only the
 * base64 body matters.
 */
export function decodePkcs8Pem(pem: string): Uint8Array<ArrayBuffer> {
  const normalized = pem.replace(/\\n/g, '\n').trim();
  const match = normalized.match(
    /-----BEGIN PRIVATE KEY-----([\s\S]+?)-----END PRIVATE KEY-----/,
  );
  const body = (match ? match[1] : normalized).replace(/\s+/g, '');
  if (!body) throw new Error('apple_private_key_malformed');

  let binary: string;
  try {
    binary = atob(body);
  } catch {
    throw new Error('apple_private_key_malformed');
  }

  // Backed by an explicit ArrayBuffer so the result satisfies BufferSource;
  // a plain `new Uint8Array(n)` is typed over ArrayBufferLike, which Web Crypto
  // will not accept.
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function importSigningKey(privateKeyPem: string): Promise<CryptoKey> {
  try {
    return await crypto.subtle.importKey(
      'pkcs8',
      decodePkcs8Pem(privateKeyPem),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false, // never extractable
      ['sign'],
    );
  } catch (error) {
    // Deliberately opaque: the message must not echo key material.
    if (error instanceof Error && error.message === 'apple_private_key_malformed') throw error;
    throw new Error('apple_private_key_unusable');
  }
}

export type ClientSecretClaims = {
  iss: string;
  iat: number;
  exp: number;
  aud: string;
  sub: string;
};

/**
 * Build the claim set. Split out from signing so tests can assert the claims
 * against Apple's specification without needing a private key.
 */
export function buildClientSecretClaims(
  config: Pick<AppleSigningConfig, 'teamId' | 'clientId'>,
  nowSeconds: number,
  lifetimeSeconds: number = CLIENT_SECRET_LIFETIME_SECONDS,
): ClientSecretClaims {
  if (!config.teamId) throw new Error('apple_team_id_missing');
  if (!config.clientId) throw new Error('apple_client_id_missing');
  if (lifetimeSeconds <= 0) throw new Error('apple_client_secret_lifetime_invalid');
  if (lifetimeSeconds > APPLE_MAX_CLIENT_SECRET_LIFETIME_SECONDS) {
    throw new Error('apple_client_secret_lifetime_exceeds_apple_maximum');
  }

  const iat = Math.floor(nowSeconds);
  return {
    iss: config.teamId,
    iat,
    exp: iat + lifetimeSeconds,
    aud: APPLE_AUDIENCE,
    sub: config.clientId,
  };
}

/**
 * Sign an Apple client secret.
 *
 * Web Crypto's ECDSA output is already the raw r‖s pair JWS requires, so no
 * DER unwrapping is needed — a DER-encoded signature here would be rejected by
 * Apple as `invalid_client`.
 */
export async function createAppleClientSecret(
  config: AppleSigningConfig,
  nowSeconds: number = Date.now() / 1000,
  lifetimeSeconds: number = CLIENT_SECRET_LIFETIME_SECONDS,
): Promise<string> {
  if (!config.keyId) throw new Error('apple_key_id_missing');

  const header = { alg: 'ES256', kid: config.keyId, typ: 'JWT' };
  const claims = buildClientSecretClaims(config, nowSeconds, lifetimeSeconds);
  const signingInput = `${encodeJsonSegment(header)}.${encodeJsonSegment(claims)}`;

  const key = await importSigningKey(config.privateKeyPem);
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(signingInput),
  );

  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}
