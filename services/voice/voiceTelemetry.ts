/**
 * Voice Scan product-funnel telemetry (allowlisted sink). Patterned after
 * services/kplus/kplusTelemetry.ts -- NOT a second analytics SDK vendor.
 * Failures never propagate and never affect recognition/entitlement logic.
 *
 * Content-free by construction: the allowlisted properties below can never
 * carry a transcript, and `scrub` rejects anything that doesn't match
 * SAFE_STRING, so accidentally passing free text degrades to "dropped",
 * never "logged".
 */

export const VOICE_EVENTS = [
  'voice_permission_granted',
  'voice_permission_denied',
  'voice_on_device_available',
  'voice_on_device_unavailable',
  'voice_session_cancelled',
  'voice_transcription_success',
  'voice_transcription_failure',
  'voice_submit',
] as const;

export type VoiceEvent = (typeof VOICE_EVENTS)[number];

export const VOICE_EVENT_PROPERTIES = [
  'source',
  'platform',
  'outcome',
  'surface',
  'destination',
] as const;

export type VoiceEventProperty = (typeof VOICE_EVENT_PROPERTIES)[number];

export type VoiceEventPayload = Partial<Record<VoiceEventProperty, string | number | boolean | null>>;

export type VoiceAnalyticsSink = (event: VoiceEvent, payload: VoiceEventPayload) => void;

/** Explicitly prohibited: no transcript text, audio, or content of any kind
 *  ever crosses this module's allowlist boundary. */
const EVENT_SET = new Set<string>(VOICE_EVENTS);
const PROPERTY_SET = new Set<string>(VOICE_EVENT_PROPERTIES);
const SAFE_STRING = /^[A-Za-z0-9_.:-]{1,64}$/;

function scrub(value: unknown): string | number | boolean | null | undefined {
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') return SAFE_STRING.test(value) ? value : undefined;
  return undefined;
}

function devSink(event: VoiceEvent, payload: VoiceEventPayload): void {
  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    // eslint-disable-next-line no-console
    console.log('[voiceAnalytics]', event, payload);
  }
}

let sink: VoiceAnalyticsSink = devSink;

export function setVoiceAnalyticsSink(next: VoiceAnalyticsSink | null): void {
  sink = typeof next === 'function' ? next : devSink;
}

export function resetVoiceAnalyticsSink(): void {
  sink = devSink;
}

export function emitVoiceEvent(event: string, payload: Record<string, unknown> = {}): void {
  try {
    if (!EVENT_SET.has(event)) return;
    const safe: VoiceEventPayload = {};
    for (const [key, value] of Object.entries(payload ?? {})) {
      if (!PROPERTY_SET.has(key)) continue;
      const scrubbed = scrub(value);
      if (scrubbed === undefined) continue;
      (safe as Record<string, unknown>)[key] = scrubbed;
    }
    sink(event as VoiceEvent, safe);
  } catch {
    /* analytics never propagates */
  }
}

export const __voiceAnalyticsInternals = { scrub, SAFE_STRING };
