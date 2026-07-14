import { StylistSpeechError } from './types.ts';

export interface SecretEnvironment {
  get(name: string): string | undefined;
}

export type SecretKind = 'apiKey' | 'voiceId' | 'model' | 'outputFormat';

// Format expectations for each configured secret. These are deliberately
// permissive enough to accept every owner-approved value while rejecting
// values that carry accidental quotes, whitespace, or placeholder text.
const FORMAT: Record<SecretKind, RegExp> = {
  // ElevenLabs keys are opaque tokens; forbid whitespace and quotes only.
  apiKey: /^[A-Za-z0-9_\-]{8,200}$/,
  // ElevenLabs voice IDs are short alphanumeric identifiers (owner values are 20 chars).
  voiceId: /^[A-Za-z0-9]{16,40}$/,
  // Model IDs such as `eleven_flash_v2_5`.
  model: /^[A-Za-z0-9_.\-]{3,64}$/,
  // Output formats such as `mp3_44100_128`.
  outputFormat: /^[A-Za-z0-9_]{3,32}$/,
};

const PLACEHOLDER = /^(your|placeholder|changeme|change_me|todo|tbd|xxx+|<.*>|\.\.\.|example|dummy|test_key|replace|none|null|undefined)$/i;
const QUOTE_CHARACTERS = ['"', "'", '`', '“', '”', '‘', '’'];

function looksQuoted(value: string): boolean {
  if (value.length < 2) return false;
  const first = value[0];
  const last = value[value.length - 1];
  return QUOTE_CHARACTERS.includes(first) || QUOTE_CHARACTERS.includes(last);
}

function containsWhitespace(value: string): boolean {
  return /\s/.test(value);
}

/**
 * Read and validate a required ElevenLabs secret. The value is trimmed of
 * surrounding whitespace, then rejected (as SERVER_CONFIGURATION) when it is
 * empty, a known placeholder, wrapped in accidental quote characters, contains
 * interior whitespace, or fails the identifier format for its kind.
 *
 * On failure this throws a sanitized error; it never echoes the stored value.
 */
export function readRequiredSecret(
  env: SecretEnvironment,
  name: string,
  kind: SecretKind,
): string {
  const raw = env.get(name);
  const value = typeof raw === 'string' ? raw.trim() : '';

  if (!value) {
    throw new StylistSpeechError(500, 'SERVER_CONFIGURATION', 'Speech is not configured.');
  }
  if (looksQuoted(value)) {
    throw new StylistSpeechError(500, 'SERVER_CONFIGURATION', 'Speech is not configured.');
  }
  if (containsWhitespace(value)) {
    throw new StylistSpeechError(500, 'SERVER_CONFIGURATION', 'Speech is not configured.');
  }
  if (PLACEHOLDER.test(value)) {
    throw new StylistSpeechError(500, 'SERVER_CONFIGURATION', 'Speech is not configured.');
  }
  if (!FORMAT[kind].test(value)) {
    throw new StylistSpeechError(500, 'SERVER_CONFIGURATION', 'Speech is not configured.');
  }
  return value;
}
