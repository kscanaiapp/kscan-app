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
  // Stable bounded pseudonym. Never place a raw UUID substring in logs.
  let hash = 0x811c9dc5;
  for (let i = 0; i < actorId.length; i += 1) {
    hash ^= actorId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `u_${(hash >>> 0).toString(16).padStart(8, '0')}`;
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
