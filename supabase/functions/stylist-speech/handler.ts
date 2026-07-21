import { requestElevenLabsSpeech, type ElevenLabsEnvironment } from './elevenLabsClient.ts';
import { assertValidSpeechAudio } from './eliseSpeechAudioValidation.ts';
import { SpeechConcurrencyGate } from './eliseSpeechConcurrency.ts';
import {
  buildSpeechOperationKey,
  createSpeechOperationIdentity,
  SpeechOperationRegistry,
} from './eliseSpeechIdentity.ts';
import { emitSpeechTelemetry } from './eliseSpeechTelemetry.ts';
import { StylistSpeechRateLimiter } from './rateLimit.ts';
import { parseBooleanEnv } from '../stylechat-generate/eliseConfig.ts';
import {
  SpeechCircuitBreaker,
  shouldRecordSpeechCircuitFailure,
  shouldRetrySpeechError,
  stableClassForSpeechError,
} from './resilience.ts';
import { buildSpeechText, isHiddenOrSystemOnlyMessage } from './speechText.ts';
import {
  StylistSpeechError,
  type StylistSpeechDataAccess,
  type StylistSpeechRequest,
  type StylistSpeechResponse,
  type StylistSpeechVoiceProfile,
} from './types.ts';
import { resolveServerVoiceProfile } from './voiceProfiles.ts';

export const STYLIST_SPEECH_CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Installed clients send sessionId/messageId/stylistId. requestId is optional. */
const REQUEST_KEYS = new Set(['sessionId', 'messageId', 'stylistId', 'requestId']);
const PROVIDER_SCOPE = 'elevenlabs';
const REQUEST_BUDGET_MS = 15_000;

export interface StylistSpeechHandlerDependencies {
  createDataAccess(authHeader: string): StylistSpeechDataAccess;
  env: ElevenLabsEnvironment;
  limiter?: StylistSpeechRateLimiter;
  circuitBreaker?: SpeechCircuitBreaker;
  concurrencyGate?: SpeechConcurrencyGate;
  operationRegistry?: SpeechOperationRegistry;
  generateSpeech?: typeof requestElevenLabsSpeech;
  now?: () => number;
  telemetrySink?: (line: string) => void;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...STYLIST_SPEECH_CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function parseRequestBody(value: unknown): StylistSpeechRequest & { requestId?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new StylistSpeechError(400, 'INVALID_REQUEST', 'A valid speech request is required.');
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !REQUEST_KEYS.has(key))) {
    throw new StylistSpeechError(400, 'INVALID_REQUEST', 'The speech request contains unsupported fields.');
  }

  const sessionId = typeof record.sessionId === 'string' ? record.sessionId.trim() : '';
  const messageId = typeof record.messageId === 'string' ? record.messageId.trim() : '';
  const stylistId = typeof record.stylistId === 'string' ? record.stylistId.trim() : '';
  const requestId = typeof record.requestId === 'string' ? record.requestId.trim() : '';
  if (!UUID_RE.test(sessionId) || !UUID_RE.test(messageId) || !stylistId) {
    throw new StylistSpeechError(400, 'INVALID_REQUEST', 'The speech request contains invalid references.');
  }
  if (requestId && requestId.length > 128) {
    throw new StylistSpeechError(400, 'INVALID_REQUEST', 'The speech request contains invalid references.');
  }
  return {
    sessionId,
    messageId,
    stylistId,
    ...(requestId ? { requestId } : {}),
  };
}

function sanitizeError(error: unknown): Response {
  if (error instanceof StylistSpeechError) {
    return json({ error: error.message, code: error.code }, error.status);
  }
  return json({ error: 'Speech is temporarily unavailable.', code: 'INTERNAL_ERROR' }, 500);
}

function readRetryAfterSeconds(error: unknown): number | null {
  if (!(error instanceof StylistSpeechError)) return null;
  return error.retryAfterSeconds;
}

