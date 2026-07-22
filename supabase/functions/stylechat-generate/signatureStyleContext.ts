// signatureStyleContext.ts — Bounded, server-verified Signature Style preference block.
// Source signals: dressing_room_items + positive dressing_room_item_reactions
// (same authority as client buildStyleMemorySummary; never trust client traits).

export const SIGNATURE_STYLE_MAX_SIGNALS_PER_GROUP = 5;
export const SIGNATURE_STYLE_MAX_CHARS = 500;

export type SignatureStyleSignals = {
  brands: string[];
  colors: string[];
  categories: string[];
  budgetMin: number | null;
  budgetMax: number | null;
};

export type SignatureStyleBlock = {
  text: string | null;
  signalCount: number;
};

function clampList(values: string[], max: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Build a deterministic Signature Style prompt section from verified stored fields only.
 * Truncates by signal count then total characters.
 */
export function buildSignatureStyleContextBlock(
  signals: SignatureStyleSignals,
): SignatureStyleBlock {
  const brands = clampList(signals.brands, SIGNATURE_STYLE_MAX_SIGNALS_PER_GROUP);
  const colors = clampList(signals.colors, SIGNATURE_STYLE_MAX_SIGNALS_PER_GROUP);
  const categories = clampList(signals.categories, SIGNATURE_STYLE_MAX_SIGNALS_PER_GROUP);

  const preferenceLines: string[] = [];
  if (brands.length) preferenceLines.push(`- Preferred brands: ${brands.join(', ')}`);
  if (categories.length) preferenceLines.push(`- Common categories: ${categories.join(', ')}`);
  if (colors.length) preferenceLines.push(`- Preferred colors: ${colors.join(', ')}`);
  if (signals.budgetMin !== null || signals.budgetMax !== null) {
    const lo = signals.budgetMin !== null ? `$${Math.round(signals.budgetMin)}` : '';
    const hi = signals.budgetMax !== null ? `$${Math.round(signals.budgetMax)}` : '';
    const range = lo && hi ? `${lo}-${hi}` : lo || hi;
    if (range) preferenceLines.push(`- Observed budget range: ${range}`);
  }

  const signalCount = preferenceLines.length;
  if (signalCount === 0) {
    return { text: null, signalCount: 0 };
  }

  const confidenceBoundary =
    signalCount >= 3
      ? '- Confidence boundary: multiple stored preference signals; treat as moderate preference hints.'
      : '- Confidence boundary: limited stored preference signals; keep personalization light.';

  const body = [
    'SIGNATURE STYLE CONTEXT',
    '',
    'Verified preference signals:',
    ...preferenceLines,
    confidenceBoundary,
    '',
    'Treat these as preference signals, not absolute rules.',
    "The user's current explicit request takes priority.",
    'Do not invent missing preferences.',
    'Do not claim greater confidence than the supplied data supports.',
  ].join('\n');

  if (body.length <= SIGNATURE_STYLE_MAX_CHARS) {
    return { text: body, signalCount };
  }

  // Deterministic truncation: keep header + as many preference lines as fit.
  const header = [
    'SIGNATURE STYLE CONTEXT',
    '',
    'Verified preference signals:',
  ];
  const footer = [
    confidenceBoundary,
    '',
    'Treat these as preference signals, not absolute rules.',
    "The user's current explicit request takes priority.",
    'Do not invent missing preferences.',
  ];
  const kept: string[] = [];
  let used = [...header, ...footer].join('\n').length;
  for (const line of preferenceLines) {
    const next = used + line.length + 1;
    if (next > SIGNATURE_STYLE_MAX_CHARS) break;
    kept.push(line);
    used = next;
  }
  if (kept.length === 0) {
    return { text: null, signalCount: 0 };
  }
  return {
    text: [...header, ...kept, ...footer].join('\n').slice(0, SIGNATURE_STYLE_MAX_CHARS),
    signalCount: kept.length,
  };
}
