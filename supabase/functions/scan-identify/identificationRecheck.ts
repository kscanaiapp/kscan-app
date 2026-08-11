/**
 * Focused second-pass fashion recheck (Phase 7.1 §7–§9, §19).
 *
 * ONE additional fashion-analysis call, for the disputed garment identity only.
 * There is no retry, no escalation to another model, no recursion and no voting
 * panel — the single call either produces a compact triple or the scan keeps its
 * primary identification unchanged.
 *
 * TRANSPORT INDEPENDENCE: the provider call is injected. That is what lets the
 * whole architecture — prompt construction, truncation handling, parsing,
 * failure classification and fail-open behavior — be proven locally against
 * deterministic fixtures with zero provider calls and zero spend.
 */

// @ts-ignore Deno local imports require explicit TypeScript extensions.
import { RECHECK_MAX_OUTPUT_TOKENS } from './identificationRecheckConfig.ts';
import type { IdentityTriple, RecheckReasonCode } from './identificationRecheckGate.ts';

/** The compact structured identity the recheck is allowed to return. */
export const RECHECK_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    category: { type: 'STRING' },
    clothing_type: { type: 'STRING' },
    subtype: { type: 'STRING' },
    confidence: { type: 'NUMBER', minimum: 0, maximum: 1 },
    // Phase 7.2 §15: when a recheck is ALREADY happening for garment identity,
    // the same call may reassess brand evidence. These add no provider call —
    // brand uncertainty never triggers a recheck on its own.
    brand: { type: 'STRING' },
    brand_evidence_level: {
      type: 'STRING',
      enum: ['direct', 'distinctive', 'style_only', 'none'],
    },
    // WHICH KIND of mark was read. Load-bearing, not decorative: adoption maps
    // this onto the artifact field that actually backs it (visible_brand_text
    // for a read mark, logo_detected for a recognized one), so an adopted brand
    // passes the SAME evidence gate as a first-pass one instead of being
    // exempted from it.
    brand_evidence_type: {
      type: 'STRING',
      enum: ['wordmark', 'logo', 'label', 'monogram', 'none'],
    },
    brand_evidence_on_item: { type: 'BOOLEAN' },
  },
  // The taxonomy keys stay required so "unknown" is always an available ANSWER
  // rather than an omission the parser has to interpret. Requiring the KEY never
  // forces a fabricated VALUE — the prompt sanctions "unknown" explicitly, the
  // same convention the primary selected-item schema already relies on.
  //
  // The brand keys are OPTIONAL on purpose: a recheck that says nothing about
  // brand must be able to say nothing, because silence is the correct output
  // when no brand evidence is visible, and a required brand key would pressure
  // the model to fill it.
  required: ['category', 'clothing_type', 'subtype', 'confidence'],
} as const;

export type RecheckGarmentContext = {
  candidateId: string;
  category: string;
  subtype?: string;
  bounds?: { x: number; y: number; width: number; height: number };
};

export type RecheckPromptInput = {
  primary: IdentityTriple;
  primaryConfidence: number | null;
  reasonCodes: RecheckReasonCode[];
  /** Present only when a multi-item selection resolved this garment. */
  garmentContext: RecheckGarmentContext | null;
  /**
   * Phase 7.2: the discriminator pack for the family the first pass already
   * established. Null when no family resolved — in which case the recheck asks
   * the generic question rather than one aimed at the wrong evidence.
   */
  discriminatorFocus?: { family: string; focus: string } | null;
  /** Whether the primary pass already established a brand. */
  primaryBrand?: string | null;
};

/**
 * Builds the recheck instruction.
 *
 * NOT a repeat of the original scanner prompt: it carries no commerce
 * instructions, no search-query generation, no attribute inventory, no user-copy
 * request and no detection vocabulary. It restates only the disputed identity.
 *
 * NO CHAIN-OF-THOUGHT AND NO PROSE ARE REQUESTED. Phase 6 established that
 * reasoning tokens draw from the same ceiling as the structured answer, so an
 * essay is not merely wasteful here — it is the mechanism by which the answer
 * gets truncated away.
 */
