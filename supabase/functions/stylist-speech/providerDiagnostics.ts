import type { ProviderFailureCategory } from './providerFailure.ts';
import type { StylistSpeechVoiceProfile } from './types.ts';

// Length of the voice-ID fingerprint retained in diagnostics. A short SHA-256
// prefix is enough to correlate the configured voice across log lines while
// remaining a one-way, non-reversible reference to the full voice ID.
export const VOICE_FINGERPRINT_LENGTH = 12;

export type SpeechFailureKind =
  | 'success'
  | 'timeout'
  | 'pre_dispatch'
  | 'provider_rejection'
  | 'invalid_response';

/**
 * Build 29 alignment diagnostic addendum.
 *
 * WHY THESE UNIONS ARE RESTATED RATHER THAN IMPORTED: `elevenLabsClient.ts`
 * already imports this module, so importing its `AlignmentDiagnosticSource`
 * back would close an import cycle. The two spellings are structurally
 * identical, so the compiler still rejects any drift at the call site.
 */
export type AlignmentDiagnosticSourceTag = 'normalized_alignment' | 'alignment' | 'none';
export type AlignmentDiagnosticRawStatusTag = 'absent' | 'malformed' | 'valid';

export interface SpeechDiagnostics {
  readonly event: 'stylist_speech_provider';
  readonly correlationId: string;
  readonly voiceProfile: StylistSpeechVoiceProfile;
  readonly failureKind: SpeechFailureKind;
  readonly providerStatus: number | null;
  readonly category: ProviderFailureCategory | null;
  readonly responseIsJson: boolean | null;
  readonly providerErrorStatus: string | null;
  readonly responseByteLength: number | null;
  readonly elapsedMs: number;
  readonly modelId: string;
  readonly outputFormat: string;
  readonly voiceFingerprint: string;
  /**
   * Which provider field produced the alignment this response carries, and
   * whether the losing field was absent or merely malformed. Null for every
   * failure kind, which never reaches alignment parsing at all.
   *
   * PRIVACY: closed enum tags and a count. The alignment CONTENT — characters
   * and their timings — never appears here.
   */
  readonly alignmentSource: AlignmentDiagnosticSourceTag | null;
  readonly alignmentRawStatus: AlignmentDiagnosticRawStatusTag | null;
  readonly alignmentEntryCount: number | null;
}

export interface DiagnosticsInput {
  readonly correlationId: string;
  readonly voiceProfile: StylistSpeechVoiceProfile;
  readonly failureKind: SpeechFailureKind;
  readonly providerStatus?: number | null;
  readonly category?: ProviderFailureCategory | null;
  readonly responseIsJson?: boolean | null;
  readonly providerErrorStatus?: string | null;
  readonly responseByteLength?: number | null;
  readonly elapsedMs: number;
  readonly modelId: string;
  readonly outputFormat: string;
  readonly voiceId: string;
  readonly alignmentSource?: AlignmentDiagnosticSourceTag | null;
  readonly alignmentRawStatus?: AlignmentDiagnosticRawStatusTag | null;
  readonly alignmentEntryCount?: number | null;
  /** Secret material that must never appear in the emitted diagnostics. */
  readonly redactSecrets?: readonly string[];
}

export type DiagnosticsSink = (line: string) => void;

/** Compute a short, one-way SHA-256 hex prefix fingerprint of a voice ID. */
export async function voiceFingerprint(voiceId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(voiceId));
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return hex.slice(0, VOICE_FINGERPRINT_LENGTH);
}

// Sanitize a provider status token defensively: only short token-shaped values
// survive, so free text, keys, voice IDs, or message bodies can never leak here.
const SAFE_STATUS_TOKEN = /^[A-Za-z0-9_.\-]{1,64}$/;

function sanitizeStatusToken(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  return SAFE_STATUS_TOKEN.test(value) ? value : null;
}

/**
 * Build a bounded, secret-free diagnostics record. As a defense in depth, any
 * configured secret material (API key, full voice ID) is stripped from the
 * retained provider status token even though it should never be present.
 */
export async function buildSpeechDiagnostics(
  input: DiagnosticsInput,
): Promise<SpeechDiagnostics> {
  const fingerprint = await voiceFingerprint(input.voiceId);
  const secrets = [
    input.voiceId,
    ...(input.redactSecrets ?? []),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);

  let providerErrorStatus = sanitizeStatusToken(input.providerErrorStatus);
  if (providerErrorStatus) {
    for (const secret of secrets) {
      if (providerErrorStatus.includes(secret)) {
        providerErrorStatus = null;
        break;
      }
    }
  }

  return {
    event: 'stylist_speech_provider',
    correlationId: input.correlationId,
    voiceProfile: input.voiceProfile,
    failureKind: input.failureKind,
    providerStatus: input.providerStatus ?? null,
    category: input.category ?? null,
    responseIsJson: input.responseIsJson ?? null,
    providerErrorStatus,
    responseByteLength: input.responseByteLength ?? null,
    elapsedMs: input.elapsedMs,
    modelId: input.modelId,
    outputFormat: input.outputFormat,
    voiceFingerprint: fingerprint,
    alignmentSource: input.alignmentSource ?? null,
    alignmentRawStatus: input.alignmentRawStatus ?? null,
    alignmentEntryCount:
      typeof input.alignmentEntryCount === 'number' && Number.isFinite(input.alignmentEntryCount)
        ? input.alignmentEntryCount
        : null,
  };
}

/** Serialize and emit diagnostics through the provided sink (default console). */
export async function logSpeechDiagnostics(
  input: DiagnosticsInput,
  sink: DiagnosticsSink = (line) => console.log(line),
): Promise<SpeechDiagnostics> {
  const diagnostics = await buildSpeechDiagnostics(input);
  sink(JSON.stringify(diagnostics));
  return diagnostics;
}
