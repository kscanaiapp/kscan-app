import {
  StylistSpeechError,
  type SpeechAlignment,
  type StylistSpeechVoiceProfile,
} from './types.ts';

export const ELEVENLABS_TIMEOUT_MS = 15_000;
export const MAX_PROVIDER_RESPONSE_BYTES = 2_500_000;
export const ELEVENLABS_TIMING_ENDPOINT = 'https://api.elevenlabs.io/v1/text-to-speech';

export interface ElevenLabsEnvironment {
  get(name: string): string | undefined;
}

export interface ElevenLabsSpeechResult {
  audioBase64: string;
  alignment: SpeechAlignment | null;
}

function readRequiredEnv(env: ElevenLabsEnvironment, name: string): string {
  const value = env.get(name)?.trim();
  if (!value) {
    throw new StylistSpeechError(500, 'SERVER_CONFIGURATION', 'Speech is not configured.');
  }
  return value;
}

function validateBase64(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  try {
    return atob(value).length > 0;
  } catch {
    return false;
  }
}

function parseAlignment(value: unknown): SpeechAlignment | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const characters = record.characters;
  const starts = record.character_start_times_seconds;
  const ends = record.character_end_times_seconds;
  if (!Array.isArray(characters) || !Array.isArray(starts) || !Array.isArray(ends)) return null;
  if (characters.length === 0 || characters.length !== starts.length || starts.length !== ends.length) {
    return null;
  }

  let previousStart = -1;
  let previousEnd = -1;
  for (let index = 0; index < characters.length; index += 1) {
    if (typeof characters[index] !== 'string') return null;
    const start = starts[index];
    const end = ends[index];
    if (
      typeof start !== 'number' || !Number.isFinite(start) || start < 0 ||
      typeof end !== 'number' || !Number.isFinite(end) || end < 0 ||
      start > end || start < previousStart || end < previousEnd
    ) {
      return null;
    }
    previousStart = start;
    previousEnd = end;
  }

  return {
    characters: [...characters] as string[],
    characterStartTimesSeconds: [...starts] as number[],
    characterEndTimesSeconds: [...ends] as number[],
  };
}

export async function requestElevenLabsSpeech(input: {
  text: string;
  voiceProfile: StylistSpeechVoiceProfile;
  env: ElevenLabsEnvironment;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<ElevenLabsSpeechResult> {
  const apiKey = readRequiredEnv(input.env, 'ELEVENLABS_API_KEY');
  const voiceId = readRequiredEnv(
    input.env,
    input.voiceProfile === 'feminine'
      ? 'ELEVENLABS_FEMININE_VOICE_ID'
      : 'ELEVENLABS_MASCULINE_VOICE_ID',
  );
  const modelId = readRequiredEnv(input.env, 'ELEVENLABS_MODEL_ID');
  const outputFormat = readRequiredEnv(input.env, 'ELEVENLABS_OUTPUT_FORMAT');
  const url = new URL(`${ELEVENLABS_TIMING_ENDPOINT}/${encodeURIComponent(voiceId)}/with-timestamps`);
  url.searchParams.set('output_format', outputFormat);

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    input.timeoutMs ?? ELEVENLABS_TIMEOUT_MS,
  );

  try {
    let response: Response;
    try {
      response = await (input.fetchImpl ?? fetch)(url.toString(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': apiKey,
        },
        body: JSON.stringify({ text: input.text, model_id: modelId }),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
        throw new StylistSpeechError(504, 'PROVIDER_TIMEOUT', 'Speech generation timed out.');
      }
      throw new StylistSpeechError(502, 'PROVIDER_UNAVAILABLE', 'Speech generation is unavailable.');
    }

    if (!response.ok) {
      if (response.status === 429) {
        throw new StylistSpeechError(429, 'PROVIDER_RATE_LIMIT', 'Speech generation is temporarily limited.');
      }
      throw new StylistSpeechError(502, 'PROVIDER_UNAVAILABLE', 'Speech generation is unavailable.');
    }

    const raw = await response.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_PROVIDER_RESPONSE_BYTES) {
      throw new StylistSpeechError(502, 'PROVIDER_RESPONSE_TOO_LARGE', 'Speech response was too large.');
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new StylistSpeechError(502, 'PROVIDER_RESPONSE_INVALID', 'Speech response was invalid.');
    }

    if (!validateBase64(parsed.audio_base64)) {
      throw new StylistSpeechError(502, 'PROVIDER_RESPONSE_INVALID', 'Speech response was invalid.');
    }

    const alignment =
      parseAlignment(parsed.normalized_alignment) ??
      parseAlignment(parsed.alignment);

    return { audioBase64: parsed.audio_base64, alignment };
  } finally {
    clearTimeout(timeout);
  }
}
