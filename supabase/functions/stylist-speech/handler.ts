import { requestElevenLabsSpeech, type ElevenLabsEnvironment } from './elevenLabsClient.ts';
import { StylistSpeechRateLimiter } from './rateLimit.ts';
import { buildSpeechText, isHiddenOrSystemOnlyMessage } from './speechText.ts';
import {
  StylistSpeechError,
  type StylistSpeechDataAccess,
  type StylistSpeechRequest,
  type StylistSpeechResponse,
  type StylistSpeechVoiceProfile,
} from './types.ts';
import { requireSpeechCueText } from './speechCues.ts';
import { resolveServerVoiceSelection } from './voiceProfiles.ts';

export const STYLIST_SPEECH_CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MESSAGE_REQUEST_KEYS = new Set(['sessionId', 'messageId', 'stylistId']);
const CUE_REQUEST_KEYS = new Set(['cue', 'stylistId']);

export interface StylistSpeechHandlerDependencies {
  createDataAccess(authHeader: string): StylistSpeechDataAccess;
  env: ElevenLabsEnvironment;
  limiter?: StylistSpeechRateLimiter;
  generateSpeech?: typeof requestElevenLabsSpeech;
  now?: () => number;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...STYLIST_SPEECH_CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

/**
 * Parse either request shape.
 *
 * The two modes are parsed as whole shapes rather than as optional fields, so a
 * body carrying both `cue` and `messageId` is rejected instead of silently
 * favouring one. Unknown keys stay rejected in both modes.
 */
function parseRequestBody(value: unknown): StylistSpeechRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new StylistSpeechError(400, 'INVALID_REQUEST', 'A valid speech request is required.');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const stylistId = typeof record.stylistId === 'string' ? record.stylistId.trim() : '';
  if (!stylistId) {
    throw new StylistSpeechError(400, 'INVALID_REQUEST', 'The speech request contains invalid references.');
  }

  if ('cue' in record) {
    if (keys.some((key) => !CUE_REQUEST_KEYS.has(key))) {
      throw new StylistSpeechError(400, 'INVALID_REQUEST', 'The speech request contains unsupported fields.');
    }
    const cue = typeof record.cue === 'string' ? record.cue.trim() : '';
    if (!cue) {
      throw new StylistSpeechError(400, 'INVALID_REQUEST', 'The speech request contains invalid references.');
    }
    return { mode: 'cue', cue, stylistId };
  }

  if (keys.some((key) => !MESSAGE_REQUEST_KEYS.has(key))) {
    throw new StylistSpeechError(400, 'INVALID_REQUEST', 'The speech request contains unsupported fields.');
  }
  const sessionId = typeof record.sessionId === 'string' ? record.sessionId.trim() : '';
  const messageId = typeof record.messageId === 'string' ? record.messageId.trim() : '';
  if (!UUID_RE.test(sessionId) || !UUID_RE.test(messageId)) {
    throw new StylistSpeechError(400, 'INVALID_REQUEST', 'The speech request contains invalid references.');
  }
  return { mode: 'message', sessionId, messageId, stylistId };
}

function operationKey(
  actorId: string,
  request: StylistSpeechRequest,
): string {
  return request.mode === 'cue'
    ? `${actorId}:cue:${request.cue}:${request.stylistId}`
    : `${actorId}:${request.sessionId}:${request.messageId}:${request.stylistId}`;
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
      const voiceSelection = resolveServerVoiceSelection(body.stylistId);
      const voiceProfile: StylistSpeechVoiceProfile = voiceSelection.profile;

      let speechText: string;
      if (body.mode === 'cue') {
        // A cue has no row to own, so the authenticated actor plus the
        // stylist-preference check below carry the whole authorization. The words
        // are looked up server-side from the allowlist; the request only named a
        // key, so a caller can never put its own text into speech.
        speechText = buildSpeechText(requireSpeechCueText(body.cue));
        if (!speechText) {
          throw new StylistSpeechError(400, 'INVALID_REQUEST', 'The speech request contains invalid references.');
        }
      } else {
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

        speechText = buildSpeechText(message.content);
        if (!speechText) {
          throw new StylistSpeechError(422, 'MESSAGE_INELIGIBLE', 'This message cannot be spoken.');
        }
      }

      const preference = await dataAccess.getStylistPreference(actor.id);
      const persistedStylistId = preference?.avatar_id ?? 'elise_default';
      if (persistedStylistId !== body.stylistId) {
        throw new StylistSpeechError(403, 'STYLIST_MISMATCH', 'The selected stylist does not match this account.');
      }

      const release = limiter.begin(actor.id, operationKey(actor.id, body), now());
      try {
        const generated = await generateSpeech({
          text: speechText,
          voiceProfile,
          voiceSecretName: voiceSelection.voiceSecretName,
          env: dependencies.env,
        });
        const response: StylistSpeechResponse = {
          messageId: body.mode === 'message' ? body.messageId : null,
          cue: body.mode === 'cue' ? body.cue : null,
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