export function buildRecheckPrompt(input: RecheckPromptInput): string {
  const shown = (value: string | null): string =>
    typeof value === 'string' && value.trim().length > 0 ? value.trim() : 'unknown';

  const focus = input.garmentContext
    ? `\nThe garment under review is the one previously selected from this image: ${
      JSON.stringify({
        category: input.garmentContext.category,
        ...(input.garmentContext.subtype ? { subtype: input.garmentContext.subtype } : {}),
        ...(input.garmentContext.bounds ? { bounds: input.garmentContext.bounds } : {}),
      })
    }\nUse its normalized bounds to locate it. Do not switch to a larger, more central, or more recognizable garment.\n`
    : '';

  return `You are K Scan AI's fashion identification reviewer.

A first identification pass has already run on this image. Re-evaluate the garment identity.

The first-pass result may be correct. Do not change a field merely because a second answer is requested.
${focus}
First-pass result:
- category: ${shown(input.primary.category)}
- clothing_type: ${shown(input.primary.clothingType)}
- subtype: ${shown(input.primary.subtype)}
- first-pass confidence: ${input.primaryConfidence === null ? 'not reported' : input.primaryConfidence.toFixed(2)}

Flagged for review because: ${input.reasonCodes.join(', ') || 'unspecified'}
${
    input.discriminatorFocus
      ? `\nThis is a ${input.discriminatorFocus.family} item. Re-evaluate it using: ${input.discriminatorFocus.focus}\nThese are attention cues, not answers — report only what the image supports.\n`
      : ''
  }
Focus specifically on the disputed part of this hierarchy:
- category is the broad family (for example: pants, top, footwear, outerwear)
- clothing_type is the recognizable garment family (for example: jeans, blazer, boot)
- subtype is the specific variant (for example: wide_leg_jeans, chelsea_boot)

These are three independent judgements. Do not restate one level as another. Do not derive a level from a neighbouring level.

Use only visible garment evidence.
Prefer uncertainty over unsupported specificity: answer "unknown" for any level the image does not actually support.
Set confidence to your support for the levels you did assert.

${
    input.primaryBrand
      ? `The brand is already established as ${input.primaryBrand}. Do not revisit it.\n`
      : `Brand: only if a readable wordmark, recognizable logo, branded label or identifiable monogram is visible ON this garment, report it as "brand" with brand_evidence_level "direct" and brand_evidence_on_item true.
Style resemblance, athletic or luxury appearance, colourway and common stitching are never brand evidence — report brand_evidence_level "style_only" and omit "brand".
Ignore marks on backgrounds, screens, watermarks, packaging, shopping bags, retailer signage and any other garment.
Size, care and composition text is not a brand. Never complete partially obscured letters.
If no qualifying brand evidence is visible, omit "brand" entirely. Unknown brand is a correct answer.\n`
  }
Ignore people, faces, bodies, bystanders, backgrounds, rooms and vehicles.
Do not identify people. Do not infer any protected trait.
Do not suggest products, retailers, prices, search queries or where to buy.

Return strict JSON only with the keys: category, clothing_type, subtype, confidence.
No markdown. No commentary. No explanation.`;
}

// ── Provider seam ────────────────────────────────────────────────────────────

export type RecheckTokenUsage = {
  inputTokens: number | null;
  responseTokens: number | null;
  /** Reasoning tokens. Billed, invisible, and drawn from the same ceiling. */
  thinkingTokens: number | null;
  totalTokens: number | null;
};

export type RecheckProviderResult = {
  ok: boolean;
  /** Model text, when the call produced any. */
  text: string | null;
  finishReason: string | null;
  usage: RecheckTokenUsage | null;
  /** Set when ok is false. Bounded vocabulary, never a raw provider string. */
  failureKind:
    | 'timeout'
    | 'http_error'
    | 'network_error'
    | 'empty_response'
    | null;
};

export type RecheckProvider = (request: {
  prompt: string;
  imageBase64: string;
  mimeType: string;
  maxOutputTokens: number;
  responseSchema: typeof RECHECK_RESPONSE_SCHEMA;
}) => Promise<RecheckProviderResult>;

export type RecheckFailureReason =
  | 'timeout'
  | 'http_error'
  | 'network_error'
  | 'empty_response'
  | 'max_tokens_truncated'
  | 'malformed_output';

