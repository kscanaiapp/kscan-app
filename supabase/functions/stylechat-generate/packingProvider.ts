// K+ Packing Intelligence V1 — provider call.
//
// The ONLY impure module in the Packing set. Everything the plan's correctness
// depends on (selection, validation, ownership, fallback) is pure and tested
// without a runtime; this file just moves bytes.
//
// NO NEW PROVIDER AND NO NEW CREDENTIAL. Same Gemini endpoint, same
// GEMINI_API_KEY, same allowlisted model routing (modelRouting.ts) this
// function already uses for chat. Packing asks for JSON instead of prose --
// that is the whole difference.

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Longer than the chat timeout (12s) because a packing plan is a single
 * structured generation the user is explicitly waiting on behind a loading
 * state, not a conversational turn that must feel instant.
 */
export const PACKING_PROVIDER_TIMEOUT_MS = 20_000;

/**
 * gemini-2.5-flash is a reasoning model: hidden thinking tokens draw from this
 * same budget. style-outfit-generate proved 1024 truncates multi-outfit JSON;
 * a packing plan is strictly larger than an outfit set, so it gets more room.
 */
const PACKING_MAX_OUTPUT_TOKENS = 6144;

export class PackingProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackingProviderError';
  }
}

/**
 * Calls the model in JSON mode and returns the PARSED object.
 *
 * Every failure mode collapses to a stable, content-free error class so the
 * caller can log and bucket it without ever touching the prompt, the response
 * text, or anything derived from the traveller's Closet.
 */
export async function callPackingProvider(input: {
  modelName: string;
  apiKey: string;
  systemText: string;
  userText: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<unknown> {
  const url = new URL(`${GEMINI_API_BASE}/${input.modelName}:generateContent`);
  url.searchParams.set('key', input.apiKey);

  const controller = new AbortController();
  const timeoutMs = input.timeoutMs ?? PACKING_PROVIDER_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const doFetch = input.fetchImpl ?? fetch;

  try {
    const response = await doFetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: input.systemText }] },
        contents: [{ role: 'user', parts: [{ text: input.userText }] }],
        generationConfig: {
          maxOutputTokens: PACKING_MAX_OUTPUT_TOKENS,
          // Low but not zero: a packing plan should be stable across retries,
          // while still allowing a genuinely different second outfit.
          temperature: 0.4,
          responseMimeType: 'application/json',
        },
      }),
      signal: controller.signal,
    });

    const raw = await response.text().catch(() => '');
    if (!response.ok) {
      throw new PackingProviderError(`provider_http_${response.status}`);
    }

    let envelope: Record<string, unknown>;
    try {
      envelope = JSON.parse(raw);
    } catch {
      throw new PackingProviderError('provider_non_json');
    }

    const candidates = Array.isArray(envelope.candidates)
      ? (envelope.candidates as Array<Record<string, unknown>>)
      : [];
    const content = candidates[0]?.content as Record<string, unknown> | undefined;
    const parts = Array.isArray(content?.parts)
      ? (content?.parts as Array<Record<string, unknown>>)
      : [];
    const text = parts
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('');

    if (!text) throw new PackingProviderError('provider_empty');

    try {
      return JSON.parse(text);
    } catch {
      throw new PackingProviderError('provider_invalid_output');
    }
  } catch (error) {
    if (error instanceof PackingProviderError) throw error;
    const aborted =
      error instanceof DOMException ? error.name === 'AbortError' : (error as Error)?.name === 'AbortError';
    throw new PackingProviderError(aborted ? 'provider_timeout' : 'provider_unavailable');
  } finally {
    clearTimeout(timer);
  }
}
