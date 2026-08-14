import type {
  AvatarBrowState,
  AvatarExpressionMode,
  AvatarMotionCapabilities,
  AvatarMotionMode,
} from './avatarMotionState';

// Deterministic local expression rules.
//
// Pure functions over text the app already has. No cloud sentiment service,
// no emotion API, no model call, no network access of any kind. The output is
// a restrained *presentation* mode — a small pose and timing bias — and is
// never a claim that Elise experiences emotion.

/**
 * Structured metadata StyleChat already carries alongside a message. Every
 * field is optional; missing metadata simply yields fewer signals.
 */
export interface ExpressionRuleInput {
  text: string;
  /** True when the reply is a direct recommendation (existing ui blocks). */
  hasRecommendation?: boolean;
  /** True when the reply asks the user a clarifying question. */
  isClarifying?: boolean;
  /** True for the session greeting. */
  isGreeting?: boolean;
}

/** Pose and timing bias a mode may apply. All values stay restrained. */
export interface ExpressionPresentation {
  /** Additional head roll in degrees; clamped by the motion contract. */
  headTiltDeg: number;
  /** Multiplier on the general state attack envelope. */
  attackScale: number;
  /** Whether the mode may trigger a brief emphasis nod. */
  allowsEmphasisNod: boolean;
}

const HEDGING_PATTERNS = [
  /\bi'?m not (?:sure|certain)\b/i,
  /\bit depends\b/i,
  /\bmight\b/i,
  /\bcould go either way\b/i,
  /\bhard to say\b/i,
];

const CONFIDENT_PATTERNS = [
  /\bdefinitely\b/i,
  /\bthis is the one\b/i,
  /\bi'?d go with\b/i,
  /\bmy pick\b/i,
  /\bwithout question\b/i,
];

const WARM_PATTERNS = [
  /\blove\b/i,
  /\bgorgeous\b/i,
  /\bbeautiful\b/i,
  /\bgreat choice\b/i,
  /\bhappy to\b/i,
  /\bwelcome\b/i,
];

/**
 * Resolve the semantic expression mode.
 *
 * Rule order is fixed so the outcome is fully reproducible: uncertainty
 * (hedging or a clarifying question) outranks confidence, which outranks
 * warmth, which outranks neutral. Empty or whitespace text is always neutral.
 */
export function resolveExpressionMode(input: ExpressionRuleInput): AvatarExpressionMode {
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (!text) return 'neutral';

  if (input.isClarifying === true) return 'uncertain';
  if (HEDGING_PATTERNS.some((pattern) => pattern.test(text))) return 'uncertain';
  // A reply that is only a question is asking, not asserting.
  if (text.endsWith('?') && !text.includes('.')) return 'uncertain';

  if (input.hasRecommendation === true) return 'confident';
  if (CONFIDENT_PATTERNS.some((pattern) => pattern.test(text))) return 'confident';

  if (input.isGreeting === true) return 'warm';
  if (WARM_PATTERNS.some((pattern) => pattern.test(text))) return 'warm';

  return 'neutral';
}

const PRESENTATIONS: Readonly<Record<AvatarExpressionMode, ExpressionPresentation>> = Object.freeze({
  neutral: Object.freeze({ headTiltDeg: 0, attackScale: 1, allowsEmphasisNod: false }),
  warm: Object.freeze({ headTiltDeg: 0.6, attackScale: 1.1, allowsEmphasisNod: false }),
  confident: Object.freeze({ headTiltDeg: 0, attackScale: 0.9, allowsEmphasisNod: true }),
  thinking: Object.freeze({ headTiltDeg: 0.8, attackScale: 1.2, allowsEmphasisNod: false }),
  uncertain: Object.freeze({ headTiltDeg: 1, attackScale: 1.2, allowsEmphasisNod: false }),
});

/**
 * Presentation for a mode, capability-gated. Without head-motion capability
 * every mode presents identically to neutral: the code must never imply a
 * facial expression the shipped assets cannot render.
 */
export function getExpressionPresentation(
  mode: AvatarExpressionMode,
  capabilities: AvatarMotionCapabilities,
): ExpressionPresentation {
  const presentation = PRESENTATIONS[mode] ?? PRESENTATIONS.neutral;
  if (!capabilities.headMotion) return PRESENTATIONS.neutral;
  return presentation;
}

/**
 * Deterministic brow state from the semantic expression and motion mode.
 *
 * Neutral is the default and the reset value. Raised expresses questions,
 * positive emphasis, or attentive acknowledgement; focused expresses
 * measured comparison or uncertainty. This maps *presentation*, derived from
 * the same local deterministic rules as the expression itself — it never
 * implies emotional awareness and consults no cloud service.
 *
 * Capability-gated: without a validated brow overlay package the result is
 * always neutral, so code can never imply brow motion the shipped assets
 * cannot render. Reduce Motion also pins neutral.
 */
export function resolveBrowState(
  expression: AvatarExpressionMode,
  mode: AvatarMotionMode,
  capabilities: AvatarMotionCapabilities,
  reducedMotion: boolean,
): AvatarBrowState {
  if (!capabilities.brows || reducedMotion) return 'neutral';
  // Interruption and error handling reset every facial layer together.
  if (mode === 'interrupted') return 'neutral';
  // Thinking reads as measured consideration regardless of expression.
  if (mode === 'thinking') return 'focused';
  if (expression === 'uncertain') return 'focused';
  if (expression === 'warm' || expression === 'confident') {
    // Positive emphasis and attentive acknowledgement raise briefly; the
    // listening mode is the attentive case.
    return mode === 'listening' || mode === 'reacting' || mode === 'speaking'
      ? 'raised'
      : 'neutral';
  }
  return 'neutral';
}

/**
 * Whether a brief emphasis nod may play. Requires head motion, an expression
 * that allows it, and no Reduce Motion.
 */
export function shouldPlayEmphasisNod(
  mode: AvatarExpressionMode,
  capabilities: AvatarMotionCapabilities,
  reducedMotion: boolean,
): boolean {
  if (reducedMotion || !capabilities.headMotion) return false;
  return getExpressionPresentation(mode, capabilities).allowsEmphasisNod;
}
