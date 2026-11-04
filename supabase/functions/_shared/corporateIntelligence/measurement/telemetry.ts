/**
 * CI-06 — metadata-only telemetry schema, dated pricing and offline aggregation
 * for Corporate Intelligence v2. Offline tooling: imported by no Edge Function.
 *
 * The record schema is CLOSED and value-shaped: every string must be a short
 * code (no spaces), so a record can never carry a prompt, conversation, image,
 * user id, merchant-authored text or ownership evidence. Records that fail the
 * schema are counted and excluded, never aggregated.
 */

export const CI_V2_TELEMETRY_KEYS = Object.freeze([
  'telemetryVersion', 'model', 'providerAttempts', 'providerRetries', 'promptTokens', 'outputTokens', 'thoughtsTokens',
  'usageUnreported', 'integration', 'flag', 'prepared', 'taskVerb', 'mode', 'register', 'origin', 'validator', 'stage',
  'failureCodes', 'fallbackReason', 'copyKey', 'eligibleCount', 'labelsRendered', 'sanitizerCorruption', 'registrySource',
  'finalizationPasses', 'elapsedMs',
] as const);
export const CI_V2_FLAG_TELEMETRY_KEYS = Object.freeze(['telemetryVersion', 'integration', 'flag'] as const);

const CODE_RE = /^[A-Za-z0-9_.:|-]{0,160}$/;

export type TelemetryRecord = Record<string, string | number | boolean | null>;

export function validateTelemetryRecord(rec: unknown, kind: 'finalization' | 'flag' = 'finalization'): { ok: true } | { ok: false; issues: string[] } {
  const issues: string[] = [];
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return { ok: false, issues: ['not_object'] };
  const allowed = new Set<string>(kind === 'flag' ? CI_V2_FLAG_TELEMETRY_KEYS : CI_V2_TELEMETRY_KEYS);
  for (const [k, v] of Object.entries(rec as Record<string, unknown>)) {
    if (!allowed.has(k)) issues.push(`unknown_key:${k}`);
    if (v === null || typeof v === 'boolean') continue;
    if (typeof v === 'number') {
      if (!Number.isFinite(v) || v < 0) issues.push(`bad_number:${k}`);
      continue;
    }
    if (typeof v !== 'string') issues.push(`bad_type:${k}`);
    else if (!CODE_RE.test(v)) issues.push(`free_text:${k}`);
  }
  return issues.length ? { ok: false, issues } : { ok: true };
}

// ── Dated pricing (estimate only; never a billing record) ───────────────────────

export const CI_V2_PRICING = Object.freeze({
  recordId: 'gemini-pricing.2026-07-29',
  provenance: 'Official Gemini API paid-tier pricing as recorded in evals/scanner-accuracy/pricing/gemini-pricing.2026-07-29.json (research/scanner-accuracy-v2-evals); output price includes thinking tokens',
  retrievedAt: '2026-07-29',
  maxAgeDays: 90,
  models: Object.freeze({
    'gemini-3.6-flash': Object.freeze({ inputPerMillionUsd: 1.5, outputPerMillionUsd: 7.5 }),
    'gemini-3.5-flash-lite': Object.freeze({ inputPerMillionUsd: 0.3, outputPerMillionUsd: 2.5 }),
  }) as Readonly<Record<string, { inputPerMillionUsd: number; outputPerMillionUsd: number }>>,
});

export function pricingStatus(now: Date): 'current' | 'stale' {
  const age = (now.getTime() - Date.parse(`${CI_V2_PRICING.retrievedAt}T00:00:00Z`)) / 86_400_000;
  return age <= CI_V2_PRICING.maxAgeDays ? 'current' : 'stale';
}

export function estimateCostUsd(model: string | null, prompt: number, output: number, thoughts: number): number | null {
  const p = model ? CI_V2_PRICING.models[model] : undefined;
  if (!p) return null;
  return (prompt * p.inputPerMillionUsd + (output + thoughts) * p.outputPerMillionUsd) / 1_000_000;
}

// ── Aggregation ─────────────────────────────────────────────────────────────────

const PREFIX = '[stylechat-generate] ci_v2 ';
const FLAG_PREFIX = '[stylechat-generate] ci_v2_flag ';

function percentile(values: number[], q: number): number | null {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.ceil(q * v.length) - 1)];
}

