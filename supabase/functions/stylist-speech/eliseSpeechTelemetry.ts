/**
 * Privacy-safe speech telemetry. Strict allowlist; fail-open.
 * Never logs speech text, audio, voice IDs, raw actor/session/message IDs.
 */

const ALLOWED_KEYS = new Set([
  'event',
  'requestId',
  'speechOperationStatus',
  'attemptCount',
  'deduplicated',
  'queueOutcome',
  'concurrencyOutcome',
  'circuitState',
  'circuitScope',
  'provider',
  'modelAlias',
  'voiceAlias',
  'stableErrorClass',
  'retryCount',
  'latencyMs',
  'audioValidationOutcome',
  'alignmentValidationOutcome',
  'playbackOutcome',
  'cleanupOutcome',
  'featureFlagSpeechResilience',
  'featureFlagSpeechRetry',
  'featureFlagSpeechCircuit',
  'featureFlagSpeechDedupe',
  'featureFlagSpeechConcurrency',
]);

export type SpeechTelemetrySink = (line: string) => void;

export function emitSpeechTelemetry(
  fields: Record<string, unknown>,
  sink?: SpeechTelemetrySink,
): void {
  if (!sink) return;
  try {
    const safe: Record<string, unknown> = { event: 'elise_speech_e3' };
    for (const [key, value] of Object.entries(fields)) {
      if (!ALLOWED_KEYS.has(key)) continue;
      if (value === undefined) continue;
      safe[key] = value;
    }
    sink(JSON.stringify(safe));
  } catch {
    // Telemetry is strictly fail-open.
  }
}

export function speechTelemetryAllowedKeys(): ReadonlySet<string> {
  return ALLOWED_KEYS;
}
