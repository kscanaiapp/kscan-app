/**
 * VRI-03 (Visual Retrieval Intelligence) flag contract — `vri-03-scan-improvements`.
 *
 * Server-side, default OFF, per-cohort, with ONE sub-flag per Phase B change so
 * each change can be attributed in a benchmark row and reverted on its own.
 *
 * STATUS: contract only. Nothing in the scan path imports this module yet
 * (asserted by scanImprovementsFlag.test.ts). VRI-03 Phase A did not pass
 * its benchmark gate (no labeled failure set exists), so no Phase B change has
 * been built, and an unmeasured change must not land. A later change wires a
 * sub-flag here only together with its own before/after benchmark row.
 *
 * Effective state of a sub-flag = master ON && caller in cohort && sub-flag ON.
 * Every malformed or missing value resolves to OFF (fail closed).
 *
 * Environment (all optional; absent means OFF / 0%):
 *   VRI03_SCAN_IMPROVEMENTS_ENABLED           master switch, "true" to enable
 *   VRI03_SCAN_IMPROVEMENTS_COHORT_PERCENT    integer 0..100, default 0
 *   VRI03_H1_INSTRUCTION_ENABLED              H1 system instruction / prompt
 *   VRI03_H2_SCHEMA_PARSER_ENABLED            H2 response schema + parser
 *   VRI03_H3_QUERY_NORMALIZATION_ENABLED      H3 deterministic query normalization + synonyms
 *   VRI03_H4_FILTER_RERANK_ENABLED            H4 filter caps, dedup, deterministic rerank
 *   VRI03_H4B_BLACK_OWNED_MATCH_ENABLED       H4b Black-owned search-quality matching
 *                                             (never verification or ownership labels)
 */

export const VRI03_FLAG_NAME = 'vri-03-scan-improvements';
export const VRI03_FLAG_VERSION = 'vri-03-v0-contract';

export const VRI03_MASTER_ENV = 'VRI03_SCAN_IMPROVEMENTS_ENABLED';
export const VRI03_COHORT_PERCENT_ENV = 'VRI03_SCAN_IMPROVEMENTS_COHORT_PERCENT';

export const VRI03_SUB_FLAG_ENV = {
  h1_instruction: 'VRI03_H1_INSTRUCTION_ENABLED',
  h2_schema_parser: 'VRI03_H2_SCHEMA_PARSER_ENABLED',
  h3_query_normalization: 'VRI03_H3_QUERY_NORMALIZATION_ENABLED',
  h4_filter_rerank: 'VRI03_H4_FILTER_RERANK_ENABLED',
  h4b_black_owned_match: 'VRI03_H4B_BLACK_OWNED_MATCH_ENABLED',
} as const;

export type Vri03SubFlag = keyof typeof VRI03_SUB_FLAG_ENV;

export const VRI03_SUB_FLAGS: readonly Vri03SubFlag[] = Object.freeze(
  Object.keys(VRI03_SUB_FLAG_ENV) as Vri03SubFlag[],
);

export type Vri03FlagState = {
  flag: typeof VRI03_FLAG_NAME;
  version: typeof VRI03_FLAG_VERSION;
  masterEnabled: boolean;
  cohortPercent: number;
  /** Stable 0..99 bucket for the cohort key, or null when no key was supplied. */
  cohortBucket: number | null;
  inCohort: boolean;
  /** Effective per-change state: master && inCohort && sub-flag. */
  subFlags: Readonly<Record<Vri03SubFlag, boolean>>;
};

type EnvGet = (key: string) => string | undefined;

function defaultEnvGet(key: string): string | undefined {
  try {
    return Deno.env.get(key);
  } catch {
    return undefined;
  }
}

/** Strict boolean: only an explicit "true" enables. Anything else is OFF. */
function strictTrue(raw: string | undefined): boolean {
  return typeof raw === 'string' && raw.trim().toLowerCase() === 'true';
}

/** Integer 0..100; anything else (including fractions) resolves to 0. */
export function parseCohortPercent(raw: string | undefined): number {
  if (typeof raw !== 'string') return 0;
  const t = raw.trim();
  if (!/^\d{1,3}$/.test(t)) return 0;
  const n = Number(t);
  return n >= 0 && n <= 100 ? n : 0;
}

/**
 * Deterministic 0..99 bucket (FNV-1a 32-bit). Pure and stable across isolates,
 * so the same cohort key always lands in the same arm of a benchmark/rollout.
 * The key is hashed, never logged or returned.
 */
export function cohortBucketFor(cohortKey: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < cohortKey.length; i++) {
    h ^= cohortKey.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 100;
}

export function resolveVri03Flags(opts: {
  /** Stable server-side identity for cohorting (e.g. verified user id). */
  cohortKey?: string | null;
  envGet?: EnvGet;
} = {}): Vri03FlagState {
  const envGet = opts.envGet ?? defaultEnvGet;
  const masterEnabled = strictTrue(envGet(VRI03_MASTER_ENV));
  const cohortPercent = parseCohortPercent(envGet(VRI03_COHORT_PERCENT_ENV));
  const key = typeof opts.cohortKey === 'string' && opts.cohortKey.trim() ? opts.cohortKey.trim() : null;
  const cohortBucket = key === null ? null : cohortBucketFor(key);
  // No key → never in cohort, even at 100%: an unidentified caller cannot be
  // attributed to an arm, so it stays on the existing path.
  const inCohort = masterEnabled && cohortBucket !== null && cohortBucket < cohortPercent;

  const subFlags = {} as Record<Vri03SubFlag, boolean>;
  for (const sub of VRI03_SUB_FLAGS) {
    subFlags[sub] = inCohort && strictTrue(envGet(VRI03_SUB_FLAG_ENV[sub]));
  }

  return {
    flag: VRI03_FLAG_NAME,
    version: VRI03_FLAG_VERSION,
    masterEnabled,
    cohortPercent,
    cohortBucket,
    inCohort,
    subFlags: Object.freeze(subFlags),
  };
}
