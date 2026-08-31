import type { EliseBackendConfig } from './eliseConfig.ts';

export type EliseTelemetryEventName =
  | 'elise_generation_outcome'
  | 'elise_context_normalization_outcome'
  | 'elise_speech_outcome'
  | 'elise_quota_outcome'
  | 'elise_advice_outcome'
  /**
   * Build 34 / K+ Wardrobe Concierge V1 (section 54). Content-free by
   * construction: every Concierge key added to the allowlist below is a count,
   * an enum or a boolean, so no item title, brand, Closet inventory, Signature
   * Style value, image URI or storage path can travel on these events.
   */
  | 'concierge_turn_outcome'
  | 'concierge_ownership_prose_conflict'
  /**
   * CON-ABSENCE-005. Fires when a Closet ABSENCE claim was removed for want of
   * authoritative census provenance. Carries subject CLASS codes and a boolean
   * only -- deliberately no count, because a count of what the Closet lacks is
   * still a statement about its contents.
   */
  | 'concierge_absence_prose_conflict';

export type EliseTelemetryPayload = Record<string, unknown>;

/** Strict allowlist — only these keys may ever be emitted. */
const ALLOWED_KEYS = new Set([
  'backendVersion',
  'contractVersion',
  'promptVersion',
  'outputParserVersion',
  'featureFlagState',
  'requestId',
  'operationType',
  'actorHash',
  'provider',
  'model',
  'latencyMs',
  'retryCount',
  'stableErrorClass',
  'normalizedContextCount',
  'rejectedContextCount',
  'acceptedAttachmentCount',
  'rejectedAttachmentCount',
  'attachmentOutcome',
  'messagesUsed',
  'messagesLimit',
  'duplicate',
  'sourceTypeCounts',
  'warningCodes',
  'flagState',
  'internalContractVersion',
  'normalizationLatencyMs',
  'receivedCount',
  'acceptedCount',
  'droppedCount',
  'rejectedCount',
  'duplicateCount',
  'truncatedCount',
  'resolverOutcomeCounts',
  'contextNormalizationV1',
  'operationStatus',
  'attemptCount',
  'duplicateDetected',
  'duplicateRecoveryOutcome',
  'quotaReservationOutcome',
  'generationLatencyMs',
  'providerLatencyMs',
  'outputValidationOutcome',
  'persistenceOutcome',
  'staleResponseOutcome',
  'groundingVersion',
  'mayGenerate',
  // E-4 allowlisted keys only — no item names, URLs, or full Closet dumps.
  'adviceIntent',
  'candidateCountsBySource',
  'authorizedCount',
  'rejectedCount',
  'retrievalLatencyMs',
  'scoringLatencyMs',
  'groundedCandidateCount',
  'ownershipSourceCounts',
  'purchaseVerdict',
  'wardrobeGapCategoryCode',
  'multiLookCount',
  // Build 34 / Track B / Phase B5 — bounded booleans only, never a profile
  // value, a Closet field, or a K+ grant source/reason.
  'kPlusActive',
  'styleDnaAvailable',
  // Build 34 / K+ Wardrobe Concierge V1 (section 54) — aggregate dimensions
  // only. `conflictCodes` carries garment CLASS codes ("unsupported_owned_
  // jacket"), never the sentence that was removed or the item that was named.
  'wardrobeContextMode',
  'focusResolutionClass',
  'focusAmbiguous',
  'censusExhaustive',
  'censusTotalItems',
  'lookCount',
  'gapPresented',
  'gapEvidenceExhaustive',
  'ownedEvidenceUsed',
  'conflictCodes',
  /**
   * CON-ABSENCE-005. Whether the turn had authoritative census provenance at
   * all. A boolean about the SYSTEM's evidence, not about the Closet: it says
   * whether we were allowed to speak, never what was in there.
   */
  'censusAvailable',
  'shortlistSize',
  'latencyBucket',
  'conciergeV1',
]);

const ALLOWED_STRING_VALUE = /^[A-Za-z0-9_.:\-|,]{0,160}$/;

export function makeRequestId(): string {
  return crypto.randomUUID();
}

export async function stableActorHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function sanitizeScalar(value: unknown): string | number | boolean | null | undefined {
  if (value == null) return value;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string') {
    const trimmed = value.slice(0, 160);
    if (!ALLOWED_STRING_VALUE.test(trimmed)) return undefined;
    if (/bearer\s+/i.test(trimmed)) return undefined;
    if (/@/.test(trimmed)) return undefined;
    if (/https?:\/\//i.test(trimmed)) return undefined;
    return trimmed;
  }
  return undefined;
}

function sanitizePayload(payload: EliseTelemetryPayload): EliseTelemetryPayload {
  const safe: EliseTelemetryPayload = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!ALLOWED_KEYS.has(key)) continue;
    if (Array.isArray(value)) {
      const items = value
        .map((item) => sanitizeScalar(item))
        .filter((item): item is string | number | boolean => item != null)
        .slice(0, 12);
      if (items.length) safe[key] = items;
      continue;
    }
    const scalar = sanitizeScalar(value);
    if (scalar !== undefined) safe[key] = scalar;
  }
  return safe;
}

export function emitEliseTelemetry(
  config: EliseBackendConfig,
  eventName: EliseTelemetryEventName,
  payload: EliseTelemetryPayload,
): void {
  if (!config.flags.telemetryV1) return;
  try {
    const safePayload = sanitizePayload({
      backendVersion: config.backendVersion,
      contractVersion: config.contextContractVersion,
      promptVersion: config.promptVersion,
      outputParserVersion: config.outputParserVersion,
      featureFlagState: Object.entries(config.flags)
        .filter(([, value]) => value)
        .map(([key]) => key)
        .sort()
        .join(','),
      ...payload,
    });
    console.log(`[${eventName}] ${JSON.stringify(safePayload)}`);
  } catch {
    // Telemetry is strictly fail-open.
  }
}
