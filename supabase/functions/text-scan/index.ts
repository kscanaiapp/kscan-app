// DEPRECATED (Phase 23): This function is no longer the canonical TextScan backend.
// The active TextScan path routes through the text mode branch of `scan-identify`.
// This file is preserved as a reference but is not invoked by any client code.
// To analyze TextScan queries, the client calls `scan-identify` with `mode: 'text'`.
//
// text-scan — Secure server-side Gemini text-to-fashion proxy for K Scan AI.
//
// Architecture:
//   TextScan input
//     → client validation (services/textScan.ts)
//     → supabase.functions.invoke('text-scan')
//     → this function → Gemini Flash (text model)
//     → normalized fashion attributes
//     → TextScan result UI
//
// Security guarantees (mirrors scan-identify and stylechat-generate):
//   - JWT verified via auth.getUser() before any provider call
//   - GEMINI_API_KEY never leaves this function
//   - Raw provider output is parsed + normalized, never returned verbatim
//   - No stack traces returned to the client
//   - recommendedProducts is always [] in this slice (matching deferred)
//
// Kill switch: set TEXT_SCAN_AI_ENABLED=false (trim/case-insensitive) to disable.
// Model precedence: TEXT_SCAN_GEMINI_MODEL, then GEMINI_MODEL, else DEFAULT_MODEL.

import { createClient } from 'npm:@supabase/supabase-js@2';

// ── Constants ──────────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const MAX_OUTPUT_TOKENS = 512;
// Provider call timeout. Target is ~4s; an 8s hard cap absorbs cold starts / free
// tier latency without hanging.
const DEFAULT_GEMINI_TIMEOUT_MS = 8_000;
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-1.5-flash';

// Output sanitization caps — keep responses small and predictable.
const MAX_STRING_LEN = 80;
const MAX_USER_MESSAGE_LEN = 240;
const MAX_ARRAY_ITEMS = 8;
const MAX_QUERY_LENGTH = 500;

// Allowed FashionAttributes keys. Anything outside this allowlist is dropped.
const STRING_ATTR_KEYS = [
  'category',
  'itemType',
  'silhouette',
  'materialEstimate',
  'pattern',
  'texture',
  'occasion',
] as const;
const ARRAY_ATTR_KEYS = ['colorPalette', 'styleTags'] as const;

const SAFE_FAILED_MESSAGE =
  "We couldn't complete this analysis. Please try rephrasing your description.";
const SAFE_NON_FASHION_MESSAGE =
  'This does not appear to be a fashion query. Try describing clothing, shoes, bags, or accessories.';
const QUERY_TOO_LONG_MESSAGE =
  'Description is too long. Please keep it under 500 characters.';

// ── Provider prompt (server-side only) ──────────────────────────────────────────

const TEXT_SCAN_PROMPT = `You are a high-fashion AI stylist. A user has described a fashion item or outfit in text. Extract the fashion attributes from their description.

If the description is about clothing, footwear, bags, jewelry, eyewear, or accessories, return fashion attributes.

If the description is about landscapes, food, animals, people, interiors, technology, or contains no fashion-relevant information, return status: non_fashion.

Return strict JSON only, matching exactly this shape (omit any attribute you cannot determine):
{
  "status": "completed" | "non_fashion",
  "attributes": {
    "category": string,          // e.g. "Tops", "Bottoms", "Footwear", "Accessories", "Outerwear", "Dresses"
    "itemType": string,          // e.g. "hoodie", "blazer", "sneakers", "tote bag"
    "silhouette": string,        // e.g. "Oversized", "Fitted", "Relaxed", "Boxy", "Cropped", "Wide-leg", "Slim", "Flowy", "Straight", "Layered"
    "colorPalette": string[],    // e.g. ["Black", "White"], ["Navy", "Earth Tones"]
    "materialEstimate": string,  // e.g. "cotton-blend", "leather", "denim", "quilted nylon"
    "pattern": string,           // e.g. "solid", "striped", "floral", "checked"
    "texture": string,           // e.g. "smooth", "ribbed", "quilted", "distressed"
    "styleTags": string[],       // e.g. ["Casual", "Streetwear", "Minimalist"]
    "occasion": string,          // e.g. "Casual", "Formal", "Athleisure", "Evening"
    "confidenceScore": number    // 0 to 1
  },
  "userMessage": string          // A 2-4 sentence professional style description with one pairing suggestion
}

Rules:
- confidenceScore is a number between 0 and 1.
- For non_fashion, omit attributes and set a short, helpful userMessage.
- Do not include prices, retailers, specific product names, or links.
- Output JSON only. No markdown, no prose outside the JSON.`;

