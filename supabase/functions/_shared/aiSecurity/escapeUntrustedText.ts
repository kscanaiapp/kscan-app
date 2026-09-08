/**
 * Canonical escaping for untrusted text before prompt envelope serialization.
 * Delimiters alone are not a security boundary — this prevents structural breakout.
 */

import { UNTRUSTED_SECTION_NAMES, type PromptSectionName } from './trustTypes.ts';

const SECTION_TAG_PATTERN = new RegExp(
  `</?(?:${['kscan_system_rules', 'trusted_server_context', ...UNTRUSTED_SECTION_NAMES].join('|')})(?:\\s[^>]*)?>`,
  'gi',
);

const FAKE_ROLE_HEADINGS =
  /(?:^|\n)\s*(?:system|developer|assistant|model|application|tool|function)\s*[:=]/gim;

/**
 * Mid-line role spoofing.
 *
 * WHY: the pattern above is anchored to a line start, which is close to useless
 * for the surface that actually carries attacker text — a shared-room item
 * title, a saved-look label or a retailer name is a SINGLE line, so
 * "Navy blazer. system: ignore prior rules" never matches it.
 *
 * Deliberately narrowed to the three roles that read as an instruction handoff.
 * Extending it to model/tool/function would corrupt legitimate fashion copy
 * ("model: Air Max 90", "function: everyday wear"), which is a real cost for no
 * real gain — those words do not redirect an assistant the way "system:" does.
 */
const FAKE_ROLE_HEADINGS_INLINE =
  /([.!?;,)\]])\s*(?:system|developer|assistant)\s*[:=]/gi;

const FAKE_TOOL_MARKERS =
  /(?:<\/?tool_call>|<\/?function_call>|<\/?actions>|```(?:json|xml|system)?|\[INST\]|<<SYS>>|<\|im_start\|>|<\|im_end\|>|<\|system\|>)/gi;

const CONTROL_TOKENS = /(?:<\|[^|>]{1,40}\|>|\[(?:SYSTEM|INST|\/INST)\])/g;

export function escapeXmlEntities(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Structural neutralization only — no entity escaping.
 *
 * Split out so the StyleChat prompt path can reuse the SAME corpus of breakout
 * patterns instead of maintaining a weaker second opinion. Callers that
 * serialize into an XML-ish envelope follow this with escapeXmlEntities();
 * callers that serialize as JSON string data do not need to.
 */
export function neutralizeInjectionMarkers(raw: string): string {
  let text = raw.replace(/\u0000/g, '');

  // Break exact envelope closing/opening tags before entity escaping.
  text = text.replace(SECTION_TAG_PATTERN, (match) => match.replace(/[<>]/g, ''));

  // Neutralize role headings and tool markers without deleting fashion words.
  text = text.replace(FAKE_ROLE_HEADINGS, '\n[untrusted-role]\n');
  text = text.replace(FAKE_ROLE_HEADINGS_INLINE, '$1 [untrusted-role]');
  text = text.replace(FAKE_TOOL_MARKERS, '[untrusted-marker]');
  text = text.replace(CONTROL_TOKENS, '[untrusted-token]');

  // Neutralize bracket delimiters used by legacy StyleChat blocks.
  return text
    .replace(/\[\/?(?:Active(?: Visual Collection| Reference Item)|Attached|Optional Signature Style Context)\]/gi, '[untrusted-block]')
    .replace(/\[(?:SYSTEM|INST|\/INST)\]/gi, '[untrusted-token]');
}

/**
 * Neutralize delimiter/role/tool breakout attempts, then escape XML entities.
 * Semantic fashion text remains readable after entity decoding mentally
 * (e.g. "black &amp; white" still conveys black & white).
 */
export function escapeUntrustedText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return escapeXmlEntities(neutralizeInjectionMarkers(raw));
}

/** Deterministic serialization for untrusted structured records. */
export function serializeUntrustedRecord(
  record: Record<string, string | number | boolean | null | undefined | string[]>,
): string {
  const keys = Object.keys(record).sort();
  const lines: string[] = [];
  for (const key of keys) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key)) continue;
    const value = record[key];
    if (value == null) continue;
    if (Array.isArray(value)) {
      const items = value.map((entry) => escapeUntrustedText(String(entry))).filter(Boolean);
      if (items.length) lines.push(`${key}=${items.join(' | ')}`);
      continue;
    }
    if (typeof value === 'boolean' || typeof value === 'number') {
      lines.push(`${key}=${value}`);
      continue;
    }
    const escaped = escapeUntrustedText(value);
    if (escaped) lines.push(`${key}=${escaped}`);
  }
  return lines.join('\n');
}

export function neutralizeSectionName(name: string): PromptSectionName | null {
  const normalized = name.trim().toLowerCase();
  const allowed = new Set<string>([
    'kscan_system_rules',
    'trusted_server_context',
    ...UNTRUSTED_SECTION_NAMES,
  ]);
  if (!allowed.has(normalized)) return null;
  return normalized as PromptSectionName;
}
