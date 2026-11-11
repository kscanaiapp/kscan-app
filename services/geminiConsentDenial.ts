// The gated Gemini Edge Functions (stylechat-generate, scan-identify) refuse a
// request with HTTP 403 and this top-level errorCode when the signed-in actor
// has no current v2 acknowledgment or has turned Gemini processing off
// (supabase/functions/_shared/geminiConsent.ts). That is a user-controlled
// setting, not an outage, a sign-in problem or a bad request, so callers must
// say so and point to the control that changes it.

export const GEMINI_CONSENT_REQUIRED_CODE = 'AI_PROCESSING_CONSENT_REQUIRED';

export const GEMINI_CONSENT_REQUIRED_MESSAGE =
  'Google Gemini processing is turned off for this account. Turn it on in Privacy settings to continue.';

export const GEMINI_CONSENT_UNAVAILABLE_MESSAGE =
  'Unable to verify Google Gemini processing permission right now. Try again later.';

export function isGeminiConsentUnavailable(httpStatus: number | null | undefined, body: unknown): boolean {
  return httpStatus === 503
    && !!body && typeof body === 'object' && !Array.isArray(body)
    && (body as Record<string, unknown>).errorCode === 'AI_PROCESSING_CONSENT_UNAVAILABLE';
}

/** Read the actual FunctionsHttpError response without consuming another handler's body. */
export async function readGeminiConsentError(error: unknown): Promise<'consent_required' | 'consent_unavailable' | null> {
  try {
    const context = (error as { context?: Response })?.context;
    if (!context || (context.status !== 403 && context.status !== 503)) return null;
    const body = await (typeof context.clone === 'function' ? context.clone() : context).json();
    if (isGeminiConsentDenial(context.status, body)) return 'consent_required';
    if (isGeminiConsentUnavailable(context.status, body)) return 'consent_unavailable';
  } catch { /* Unknown responses never become permission decisions. */ }
  return null;
}

/** True only for the exact 403 denial body; never inferred from status alone. */
export function isGeminiConsentDenial(httpStatus: number | null | undefined, body: unknown): boolean {
  return httpStatus === 403
    && !!body && typeof body === 'object' && !Array.isArray(body)
    && (body as Record<string, unknown>).errorCode === GEMINI_CONSENT_REQUIRED_CODE;
}

/**
 * Reads a supabase-js FunctionsHttpError once and reports whether it is the
 * consent denial. Guarded so a consumed or non-JSON body simply yields false.
 */
export async function readGeminiConsentDenial(error: unknown): Promise<boolean> {
  try {
    const context = (error as { context?: unknown })?.context as
      | { status?: unknown; json?: () => Promise<unknown> }
      | undefined;
    if (!context || typeof context.status !== 'number' || typeof context.json !== 'function') return false;
    return isGeminiConsentDenial(context.status, await context.json());
  } catch {
    return false;
  }
}
