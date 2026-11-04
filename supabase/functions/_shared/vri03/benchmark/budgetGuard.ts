/**
 * VRI-03 benchmark budget guard — the $20 Gemini ceiling, enforced in code.
 *
 * Owner approval scope, as enforced here:
 *   - ONE immutable $20 ceiling across ALL VRI-03 benchmarking. Paid mode
 *     accepts no other value; offline (mock) mode may only LOWER it for tests.
 *   - Write-ahead ledger. Every Gemini attempt appends an `intent` entry
 *     (durably, through the injected store) BEFORE it is sent, then a `settled`,
 *     `uncertain` or `released` entry. The ledger is checksum-chained and is
 *     verified and reconciled on load:
 *       · an intent with no outcome (crash, kill, lost response) is charged its
 *         worst case as `uncertain` — interrupted requests are never free;
 *       · a broken chain or malformed entry refuses to load.
 *   - Reservation before every attempt: spent + outstanding + worst case must
 *     fit the ceiling, or it throws before any call is sent.
 *   - Actual cost settles from `usageMetadata` (thinking billed as output).
 *     Missing/malformed usage is charged worst case.
 *   - If actual cost exceeds its reservation, the estimate is invalid: the guard
 *     HALTS (durable `halt` entry) and refuses every further reservation. It also
 *     halts if total spend ever exceeds the ceiling.
 *   - Provider (Serper / Poshmark) calls are counted, never priced: provider
 *     cost is always INSUFFICIENT_EVIDENCE until the owner supplies prices.
 *
 * No network, no Deno.env. File IO lives only in ledgerStore.ts.
 */

export type ModelPrice = { inputPerMillionUsd: number; outputPerMillionUsd: number };

export type PricingRecord = {
  recordId: string;
  provenance: string;
  retrievedAt: string;
  models: Readonly<Record<string, ModelPrice>>;
};

export const VRI03_PRICING: PricingRecord = Object.freeze({
  recordId: 'gemini-pricing.2026-07-29',
  provenance:
    'evals/scanner-accuracy/pricing/gemini-pricing.2026-07-29.json on research/scanner-accuracy-v2-evals ' +
    '(official Gemini API paid-tier pricing, retrieved 2026-07-29; output price includes thinking tokens)',
  retrievedAt: '2026-07-29',
  models: Object.freeze({
    'gemini-3.6-flash': Object.freeze({ inputPerMillionUsd: 1.5, outputPerMillionUsd: 7.5 }),
    'gemini-3.5-flash-lite': Object.freeze({ inputPerMillionUsd: 0.3, outputPerMillionUsd: 2.5 }),
  }),
});

/** Immutable. Not configurable by env, option or argument in paid mode. */
export const VRI03_GEMINI_CEILING_USD = 20 as const;
/** scan-identify MAX_OUTPUT_TOKENS (index.ts). Thinking tokens bill as output. */
export const VRI03_MAX_OUTPUT_TOKENS = 2048;
/** Bound used only offline when no free countTokens preflight was supplied. */
export const VRI03_DEFAULT_INPUT_TOKEN_UPPER_BOUND = 6000;
/** A pricing record older than this must be re-verified before billed execution. */
export const VRI03_PRICING_MAX_AGE_DAYS = 90;

export type UsageMetadata = {
  promptTokenCount?: unknown;
  candidatesTokenCount?: unknown;
  thoughtsTokenCount?: unknown;
  totalTokenCount?: unknown;
};

