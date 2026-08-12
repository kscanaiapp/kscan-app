/**
 * Server-side storage for the Apple refresh token that account deletion later
 * revokes.
 *
 * Protection model — two independent layers:
 *
 *   1. Database access control. public.apple_auth_credentials has RLS enabled
 *      with NO policies and an explicit REVOKE ALL from anon and authenticated,
 *      so a leaked anon key, a compromised user JWT, or a future accidental
 *      policy on a sibling table cannot read it. Only service_role reaches it.
 *
 *   2. Application-layer AES-256-GCM. The token is encrypted before it is
 *      written, with a key held only in the Edge Function environment. The key
 *      is never stored in the database and is never reachable from SQL, so a
 *      database dump — backup, snapshot, replica, or an operator with
 *      service_role — yields ciphertext and nothing else.
 *
 * The second layer is why this is not simply a text column. Apple refresh
 * tokens are long-lived bearer credentials for a user's Apple authorization;
 * they warrant more than table permissions.
 *
 * Failure of layer 2 is deliberately non-fatal at deletion time: if the key is
 * rotated or lost, the stored token is unrecoverable, and TN3194's documented
 * fallback for "you don't have the token" applies — delete the account data
 * anyway and direct the user to revoke access manually. Deletion is never
 * blocked by a key problem.
 */

const AES_KEY_BYTES = 32; // AES-256
const GCM_IV_BYTES = 12; // 96-bit nonce, the GCM standard
const ENVELOPE_VERSION = 'v1';

export type StoredAppleCredential = {
  userId: string;
  refreshToken: string;
};

function base64Encode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64Decode(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  // Explicit ArrayBuffer backing: Web Crypto's BufferSource does not accept a
  // Uint8Array typed over ArrayBufferLike.
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Import the AES key from a base64 secret.
 *
 * A wrong-length key is a configuration error and must fail loudly at the
 * point of use rather than silently degrade to storing something weaker.
 */
export async function importEncryptionKey(base64Key: string): Promise<CryptoKey> {
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = base64Decode(base64Key.trim());
  } catch {
    throw new Error('apple_token_encryption_key_malformed');
  }
  if (raw.length !== AES_KEY_BYTES) {
    throw new Error('apple_token_encryption_key_wrong_length');
  }
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/**
 * Encrypt to a self-describing envelope: `v1.<iv>.<ciphertext>`.
 *
 * The version prefix means a future key-rotation or algorithm change can be
 * introduced without guessing at how an existing row was written.
 */
export async function encryptToken(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(GCM_IV_BYTES)));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return `${ENVELOPE_VERSION}.${base64Encode(iv)}.${base64Encode(new Uint8Array(ciphertext))}`;
}

/**
 * Decrypt an envelope. Returns null rather than throwing on anything
 * unreadable — a tampered, truncated, or wrong-key value is operationally the
 * same as "no usable credential", and the deletion path already handles that.
 */
export async function decryptToken(key: CryptoKey, envelope: string): Promise<string | null> {
  const parts = envelope.split('.');
  if (parts.length !== 3 || parts[0] !== ENVELOPE_VERSION) return null;
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64Decode(parts[1]) },
      key,
      base64Decode(parts[2]),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    return null;
  }
}

export type RestClient = (
  path: string,
  init: RequestInit,
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }>;

/**
 * Upsert the encrypted credential for a user.
 *
 * Re-authorising replaces the previous token: Apple issues a new refresh token
 * per authorization, and keeping the stale one would leave us revoking
 * something that no longer represents the user's current grant.
 */
export async function saveEncryptedCredential(params: {
  rest: RestClient;
  userId: string;
  envelope: string;
}): Promise<boolean> {
  const response = await params.rest('apple_auth_credentials', {
    method: 'POST',
    headers: {
      Prefer: 'resolution=merge-duplicates,return=minimal',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      user_id: params.userId,
      encrypted_refresh_token: params.envelope,
      updated_at: new Date().toISOString(),
    }),
  });
  return response.ok;
}

export type CredentialLookup =
  | { found: true; envelope: string }
  | { found: false }
  | { error: true };

export async function loadEncryptedCredential(params: {
  rest: RestClient;
  userId: string;
}): Promise<CredentialLookup> {
  const response = await params.rest(
    `apple_auth_credentials?user_id=eq.${params.userId}&select=encrypted_refresh_token&limit=1`,
    { method: 'GET' },
  );
  if (!response.ok) return { error: true };

  const rows = (await response.json()) as Array<{ encrypted_refresh_token?: unknown }> | null;
  if (!Array.isArray(rows) || rows.length === 0) return { found: false };

  const envelope = rows[0]?.encrypted_refresh_token;
  if (typeof envelope !== 'string' || !envelope) return { found: false };
  return { found: true, envelope };
}

/**
 * Erase the stored credential. TN3194 requires deleting "the token used for
 * token revocation" as part of completing an account deletion.
 */
export async function deleteCredential(params: {
  rest: RestClient;
  userId: string;
}): Promise<boolean> {
  const response = await params.rest(`apple_auth_credentials?user_id=eq.${params.userId}`, {
    method: 'DELETE',
    headers: { Prefer: 'return=minimal' },
  });
  return response.ok;
}
