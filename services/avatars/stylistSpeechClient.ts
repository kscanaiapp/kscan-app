import { supabase } from '../supabaseClient';
import type { AvatarSpeechAlignment } from '../../stores/avatarSpeechStore';
import type { StylistVoiceProfile } from '../../constants/stylistIdentity';

const CLIENT_SPEECH_TIMEOUT_MS = 20_000;
const MAX_AUDIO_BASE64_CHARACTERS = 2_500_000;

export interface StylistSpeechClientRequest {
  actorId: string;
  sessionId: string;
  messageId: string;
  stylistId: string;
  signal?: AbortSignal;
}

export interface StylistSpeechClientResponse {
  messageId: string;
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
  if (
    record.messageId !== request.messageId ||
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
    messageId: record.messageId,
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
  if (!request.actorId || !request.sessionId || !request.messageId || !request.stylistId) {
    throw new Error('Speech references are required.');
  }

  const { data, error } = await supabase.functions.invoke('stylist-speech', {
    body: {
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
