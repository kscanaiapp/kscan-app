import { requestElevenLabsSpeech, type ElevenLabsEnvironment } from './elevenLabsClient.ts';
import { StylistSpeechRateLimiter } from './rateLimit.ts';
import { parseBooleanEnv } from '../stylechat-generate/eliseConfig.ts';
import {
  SpeechCircuitBreaker,
  shouldRecordSpeechCircuitFailure,
  shouldRetrySpeechError,
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
const REQUEST_KEYS = new Set(['sessionId', 'messageId', 'stylistId']);

export interface StylistSpeechHandlerDependencies {
  createDataAccess(authHeader: string): StylistSpeechDataAccess;
  env: ElevenLabsEnvironment;
  limiter?: StylistSpeechRateLimiter;
  circuitBreaker?: SpeechCircuitBreaker;
  generateSpeech?: typeof requestElevenLabsSpeech;
  now?: () => number;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...STYLIST_SPEECH_CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function parseRequestBody(value: unknown): StylistSpeechRequest {
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
  if (!UUID_RE.test(sessionId) || !UUID_RE.test(messageId) || !stylistId) {
    throw new StylistSpeechError(400, 'INVALID_REQUEST', 'The speech request contains invalid references.');
  }
  return { sessionId, messageId, stylistId };
}

function operationKey(
  actorId: string,
  request: StylistSpeechRequest,
): string {
  return `${actorId}:${request.sessionId}:${request.messageId}:${request.stylistId}`;
}

function sanitizeError(error: unknown): Response {
  if (error instanceof StylistSpeechError) {
    return json({ error: error.message, code: error.code }, error.status);
  }
  return json({ error: 'Speech is temporarily unavailable.', code: 'INTERNAL_ERROR' }, 500);
}

export function createStylistSpeechHandler(
  dependencies: StylistSpeechHandlerDependencies,
): (request: Request) => Promise<Response> {
  const limiter = dependencies.limiter ?? new StylistSpeechRateLimiter();
  const circuitBreaker = dependencies.circuitBreaker ?? new SpeechCircuitBreaker();
  const generateSpeech = dependencies.generateSpeech ?? requestElevenLabsSpeech;
  const now = dependencies.now ?? Date.now;

  return async (request: Request): Promise<Response> => {
    if (request.method === 'OPTIONS') {
      return new Response('ok', { headers: STYLIST_SPEECH_CORS_HEADERS });
    }
    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed', code: 'INVALID_REQUEST' }, 405);
    }

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
      if (speechCircuitEnabled && !circuitBreaker.canAttempt('elevenlabs', now())) {
        throw new StylistSpeechError(503, 'PROVIDER_UNAVAILABLE', 'Speech generation is unavailable.');
      }

      const release = limiter.begin(actor.id, operationKey(actor.id, body), now());
      try {
        let generated: Awaited<ReturnType<typeof generateSpeech>> | null = null;
        let retryCount = 0;
        const startedAt = now();
        for (;;) {
          try {
            generated = await generateSpeech({
              text: speechText,
              voiceProfile,
              env: dependencies.env,
            });
            if (speechCircuitEnabled) circuitBreaker.recordSuccess('elevenlabs');
            break;
          } catch (error) {
            if (speechCircuitEnabled && shouldRecordSpeechCircuitFailure(error)) {
              circuitBreaker.recordFailure('elevenlabs', now());
            }
            const retryAfterSeconds = error instanceof StylistSpeechError && error.code === 'PROVIDER_RATE_LIMIT'
              ? 1
              : null;
            const shouldRetry = speechResilienceEnabled && speechRetryEnabled && shouldRetrySpeechError({
              error,
              retryCount,
              retryAfterSeconds,
              remainingBudgetMs: 15_000 - (now() - startedAt),
            });
            if (!shouldRetry) throw error;
            retryCount += 1;
          }
        }
        if (!generated) {
          throw new StylistSpeechError(500, 'INTERNAL_ERROR', 'Speech is temporarily unavailable.');
        }
        const response: StylistSpeechResponse = {
          messageId: body.messageId,
          stylistId: body.stylistId,
          voiceProfile,
          mimeType: 'audio/mpeg',
          audioBase64: generated.audioBase64,
          alignment: generated.alignment,
        };
        return json(response);
      } finally {
        release();
      }
    } catch (error) {
      return sanitizeError(error);
    }
  };
}
