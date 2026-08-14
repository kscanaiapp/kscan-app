import { supabase } from '../supabaseClient';
import type { AvatarSpeechAlignment } from '../../stores/avatarSpeechStore';
import type { StylistVoiceProfile } from '../../constants/stylistIdentity';

const CLIENT_SPEECH_TIMEOUT_MS = 20_000;
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
    throw new Error('Speech is temporarily unavailable.');
  }
  return validateResponse(data, request);
}