// ── Helpers ──────────────────────────────────────────────────────────────────

const readTrimmedEnv = (name: string): string | undefined => {
  const value = Deno.env.get(name)?.trim();
  return value ? value : undefined;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

/** Every domain response is normalized to this shape before returning. */
function normalized(
  status: 'completed' | 'non_fashion' | 'failed',
  userMessage: string,
  attributes?: Record<string, unknown>,
) {
  const out: Record<string, unknown> = {
    status,
    recommendedProducts: [],
    userMessage,
  };
  if (status === 'completed' && attributes) out.attributes = attributes;
  return out;
}

function safeString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const t = value.replace(/\s+/g, ' ').trim();
  if (!t) return undefined;
  return t.slice(0, MAX_STRING_LEN);
}

function safeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .map((v) => safeString(v))
    .filter((v): v is string => Boolean(v))
    .slice(0, MAX_ARRAY_ITEMS);
  return out.length ? out : undefined;
}

function safeConfidence(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return undefined;
  return Math.max(0, Math.min(1, n));
}

/**
 * Build a sanitized attributes object from raw model output. Only allowlisted
 * fashion keys survive; unknown keys are dropped.
 */
function sanitizeAttributes(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const src = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const key of STRING_ATTR_KEYS) {
    const v = safeString(src[key]);
    if (v) out[key] = v;
  }
  for (const key of ARRAY_ATTR_KEYS) {
    const v = safeStringArray(src[key]);
    if (v) out[key] = v;
  }
  const conf = safeConfidence(src.confidenceScore);
  if (conf !== undefined) out.confidenceScore = conf;

  return Object.keys(out).length ? out : undefined;
}

/** Strip markdown fences and parse the first JSON object from model text. */
function parseModelJson(text: string): Record<string, unknown> | null {
  let t = text.trim().replace(/^```[\w]*\n?/gm, '').replace(/```$/gm, '').trim();
  try {
    const parsed = JSON.parse(t);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    // Fallback: extract the first {...} block.
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(t.slice(start, end + 1));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null;
      } catch {
        return null;
      }
    }
    return null;
  }
}

// Parses only safe metadata fields from a Gemini error payload. Never returns the
// raw body or request contents.
function extractGeminiErrorMeta(raw: string): { code?: number | string; status?: string } {
  try {
    const parsed = JSON.parse(raw);
    return { code: parsed?.error?.code, status: parsed?.error?.status };
  } catch {
    return {};
  }
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
  promptFeedback?: { blockReason?: string };
}

function extractGeminiText(data: GeminiResponse): string {
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  return parts
    .map((p) => (typeof p.text === 'string' ? p.text : ''))
    .filter(Boolean)
    .join('')
    .trim();
}

function safeStringMessage(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const t = value.replace(/\s+/g, ' ').trim();
  if (!t) return undefined;
  return t.slice(0, MAX_USER_MESSAGE_LEN);
}