export type RecheckOutcome =
  | {
    status: 'completed';
    identity: IdentityTriple;
    confidence: number | null;
    brand: RecheckBrandFinding;
    finishReason: string | null;
    usage: RecheckTokenUsage | null;
    latencyMs: number;
  }
  | {
    status: 'failed';
    reason: RecheckFailureReason;
    finishReason: string | null;
    usage: RecheckTokenUsage | null;
    latencyMs: number;
  };

function normalizeLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // "unknown" is a legitimate, prompt-sanctioned ANSWER meaning "I decline to
  // assert this level". It is folded to null here so that declining and omitting
  // reach reconciliation as the same thing.
  if (/^(unknown|n\/a|none|null|undefined)$/i.test(trimmed)) return null;
  if (trimmed.length > 80) return null;
  return trimmed;
}

function normalizeConfidence(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(1, value));
}

/**
 * Tolerant JSON extraction, bounded.
 *
 * Accepts a bare object or one wrapped in a fenced block, because those are the
 * two shapes a model actually emits under `responseMimeType: application/json`.
 * It does NOT attempt to repair truncated JSON: a half-written object is exactly
 * the Phase 6 failure mode, and salvaging fields from one would reconcile
 * against an answer the model never finished making.
 */
export type RecheckBrandFinding = {
  brand: string | null;
  evidenceLevel: 'direct' | 'distinctive' | 'style_only' | 'none' | null;
  evidenceType: 'wordmark' | 'logo' | 'label' | 'monogram' | 'none' | null;
  evidenceOnItem: boolean | null;
};

export function parseRecheckPayload(text: string | null): {
  identity: IdentityTriple;
  confidence: number | null;
  brand: RecheckBrandFinding;
} | null {
  if (typeof text !== 'string') return null;
  let candidate = text.trim();
  if (!candidate) return null;

  const fenced = candidate.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) candidate = fenced[1].trim();

  if (!candidate.startsWith('{')) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;
    candidate = candidate.slice(start, end + 1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const record = parsed as Record<string, unknown>;
  // At least one taxonomy key must be present. An object carrying only a
  // confidence number is not an identity and must not be reconciled as one.
  const hasAnyTier = ['category', 'clothing_type', 'subtype'].some((key) => key in record);
  if (!hasAnyTier) return null;

  const rawLevel = record.brand_evidence_level;
  const evidenceLevel =
    rawLevel === 'direct' || rawLevel === 'distinctive' || rawLevel === 'style_only' ||
      rawLevel === 'none'
      ? rawLevel
      : null;

  return {
    identity: {
      category: normalizeLabel(record.category),
      clothingType: normalizeLabel(record.clothing_type),
      subtype: normalizeLabel(record.subtype),
    },
    confidence: normalizeConfidence(record.confidence),
    brand: {
      brand: normalizeLabel(record.brand),
      evidenceLevel,
      evidenceType: record.brand_evidence_type === 'wordmark' ||
          record.brand_evidence_type === 'logo' ||
          record.brand_evidence_type === 'label' ||
          record.brand_evidence_type === 'monogram' ||
          record.brand_evidence_type === 'none'
        ? record.brand_evidence_type
        : null,
      // Absent attestation stays NULL and is never read as confirmation.
      evidenceOnItem: typeof record.brand_evidence_on_item === 'boolean'
        ? record.brand_evidence_on_item
        : null,
    },
  };
}

/**
 * Runs the single recheck call and classifies its result.
 *
 * FAIL-OPEN IS TOTAL (§19): every failure path returns `status: 'failed'`, and
 * this function never throws. A caller that keeps its primary identification on
 * a failed outcome cannot be made to lose a usable scan by anything that happens
 * in here — including a provider exception, which is caught rather than
 * propagated.
 */
