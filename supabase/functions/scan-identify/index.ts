// scan-identify — Secure server-side Gemini proxy for K Scan fashion ID.
//
// Architecture:
//   Mobile Scan capture
//     → local compression + privacy sanitizer (client)
//     → supabase.functions.invoke('scan-identify')
//     → this function → Gemini Flash (vision or text)
//     → normalized fashion attributes
//     → Scan result UI
//
// Supports two modes:
//   - image: vision analysis of a captured/uploaded photo
//   - text:  natural-language fashion query analysis (TextScan)
//
// Product rule: K Scan identifies FASHION ITEMS, not people. If a person, face,
// or bystander appears, identity is ignored entirely; only fashion attributes of
// visible garments/accessories are returned. No biometric/demographic traits.
//
// Security guarantees (mirrors stylechat-generate):
//   - JWT verified via auth.getUser() before any provider call
//   - GEMINI_API_KEY never leaves this function
//   - Raw provider output is parsed + normalized, never returned verbatim
//   - No stack traces returned to the client
//   - recommendedProducts is always [] in this slice (matching deferred)
//
// Kill switch: set SCAN_IDENTIFY_AI_ENABLED=false (trim/case-insensitive) to disable.
// Model precedence: SCAN_GEMINI_MODEL, then GEMINI_MODEL, else DEFAULT_MODEL.

import { createClient } from 'npm:@supabase/supabase-js@2';

// ── Constants ──────────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Max compressed base64 payload accepted from the client (2 MB of base64 chars).
const MAX_IMAGE_BASE64_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_QUERY_LEN = 500;
const MAX_OUTPUT_TOKENS = 512;
// Provider call timeout. Target is ~5s; an 8s hard cap absorbs cold starts / free
// tier latency without hanging. Operator-tunable via SCAN_GEMINI_TIMEOUT_MS.
const DEFAULT_GEMINI_TIMEOUT_MS = 8_000;
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-1.5-flash';
const DEFAULT_MIME = 'image/jpeg';

// Output sanitization caps — keep responses small and predictable.
const MAX_STRING_LEN = 80;
const MAX_USER_MESSAGE_LEN = 240;
const MAX_ARRAY_ITEMS = 8;

// Allowed FashionAttributes keys. Anything outside this allowlist (e.g. a stray
// face/person/demographic field) is dropped before the response is returned.
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
  "We couldn't complete this scan. Please try again in better light or retake the photo.";
const SAFE_NON_FASHION_MESSAGE =
  'This does not appear to be a fashion item. Try scanning clothing, shoes, bags, or accessories.';
const IMAGE_TOO_LARGE_MESSAGE =
  'Image too large. Please retake the photo closer or in better light.';
const SAFE_TEXT_FAILED_MESSAGE =
  "We couldn't analyze this request. Please try describing a garment, style, or outfit.";
const SAFE_TEXT_NON_FASHION_MESSAGE =
  "This doesn't appear to be a fashion query. Try describing a garment, style, or outfit.";

// ── Provider prompts (server-side only) ────────────────────────────────────────

const IDENTIFY_PROMPT = `Analyze this image for fashion items only.

If the image contains clothing, shoes, bags, jewelry, eyewear, or accessories, return fashion attributes.

If the image contains landscapes, food, animals, interiors, text-only content, or no fashion-relevant item, return status: non_fashion.

If people or faces are visible, ignore identity completely. Do not describe faces, bodies, demographic traits, race, age, gender, body type, health, or identity. Analyze only visible clothing or accessories if they are present.

Return strict JSON only, matching exactly this shape (omit any attribute you cannot determine):
{
  "status": "completed" | "non_fashion",
  "attributes": {
    "category": string,
    "itemType": string,
    "silhouette": string,
    "colorPalette": string[],
    "materialEstimate": string,
    "pattern": string,
    "texture": string,
    "styleTags": string[],
    "occasion": string,
    "confidenceScore": number
  },
  "userMessage": string
}

Rules:
- confidenceScore is a number between 0 and 1.
- For non_fashion, omit attributes and set a short userMessage.
- Do not include people, identity, or demographic fields under any key.
- Output JSON only. No markdown, no prose outside the JSON.`;

