/**
 * Bound for spoken text. This must stay at or above `MAX_RESPONSE_CHARS` in
 * `stylechat-generate`, which is the longest reply a user can be shown: a
 * smaller value here silently narrates only part of a complete, valid Elise
 * answer. The two functions are deployed separately, so the value is restated
 * rather than imported and `__tests__/stylistVoiceLengthContract.test.js` fails
 * if the pair ever drifts apart.
 */
export const MAX_SPEECH_CHARACTERS = 1000;

const HIDDEN_BLOCK_RE = /<(?:actions|stylechat_actions|internal|system|debug)\b[^>]*>[\s\S]*?<\/(?:actions|stylechat_actions|internal|system|debug)>/gi;
const MARKDOWN_LINK_RE = /!?\[([^\]]+)\]\((?:https?:\/\/|mailto:)[^)]+\)/gi;
const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

function lastSentenceBoundary(value: string): number {
  let boundary = -1;
  const matches = value.matchAll(/[.!?](?=["'”’\])}]?(?:\s|$))/g);
  for (const match of matches) {
    if (typeof match.index === 'number') boundary = match.index + 1;
  }
  return boundary;
}

export function buildSpeechText(
  input: unknown,
  maxCharacters = MAX_SPEECH_CHARACTERS,
): string {
  if (typeof input !== 'string') return '';

  const normalized = input
    .replace(HIDDEN_BLOCK_RE, ' ')
    .replace(MARKDOWN_LINK_RE, '$1')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[`*_~#>|]+/g, ' ')
    .replace(CONTROL_CHAR_RE, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .trim();

  if (!normalized || maxCharacters <= 0) return '';
  if (normalized.length <= maxCharacters) return normalized;

  const bounded = normalized.slice(0, maxCharacters);
  const sentenceBoundary = lastSentenceBoundary(bounded);
  if (sentenceBoundary > 0) return bounded.slice(0, sentenceBoundary).trim();

  const lastWhitespace = bounded.lastIndexOf(' ');
  return (lastWhitespace > Math.floor(maxCharacters * 0.6)
    ? bounded.slice(0, lastWhitespace)
    : bounded
  ).trim();
}

export function isHiddenOrSystemOnlyMessage(input: {
  provider: string | null;
  ui_blocks: unknown;
}): boolean {
  if (input.provider?.toLowerCase() === 'system') return true;
  if (!Array.isArray(input.ui_blocks)) return false;
  const hiddenTypes = new Set(['hidden', 'internal', 'system', 'debug']);
  return input.ui_blocks.some((block) => {
    if (!block || typeof block !== 'object') return false;
    const type = (block as Record<string, unknown>).type;
    return typeof type === 'string' && hiddenTypes.has(type.toLowerCase());
  });
}
