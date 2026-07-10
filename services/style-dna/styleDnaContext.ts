// ── Style DNA Phase 2 — client-side context builder ─────────────────────────────
// Turns the device-local Phase 1 profile summary into a compact, DATA-ONLY context
// object that StyleChat may attach to a request (additively, alongside weather).
//
// Design invariants:
//   - Data only. No prompt-engineering prose is stored or returned here; any
//     LLM-facing wording is the server/prompt-builder's job (deferred).
//   - Honest gating. Below the minimum signal count the builder returns null so the
//     request is byte-identical to a flag-off request — never an empty object,
//     never confidence:'none', never signalCount:0.
//   - No identity/message/weather/location data ever enters this object.

// Independent feature flag (separate from the profile-UI flag). Default disabled.
export const STYLE_DNA_CONTEXT_ENABLED =
  process.env.EXPO_PUBLIC_STYLE_DNA_CONTEXT_ENABLED === 'true';

// Below this many signals: send nothing at all.
export const STYLE_DNA_CONTEXT_MIN_SIGNALS = 3;
// At/above this many signals: still-careful but slightly stronger personalization.
export const STYLE_DNA_CONTEXT_MEDIUM_SIGNALS = 6;

export type StyleDnaConfidence = 'low' | 'medium';

// The only Style DNA payload that may leave the device. Data-only by contract.
export type StyleDnaContext = {
  enabled: true;
  signalCount: number;
  helpfulCount: number;
  notMyStyleCount: number;
  confidence: StyleDnaConfidence;
};

// Minimal structural input so this module needs no runtime import of the profile
// service (keeps it trivially unit-testable and dependency-free).
export type StyleDnaContextInput = {
  helpfulCount: number;
  notMyStyleCount: number;
  totalSignals: number;
};

function toCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

// Builds the data-only context, or returns null when it must be omitted entirely.
// `opts.enabled` overrides the module flag (used by callers/tests); when omitted the
// module-level STYLE_DNA_CONTEXT_ENABLED flag decides.
export function buildStyleDnaContext(
  summary: StyleDnaContextInput,
  opts?: { enabled?: boolean },
): StyleDnaContext | null {
  const enabled = opts?.enabled ?? STYLE_DNA_CONTEXT_ENABLED;
  if (!enabled) return null;

  const signalCount = toCount(summary.totalSignals);
  if (signalCount < STYLE_DNA_CONTEXT_MIN_SIGNALS) return null;

  return {
    enabled: true,
    signalCount,
    helpfulCount: toCount(summary.helpfulCount),
    notMyStyleCount: toCount(summary.notMyStyleCount),
    confidence: signalCount >= STYLE_DNA_CONTEXT_MEDIUM_SIGNALS ? 'medium' : 'low',
  };
}