type Base = { seq: number; prev: string; sum: string };
export type IntentEntry = Base & { kind: 'intent'; reservationId: string; model: string; itemId: string; arm: string; worstCaseUsd: number };
export type SettledEntry = Base & {
  kind: 'settled'; reservationId: string; model: string; promptTokens: number | null; outputTokens: number | null;
  costUsd: number; costSource: 'usage_metadata' | 'worst_case_no_usage'; overrunUsd: number;
};
export type UncertainEntry = Base & { kind: 'uncertain'; reservationId: string; costUsd: number; reason: string };
export type ReleasedEntry = Base & { kind: 'released'; reservationId: string };
export type ProviderEntry = Base & { kind: 'provider'; provider: string; itemId: string; arm: string };
export type HaltEntry = Base & { kind: 'halt'; reason: string };
export type LedgerEntry = IntentEntry | SettledEntry | UncertainEntry | ReleasedEntry | ProviderEntry | HaltEntry;

type Unsealed<T> = T extends LedgerEntry ? Omit<T, 'seq' | 'prev' | 'sum'> : never;

export class BudgetExceededError extends Error {
  constructor(readonly spentUsd: number, readonly outstandingUsd: number, readonly requestedUsd: number, readonly ceilingUsd: number) {
    super(
      `VRI-03 Gemini ceiling: reserving $${requestedUsd.toFixed(4)} would exceed $${ceilingUsd.toFixed(2)} ` +
        `(spent $${spentUsd.toFixed(4)}, outstanding $${outstandingUsd.toFixed(4)}). No call was sent.`,
    );
    this.name = 'BudgetExceededError';
  }
}

export class BudgetHaltedError extends Error {
  constructor(readonly reasons: readonly string[]) {
    super(`VRI-03 budget guard is HALTED (${reasons.join('; ')}). No further Gemini call may be reserved.`);
    this.name = 'BudgetHaltedError';
  }
}

export class LedgerIntegrityError extends Error {
  constructor(message: string) {
    super(`VRI-03 ledger integrity: ${message}`);
    this.name = 'LedgerIntegrityError';
  }
}

export type Reservation = {
  readonly reservationId: string;
  readonly model: string;
  readonly worstCaseUsd: number;
  readonly itemId: string;
  readonly arm: string;
};

// ── Checksum chain (corruption/truncation detection, not cryptographic) ─────

const GENESIS = '0000000000000000';

