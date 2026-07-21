import { assertValidSpeechAudio, validateSpeechAlignment } from './eliseSpeechAudioValidation.ts';
import {
  classifyProviderFailure,
  providerFailureError,
} from './providerFailure.ts';
import {
  logSpeechDiagnostics,
  type DiagnosticsSink,
} from './providerDiagnostics.ts';
import { readRequiredSecret, type SecretEnvironment } from './secretConfig.ts';
import {
  StylistSpeechError,
  type SpeechAlignment,
  type StylistSpeechVoiceProfile,
} from './types.ts';

export const ELEVENLABS_TIMEOUT_MS = 15_000;
export const MAX_PROVIDER_RESPONSE_BYTES = 2_500_000;
export const ELEVENLABS_TIMING_ENDPOINT = 'https://api.elevenlabs.io/v1/text-to-speech';

export type ElevenLabsEnvironment = SecretEnvironment;

export interface ElevenLabsSpeechResult {
  audioBase64: string;
  alignment: SpeechAlignment | null;
}

export async function requestElevenLabsSpeech(input: {
  text: string;
  voiceProfile: StylistSpeechVoiceProfile;
  env: ElevenLabsEnvironment;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
  diagnosticsSink?: DiagnosticsSink;
  correlationId?: string;
}): Promise<ElevenLabsSpeechResult> {
  const apiKey = readRequiredSecret(input.env, 'ELEVENLABS_API_KEY', 'apiKey');
  const voiceId = readRequiredSecret(
    input.env,
    input.voiceProfile === 'feminine'
      ? 'ELEVENLABS_FEMININE_VOICE_ID'
      : 'ELEVENLABS_MASCULINE_VOICE_ID',
    'voiceId',
  );
  const modelId = readRequiredSecret(input.env, 'ELEVENLABS_MODEL_ID', 'model');
  const outputFormat = readRequiredSecret(input.env, 'ELEVENLABS_OUTPUT_FORMAT', 'outputFormat');
  const url = new URL(`${ELEVENLABS_TIMING_ENDPOINT}/${encodeURIComponent(voiceId)}/with-timestamps`);
  url.searchParams.set('output_format', outputFormat);

  const now = input.now ?? (() => Date.now());
  const startedAt = now();
  const correlationId = input.correlationId ?? crypto.randomUUID();

  const emit = (fields: {
    failureKind: Parameters<typeof logSpeechDiagnostics>[0]['failureKind'];
    providerStatus?: number | null;
    category?: Parameters<typeof logSpeechDiagnostics>[0]['category'];
    responseIsJson?: boolean | null;
    providerErrorStatus?: string | null;
    responseByteLength?: number | null;
  }): Promise<unknown> =>
    logSpeechDiagnostics(
      {
        correlationId,
        voiceProfile: input.voiceProfile,
        elapsedMs: now() - startedAt,
        modelId,
        outputFormat,
        voiceId,
        redactSecrets: [apiKey],
        ...fields,
      },
      input.diagnosticsSink,
    ).catch(() => undefined);

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
          'Accept': 'application/json',
          'xi-api-key': apiKey,
        },
        body: JSON.stringify({ text: input.text, model_id: modelId }),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
        await emit({ failureKind: 'timeout' });
        throw new StylistSpeechError(504, 'PROVIDER_TIMEOUT', 'Speech generation timed out.');
      }
      await emit({ failureKind: 'pre_dispatch' });
      throw new StylistSpeechError(502, 'PROVIDER_UNAVAILABLE', 'Speech generation is unavailable.');
    }

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      const classification = classifyProviderFailure(response.status, errorBody, response.headers);
      await emit({
        failureKind: 'provider_rejection',
        providerStatus: classification.providerStatus,
        category: classification.category,
        responseIsJson: classification.isJson,
        providerErrorStatus: classification.providerErrorStatus,
        responseByteLength: classification.totalByteLength,
      });
      throw providerFailureError(classification);
    }

    const raw = await response.text();
    const rawByteLength = new TextEncoder().encode(raw).byteLength;
    if (rawByteLength > MAX_PROVIDER_RESPONSE_BYTES) {
      await emit({
        failureKind: 'invalid_response',
        providerStatus: response.status,
        responseByteLength: rawByteLength,
      });
      throw new StylistSpeechError(502, 'PROVIDER_RESPONSE_TOO_LARGE', 'Speech response was too large.');
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      await emit({
        failureKind: 'invalid_response',
        providerStatus: response.status,
        responseIsJson: false,
        responseByteLength: rawByteLength,
      });
      throw new StylistSpeechError(502, 'PROVIDER_RESPONSE_INVALID', 'Speech response was invalid.');
    }

    const alignmentCandidate =
      validateSpeechAlignment(parsed.normalized_alignment, { strict: false }) ??
      validateSpeechAlignment(parsed.alignment, { strict: false });

    let validated;
    try {
      validated = assertValidSpeechAudio({
        audioBase64: parsed.audio_base64,
        alignment: alignmentCandidate,
        strictAlignment: false,
      });
    } catch (error) {
      await emit({
        failureKind: 'invalid_response',
        providerStatus: response.status,
        responseIsJson: true,
        responseByteLength: rawByteLength,
      });
      throw error;
    }

    await emit({
      failureKind: 'success',
      providerStatus: response.status,
      responseIsJson: true,
      responseByteLength: rawByteLength,
    });
    return { audioBase64: validated.audioBase64, alignment: validated.alignment };
  } finally {
    clearTimeout(timeout);
  }
}
