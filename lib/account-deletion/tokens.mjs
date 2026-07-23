// Runtime-neutral restoration-token helpers. Prefers the standard Web Crypto
// API (globalThis.crypto), which is available unflagged in modern Node,
// Deno, and browsers, and only falls back to node:crypto (via a dynamic
// import that is never reached outside Node) when Web Crypto is missing.

const MIN_TOKEN_BYTES = 32;

function toBase64Url(bytes) {
  let base64;
  if (typeof Buffer !== 'undefined') {
    base64 = Buffer.from(bytes).toString('base64');
  } else {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    // eslint-disable-next-line no-undef
    base64 = btoa(binary);
  }
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function toHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Generates a URL-safe, base64url-encoded restoration token from at least
 * 32 cryptographically secure random bytes.
 */
export async function generateRestorationToken(byteLength = MIN_TOKEN_BYTES) {
  const length = Math.max(MIN_TOKEN_BYTES, byteLength);
  const bytes = new Uint8Array(length);

  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    // Node < 19 without --experimental-global-webcrypto, or any runtime
    // that has not exposed globalThis.crypto. Never reached in Deno or a
    // browser, both of which always provide Web Crypto.
    const nodeCrypto = await import('node:crypto');
    nodeCrypto.randomFillSync(bytes);
  }

  return toBase64Url(bytes);
}

/**
 * Hashes a restoration token with SHA-256 and returns a lowercase hex
 * digest, suitable for storing instead of the plaintext token.
 */
export async function hashRestorationToken(token) {
  const data = new TextEncoder().encode(String(token));

  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
    return toHex(new Uint8Array(digest));
  }

  const nodeCrypto = await import('node:crypto');
  return nodeCrypto.createHash('sha256').update(token).digest('hex');
}
