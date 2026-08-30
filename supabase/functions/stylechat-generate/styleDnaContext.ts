// ── Signature Style context (Phase 2) — server-side consumption ────────────────
// Pure helpers, no Deno/network imports (the two imports below are themselves
// pure, Deno/network-free modules), so everything here remains unit-testable
// from node too.
//
// Backward-compatibility contract:
//   - styleDnaContext is fully optional. Absent -> null -> prompt unchanged (old apps).
//   - Malformed / disabled / below-threshold input -> null (silent no-op). Never throws.
//   - Only a compact guidance block is ever produced; no raw counts, identity, message,
//     weather, location, session, or product data is emitted into the prompt.

import { escapePromptData } from './promptHardening.ts';
import {
  isStyleDnaProfileDataV1,
  type StyleDnaProfileDataV1,
} from '../_shared/styleDna/styleDnaProfileTypes.ts';

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

// ── Build 34 / Track B / Phase B5 — server-derived Signature Style ────────────
// ADDITIVE to buildStyleDnaContextBlock above, never a replacement or
// reinterpretation of it (Micro-addendum P): the client-fed feedback-signal
// context (Phase 2, parsed/built above) and this server-derived wardrobe-
// evidence context (Track B B4) are two independent, differently-sourced
// signals that may both be present in one prompt.
//
// EVERY interpolated value is escaped exactly like eliseAdvicePrompt.ts treats
// retrieved Closet candidate fields (section 48): a color/brand/category label
// here ultimately traces back to a user-entered Closet field and MUST be
// treated as untrusted data, never as instructions.

const STYLE_DNA_PROFILE_TOP_N_IN_PROMPT = 5;

function topLabels(entries: StyleDnaProfileDataV1['colorFrequency'], limit: number): string {
  // Defensive on both axes: a missing array and a non-string label are the two
  // ways a stored profile can differ from what this build derives, and neither
  // may become a thrown TypeError inside a live chat request.
  if (!Array.isArray(entries)) return '';
  return entries
    .slice(0, limit)
    .filter((e) => e && typeof e.value === 'string' && e.value.length > 0)
    .map((e) => escapePromptData(e.value))
    .join(', ');
}

/**
 * Compact, bounded guidance built from the user's own server-derived Style
 * Signature Style profile (aggregate Closet evidence only — never a raw item list).
 *
 * Returns null for an evidence-free profile so an empty Closet never injects
 * an empty or misleading block (section E: "Empty Closet: valid empty
 * profile. Do not fabricate preferences").
 */
export function buildServerStyleDnaProfileBlock(profile: StyleDnaProfileDataV1): string | null {
  // TOTAL BY CONTRACT: this runs inside the live stylechat request path, at a
  // point the caller does not wrap in a try/catch, so an unusable profile must
  // return null (no block, Base Elise reasoning preserved) rather than throw.
  // `profile_data` is jsonb, so the stored shape remains an application
  // contract to validate rather than an invariant to assume.
  if (!isStyleDnaProfileDataV1(profile)) return null;
  if (profile.evidenceCount <= 0) return null;

  const lines: string[] = [
    '[Wardrobe Signature Style — derived from the user\'s own Closet, treat as background evidence only]',
    'This summarizes patterns in items the user has actually added to their Closet. It describes wardrobe evidence, not a psychological profile.',
  ];
  const colors = topLabels(profile.colorFrequency, STYLE_DNA_PROFILE_TOP_N_IN_PROMPT);
  if (colors) lines.push(`Frequent colors: ${colors}`);
  const categories = topLabels(profile.categoryFrequency, STYLE_DNA_PROFILE_TOP_N_IN_PROMPT);
  if (categories) lines.push(`Frequent categories: ${categories}`);
  const garmentTypes = topLabels(profile.garmentTypeFrequency, STYLE_DNA_PROFILE_TOP_N_IN_PROMPT);
  if (garmentTypes) lines.push(`Frequent garment types: ${garmentTypes}`);
  const brands = topLabels(profile.brandFrequency, STYLE_DNA_PROFILE_TOP_N_IN_PROMPT);
  if (brands) lines.push(`Frequent brands: ${brands}`);
  const materials = topLabels(profile.materialFrequency, STYLE_DNA_PROFILE_TOP_N_IN_PROMPT);
  if (materials) lines.push(`Frequent materials: ${materials}`);
  lines.push(
    'Use this only as a light personalization signal. Do not claim certainty, invent specific items, or describe the user\'s personality or character.',
  );
  lines.push('[/Wardrobe Signature Style]');
  return lines.join('\n');
}