export async function performIdentificationRecheck(
  input: RecheckPromptInput & { imageBase64: string; mimeType: string },
  provider: RecheckProvider,
  now: () => number = () => Date.now(),
): Promise<RecheckOutcome> {
  const startedAt = now();
  const prompt = buildRecheckPrompt(input);

  let result: RecheckProviderResult;
  try {
    result = await provider({
      prompt,
      imageBase64: input.imageBase64,
      mimeType: input.mimeType,
      maxOutputTokens: RECHECK_MAX_OUTPUT_TOKENS,
      responseSchema: RECHECK_RESPONSE_SCHEMA,
    });
  } catch {
    // A provider that throws is a failed recheck, not a failed scan.
    return {
      status: 'failed',
      reason: 'network_error',
      finishReason: null,
      usage: null,
      latencyMs: now() - startedAt,
    };
  }

  const latencyMs = now() - startedAt;
  const finishReason = result.finishReason ?? null;
  const usage = result.usage ?? null;

  if (!result.ok) {
    return {
      status: 'failed',
      reason: result.failureKind ?? 'network_error',
      finishReason,
      usage,
      latencyMs,
    };
  }

  // Truncation is a FAILURE, never a partial answer. This is the Phase 6
  // finding encoded as control flow: output that stopped at the ceiling is
  // indistinguishable from output that was never going to be valid, and
  // reconciling against it would import the truncation as an identity claim.
  if (typeof finishReason === 'string' && finishReason.toUpperCase() === 'MAX_TOKENS') {
    return {
      status: 'failed',
      reason: 'max_tokens_truncated',
      finishReason,
      usage,
      latencyMs,
    };
  }

  const payload = parseRecheckPayload(result.text);
  if (!payload) {
    return {
      status: 'failed',
      reason: result.text ? 'malformed_output' : 'empty_response',
      finishReason,
      usage,
      latencyMs,
    };
  }

  return {
    status: 'completed',
    identity: payload.identity,
    confidence: payload.confidence,
    brand: payload.brand,
    finishReason,
    usage,
    latencyMs,
  };
}

/**
 * Whether a recheck's brand finding may be adopted (Phase 7.2 §11, §13).
 *
 * DELIBERATELY NARROW — it may only FILL an unknown brand, never overwrite one
 * and never clear one:
 *
 *   - Overwriting would let a second look relabel a maker the first pass read
 *     directly off the garment, on evidence no stronger than the first pass had.
 *   - Clearing would let silence refute evidence. A recheck that was asked about
 *     leg geometry saying nothing about brand is not a finding about brand.
 *
 * Tier A only. Tier B is genuinely distinctive product evidence, but it is a
 * judgement call about resemblance to a known product, and this path exists to
 * add brands the first pass MISSED — the case where a mark was visible and
 * simply not read. Requiring a direct mark keeps that narrow.
 */
export function shouldAdoptRecheckBrand(input: {
  primaryBrand: string | null;
  finding: RecheckBrandFinding;
}): boolean {
  const primary = typeof input.primaryBrand === 'string' ? input.primaryBrand.trim() : '';
  if (primary.length > 0) return false;
  const proposed = typeof input.finding.brand === 'string' ? input.finding.brand.trim() : '';
  if (proposed.length === 0) return false;
  if (input.finding.evidenceLevel !== 'direct') return false;
  // Attribution must be affirmative. An unstated attestation is not one.
  if (input.finding.evidenceOnItem !== true) return false;
  // A direct level must name the KIND of mark that made it direct. Without it
  // there is no artifact to record, and the brand would be exempted from the
  // evidence gate rather than passed through it.
  const type = input.finding.evidenceType;
  if (type !== 'wordmark' && type !== 'logo' && type !== 'label' && type !== 'monogram') {
    return false;
  }
  return true;
}

/**
 * The artifact field that backs an adopted brand.
 *
 * A read mark becomes visible brand text; a recognized one becomes a detected
 * logo. This is what lets the adopted brand re-enter `applyBrandEvidenceGate`
 * and be judged by the same rules as a first-pass brand, rather than bypassing
 * them because it arrived later.
 */
export function recheckBrandArtifact(
  finding: RecheckBrandFinding,
): { visibleBrandText: string | null; logoDetected: boolean } {
  const brand = typeof finding.brand === 'string' ? finding.brand.trim() : '';
  if (finding.evidenceType === 'wordmark' || finding.evidenceType === 'label') {
    return { visibleBrandText: brand || null, logoDetected: false };
  }
  return { visibleBrandText: null, logoDetected: true };
}
