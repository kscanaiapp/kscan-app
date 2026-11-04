/**
 * VRI-03 benchmark budget guard — the $20 Gemini ceiling, enforced in code.
 *
 * Rules (owner approval scope):
 *   - One hard ceiling across ALL VRI-03 benchmarking. Prior spend is carried in
 *     through the persisted ledger, so a second run cannot reset it.
 *   - Every Gemini attempt must RESERVE its worst-case cost before it is sent.
 *     A reservation that would push spent + outstanding over the ceiling throws
 *     before any network call, so the ceiling is never crossed on a known bound.
 *   - Actual cost is settled from the response `usageMetadata`. A response
 *     without usable usage is charged its worst case (fail safe, never free).
 *   - Provider (Serper / Poshmark) calls are counted exactly. Their prices were
 *     never supplied, so provider cost is always INSUFFICIENT_EVIDENCE.
 *
 * Offline module: no network, no Deno.env, no file IO. Not imported by any
 * deployed function.
 */

export type ModelPrice = { inputPerMillionUsd: number; outputPerMillionUsd: number };

export const VRI03_PRICING = Object.freeze({
  recordId: 'gemini-pricing.2026-07-29',
  provenance:
    'evals/scanner-accuracy/pricing/gemini-pricing.2026-07-29.json on research/scanner-accuracy-v2-evals ' +
    '(official Gemini API paid-tier pricing, retrieved 2026-07-29; output price includes thinking tokens)',
  retrievedAt: '2026-07-29',
  models: Object.freeze({
    'gemini-3.6-flash': Object.freeze({ inputPerMillionUsd: 1.5, outputPerMillionUsd: 7.5 }),
    'gemini-3.5-flash-lite': Object.freeze({ inputPerMillionUsd: 0.3, outputPerMillionUsd: 2.5 }),
  }) as Readonly<Record<string, ModelPrice>>,
});

export const VRI03_GEMINI_CEILING_USD = 20;
/** scan-identify MAX_OUTPUT_TOKENS (index.ts). Thinking tokens bill as output. */
export const VRI03_MAX_OUTPUT_TOKENS = 2048;
/**
 * Conservative per-attempt input bound used when no free countTokens preflight
 * was supplied: ~1,032 image tokens (896 px payload, 4 tiles) plus the longest
 * scanner prompt with every addendum, rounded up generously.
 */
export const VRI03_DEFAULT_INPUT_TOKEN_UPPER_BOUND = 6000;

export type UsageMetadata = {
  promptTokenCount?: unknown;
  candidatesTokenCount?: unknown;
  thoughtsTokenCount?: unknown;
  totalTokenCount?: unknown;
};

export type GeminiLedgerEntry = {
  kind: 'gemini';
  seq: number;
  model: string;
  itemId: string;
  arm: string;
  promptTokens: number | null;
  outputTokens: number | null;
  costUsd: number;
  costSource: 'usage_metadata' | 'worst_case_no_usage';
};

export type ProviderLedgerEntry = { kind: 'provider'; seq: number; provider: string; itemId: string; arm: string };

export type LedgerEntry = GeminiLedgerEntry | ProviderLedgerEntry;

export class BudgetExceededError extends Error {
  constructor(
    readonly spentUsd: number,
    readonly outstandingUsd: number,
    readonly requestedUsd: number,
    readonly ceilingUsd: number,
  ) {
    super(
      `VRI-03 Gemini ceiling: reserving $${requestedUsd.toFixed(4)} would exceed $${ceilingUsd.toFixed(2)} ` +
        `(spent $${spentUsd.toFixed(4)}, outstanding $${outstandingUsd.toFixed(4)}). No call was sent.`,
    );
    this.name = 'BudgetExceededError';
  }
}

export type Reservation = {
  readonly id: number;
  readonly model: string;
  readonly worstCaseUsd: number;
  readonly itemId: string;
  readonly arm: string;
};

function nonNegInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
}

function priceFor(pricing: typeof VRI03_PRICING, model: string): ModelPrice {
  const p = pricing.models[model];
  if (!p) throw new Error(`VRI-03 budget: no dated price for model "${model}"; refusing to reserve`);
  return p;
}

export function costFromUsage(price: ModelPrice, promptTokens: number, outputTokens: number): number {
  return (promptTokens * price.inputPerMillionUsd + outputTokens * price.outputPerMillionUsd) / 1_000_000;
}

