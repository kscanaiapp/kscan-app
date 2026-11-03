/**
 * Corporate Intelligence v2 -- the ONE place a generation outcome becomes a customer response (CI-03).
 *
 * Every existing path (initial, provider retry, completeness retry, both best-effort branches) and any future fallback
 * model hands its outcome here with the SAME server-assembled task. The finalizer:
 *   1. re-validates the task (Stage 0) and validates the candidate (Stages 1-3) with `validateCorporateOutput`;
 *   2. on acceptance returns the model text plus SERVER-RENDERED labels (label text from the record, never the model);
 *   3. otherwise returns frozen deterministic copy with a closed fallback reason (Stage 4).
 *
 * It never calls a model, never asks for a retry, never repairs text (`regenerate` is the literal type `false`), and
 * contains no clock, randomness or I/O. Any exception inside validation fails CLOSED to deterministic copy.
 *
 * The neutral Black-owned discovery empty state is ALWAYS rendered from frozen copy (Addendum 01 section 5): a model is
 * not the carrier of "there are no verified matches".
 *
 * Imported by no Edge Function (boundaries.test.ts). Wiring into stylechat-generate is CI-04 and gated.
 */
import { CORPORATE_CHARTER_VERSION, CORPORATE_TASK_CONTRACT_VERSION, type CorporateTaskV1, type IntegrityFailureCode, type ValidationStage, validateCorporateTaskV1 } from './contracts.ts';
import { copyKeyFor, type FallbackReason, type FrozenCopyKey, FROZEN_COPY_SET_VERSION, REASON_FOR_FAILURE, resolveFrozenCopy } from './frozenCopy.ts';
import {
  type GenerationOrigin,
  GENERATION_ORIGINS,
  type MerchantNameRegistry,
  OUTPUT_CONTRACT_VERSION,
  OUTPUT_VALIDATOR_VERSION,
  type OutputDetailCode,
  type OutputValidationResult,
  type ServerRenderedLabel,
  validateCorporateOutput,
} from './outputValidation.ts';

export const REASON_TRACE_VERSION = 'ci03-reason-trace-v1' as const;

/** How a generation path ended, BEFORE validation. Provider errors keep their existing classification. */
export type GenerationOutcome =
  | { kind: 'candidate'; candidate: unknown }
  | { kind: 'provider_failure'; failureClass: string };

export interface FinalizeInput {
  task: unknown;
  origin: GenerationOrigin;
  outcome: GenerationOutcome;
  registry: MerchantNameRegistry;
  now: Date;
}

/**
 * Content-minimized reason trace (Addendum 01 section 8). Closed key set (tested). It carries ids, enums, counts and
 * versions only: never output text, prompts, user messages, merchant names, owner identity or verification evidence.
 * `labelRefs` are authoritative record REFERENCES (fact id + opaque source record ref), not evidence.
 */
export interface ReasonTraceV1 {
  traceVersion: typeof REASON_TRACE_VERSION;
  validatorVersion: typeof OUTPUT_VALIDATOR_VERSION;
  outputContractVersion: typeof OUTPUT_CONTRACT_VERSION;
  taskContractVersion: typeof CORPORATE_TASK_CONTRACT_VERSION;
  charterVersion: typeof CORPORATE_CHARTER_VERSION;
  copySetVersion: typeof FROZEN_COPY_SET_VERSION;
  correlationId: string | null;
  origin: GenerationOrigin | 'invalid_origin';
  taskVerb: string | null;
  communicationMode: string | null;
  presentationRegister: string | null;
  surface: string | null;
  inventoryStatus: string | null;
  eligibleCount: number | null;
  eligibleMerchantsAtValidation: number;
  zeroEligible: boolean;
  labelRefs: readonly { labelFactId: string; sourceRecordRef: string }[];
  labelsRendered: number;
  modelLabelEmitted: boolean;
  modelLabelExactMatch: boolean | null;
  validatorStage: ValidationStage | 'not_run';
  validatorResult: 'accept' | 'reject' | 'not_run';
  failureCodes: readonly IntegrityFailureCode[];
  detailCodes: readonly OutputDetailCode[];
  fallbackReason: FallbackReason | null;
  copyKey: FrozenCopyKey | null;
  regenerate: false;
}

export type FinalResponse =
  | { kind: 'model'; text: string; whyThisWorks?: string; labels: readonly ServerRenderedLabel[]; regenerate: false; trace: ReasonTraceV1 }
  | { kind: 'deterministic'; text: string; copyKey: FrozenCopyKey; reason: FallbackReason; regenerate: false; trace: ReasonTraceV1 };

