/**
 * Metadata-only security telemetry for AI entry points.
 * Never log prompts, messages, images, JWTs, API keys, storage paths, or full user IDs.
 */

export type AiSecurityEntryPoint = 'elise' | 'typechat';

export type AiSecurityTelemetryEvent = {
  requestId: string;
  timestamp: string;
  actorRef: string;
  entryPoint: AiSecurityEntryPoint;
  validationCategory?: string;
  rejectedActionCategory?: string;
  sectionLengths?: Record<string, number>;
  attachmentCount?: number;
  rateLimitDecision?: 'allow' | 'throttle';
  authorizationResult?: 'allow' | 'deny';
  providerLatencyMs?: number;
  timeoutCategory?: 'none' | 'provider' | 'commerce' | 'weather';
};

export function oneWayActorRef(actorId: string | null | undefined): string {
  if (!actorId) return 'anon';
  // Bounded one-way reference — never the full user id.
  return `u_${actorId.slice(0, 8)}`;
}

export function emitAiSecurityTelemetry(
  event: AiSecurityTelemetryEvent,
  log: (line: string) => void = console.log,
): void {
  const payload = {
    kind: 'ai_security',
    requestId: event.requestId,
    ts: event.timestamp,
    actorRef: event.actorRef,
    entryPoint: event.entryPoint,
    validationCategory: event.validationCategory ?? null,
    rejectedActionCategory: event.rejectedActionCategory ?? null,
    sectionLengths: event.sectionLengths ?? null,
    attachmentCount: event.attachmentCount ?? 0,
    rateLimitDecision: event.rateLimitDecision ?? null,
    authorizationResult: event.authorizationResult ?? null,
    providerLatencyMs: event.providerLatencyMs ?? null,
    timeoutCategory: event.timeoutCategory ?? 'none',
  };
  log(`[ai-security] ${JSON.stringify(payload)}`);
}

export const AI_SECURITY_ALERT_THRESHOLDS = {
  rejectedActionVolumePerMinute: 20,
  crossUserAuthFailuresPerMinute: 5,
  malformedModelOutputPerMinute: 15,
  validationFailurePerMinute: 30,
  providerRequestBurstPerMinute: 60,
} as const;
