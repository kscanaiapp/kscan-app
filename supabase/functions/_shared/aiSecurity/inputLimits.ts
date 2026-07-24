/**
 * Explicit per-field input limits for Elise and TypeChat/TextScan.
 * Descriptive fields may be deterministically truncated; action-critical fields reject.
 */

export const AI_INPUT_LIMITS = {
  eliseUserMessage: 500,
  typeChatQuery: 500,
  focusText: 200,
  attachmentLabel: 80,
  visualCaption: 500,
  visualTitle: 160,
  savedNote: 500,
  commerceTitle: 200,
  commerceDescription: 500,
  conversationMessage: 1000,
  conversationHistoryMessages: 6,
  closetContext: 500,
  signatureStyleContext: 500,
  styleDnaContext: 280,
  sharedRoomContent: 500,
  totalPromptChars: 24_000,
  arrayItems: 8,
  arrayItemChars: 80,
} as const;

export type AiInputField = keyof typeof AI_INPUT_LIMITS;

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const RAW_PATH_OR_DATA = /(?:file|content):\/\/|data:image\/|;base64,/i;
// Require base64 alphabet markers so long alphabetic fashion phrases are not rejected.
const BASE64_LIKE = /^(?:[A-Za-z0-9+/]{64,}={1,2}|[A-Za-z0-9+/]*[+/][A-Za-z0-9+/]{20,}={0,2})$/;
const JWT_LIKE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const API_KEY_LIKE =
  /\b(?:sk-|AIza|ghp_|xox[baprs]-|Bearer\s+[A-Za-z0-9._\-]+)[A-Za-z0-9._\-]{8,}\b/gi;
const AUTH_HEADER_LIKE = /\bAuthorization\s*:\s*\S+/gi;
const UUID_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

export type BoundTextResult =
  | { ok: true; value: string; truncated: boolean }
  | { ok: false; reason: string };

export type BoundMode = 'truncate' | 'reject';

/**
 * Normalize line endings, strip control chars, reject binary/path payloads,
 * and optionally strip secret-like tokens before applying a hard char cap.
 */
export function boundTextField(
  raw: unknown,
  maxChars: number,
  options: { mode?: BoundMode; stripSecrets?: boolean; stripUserIds?: boolean } = {},
): BoundTextResult {
  const mode = options.mode ?? 'truncate';
  const stripSecrets = options.stripSecrets !== false;
  const stripUserIds = options.stripUserIds === true;

  if (typeof raw !== 'string') {
    return { ok: false, reason: 'not_string' };
  }

  let value = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  value = value.replace(CONTROL_CHARS, ' ');
  value = value.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  value = value.replace(/[^\S\n]+/g, ' ').trim();

  if (!value) return { ok: false, reason: 'empty' };
  if (RAW_PATH_OR_DATA.test(value)) return { ok: false, reason: 'raw_path_or_data' };
  if (value.length >= 64 && BASE64_LIKE.test(value.replace(/\s/g, ''))) {
    return { ok: false, reason: 'binary_like' };
  }

  if (stripSecrets) {
    value = value.replace(JWT_LIKE, '[redacted_token]');
    value = value.replace(API_KEY_LIKE, '[redacted_secret]');
    value = value.replace(AUTH_HEADER_LIKE, '[redacted_auth]');
  }
  if (stripUserIds) {
    value = value.replace(UUID_RE, '[redacted_id]');
  }

  value = value.trim();
  if (!value) return { ok: false, reason: 'empty_after_strip' };

  if (value.length <= maxChars) {
    return { ok: true, value, truncated: false };
  }
  if (mode === 'reject') {
    return { ok: false, reason: 'too_long' };
  }
  return { ok: true, value: value.slice(0, maxChars), truncated: true };
}

export function boundStringArray(
  raw: unknown,
  maxItems = AI_INPUT_LIMITS.arrayItems,
  maxItemChars = AI_INPUT_LIMITS.arrayItemChars,
): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw.slice(0, maxItems)) {
    const bound = boundTextField(entry, maxItemChars, { mode: 'truncate' });
    if (bound.ok) out.push(bound.value);
  }
  return out;
}

export function assertTotalPromptBudget(sections: string[], max = AI_INPUT_LIMITS.totalPromptChars): {
  ok: boolean;
  totalChars: number;
} {
  const totalChars = sections.reduce((sum, part) => sum + (part?.length ?? 0), 0);
  return { ok: totalChars <= max, totalChars };
}
