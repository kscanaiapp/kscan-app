/**
 * Apple Sign in configuration, read from the Edge Function environment only.
 *
 * Every one of these is a server secret or server-only identifier. None of
 * them may appear in app.json, eas.json, any EXPO_PUBLIC_* variable, or the
 * JavaScript bundle.
 *
 *   APPLE_TEAM_ID               10-character Apple Developer Team ID (JWT `iss`)
 *   APPLE_KEY_ID                10-character Key ID of the Sign in with Apple
 *                               private key (JWT `kid`)
 *   APPLE_PRIVATE_KEY           PKCS#8 PEM contents of the .p8 (never the path,
 *                               never committed)
 *   APPLE_CLIENT_ID             client identifier. For the native iOS app this
 *                               is the bundle identifier com.kscanai.app, NOT a
 *                               web Services ID
 *   APPLE_TOKEN_ENCRYPTION_KEY  base64 of 32 random bytes, used for AES-256-GCM
 *                               at rest
 *
 * `resolveAppleConfig` returns a reason instead of throwing when something is
 * absent. That distinction matters: an unconfigured deployment must not crash
 * account deletion, it must fall through to TN3194's documented manual path.
 */

import type { AppleSigningConfig } from './appleClientSecret.ts';

export type AppleConfigResolution =
  | { configured: true; config: AppleSigningConfig; encryptionKeyBase64: string }
  | { configured: false; missing: string[] };

const REQUIRED_VARS = [
  'APPLE_TEAM_ID',
  'APPLE_KEY_ID',
  'APPLE_PRIVATE_KEY',
  'APPLE_CLIENT_ID',
  'APPLE_TOKEN_ENCRYPTION_KEY',
] as const;

export function resolveAppleConfig(
  read: (name: string) => string | undefined = (name) => Deno.env.get(name),
): AppleConfigResolution {
  const values: Record<string, string> = {};
  const missing: string[] = [];

  for (const name of REQUIRED_VARS) {
    const value = (read(name) ?? '').trim();
    if (!value) missing.push(name);
    else values[name] = value;
  }

  if (missing.length > 0) return { configured: false, missing };

  return {
    configured: true,
    config: {
      teamId: values.APPLE_TEAM_ID,
      keyId: values.APPLE_KEY_ID,
      clientId: values.APPLE_CLIENT_ID,
      privateKeyPem: values.APPLE_PRIVATE_KEY,
    },
    encryptionKeyBase64: values.APPLE_TOKEN_ENCRYPTION_KEY,
  };
}

/**
 * Apple authorization codes are opaque and short. This is a shape guard only —
 * it keeps obviously bogus input from reaching Apple and keeps an oversized
 * body from being forwarded, and is never a substitute for Apple's own
 * validation of the code.
 */
export function isPlausibleAuthorizationCode(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 8 && value.length <= 512
    && /^[A-Za-z0-9._~+/=-]+$/.test(value);
}