export function createBudgetGuard(opts: {
  ceilingUsd?: number;
  priorLedger?: readonly LedgerEntry[];
  pricing?: typeof VRI03_PRICING;
  maxOutputTokens?: number;
  inputTokenUpperBound?: number;
} = {}) {
  const ceilingUsd = opts.ceilingUsd ?? VRI03_GEMINI_CEILING_USD;
  if (!(ceilingUsd > 0) || ceilingUsd > VRI03_GEMINI_CEILING_USD) {
    throw new Error(`VRI-03 budget: ceiling must be in (0, ${VRI03_GEMINI_CEILING_USD}]`);
  }
  const pricing = opts.pricing ?? VRI03_PRICING;
  const maxOutputTokens = opts.maxOutputTokens ?? VRI03_MAX_OUTPUT_TOKENS;
  const inputUpper = opts.inputTokenUpperBound ?? VRI03_DEFAULT_INPUT_TOKEN_UPPER_BOUND;

  const ledger: LedgerEntry[] = [...(opts.priorLedger ?? [])];
  let spentUsd = ledger.reduce((s, e) => s + (e.kind === 'gemini' ? e.costUsd : 0), 0);
  let seq = ledger.reduce((m, e) => Math.max(m, e.seq), 0);
  let nextReservation = 1;
  const outstanding = new Map<number, Reservation>();
  const outstandingUsd = () => [...outstanding.values()].reduce((s, r) => s + r.worstCaseUsd, 0);

  function worstCaseCallUsd(model: string, countedInputTokens?: number): number {
    const input = countedInputTokens !== undefined && nonNegInt(countedInputTokens) !== null
      ? countedInputTokens
      : inputUpper;
    return costFromUsage(priceFor(pricing, model), input, maxOutputTokens);
  }

  return {
    ceilingUsd,
    worstCaseCallUsd,

    /** Throws BudgetExceededError BEFORE the call when the bound does not fit. */
    reserveGeminiAttempt(model: string, ctx: { itemId: string; arm: string; countedInputTokens?: number }): Reservation {
      const worst = worstCaseCallUsd(model, ctx.countedInputTokens);
      const out = outstandingUsd();
      if (spentUsd + out + worst > ceilingUsd + 1e-12) {
        throw new BudgetExceededError(spentUsd, out, worst, ceilingUsd);
      }
      const r: Reservation = Object.freeze({ id: nextReservation++, model, worstCaseUsd: worst, itemId: ctx.itemId, arm: ctx.arm });
      outstanding.set(r.id, r);
      return r;
    },

    /** The reserved call was never sent (e.g. aborted locally). */
    releaseReservation(r: Reservation): void {
      outstanding.delete(r.id);
    },

    /** Settle a sent attempt from its usageMetadata. Missing usage → worst case. */
    settleGeminiAttempt(r: Reservation, usage: UsageMetadata | null | undefined): GeminiLedgerEntry {
      if (!outstanding.has(r.id)) throw new Error('VRI-03 budget: unknown or already settled reservation');
      outstanding.delete(r.id);
      const prompt = nonNegInt(usage?.promptTokenCount);
      const candidates = nonNegInt(usage?.candidatesTokenCount);
      const thoughts = nonNegInt(usage?.thoughtsTokenCount) ?? 0;
      const usable = prompt !== null && candidates !== null;
      const outputTokens = usable ? candidates! + thoughts : null;
      const costUsd = usable ? costFromUsage(priceFor(pricing, r.model), prompt!, outputTokens!) : r.worstCaseUsd;
      const entry: GeminiLedgerEntry = {
        kind: 'gemini', seq: ++seq, model: r.model, itemId: r.itemId, arm: r.arm,
        promptTokens: prompt, outputTokens, costUsd,
        costSource: usable ? 'usage_metadata' : 'worst_case_no_usage',
      };
      spentUsd += costUsd;
      ledger.push(entry);
      return entry;
    },

    recordProviderCall(provider: string, ctx: { itemId: string; arm: string }): ProviderLedgerEntry {
      const entry: ProviderLedgerEntry = { kind: 'provider', seq: ++seq, provider, itemId: ctx.itemId, arm: ctx.arm };
      ledger.push(entry);
      return entry;
    },

    remainingUsd(): number {
      return Math.max(0, ceilingUsd - spentUsd - outstandingUsd());
    },

    ledger(): readonly LedgerEntry[] {
      return [...ledger];
    },

    summary() {
      const providerCalls: Record<string, number> = {};
      let geminiCalls = 0;
      let worstCaseCharged = 0;
      for (const e of ledger) {
        if (e.kind === 'provider') providerCalls[e.provider] = (providerCalls[e.provider] ?? 0) + 1;
        else {
          geminiCalls++;
          if (e.costSource === 'worst_case_no_usage') worstCaseCharged++;
        }
      }
      return {
        ceilingUsd,
        spentUsd,
        outstandingUsd: outstandingUsd(),
        remainingUsd: Math.max(0, ceilingUsd - spentUsd - outstandingUsd()),
        geminiCalls,
        geminiCallsChargedWorstCase: worstCaseCharged,
        providerCalls,
        providerCostStatus: 'INSUFFICIENT_EVIDENCE' as const,
        providerCostReason: 'Serper/Poshmark per-query prices were not supplied by the owner',
        pricingProvenance: pricing.provenance,
      };
    },
  };
}

export type BudgetGuard = ReturnType<typeof createBudgetGuard>;
