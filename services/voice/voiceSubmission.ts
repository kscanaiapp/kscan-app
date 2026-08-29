/**
 * The Voice -> TextScan submission seam.
 *
 * This is intentionally the smallest possible function: it exists so that
 * "what routes a voice submission" is one auditable unit instead of an
 * inline literal scattered at call sites. It must ignore the transcript
 * entirely -- the destination (TextScan's existing `analyzeTextWithEdge`,
 * `scan-identify`, mode "text") is fixed by the Voice Scan surface, never by
 * what the user said. See __tests__/voiceScanRouting.test.js for the
 * adversarial-input property test and its negative control.
 */
import type { TextScanInvokeOptions } from '../textScanEdge';

export const VOICE_SUBMIT_SOURCE = 'voicescan' as const;

/**
 * @param _transcript Accepted for call-site symmetry with the typed-search
 *   submit path only. Deliberately unused: the return value must never
 *   depend on it.
 */
export function buildVoiceSubmitOptions(_transcript: string): TextScanInvokeOptions {
  return { source: VOICE_SUBMIT_SOURCE };
}