const TEXT_IDENTIFY_PROMPT = `Analyze this fashion text query and return structured attributes.

If the query describes clothing, footwear, accessories, or fashion styling, return fashion attributes.

If the query is about non-fashion topics (landscapes, food, animals, interiors, etc.), return status: non_fashion.

Return strict JSON only, matching exactly this shape (omit any attribute you cannot determine):
{
  "status": "completed" | "non_fashion",
  "attributes": {
    "category": string,
    "itemType": string,
    "silhouette": string,
    "colorPalette": string[],
    "materialEstimate": string,
    "pattern": string,
    "texture": string,
    "styleTags": string[],
    "occasion": string,
    "confidenceScore": number
  },
  "userMessage": string
}

Rules:
- confidenceScore is a number between 0 and 1.
- For non_fashion, omit attributes and set a short userMessage (≤ 120 characters where possible).
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
 * fashion keys survive; identity/demographic/unknown keys are dropped.
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

function validateTextQuery(value: unknown): string | undefined {
  if (typeof value !== 'string') return 'Invalid query format';
  const trimmed = value.trim();
  if (!trimmed || trimmed.length < 3 || trimmed.length > MAX_TEXT_QUERY_LEN) return 'Invalid query format';
  if (/^[A-Za-z0-9+/]{40,}={0,2}$/.test(trimmed)) return 'Invalid query format';
  if (trimmed.includes('```') || trimmed.includes('`')) return 'Invalid query format';
  const lower = trimmed.toLowerCase();
  const injections = [
    'ignore previous instructions',
    'system prompt',
    'developer message',
    'reveal your prompt',
    'act as another system',
    'ignore all instructions',
    'forget previous',
    'you are now',
    'new role:',
    'override instructions',
  ];
  if (injections.some((p) => lower.includes(p))) return 'Invalid query format';
  if (/[\w.+-]+@[\w.-]+\.\w+/.test(trimmed)) return 'Invalid query format';
  if (/(\+?\d[\d\s-]{7,}\d)/.test(trimmed)) return 'Invalid query format';
  if (/\b\d{3}[\s-]\d{2}[\s-]\d{4}\b/.test(trimmed)) return 'Invalid query format';
  const nonAlphaNum = (trimmed.match(/[^a-zA-Z0-9\s]/g) || []).length;
  if (nonAlphaNum / trimmed.length > 0.30) return 'Invalid query format';
  return undefined;
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
    console.error('[scan-identify] Supabase function env is not configured');
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
  let body: {
    mode?: unknown;
    imageBase64?: unknown;
    textQuery?: unknown;
    source?: unknown;
    localPrivacyFiltered?: unknown;
    clientTimestamp?: unknown;
  } = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const mode = typeof body.mode === 'string' ? body.mode.toLowerCase() : 'image';
  const source = typeof body.source === 'string' ? body.source : 'unknown';
  let imageBase64 = '';
  let textQuery = '';

  if (mode === 'text') {
    textQuery = typeof body.textQuery === 'string' ? body.textQuery.trim() : '';
    if (!textQuery) {
      return json(normalized('failed', SAFE_TEXT_FAILED_MESSAGE), 200);
    }
    const textValidation = validateTextQuery(textQuery);
    if (textValidation) {
      return json({ error: true, message: textValidation, code: 'TEXTSCAN_INVALID_INPUT' }, 400);
    }
  } else {
    // Accept either a raw base64 string or a data URI; strip the prefix server-side.
    imageBase64 = typeof body.imageBase64 === 'string' ? body.imageBase64 : '';
    imageBase64 = imageBase64.replace(/^data:[^;]+;base64,/, '').trim();

    if (!imageBase64) {
      return json(normalized('failed', SAFE_FAILED_MESSAGE), 200);
    }
    if (imageBase64.length > MAX_IMAGE_BASE64_BYTES) {
      console.warn('[scan-identify] image_too_large bytes=%d', imageBase64.length);
      return json(normalized('failed', IMAGE_TOO_LARGE_MESSAGE), 200);
    }
  }

  // ── 3. Kill switch + provider key ────────────────────────────────────────────
  const isAiDisabled = readTrimmedEnv('SCAN_IDENTIFY_AI_ENABLED')?.toLowerCase() === 'false';
  if (isAiDisabled) {
    console.log('[scan-identify] kill switch active');
    return json(normalized('failed', mode === 'text' ? SAFE_TEXT_FAILED_MESSAGE : SAFE_FAILED_MESSAGE), 200);
  }

  const geminiKey = Deno.env.get('GEMINI_API_KEY');
  if (!geminiKey) {
    console.error('[scan-identify] GEMINI_API_KEY not configured');
    return json({ error: 'AI provider not configured' }, 500);
  }

  const modelName =
    readTrimmedEnv('SCAN_GEMINI_MODEL') || readTrimmedEnv('GEMINI_MODEL') || DEFAULT_MODEL;
  const timeoutMs = (() => {
    const raw = readTrimmedEnv('SCAN_GEMINI_TIMEOUT_MS');
    const parsed = raw !== undefined ? parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) && parsed >= 2_000 && parsed <= 20_000
      ? parsed
      : DEFAULT_GEMINI_TIMEOUT_MS;
  })();

  // ── 4. Call Gemini with a timeout guard ──────────────────────────────────────
  const geminiUrl = (() => {
    const u = new URL(`${GEMINI_API_BASE}/${modelName}:generateContent`);
    u.searchParams.set('key', geminiKey);
    return u.toString();
  })();

  const geminiBody = mode === 'text'
    ? {
        contents: [
          {
            role: 'user',
            parts: [
              { text: TEXT_IDENTIFY_PROMPT },
              { text: textQuery },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          responseMimeType: 'application/json',
        },
      }
    : {
        contents: [
          {
            role: 'user',
            parts: [
              { text: IDENTIFY_PROMPT },
              { inline_data: { mime_type: DEFAULT_MIME, data: imageBase64 } },
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

  const safeFailed = mode === 'text' ? SAFE_TEXT_FAILED_MESSAGE : SAFE_FAILED_MESSAGE;
  const safeNonFashion = mode === 'text' ? SAFE_TEXT_NON_FASHION_MESSAGE : SAFE_NON_FASHION_MESSAGE;

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
        '[scan-identify] gemini_http_error uid=%s mode=%s source=%s httpStatus=%d code=%s status=%s elapsedMs=%d',
        userId.slice(0, 8),
        mode,
        source,
        res.status,
        String(meta.code ?? 'none'),
        String(meta.status ?? 'none'),
        elapsedMs,
      );
      return json(normalized('failed', safeFailed), 200);
    }

    let data: GeminiResponse;
    try {
      data = JSON.parse(raw);
    } catch {
      console.warn('[scan-identify] gemini_parse_failure mode=%s source=%s elapsedMs=%d', mode, source, elapsedMs);
      return json(normalized('failed', safeFailed), 200);
    }

    const blockReason = data.promptFeedback?.blockReason;
    const text = extractGeminiText(data);
    if (!text) {
      console.warn(
        '[scan-identify] gemini_empty mode=%s source=%s blockReason=%s elapsedMs=%d',
        mode,
        source,
        blockReason ?? 'none',
        elapsedMs,
      );
      return json(normalized('failed', safeFailed), 200);
    }

    const parsed = parseModelJson(text);
    if (!parsed) {
      console.warn('[scan-identify] model_json_unparseable mode=%s source=%s elapsedMs=%d', mode, source, elapsedMs);
      return json(normalized('failed', safeFailed), 200);
    }

    const rawStatus = typeof parsed.status === 'string' ? parsed.status.toLowerCase() : '';
    const attributes = sanitizeAttributes(parsed.attributes);

    // Non-fashion (explicit, or completed with no usable attributes).
    if (rawStatus.includes('non') || (!attributes && rawStatus !== 'completed')) {
      const msg = safeStringMessage(parsed.userMessage) ?? safeNonFashion;
      console.log('[scan-identify] ok uid=%s mode=%s source=%s status=non_fashion elapsedMs=%d', userId.slice(0, 8), mode, source, elapsedMs);
      return json(normalized('non_fashion', msg), 200);
    }

    if (!attributes) {
      console.warn('[scan-identify] completed_without_attributes mode=%s source=%s elapsedMs=%d', mode, source, elapsedMs);
      return json(normalized('failed', safeFailed), 200);
    }

    const userMessage =
      safeStringMessage(parsed.userMessage) ?? (mode === 'text'
        ? 'Analyzed your fashion request.'
        : 'Identified a fashion item from your scan.');
    console.log(
      '[scan-identify] ok uid=%s mode=%s source=%s status=completed attrKeys=%d elapsedMs=%d',
      userId.slice(0, 8),
      mode,
      source,
      Object.keys(attributes).length,
      elapsedMs,
    );
    return json(normalized('completed', userMessage, attributes), 200);
  } catch (err) {
    const isTimeout = err instanceof DOMException && err.name === 'AbortError';
    console.warn('[scan-identify] %s mode=%s source=%s elapsedMs=%d', isTimeout ? 'timeout' : 'error', mode, source, Date.now() - startedAt);
    return json(normalized('failed', safeFailed), 200);
  } finally {
    clearTimeout(timer);
  }
});

function safeStringMessage(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const t = value.replace(/\s+/g, ' ').trim();
  if (!t) return undefined;
  return t.slice(0, MAX_USER_MESSAGE_LEN);
}
