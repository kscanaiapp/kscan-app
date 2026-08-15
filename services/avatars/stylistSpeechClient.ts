import { supabase } from '../supabaseClient';
import type { AvatarSpeechAlignment } from '../../stores/avatarSpeechStore';
import type { StylistVoiceProfile } from '../../constants/stylistIdentity';

const CLIENT_SPEECH_TIMEOUT_MS = 20_000;

/**
 * KSB29-022 — why a speech request failed, kept as a classification rather than
 * a bare throw.
 *
 * The client previously threw one undifferentiated
 * `Error('Speech is temporarily unavailable.')` for every failure, and the
 * caller caught it with a bare `catch {}`. So a COMPLETE cue-service outage —
 * every cue rejected because the deployed backend predates cue mode — was
 * indistinguishable from one flaky network call, and nothing anywhere recorded
 * which had happened. That is what let the production contract gap stay
 * invisible.
 *
 * `unsupported_contract` is the specific shape of that gap: the deployed
 * stylist-speech generation rejects the request as malformed (HTTP 400) because
 * it does not know cue mode. It is not retryable — retrying cannot make an
 * older deployment understand a newer request — and that distinction is the
 * point of classifying at all.
 *
 * The user-facing copy is unchanged; this is diagnostic state, not new UI.
 */
export type StylistSpeechFailureCode =
  | 'unsupported_contract'
  | 'unavailable'
  | 'invalid_response';

export class StylistSpeechClientError extends Error {
  readonly code: StylistSpeechFailureCode;
  /** False when retrying provably cannot help, e.g. a deployment mismatch. */
  readonly retryable: boolean;

  constructor(code: StylistSpeechFailureCode, message: string) {
    super(message);
    this.name = 'StylistSpeechClientError';
    this.code = code;
    this.retryable = code !== 'unsupported_contract';
  }
}

/**
 * Classify a Supabase Functions invoke error.
 *
 * A 400 on a cue request means the deployment does not recognise the cue
 * contract — production v29 rejects any key outside
 * {sessionId, messageId, stylistId}. Anything else is treated as transient,
 * which is the safe default: a wrong "permanent" verdict would suppress a retry
 * that would have worked.
 */
function classifyInvokeFailure(error: unknown, cueMode: boolean): StylistSpeechClientError {
  const status = (() => {
    const candidate = error as { status?: unknown; context?: { status?: unknown } } | null;
    if (typeof candidate?.status === 'number') return candidate.status;
    if (typeof candidate?.context?.status === 'number') return candidate.context.status;
    return null;
  })();

  if (cueMode && status === 400) {
    return new StylistSpeechClientError(
      'unsupported_contract',
      'Speech is temporarily unavailable.',
    );
  }
  return new StylistSpeechClientError('unavailable', 'Speech is temporarily unavailable.');
}
const MAX_AUDIO_BASE64_CHARACTERS = 2_500_000;

/** Speak a persisted assistant message the caller owns. */
export interface StylistSpeechMessageClientRequest {
  mode?: 'message';
  actorId: string;
  sessionId: string;
  messageId: string;
  stylistId: string;
  signal?: AbortSignal;
}

/**
 * Speak one allowlisted deterministic cue.
 *
 * Carries a cue KEY only. The approved words live in the Edge Function, which is
 * what keeps a client from putting arbitrary text into text-to-speech.
 */
export interface StylistSpeechCueClientRequest {
  mode: 'cue';
  actorId: string;
  cue: string;
  stylistId: string;
  signal?: AbortSignal;
}

export type StylistSpeechClientRequest =
  | StylistSpeechMessageClientRequest
  | StylistSpeechCueClientRequest;

function isCueRequest(
  request: StylistSpeechClientRequest,
): request is StylistSpeechCueClientRequest {
  return request.mode === 'cue';
}

export interface StylistSpeechClientResponse {
  messageId: string | null;
  cue: string | null;
  stylistId: string;
  voiceProfile: Exclude<StylistVoiceProfile, 'silent'>;
  mimeType: 'audio/mpeg';
  audioBase64: string;
  alignment: AvatarSpeechAlignment | null;
}

function isFiniteNonNegativeArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(
    (item) => typeof item === 'number' && Number.isFinite(item) && item >= 0,
  );
}

function validateAlignment(value: unknown): AvatarSpeechAlignment | null {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Speech response alignment is invalid.');
  }
  const record = value as Record<string, unknown>;
  const characters = record.characters;
  const starts = record.characterStartTimesSeconds;
  const ends = record.characterEndTimesSeconds;
  if (
    !Array.isArray(characters) ||
    !characters.every((item) => typeof item === 'string') ||
    !isFiniteNonNegativeArray(starts) ||
    !isFiniteNonNegativeArray(ends) ||
    characters.length === 0 ||
    characters.length !== starts.length ||
    starts.length !== ends.length
  ) throw new Error('Speech response alignment is invalid.');

  let priorStart = -1;
  let priorEnd = -1;
  for (let index = 0; index < starts.length; index += 1) {
    if (
      starts[index] > ends[index] ||
      starts[index] < priorStart ||
      ends[index] < priorEnd
    ) throw new Error('Speech response alignment is invalid.');
    priorStart = starts[index];
    priorEnd = ends[index];
  }
  return {
    characters: [...characters],
    characterStartTimesSeconds: [...starts],
    characterEndTimesSeconds: [...ends],
  };
}

function validateResponse(
  value: unknown,
  request: StylistSpeechClientRequest,
): StylistSpeechClientResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Speech response is invalid.');
  }
  const record = value as Record<string, unknown>;
  // The response echoes exactly one identity. Checking that the *other* field is
  // empty is what stops a cue reply from satisfying a message request, or the
  // reverse, instead of only checking the field we happened to ask for.
  //
  // "Empty" deliberately accepts absent as well as null. A client build can reach
  // a stylist-speech deployment that predates cue mode and therefore omits `cue`
  // entirely; requiring a literal null would break message-mode speech for every
  // user between the app release and the function deploy. The field we asked for
  // is still matched exactly, so nothing is loosened where it matters.
  const identityMatches = isCueRequest(request)
    ? record.cue === request.cue && record.messageId == null
    : record.messageId === request.messageId && record.cue == null;
  if (
    !identityMatches ||
    record.stylistId !== request.stylistId ||
    (record.voiceProfile !== 'feminine' && record.voiceProfile !== 'masculine') ||
    record.mimeType !== 'audio/mpeg' ||
    typeof record.audioBase64 !== 'string' ||
    record.audioBase64.length === 0 ||
    record.audioBase64.length > MAX_AUDIO_BASE64_CHARACTERS ||
    record.audioBase64.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(record.audioBase64)
  ) throw new Error('Speech response is invalid.');

  return {
    messageId: isCueRequest(request) ? null : request.messageId,
    cue: isCueRequest(request) ? request.cue : null,
    stylistId: record.stylistId,
    voiceProfile: record.voiceProfile,
    mimeType: record.mimeType,
    audioBase64: record.audioBase64,
    alignment: validateAlignment(record.alignment),
  };
}

export async function requestStylistSpeech(
  request: StylistSpeechClientRequest,
): Promise<StylistSpeechClientResponse> {
  const cueMode = isCueRequest(request);
  if (!request.actorId || !request.stylistId) {
    throw new Error('Speech references are required.');
  }
  if (cueMode ? !request.cue : (!request.sessionId || !request.messageId)) {
    throw new Error('Speech references are required.');
  }

  const { data, error } = await supabase.functions.invoke('stylist-speech', {
    body: cueMode
      ? { cue: request.cue, stylistId: request.stylistId }
      : {
        sessionId: request.sessionId,
        messageId: request.messageId,
        stylistId: request.stylistId,
      },
    signal: request.signal,
    timeout: CLIENT_SPEECH_TIMEOUT_MS,
  });
  if (error) {
    throw classifyInvokeFailure(error, cueMode);
  }
  return validateResponse(data, request);
}
