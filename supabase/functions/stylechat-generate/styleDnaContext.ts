// ── Signature Style context (Phase 2) — server-side consumption ────────────────
// Pure helpers, no Deno/network imports, so they are unit-testable from node too.
//
// Backward-compatibility contract:
//   - styleDnaContext is fully optional. Absent -> null -> prompt unchanged (old apps).
//   - Malformed / disabled / below-threshold input -> null (silent no-op). Never throws.
//   - Only a compact guidance block is ever produced; no raw counts, identity, message,
//     weather, location, session, or product data is emitted into the prompt.

export interface StyleDnaContextInput {
  signalCount: number;
  helpfulCount: number;
  notMyStyleCount: number;
  confidence: 'low' | 'medium';
}

// Mirror of the client omission threshold: below this, the client should not have sent
// anything; we defensively re-check so a stale/old client can never force injection.
export const STYLE_DNA_MIN_SIGNALS = 3;

export function parseStyleDnaContext(raw: unknown): StyleDnaContextInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  // Consume only when the client explicitly enabled the feature.
  if (r.enabled !== true) return null;

  const signalCount =
    typeof r.signalCount === 'number' && Number.isFinite(r.signalCount)
      ? Math.floor(r.signalCount)
      : 0;
  if (signalCount < STYLE_DNA_MIN_SIGNALS) return null;

  const confidence =
    r.confidence === 'medium' ? 'medium' : r.confidence === 'low' ? 'low' : null;
  if (!confidence) return null;

  const helpfulCount =
    typeof r.helpfulCount === 'number' && Number.isFinite(r.helpfulCount)
      ? Math.max(0, Math.floor(r.helpfulCount))
      : 0;
  const notMyStyleCount =
    typeof r.notMyStyleCount === 'number' && Number.isFinite(r.notMyStyleCount)
      ? Math.max(0, Math.floor(r.notMyStyleCount))
      : 0;

  return { signalCount, helpfulCount, notMyStyleCount, confidence };
}

// Compact guidance, clearly separated from the system instructions. Wording is tied to
// confidence (which the client derives from signal bands: 3–5 low, 6+ medium).
export function buildStyleDnaContextBlock(ctx: StyleDnaContextInput): string {
  const body =
    ctx.confidence === 'medium'
      ? [
          'The user has given several local StyleChat feedback signals for their Signature Style.',
          'Lightly adapt recommendations toward what has received helpful feedback and away from suggestions marked not-my-style.',
          'Do not claim certainty or invent specific preferences.',
        ]
      : [
          'The user has given a small number of local StyleChat feedback signals for their Signature Style.',
          'Use this only as a light personalization signal.',
          'Do not overstate preferences or claim a defined style identity.',
        ];
  return ['[Optional Signature Style Context]', ...body, '[/Optional Signature Style Context]'].join('\n');
}
