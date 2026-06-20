// services/textScanEdge.ts
// Canonical client adapter for TextScan (Phase 23).
//
// Backend path:
//   TextScan screen → analyzeTextWithEdge() → supabase.functions.invoke('scan-identify')
//   → scan-identify Edge Function (text mode branch) → Gemini
//   → normalized TextScan result
//
// The parallel `supabase/functions/text-scan/` Edge Function is deprecated and not
// invoked by this adapter. It is preserved only as a reference.

import { supabase } from './supabaseClient';
import {
  normalizeTextScanResult,
  type TextScanResult,
} from './textScan';

const EDGE_FUNCTION_NAME = 'scan-identify';
const INVOKE_TIMEOUT_MS = 12_000;

const SIGN_IN_REQUIRED_MESSAGE = 'Please sign in to analyze a TextScan request.';
const TEXTSCAN_INVALID_INPUT_MESSAGE =
  'Invalid query format. Please describe a fashion item.';
const TEXTSCAN_FAILED_MESSAGE =
  "I couldn't analyze that fashion request yet. Try describing the item, color, material, and occasion.";
const TEXTSCAN_TIMEOUT_MESSAGE =
  'Analysis is taking longer than expected. Please try again in a moment.';

type TextScanInvokeOptions = {
  source?: 'text-scan';
};

function userSafeError(message: string, userMessage: string): Error & { userMessage: string } {
  const error = new Error(message) as Error & { userMessage: string };
  error.userMessage = userMessage;
  return error;
}

function safeUserMessage(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Analyze a text fashion query through scan-identify mode: "text".
 *
 * The adapter returns the TextScan UI's normalized result shape and throws only
 * user-safe errors. Product matching remains deferred: products are always [].
 */
export async function analyzeTextWithEdge(
  query: string,
  options: TextScanInvokeOptions = {}
): Promise<TextScanResult> {
  const textQuery = typeof query === 'string' ? query.replace(/\s+/g, ' ').trim() : '';
  if (!textQuery) {
    throw userSafeError('TEXTSCAN_INVALID_INPUT', TEXTSCAN_INVALID_INPUT_MESSAGE);
  }

  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      throw userSafeError('TEXTSCAN_AUTH_REQUIRED', SIGN_IN_REQUIRED_MESSAGE);
    }
  } catch (err: any) {
    if (err?.userMessage) throw err;
    throw userSafeError('TEXTSCAN_AUTH_REQUIRED', SIGN_IN_REQUIRED_MESSAGE);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), INVOKE_TIMEOUT_MS);

  try {
    const { data, error } = await supabase.functions.invoke(EDGE_FUNCTION_NAME, {
      body: {
        mode: 'text',
        textQuery,
        source: options.source ?? 'text-scan',
        clientTimestamp: new Date().toISOString(),
      },
      signal: controller.signal,
    });

    if (error) {
      if (__DEV__) console.warn('[textScanEdge] scan-identify invoke error:', error?.message);
      throw userSafeError('TEXTSCAN_ANALYSIS_FAILED', TEXTSCAN_FAILED_MESSAGE);
    }

    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw userSafeError('TEXTSCAN_ANALYSIS_FAILED', TEXTSCAN_FAILED_MESSAGE);
    }

    const status = typeof data.status === 'string' ? data.status.toLowerCase() : '';
    if (status === 'failed') {
      throw userSafeError(
        'TEXTSCAN_ANALYSIS_FAILED',
        safeUserMessage(data.userMessage) ?? TEXTSCAN_FAILED_MESSAGE
      );
    }

    return normalizeTextScanResult(data, textQuery);
  } catch (err: any) {
    if (err?.userMessage) throw err;

    if (err?.name === 'AbortError') {
      throw userSafeError('TEXTSCAN_TIMEOUT', TEXTSCAN_TIMEOUT_MESSAGE);
    }

    if (__DEV__) console.warn('[textScanEdge] scan-identify request failed:', err?.message);
    throw userSafeError('TEXTSCAN_ANALYSIS_FAILED', TEXTSCAN_FAILED_MESSAGE);
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * The TextScan Edge path is direct when TEXTSCAN_BACKEND_ENABLED reaches here.
 */
export function isTextScanEdgeActive(): boolean {
  return true;
}

export { TextScanResult };