// ── Main handler ───────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  // ── 1. Verify authenticated user from JWT ────────────────────────────────────
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return json({ error: 'Missing authorization' }, 401);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!supabaseUrl || !supabaseAnonKey) {
    console.error('[text-scan] Supabase function env is not configured');
    return json({ error: 'Server configuration error' }, 500);
  }

  const userClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: { user }, error: authError } = await userClient.auth.getUser();
  if (authError || !user) {
    return json({ error: 'Not authenticated' }, 401);
  }
  const userId = user.id;

  // ── 2. Parse and validate request body ──────────────────────────────────────
  let body: { query?: unknown; source?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const query = typeof body.query === 'string' ? body.query.trim() : '';
  if (!query) {
    return json(normalized('failed', SAFE_FAILED_MESSAGE), 200);
  }
  if (query.length > MAX_QUERY_LENGTH) {
    console.warn('[text-scan] query_too_long length=%d', query.length);
    return json(normalized('failed', QUERY_TOO_LONG_MESSAGE), 200);
  }

  // ── 3. Kill switch + provider key ────────────────────────────────────────────
  const isAiDisabled = readTrimmedEnv('TEXT_SCAN_AI_ENABLED')?.toLowerCase() === 'false';
  if (isAiDisabled) {
    console.log('[text-scan] kill switch active');
    return json(normalized('failed', SAFE_FAILED_MESSAGE), 200);
  }

  const geminiKey = Deno.env.get('GEMINI_API_KEY');
  if (!geminiKey) {
    console.error('[text-scan] GEMINI_API_KEY not configured');
    return json({ error: 'AI provider not configured' }, 500);
  }

  const modelName =
    readTrimmedEnv('TEXT_SCAN_GEMINI_MODEL') || readTrimmedEnv('GEMINI_MODEL') || DEFAULT_MODEL;
  const timeoutMs = (() => {
    const raw = readTrimmedEnv('TEXT_SCAN_GEMINI_TIMEOUT_MS');
    const parsed = raw !== undefined ? parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) && parsed >= 2_000 && parsed <= 20_000
      ? parsed
      : DEFAULT_GEMINI_TIMEOUT_MS;
  })();

  // ── 4. Call Gemini (text) with a timeout guard ───────────────────────────────
  const geminiUrl = (() => {
    const u = new URL(`${GEMINI_API_BASE}/${modelName}:generateContent`);
    u.searchParams.set('key', geminiKey);
    return u.toString();
  })();

  const geminiBody = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: TEXT_SCAN_PROMPT },
          { text: `User description: "${query}"` },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      responseMimeType: 'application/json',
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    const res = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiBody),
      signal: controller.signal,
    });

    const raw = await res.text().catch(() => '');
    const elapsedMs = Date.now() - startedAt;

    if (!res.ok) {
      const meta = extractGeminiErrorMeta(raw);
      console.warn(
        '[text-scan] gemini_http_error uid=%s httpStatus=%d code=%s status=%s elapsedMs=%d',
        userId.slice(0, 8),
        res.status,
        String(meta.code ?? 'none'),
        String(meta.status ?? 'none'),
        elapsedMs,
      );
      return json(normalized('failed', SAFE_FAILED_MESSAGE), 200);
    }

    let data: GeminiResponse;
    try {
      data = JSON.parse(raw);
    } catch {
      console.warn('[text-scan] gemini_parse_failure elapsedMs=%d', elapsedMs);
      return json(normalized('failed', SAFE_FAILED_MESSAGE), 200);
    }

    const blockReason = data.promptFeedback?.blockReason;
    const text = extractGeminiText(data);
    if (!text) {
      console.warn(
        '[text-scan] gemini_empty blockReason=%s elapsedMs=%d',
        blockReason ?? 'none',
        elapsedMs,
      );
      return json(normalized('failed', SAFE_FAILED_MESSAGE), 200);
    }

    const parsed = parseModelJson(text);
    if (!parsed) {
      console.warn('[text-scan] model_json_unparseable elapsedMs=%d', elapsedMs);
      return json(normalized('failed', SAFE_FAILED_MESSAGE), 200);
    }

    const rawStatus = typeof parsed.status === 'string' ? parsed.status.toLowerCase() : '';
    const attributes = sanitizeAttributes(parsed.attributes);

    // Non-fashion (explicit, or completed with no usable attributes).
    if (rawStatus.includes('non') || (!attributes && rawStatus !== 'completed')) {
      const msg = safeStringMessage(parsed.userMessage) ?? SAFE_NON_FASHION_MESSAGE;
      console.log('[text-scan] ok uid=%s status=non_fashion elapsedMs=%d', userId.slice(0, 8), elapsedMs);
      return json(normalized('non_fashion', msg), 200);
    }

    if (!attributes) {
      // Claimed completed but produced nothing usable — treat as failed, not empty success.
      console.warn('[text-scan] completed_without_attributes elapsedMs=%d', elapsedMs);
      return json(normalized('failed', SAFE_FAILED_MESSAGE), 200);
    }

    const userMessage =
      safeStringMessage(parsed.userMessage) ?? 'Identified a fashion item from your description.';
    console.log(
      '[text-scan] ok uid=%s status=completed attrKeys=%d elapsedMs=%d',
      userId.slice(0, 8),
      Object.keys(attributes).length,
      elapsedMs,
    );
    return json(normalized('completed', userMessage, attributes), 200);
  } catch (err) {
    const isTimeout = err instanceof DOMException && err.name === 'AbortError';
    console.warn('[text-scan] %s elapsedMs=%d', isTimeout ? 'timeout' : 'error', Date.now() - startedAt);
    return json(normalized('failed', SAFE_FAILED_MESSAGE), 200);
  } finally {
    clearTimeout(timer);
  }
});