function bump(map: Record<string, number>, key: unknown) {
  const k = typeof key === 'string' && key ? key : 'none';
  map[k] = (map[k] ?? 0) + 1;
}

/** Parse log lines (e.g. exported Edge logs); anything that is not a CI-v2 line is ignored. */
export function parseTelemetryLines(lines: readonly string[]): { finalization: unknown[]; flag: unknown[] } {
  const finalization: unknown[] = [];
  const flag: unknown[] = [];
  for (const line of lines) {
    const i = line.indexOf('{');
    if (i < 0) continue;
    const target = line.includes(FLAG_PREFIX) ? flag : line.includes(PREFIX) ? finalization : null;
    if (!target) continue;
    try { target.push(JSON.parse(line.slice(i))); } catch { target.push('unparseable'); }
  }
  return { finalization, flag };
}

export function aggregateTelemetry(input: { finalization: readonly unknown[]; flag: readonly unknown[] }, now: Date) {
  const valid: TelemetryRecord[] = [];
  let rejected = 0;
  for (const r of input.finalization) {
    if (validateTelemetryRecord(r).ok) valid.push(r as TelemetryRecord); else rejected++;
  }
  let flagRejected = 0;
  const flagStates: Record<string, number> = {};
  for (const r of input.flag) {
    if (validateTelemetryRecord(r, 'flag').ok) bump(flagStates, (r as TelemetryRecord).flag); else flagRejected++;
  }
  // The LAST finalization pass of a request is what the customer saw; passes > 1 are re-finalizations.
  const byTaskVerb: Record<string, number> = {};
  const byMode: Record<string, number> = {};
  const validator: Record<string, number> = {};
  const fallbackReasons: Record<string, number> = {};
  const failureCategories: Record<string, number> = {};
  const origins: Record<string, number> = {};
  const eligibleCounts: Record<string, number> = {};
  let sanitizerCorruption = 0;
  let labels = 0;
  const latency: number[] = [];
  const costs: number[] = [];
  let prompt = 0, output = 0, thoughts = 0, unreported = 0, attempts = 0;
  for (const r of valid) {
    bump(byTaskVerb, r.taskVerb);
    bump(byMode, r.mode);
    bump(validator, r.validator);
    bump(fallbackReasons, r.fallbackReason);
    bump(origins, r.origin);
    bump(eligibleCounts, r.eligibleCount === null ? 'n/a' : String(r.eligibleCount));
    for (const c of String(r.failureCodes ?? '').split('|').filter(Boolean)) bump(failureCategories, c);
    if (r.sanitizerCorruption === true) sanitizerCorruption++;
    labels += typeof r.labelsRendered === 'number' ? r.labelsRendered : 0;
    if (typeof r.elapsedMs === 'number') latency.push(r.elapsedMs);
    const pT = typeof r.promptTokens === 'number' ? r.promptTokens : 0;
    const oT = typeof r.outputTokens === 'number' ? r.outputTokens : 0;
    const tT = typeof r.thoughtsTokens === 'number' ? r.thoughtsTokens : 0;
    prompt += pT; output += oT; thoughts += tT;
    unreported += typeof r.usageUnreported === 'number' ? r.usageUnreported : 0;
    attempts += typeof r.providerAttempts === 'number' ? r.providerAttempts : 0;
    const c = estimateCostUsd(typeof r.model === 'string' ? r.model : null, pT, oT, tT);
    if (c !== null) costs.push(c);
  }
  return {
    records: valid.length,
    rejectedRecords: rejected,
    flagRecords: Object.values(flagStates).reduce((a, b) => a + b, 0),
    rejectedFlagRecords: flagRejected,
    flagStates,
    byTaskVerb, byMode, validator, fallbackReasons, failureCategories, origins, eligibleCounts,
    sanitizerCorruption,
    labelsRendered: labels,
    latencyMs: { p50: percentile(latency, 0.5), p95: percentile(latency, 0.95), n: latency.length, scope: 'ci_v2_overhead_since_flag_resolution' },
    tokens: { prompt, output, thoughts, providerAttempts: attempts, unreportedAttempts: unreported },
    costUsd: {
      mean: costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : null,
      p95: percentile(costs, 0.95),
      n: costs.length,
      pricingRecord: CI_V2_PRICING.recordId,
      pricingStatus: pricingStatus(now),
      basis: 'estimate_from_dated_pricing',
    },
  };
}