export function createStylistSpeechHandler(
  dependencies: StylistSpeechHandlerDependencies,
): (request: Request) => Promise<Response> {
  const limiter = dependencies.limiter ?? new StylistSpeechRateLimiter();
  const circuitBreaker = dependencies.circuitBreaker ?? new SpeechCircuitBreaker();
  const concurrencyGate = dependencies.concurrencyGate ?? new SpeechConcurrencyGate();
  const operationRegistry = dependencies.operationRegistry ?? new SpeechOperationRegistry();
  const generateSpeech = dependencies.generateSpeech ?? requestElevenLabsSpeech;
  const now = dependencies.now ?? Date.now;
  const telemetrySink = dependencies.telemetrySink;

  return async (request: Request): Promise<Response> => {
    if (request.method === 'OPTIONS') {
      return new Response('ok', { headers: STYLIST_SPEECH_CORS_HEADERS });
    }
    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed', code: 'INVALID_REQUEST' }, 405);
    }

    const requestStartedAt = now();
    let serverRequestId: string = crypto.randomUUID();
    let operationKeyForCleanup: string | null = null;
    let releaseQuota: (() => void) | null = null;
    let releaseConcurrency: (() => void) | null = null;
    let probeReserved = false;

    try {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader?.startsWith('Bearer ') || authHeader.slice(7).trim().length === 0) {
        throw new StylistSpeechError(401, 'NOT_AUTHENTICATED', 'Authentication is required.');
      }

      const dataAccess = dependencies.createDataAccess(authHeader);
      const actor = await dataAccess.getAuthenticatedActor().catch(() => null);
      if (!actor?.id) {
        throw new StylistSpeechError(401, 'NOT_AUTHENTICATED', 'Authentication is required.');
      }

      const accountStatus = await dataAccess.getAccountStatus(actor.id);
      if (accountStatus === 'pending_deletion' || accountStatus === 'locked') {
        throw new StylistSpeechError(403, 'ACCOUNT_UNAVAILABLE', 'Speech is unavailable for this account.');
      }

      let rawBody: unknown;
      try {
        rawBody = await request.json();
      } catch {
        throw new StylistSpeechError(400, 'INVALID_REQUEST', 'A valid JSON request is required.');
      }
      const body = parseRequestBody(rawBody);
      if (body.requestId) serverRequestId = body.requestId;
      const voiceProfile: StylistSpeechVoiceProfile = resolveServerVoiceProfile(body.stylistId);

      const session = await dataAccess.getSession(body.sessionId, actor.id);
      if (!session || session.id !== body.sessionId || session.user_id !== actor.id) {
        throw new StylistSpeechError(404, 'SESSION_NOT_FOUND', 'The conversation was not found.');
      }

      const message = await dataAccess.getMessage(body.messageId, actor.id);
      if (
        !message ||
        message.id !== body.messageId ||
        message.user_id !== actor.id ||
        message.session_id !== body.sessionId
      ) {
        throw new StylistSpeechError(404, 'MESSAGE_NOT_FOUND', 'The message was not found.');
      }
      if (message.sender !== 'assistant' || isHiddenOrSystemOnlyMessage(message)) {
        throw new StylistSpeechError(422, 'MESSAGE_INELIGIBLE', 'This message cannot be spoken.');
      }

      const speechText = buildSpeechText(message.content);
      if (!speechText) {
        throw new StylistSpeechError(422, 'MESSAGE_INELIGIBLE', 'This message cannot be spoken.');
      }

      const preference = await dataAccess.getStylistPreference(actor.id);
      const persistedStylistId = preference?.avatar_id ?? 'elise_default';
      if (persistedStylistId !== body.stylistId) {
        throw new StylistSpeechError(403, 'STYLIST_MISMATCH', 'The selected stylist does not match this account.');
      }

      const speechResilienceEnabled = parseBooleanEnv(
        dependencies.env,
        'ELISE_SPEECH_RESILIENCE_V1_ENABLED',
        false,
      );
      const speechRetryEnabled = parseBooleanEnv(
        dependencies.env,
        'ELISE_SPEECH_RETRY_ENABLED',
        false,
      );
      const speechCircuitEnabled = parseBooleanEnv(
        dependencies.env,
        'ELISE_SPEECH_CIRCUIT_BREAKER_ENABLED',
        false,
      );
      const speechDedupeEnabled = parseBooleanEnv(
        dependencies.env,
        'ELISE_SPEECH_DEDUPLICATION_V1_ENABLED',
        false,
      );
      const speechConcurrencyEnabled = parseBooleanEnv(
        dependencies.env,
        'ELISE_SPEECH_CONCURRENCY_V1_ENABLED',
        false,
      );

      const identity = createSpeechOperationIdentity({
        actorId: actor.id,
        sessionId: body.sessionId,
        messageId: body.messageId,
        avatarId: body.stylistId,
        voiceProfile,
      });
      const operationKey = buildSpeechOperationKey(identity);
      operationKeyForCleanup = operationKey;

      if (speechDedupeEnabled || speechResilienceEnabled) {
        operationRegistry.supersedeOlderMessages({
          actorId: actor.id,
          sessionId: body.sessionId,
          avatarId: body.stylistId,
          keepMessageId: body.messageId,
        });
        const reserved = operationRegistry.reserve({
          operationKey,
          actorId: actor.id,
          sessionId: body.sessionId,
          messageId: body.messageId,
          avatarId: body.stylistId,
          voiceProfile,
          requestId: serverRequestId,
        });
        if (reserved.duplicate) {
          emitSpeechTelemetry({
            requestId: serverRequestId,
            speechOperationStatus: reserved.operation.status,
            attemptCount: reserved.operation.attemptCount,
            deduplicated: true,
            featureFlagSpeechDedupe: speechDedupeEnabled,
            featureFlagSpeechResilience: speechResilienceEnabled,
            latencyMs: now() - requestStartedAt,
          }, telemetrySink);
          if (reserved.operation.status === 'completed') {
            throw new StylistSpeechError(409, 'DUPLICATE_REQUEST', 'Speech was already prepared for this message.');
          }
          if (
            reserved.operation.status === 'failed_terminal' ||
            reserved.operation.status === 'stale' ||
            reserved.operation.status === 'cancelled'
          ) {
            throw new StylistSpeechError(409, 'DUPLICATE_REQUEST', 'Speech is unavailable for this message.');
          }
          throw new StylistSpeechError(409, 'DUPLICATE_REQUEST', 'Speech is already being prepared.');
        }
      }

      if (speechCircuitEnabled) {
        const snapshot = circuitBreaker.snapshot(PROVIDER_SCOPE, now());
        if (!circuitBreaker.canAttempt(PROVIDER_SCOPE, now())) {
          emitSpeechTelemetry({
            requestId: serverRequestId,
            circuitState: snapshot.state,
            circuitScope: PROVIDER_SCOPE,
            stableErrorClass: 'PROVIDER_BUSY',
            featureFlagSpeechCircuit: true,
          }, telemetrySink);
          throw new StylistSpeechError(503, 'PROVIDER_UNAVAILABLE', 'Speech generation is unavailable.');
        }
        if (snapshot.state === 'half_open') {
          if (!circuitBreaker.beginProbe(PROVIDER_SCOPE, now())) {
            throw new StylistSpeechError(503, 'PROVIDER_UNAVAILABLE', 'Speech generation is unavailable.');
          }
          probeReserved = true;
        }
      }

      if (speechConcurrencyEnabled) {
        releaseConcurrency = await concurrencyGate.admit(actor.id, now());
      }

      releaseQuota = limiter.begin(actor.id, operationKey, now(), {
        deferDailyCommit: speechResilienceEnabled,
      });

      if (speechDedupeEnabled || speechResilienceEnabled) {
        operationRegistry.markGenerating(operationKey);
      }

      try {
        let generated: Awaited<ReturnType<typeof generateSpeech>> | null = null;
        let retryCount = 0;
        let audioOutcome = 'valid';
        const startedAt = now();
        for (;;) {
          // Re-validate ownership before each provider attempt (account switch / deletion).
          const sessionStill = await dataAccess.getSession(body.sessionId, actor.id);
          if (!sessionStill || sessionStill.user_id !== actor.id) {
            if (speechDedupeEnabled || speechResilienceEnabled) {
              operationRegistry.markStale(operationKey);
            }
            throw new StylistSpeechError(404, 'SESSION_NOT_FOUND', 'The conversation was not found.');
          }
          const messageStill = await dataAccess.getMessage(body.messageId, actor.id);
          if (
            !messageStill ||
            messageStill.user_id !== actor.id ||
            messageStill.session_id !== body.sessionId
          ) {
            if (speechDedupeEnabled || speechResilienceEnabled) {
              operationRegistry.markStale(operationKey);
            }
            throw new StylistSpeechError(404, 'MESSAGE_NOT_FOUND', 'The message was not found.');
          }
          const op = operationRegistry.get(operationKey);
          if (op && (op.status === 'stale' || op.status === 'cancelled')) {
            throw new StylistSpeechError(409, 'DUPLICATE_REQUEST', 'Speech request was cancelled.');
          }

          try {
            generated = await generateSpeech({
              text: speechText,
              voiceProfile,
              env: dependencies.env,
              correlationId: serverRequestId,
            });
            const validated = assertValidSpeechAudio({
              audioBase64: generated.audioBase64,
              alignment: generated.alignment,
              strictAlignment: false,
            });
            generated = {
              audioBase64: validated.audioBase64,
              alignment: validated.alignment,
            };
            audioOutcome = validated.outcome;
            if (speechCircuitEnabled) circuitBreaker.recordSuccess(PROVIDER_SCOPE);
            probeReserved = false;
            break;
          } catch (error) {
            if (speechCircuitEnabled && shouldRecordSpeechCircuitFailure(error)) {
              circuitBreaker.recordFailure(PROVIDER_SCOPE, now());
              probeReserved = false;
            }
            const retryAfterSeconds = readRetryAfterSeconds(error);
            const shouldRetry = speechResilienceEnabled && speechRetryEnabled && shouldRetrySpeechError({
              error,
              retryCount,
              retryAfterSeconds,
              remainingBudgetMs: REQUEST_BUDGET_MS - (now() - startedAt),
            });
            if (!shouldRetry) {
              if (speechDedupeEnabled || speechResilienceEnabled) {
                const stable = stableClassForSpeechError(error);
                const wouldRetryFromFresh = shouldRetrySpeechError({
                  error,
                  retryCount: 0,
                  retryAfterSeconds,
                  remainingBudgetMs: REQUEST_BUDGET_MS,
                });
                operationRegistry.finalize(
                  operationKey,
                  wouldRetryFromFresh && retryCount >= 1 ? 'failed_terminal' : (wouldRetryFromFresh ? 'failed_retryable' : 'failed_terminal'),
                  stable,
                );
              }
              throw error;
            }
            retryCount += 1;
          }
        }
        if (!generated) {
          throw new StylistSpeechError(500, 'INTERNAL_ERROR', 'Speech is temporarily unavailable.');
        }

        if (speechResilienceEnabled) {
          limiter.commitDaily(operationKey);
        }
        if (speechDedupeEnabled || speechResilienceEnabled) {
          operationRegistry.finalize(operationKey, 'completed');
        }

        const response: StylistSpeechResponse = {
          messageId: body.messageId,
          stylistId: body.stylistId,
          voiceProfile,
          mimeType: 'audio/mpeg',
          audioBase64: generated.audioBase64,
          alignment: generated.alignment,
        };

        emitSpeechTelemetry({
          requestId: serverRequestId,
          speechOperationStatus: 'completed',
          attemptCount: (operationRegistry.get(operationKey)?.attemptCount) ?? 1,
          retryCount,
          latencyMs: now() - requestStartedAt,
          audioValidationOutcome: audioOutcome,
          circuitState: speechCircuitEnabled
            ? circuitBreaker.getState(PROVIDER_SCOPE, now())
            : 'closed',
          voiceAlias: voiceProfile,
          provider: PROVIDER_SCOPE,
          featureFlagSpeechResilience: speechResilienceEnabled,
          featureFlagSpeechRetry: speechRetryEnabled,
          featureFlagSpeechCircuit: speechCircuitEnabled,
          featureFlagSpeechDedupe: speechDedupeEnabled,
          featureFlagSpeechConcurrency: speechConcurrencyEnabled,
        }, telemetrySink);

        return json(response);
      } finally {
        releaseQuota?.();
        releaseQuota = null;
        releaseConcurrency?.();
        releaseConcurrency = null;
      }
    } catch (error) {
      try {
        emitSpeechTelemetry({
          requestId: serverRequestId,
          stableErrorClass: stableClassForSpeechError(error),
          speechOperationStatus: operationKeyForCleanup
            ? (operationRegistry.get(operationKeyForCleanup)?.status ?? null)
            : null,
          latencyMs: now() - requestStartedAt,
          circuitState: circuitBreaker.getState(PROVIDER_SCOPE, now()),
        }, telemetrySink);
      } catch {
        // fail-open
      }
      return sanitizeError(error);
    }
  };
}
