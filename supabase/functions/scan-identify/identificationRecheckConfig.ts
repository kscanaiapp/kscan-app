/**
 * Backend confidence-gated identification recheck control (Phase 7.1).
 *
 * disabled → exact Phase 7 scanner behavior (no gate evaluation influences the
 *            response, no second provider call, byte-identical identity)
 * enabled  → difficult scans receive ONE additional focused fashion-analysis
 *            pass, followed by deterministic reconciliation
 *
 * Rollback without redeploy: set SCAN_IDENTIFICATION_RECHECK_ENABLED=false
 * (same env-gate pattern as BACKEND_QUALITY_TUNE_ENABLED and
 * BACKEND_SCANNER_INTELLIGENCE_ENABLED).
 *
 * WHY DEFAULT FALSE, unlike its two predecessors: quality-tune and intelligence
 * are deterministic post-processing of a response that was already paid for.
 * This one spends a second provider call and real money on a fraction of live
 * traffic. A flag that defaults ON is a flag that ships an unmeasured cost
 * increase, so the default stays OFF until the staging accuracy experiment
 * reports incorrect→correct minus correct→incorrect.
 */

export const IDENTIFICATION_RECHECK_VERSION = 'v7.1';

/**
 * Default OFF. Env override wins:
 *   SCAN_IDENTIFICATION_RECHECK_ENABLED=true  → enabled
 *   SCAN_IDENTIFICATION_RECHECK_ENABLED=false → disabled (Phase 7-equivalent)
 */
export const IDENTIFICATION_RECHECK_DEFAULT_ENABLED = false;

export function isIdentificationRecheckEnabled(
  envGet: (key: string) => string | undefined = (key) => {
    try {
      return Deno.env.get(key);
    } catch {
      return undefined;
    }
  },
): boolean {
  const raw = envGet('SCAN_IDENTIFICATION_RECHECK_ENABLED')?.trim().toLowerCase();
  if (raw === 'false' || raw === '0' || raw === 'off' || raw === 'no') return false;
  if (raw === 'true' || raw === '1' || raw === 'on' || raw === 'yes') return true;
  return IDENTIFICATION_RECHECK_DEFAULT_ENABLED;
}

export function identificationRecheckTreatmentBucket(
  enabled: boolean,
): 'identification_recheck_on' | 'identification_recheck_off' {
  return enabled ? 'identification_recheck_on' : 'identification_recheck_off';
}

// ── Hard bounds (Phase 7.1 §14) ──────────────────────────────────────────────

/**
 * One additional fashion-analysis call per scan. Not a retry budget: there is no
 * second attempt, no model escalation, and no third opinion. A failed recheck
 * fails open to the primary identification rather than trying again.
 */
export const RECHECK_MAX_PROVIDER_CALLS = 1;

/** Default recheck timeout. Deliberately tighter than the primary scan call: the
 * recheck is optional accuracy work sitting in front of the user's result, so it
 * must surrender quickly rather than extend total latency. */
export const RECHECK_DEFAULT_TIMEOUT_MS = 6_000;
export const RECHECK_MIN_TIMEOUT_MS = 1_500;
export const RECHECK_MAX_TIMEOUT_MS = 12_000;

export function resolveRecheckTimeoutMs(
  envGet: (key: string) => string | undefined = (key) => {
    try {
      return Deno.env.get(key);
    } catch {
      return undefined;
    }
  },
): number {
  const raw = envGet('SCAN_IDENTIFICATION_RECHECK_TIMEOUT_MS');
  const parsed = raw !== undefined ? parseInt(raw.trim(), 10) : NaN;
  return Number.isFinite(parsed) &&
      parsed >= RECHECK_MIN_TIMEOUT_MS &&
      parsed <= RECHECK_MAX_TIMEOUT_MS
    ? parsed
    : RECHECK_DEFAULT_TIMEOUT_MS;
}

/**
 * Output budget for the recheck call.
 *
 * PHASE 6 LESSON, ENCODED: the primary scanner shares one 2048-token ceiling
 * between reasoning tokens and visible structured output, and Phase 6 traced its
 * "unparseable JSON" population to truncation at that ceiling rather than to
 * formatting. The recheck keeps the same ceiling but asks for roughly a tenth of
 * the fields, so the headroom left for reasoning is far larger. The ceiling is
 * not a target: `finishReason` and token usage are captured on every call, and a
 * MAX_TOKENS finish is treated as a recheck FAILURE (fail open to primary), never
 * as a partial answer worth reconciling.
 */
export const RECHECK_MAX_OUTPUT_TOKENS = 2048;

/**
 * Provider confidence at or below which the first-pass identity is treated as
 * genuinely uncertain rather than merely terse.
 *
 * Conservative by construction: the provider reports ~0.9+ when it is confident,
 * so a 0.55 floor escalates only the clearly hesitant tail. A MISSING confidence
 * score is never treated as a low one — see identificationRecheckGate.
 */
export const RECHECK_LOW_CONFIDENCE_THRESHOLD = 0.55;

/**
 * Support floor for ACCEPTING new specificity the first pass did not assert.
 * A populated second answer is not evidence; an explicitly supported one is.
 */
export const RECHECK_NEW_SPECIFICITY_SUPPORT_THRESHOLD = 0.7;

/**
 * Support floor for OVERWRITING a value the first pass did assert.
 * Higher than the new-specificity floor on purpose: replacing an existing
 * assertion is the reversal that the promotion metric punishes hardest
 * (correct→incorrect), so it demands more support than filling a blank.
 */
export const RECHECK_CORRECTION_SUPPORT_THRESHOLD = 0.8;