function fnv1a32(s: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function entryChecksum(prev: string, body: Record<string, unknown>): string {
  const payload = `${prev}|${JSON.stringify(body)}`;
  return fnv1a32(payload, 0x811c9dc5).toString(16).padStart(8, '0') + fnv1a32(payload, 0x050c5d1f).toString(16).padStart(8, '0');
}

function bodyOf(e: LedgerEntry): Record<string, unknown> {
  const { sum: _sum, ...rest } = e as LedgerEntry & Record<string, unknown>;
  return rest;
}

export type LedgerInspection = {
  ok: boolean;
  problems: string[];
  entries: number;
  spentUsd: number;
  openIntents: IntentEntry[];
  halted: boolean;
  haltReasons: string[];
  geminiAttempts: number;
  uncertainAttempts: number;
  worstCaseCharged: number;
  overruns: number;
  providerCalls: Record<string, number>;
};

/** Verify the chain and fold the ledger. Never throws; reports problems. */
export function inspectLedger(entries: readonly LedgerEntry[]): LedgerInspection {
  const problems: string[] = [];
  let prev = GENESIS;
  let spentUsd = 0;
  const open = new Map<string, IntentEntry>();
  const closed = new Set<string>();
  const haltReasons: string[] = [];
  const providerCalls: Record<string, number> = {};
  let geminiAttempts = 0, uncertain = 0, worstCaseCharged = 0, overruns = 0;
  entries.forEach((e, i) => {
    if (!e || typeof e !== 'object') { problems.push(`entry ${i}: not an object`); return; }
    if (e.seq !== i + 1) problems.push(`entry ${i}: seq ${e.seq} is not ${i + 1}`);
    if (e.prev !== prev) problems.push(`entry ${i}: chain break (prev mismatch)`);
    if (entryChecksum(e.prev, bodyOf(e)) !== e.sum) problems.push(`entry ${i}: checksum mismatch`);
    prev = e.sum;
    switch (e.kind) {
      case 'intent':
        if (open.has(e.reservationId) || closed.has(e.reservationId)) problems.push(`entry ${i}: duplicate reservation ${e.reservationId}`);
        open.set(e.reservationId, e);
        geminiAttempts++;
        break;
      case 'settled':
      case 'uncertain':
      case 'released': {
        if (!open.has(e.reservationId)) { problems.push(`entry ${i}: ${e.kind} without open intent ${e.reservationId}`); break; }
        open.delete(e.reservationId);
        closed.add(e.reservationId);
        if (e.kind === 'released') geminiAttempts--;
        if (e.kind === 'settled') {
          spentUsd += e.costUsd;
          if (e.costSource === 'worst_case_no_usage') worstCaseCharged++;
          if (e.overrunUsd > 0) overruns++;
        }
        if (e.kind === 'uncertain') { spentUsd += e.costUsd; uncertain++; worstCaseCharged++; }
        break;
      }
      case 'provider':
        providerCalls[e.provider] = (providerCalls[e.provider] ?? 0) + 1;
        break;
      case 'halt':
        haltReasons.push(e.reason);
        break;
      default:
        problems.push(`entry ${i}: unknown kind`);
    }
  });
  return {
    ok: problems.length === 0, problems, entries: entries.length, spentUsd, openIntents: [...open.values()],
    halted: haltReasons.length > 0, haltReasons, geminiAttempts, uncertainAttempts: uncertain, worstCaseCharged, overruns, providerCalls,
  };
}

// ── Pricing validation against the configured route ─────────────────────────

export function validatePricing(opts: { pricing: PricingRecord; models: readonly string[]; now: Date; maxAgeDays?: number }): string[] {
  const issues: string[] = [];
  for (const m of new Set(opts.models)) {
    const p = opts.pricing.models[m];
    if (!p) issues.push(`no dated price for configured model "${m}"`);
    else if (!(p.inputPerMillionUsd > 0) || !(p.outputPerMillionUsd > 0)) issues.push(`invalid price for "${m}"`);
  }
  const retrieved = Date.parse(`${opts.pricing.retrievedAt}T00:00:00Z`);
  const maxAge = opts.maxAgeDays ?? VRI03_PRICING_MAX_AGE_DAYS;
  if (!Number.isFinite(retrieved)) issues.push('pricing record has no valid retrievedAt');
  else {
    const ageDays = Math.floor((opts.now.getTime() - retrieved) / 86_400_000);
    if (ageDays > maxAge) issues.push(`pricing record is ${ageDays} days old (max ${maxAge}); re-verify official pricing before billed execution`);
    if (ageDays < 0) issues.push('pricing record is dated in the future');
  }
  return issues;
}

// ── Guard ────────────────────────────────────────────────────────────────────

function nonNegInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
}

export function costFromUsage(price: ModelPrice, promptTokens: number, outputTokens: number): number {
  return (promptTokens * price.inputPerMillionUsd + outputTokens * price.outputPerMillionUsd) / 1_000_000;
}

export type BudgetGuardOptions = {
  /** 'paid' requires a durable append, counted input tokens and the immutable ceiling. */
  mode: 'offline' | 'paid';
  priorLedger?: readonly LedgerEntry[];
  /** Durable append (must persist before returning). Required in paid mode. */
  append?: (entry: LedgerEntry) => void;
  pricing?: PricingRecord;
  /** Offline only, and only lower than the immutable ceiling. */
  offlineCeilingUsd?: number;
  maxOutputTokens?: number;
  inputTokenUpperBound?: number;
};