function baseTrace(task: CorporateTaskV1 | null, origin: unknown): ReasonTraceV1 {
  return {
    traceVersion: REASON_TRACE_VERSION,
    validatorVersion: OUTPUT_VALIDATOR_VERSION,
    outputContractVersion: OUTPUT_CONTRACT_VERSION,
    taskContractVersion: CORPORATE_TASK_CONTRACT_VERSION,
    charterVersion: CORPORATE_CHARTER_VERSION,
    copySetVersion: FROZEN_COPY_SET_VERSION,
    correlationId: task?.correlationId ?? null,
    origin: (GENERATION_ORIGINS as readonly unknown[]).includes(origin) ? origin as GenerationOrigin : 'invalid_origin',
    taskVerb: task?.taskVerb ?? null,
    communicationMode: task?.communicationMode ?? null,
    presentationRegister: task?.presentationRegister ?? null,
    surface: task?.surface ?? null,
    inventoryStatus: task?.inventory.status ?? null,
    eligibleCount: task?.inventory.eligibleCount ?? null,
    eligibleMerchantsAtValidation: 0,
    zeroEligible: task?.inventory.status === 'zero_eligible',
    labelRefs: [],
    labelsRendered: 0,
    modelLabelEmitted: false,
    modelLabelExactMatch: null,
    validatorStage: 'not_run',
    validatorResult: 'not_run',
    failureCodes: [],
    detailCodes: [],
    fallbackReason: null,
    copyKey: null,
    regenerate: false,
  };
}

function withValidation(trace: ReasonTraceV1, v: OutputValidationResult): ReasonTraceV1 {
  return {
    ...trace,
    eligibleMerchantsAtValidation: v.eligibleMerchantsAtValidation,
    labelRefs: v.labels.map((l) => ({ labelFactId: l.labelFactId, sourceRecordRef: l.sourceRecordRef })),
    labelsRendered: v.labels.length,
    modelLabelEmitted: v.modelLabelEmitted,
    modelLabelExactMatch: v.modelLabelExactMatch,
    validatorStage: v.stage,
    validatorResult: v.verdict,
    failureCodes: [...new Set(v.failures.map((f) => f.code))],
    detailCodes: v.failures.map((f) => f.detail),
  };
}

function deterministic(
  task: CorporateTaskV1 | null,
  trace: ReasonTraceV1,
  reason: FallbackReason,
  primaryFailure: IntegrityFailureCode | null,
): FinalResponse {
  const key = copyKeyFor({ reason, ...(primaryFailure ? { primaryFailure } : {}) }, task?.inventory.status ?? 'not_applicable');
  const copy = resolveFrozenCopy(key, task?.locale ?? 'en');
  return {
    kind: 'deterministic',
    text: copy.text,
    copyKey: copy.key,
    reason,
    regenerate: false,
    trace: { ...trace, fallbackReason: reason, copyKey: copy.key },
  };
}

export function finalizeCorporateResponse(input: FinalizeInput): FinalResponse {
  let task: CorporateTaskV1 | null = null;
  let trace = baseTrace(null, input?.origin);
  try {
    const nowOk = input?.now instanceof Date && Number.isFinite(input.now.getTime());
    const taskResult = nowOk ? validateCorporateTaskV1(input.task, input.now) : null;
    if (!taskResult || !taskResult.ok) {
      return deterministic(null, { ...trace, validatorStage: 'stage0_server_authority', validatorResult: 'reject', detailCodes: ['task_contract_rejected'], failureCodes: ['output_contract_violation'] }, 'provider_or_validation_failure', null);
    }
    task = taskResult.value;
    trace = baseTrace(task, input.origin);
    if (trace.origin === 'invalid_origin') return deterministic(task, trace, 'provider_or_validation_failure', null);

    // A provider failure is operational: deterministic copy, no new retry here (existing retry policy is unchanged).
    if (!input.outcome || input.outcome.kind !== 'candidate') {
      return deterministic(task, trace, 'provider_or_validation_failure', null);
    }

    const v = validateCorporateOutput({ task, candidate: input.outcome.candidate, registry: input.registry, origin: input.origin, now: input.now });
    trace = withValidation(trace, v);

    // The neutral empty state is always the frozen copy, whatever the model said (the trace still records the verdict).
    if (task.taskVerb === 'discovery_empty_state') return deterministic(task, trace, 'neutral_empty_inventory', null);

    if (v.verdict === 'accept') {
      const c = input.outcome.candidate as { text: string; whyThisWorks?: string };
      return {
        kind: 'model',
        text: c.text,
        ...(typeof c.whyThisWorks === 'string' ? { whyThisWorks: c.whyThisWorks } : {}),
        labels: v.labels,
        regenerate: false,
        trace,
      };
    }
    const primary = v.primaryFailure ?? 'output_contract_violation';
    const contractDetails: readonly OutputDetailCode[] = ['empty_text', 'truncated_output'];
    const reason: FallbackReason = primary === 'output_contract_violation' && v.failures.every((f) => contractDetails.includes(f.detail))
      ? 'provider_or_validation_failure'
      : REASON_FOR_FAILURE[primary];
    return deterministic(task, trace, reason, primary);
  } catch {
    // Fail closed: a validator fault can never let unvalidated text through.
    return deterministic(task, { ...trace, validatorResult: 'reject' }, 'provider_or_validation_failure', null);
  }
}