export function createBudgetGuard(opts: BudgetGuardOptions = { mode: 'offline' }) {
  const paid = opts.mode === 'paid';
  if (opts.mode !== 'offline' && opts.mode !== 'paid') throw new Error('VRI-03 budget: mode must be offline or paid');
  if (paid && opts.offlineCeilingUsd !== undefined) throw new Error('VRI-03 budget: the $20 ceiling is immutable in paid mode');
  if (paid && typeof opts.append !== 'function') throw new Error('VRI-03 budget: paid mode requires a durable ledger store');
  const ceilingUsd: number = opts.offlineCeilingUsd ?? VRI03_GEMINI_CEILING_USD;
  if (!(ceilingUsd > 0) || ceilingUsd > VRI03_GEMINI_CEILING_USD) {
    throw new Error(`VRI-03 budget: ceiling must be in (0, ${VRI03_GEMINI_CEILING_USD}]`);
  }
  const pricing = opts.pricing ?? VRI03_PRICING;
  const maxOutputTokens = opts.maxOutputTokens ?? VRI03_MAX_OUTPUT_TOKENS;
  const inputUpper = opts.inputTokenUpperBound ?? VRI03_DEFAULT_INPUT_TOKEN_UPPER_BOUND;

  const prior = [...(opts.priorLedger ?? [])];
  const loaded = inspectLedger(prior);
  if (!loaded.ok) throw new LedgerIntegrityError(loaded.problems.join('; '));

  const ledger: LedgerEntry[] = prior;
  let prev = ledger.length ? ledger[ledger.length - 1].sum : GENESIS;

  function write<T extends Unsealed<LedgerEntry>>(body: T): LedgerEntry {
    const withChain = { seq: ledger.length + 1, prev, ...body } as Record<string, unknown>;
    const sum = entryChecksum(prev, withChain);
    const entry = { ...withChain, sum } as unknown as LedgerEntry;
    // Durable first: if the store throws, nothing is recorded in memory and the
    // caller's call is never sent.
    opts.append?.(entry);
    ledger.push(entry);
    prev = sum;
    return entry;
  }

  // Reconcile: any intent left open by an interrupted run is charged worst case.
  for (const intent of loaded.openIntents) {
    write({ kind: 'uncertain', reservationId: intent.reservationId, costUsd: intent.worstCaseUsd, reason: 'reconciled_open_intent_on_load' });
  }

  let state = inspectLedger(ledger);
  const outstanding = new Map<string, Reservation>();
  let counter = 0;
  const outstandingUsd = () => [...outstanding.values()].reduce((s, r) => s + r.worstCaseUsd, 0);
  const refresh = () => { state = inspectLedger(ledger); };

  function priceFor(model: string): ModelPrice {
    const p = pricing.models[model];
    if (!p) throw new Error(`VRI-03 budget: no dated price for model "${model}"; refusing to reserve`);
    return p;
  }

  function worstCaseCallUsd(model: string, countedInputTokens?: number): number {
    const counted = countedInputTokens === undefined ? null : nonNegInt(countedInputTokens);
    if (paid && counted === null) throw new Error('VRI-03 budget: paid mode requires counted input tokens (free countTokens preflight)');
    return costFromUsage(priceFor(model), counted ?? inputUpper, maxOutputTokens);
  }

  function halt(reason: string) {
    write({ kind: 'halt', reason });
    refresh();
  }

  return {
    mode: opts.mode,
    ceilingUsd,
    worstCaseCallUsd,

    /** Throws BEFORE the call when halted, unpriced, or the bound does not fit. */
    reserveGeminiAttempt(model: string, ctx: { itemId: string; arm: string; countedInputTokens?: number }): Reservation {
      if (state.halted) throw new BudgetHaltedError(state.haltReasons);
      const worst = worstCaseCallUsd(model, ctx.countedInputTokens);
      const out = outstandingUsd();
      if (state.spentUsd + out + worst > ceilingUsd + 1e-12) throw new BudgetExceededError(state.spentUsd, out, worst, ceilingUsd);
      const reservationId = `r${ledger.length + 1}-${++counter}`;
      write({ kind: 'intent', reservationId, model, itemId: ctx.itemId, arm: ctx.arm, worstCaseUsd: worst });
      const r: Reservation = Object.freeze({ reservationId, model, worstCaseUsd: worst, itemId: ctx.itemId, arm: ctx.arm });
      outstanding.set(reservationId, r);
      refresh();
      return r;
    },

    /** Only when the call provably never left the process. */
    releaseNotSent(r: Reservation): void {
      if (!outstanding.delete(r.reservationId)) throw new Error('VRI-03 budget: unknown or closed reservation');
      write({ kind: 'released', reservationId: r.reservationId });
      refresh();
    },

    /** Sent, but the outcome is unknown (timeout, abort, transport error): worst case. */
    markUncertain(r: Reservation, reason: string): UncertainEntry {
      if (!outstanding.delete(r.reservationId)) throw new Error('VRI-03 budget: unknown or closed reservation');
      const e = write({ kind: 'uncertain', reservationId: r.reservationId, costUsd: r.worstCaseUsd, reason }) as UncertainEntry;
      refresh();
      if (state.spentUsd > ceilingUsd + 1e-12) halt('ceiling_exceeded');
      return e;
    },

    settleGeminiAttempt(r: Reservation, usage: UsageMetadata | null | undefined): SettledEntry {
      if (!outstanding.delete(r.reservationId)) throw new Error('VRI-03 budget: unknown or closed reservation');
      const prompt = nonNegInt(usage?.promptTokenCount);
      const candidates = nonNegInt(usage?.candidatesTokenCount);
      const thoughts = nonNegInt(usage?.thoughtsTokenCount) ?? 0;
      const usable = prompt !== null && candidates !== null;
      const outputTokens = usable ? candidates! + thoughts : null;
      const costUsd = usable ? costFromUsage(priceFor(r.model), prompt!, outputTokens!) : r.worstCaseUsd;
      const overrunUsd = Math.max(0, costUsd - r.worstCaseUsd);
      const e = write({
        kind: 'settled', reservationId: r.reservationId, model: r.model, promptTokens: prompt, outputTokens,
        costUsd, costSource: usable ? 'usage_metadata' : 'worst_case_no_usage', overrunUsd,
      }) as SettledEntry;
      refresh();
      if (overrunUsd > 1e-12) halt('actual_usage_exceeded_reservation');
      if (state.spentUsd > ceilingUsd + 1e-12) halt('ceiling_exceeded');
      return e;
    },

    /** Count BEFORE the provider call is sent. Never priced. */
    recordProviderCall(provider: string, ctx: { itemId: string; arm: string }): ProviderEntry {
      if (state.halted) throw new BudgetHaltedError(state.haltReasons);
      const e = write({ kind: 'provider', provider, itemId: ctx.itemId, arm: ctx.arm }) as ProviderEntry;
      refresh();
      return e;
    },

    remainingUsd(): number {
      return Math.max(0, ceilingUsd - state.spentUsd - outstandingUsd());
    },

    ledger(): readonly LedgerEntry[] {
      return [...ledger];
    },

    summary() {
      return {
        mode: opts.mode,
        ceilingUsd,
        spentUsd: state.spentUsd,
        outstandingUsd: outstandingUsd(),
        remainingUsd: Math.max(0, ceilingUsd - state.spentUsd - outstandingUsd()),
        halted: state.halted,
        haltReasons: [...state.haltReasons],
        geminiAttempts: state.geminiAttempts,
        geminiAttemptsChargedWorstCase: state.worstCaseCharged,
        uncertainAttempts: state.uncertainAttempts,
        overruns: state.overruns,
        providerCalls: { ...state.providerCalls },
        providerCostStatus: 'INSUFFICIENT_EVIDENCE' as const,
        providerCostReason: 'Serper/Poshmark per-query prices were not supplied by the owner',
        pricingProvenance: pricing.provenance,
      };
    },
  };
}

export type BudgetGuard = ReturnType<typeof createBudgetGuard>;
