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
const MAX_OUTPUT_TOKENS = 1024;
// Provider call timeout. Target is ~5s; an 8s hard cap absorbs cold starts / free
// tier latency without hanging. Operator-tunable via SCAN_GEMINI_TIMEOUT_MS.
const DEFAULT_GEMINI_TIMEOUT_MS = 8_000;
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-1.5-flash';
const DEFAULT_MIME = 'image/jpeg';

// Output sanitization caps — keep responses small and predictable.
const MAX_STRING_LEN = 120;
const MAX_USER_MESSAGE_LEN = 240;
const MAX_VISUAL_OBSERVATION_LEN = 200;
const MAX_ARRAY_ITEMS = 12;

// Allowed FashionAttributes keys (legacy contract). Anything outside this
// allowlist (e.g. a stray face/person/demographic field) is dropped.
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

// Allowed DetailedIdentification keys for the new rich identification shape.
const IDENTIFICATION_STRING_KEYS = [
  'visual_observation',
  'item_type',
  'subtype',
  'primary_color',
  'pattern',
  'material_estimate',
  'silhouette',
  'fit',
  'length',
  'sleeve_length',
  'neckline_or_lapel',
  'closure',
  'visible_brand_text',
  'brand_guess',
] as const;
const IDENTIFICATION_ARRAY_KEYS = [
  'secondary_colors',
  'distinctive_features',
  'style_tags',
  'occasion_tags',
  'search_queries',
] as const;
const IDENTIFICATION_BOOLEAN_KEYS = ['logo_detected', 'non_fashion'] as const;
const IDENTIFICATION_NUMBER_KEYS = ['confidence_score'] as const;

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

const IDENTIFY_PROMPT = `You are a high-fidelity fashion identification engine. Analyze the provided image and identify the SINGLE dominant fashion item. Ignore people, faces, bodies, backgrounds, and bystanders. Do not infer demographic traits, race, age, gender, body type, or health.

If the image contains clothing, footwear, accessories, or jewelry, return detailed fashion attributes.
If the image contains landscapes, food, animals, interiors, text-only content, or no fashion-relevant item, return non_fashion.

Be specific. Prefer "black double-breasted blazer with gold buttons" over "jacket." Prefer "white ribbed sleeveless tank top" over "shirt." Prefer "floral puff-sleeve midi dress" over "dress."

Never hallucinate a brand, SKU, exact material, or exact product name. Use unknown, null, or [] when uncertain. Only set brand_guess when visible brand text/logo or strong evidence exists.

Return strict JSON only, matching exactly this shape:
{
  "status": "completed" | "non_fashion",
  "identification": {
    "visual_observation": "A concise 1-2 sentence description of the dominant fashion item only.",
    "item_type": "blazer",
    "subtype": "double-breasted blazer",
    "primary_color": "black",
    "secondary_colors": [],
    "pattern": "solid",
    "material_estimate": "wool blend",
    "silhouette": "structured",
    "fit": "tailored",
    "length": "hip length",
    "sleeve_length": "long sleeve",
    "neckline_or_lapel": "peak lapel",
    "closure": "front buttons",
    "distinctive_features": ["gold buttons", "structured shoulders"],
    "style_tags": ["tailored", "minimalist", "polished"],
    "occasion_tags": ["workwear", "evening", "smart casual"],
    "visible_brand_text": null,
    "logo_detected": false,
    "brand_guess": null,
    "confidence_score": 0.84,
    "search_queries": [
      "black double breasted blazer gold buttons",
      "tailored black blazer structured shoulders",
      "minimalist black blazer peak lapel"
    ],
    "non_fashion": false
  },
  "userMessage": "Black double-breasted blazer with structured shoulders, peak lapels, and gold buttons."
}

Few-shot examples:

Example 1 — Black Blazer
Input description: A black tailored blazer with structured shoulders, gold buttons, and peak lapels.
Expected output:
{
  "status": "completed",
  "identification": {
    "visual_observation": "A black double-breasted blazer with structured shoulders, peak lapels, and gold buttons.",
    "item_type": "blazer",
    "subtype": "double-breasted blazer",
    "primary_color": "black",
    "secondary_colors": [],
    "pattern": "solid",
    "material_estimate": "wool blend",
    "silhouette": "structured",
    "fit": "tailored",
    "length": "hip length",
    "sleeve_length": "long sleeve",
    "neckline_or_lapel": "peak lapel",
    "closure": "front buttons",
    "distinctive_features": ["gold buttons", "structured shoulders"],
    "style_tags": ["tailored", "minimalist", "polished"],
    "occasion_tags": ["workwear", "evening", "smart casual"],
    "visible_brand_text": null,
    "logo_detected": false,
    "brand_guess": null,
    "confidence_score": 0.92,
    "search_queries": [
      "black double breasted blazer gold buttons",
      "tailored black blazer structured shoulders",
      "minimalist black blazer peak lapel"
    ],
    "non_fashion": false
  },
  "userMessage": "Black double-breasted blazer with structured shoulders, peak lapels, and gold buttons."
}

Example 2 — Floral Midi Dress
Input description: A floral midi dress with short puff sleeves, fitted waist, and soft flowing skirt.
Expected output:
{
  "status": "completed",
  "identification": {
    "visual_observation": "A floral puff-sleeve midi dress with a fitted waist and soft flowing skirt.",
    "item_type": "dress",
    "subtype": "puff-sleeve midi dress",
    "primary_color": "multi",
    "secondary_colors": ["green", "pink"],
    "pattern": "floral",
    "material_estimate": "lightweight cotton or viscose",
    "silhouette": "A-line",
    "fit": "fitted waist",
    "length": "midi",
    "sleeve_length": "short sleeve",
    "neckline_or_lapel": "round neck",
    "closure": "side zipper",
    "distinctive_features": ["puff sleeves", "fitted waist", "flowing skirt"],
    "style_tags": ["feminine", "romantic", "summer"],
    "occasion_tags": ["daytime", "casual", "brunch"],
    "visible_brand_text": null,
    "logo_detected": false,
    "brand_guess": null,
    "confidence_score": 0.89,
    "search_queries": [
      "floral puff sleeve midi dress fitted waist",
      "A-line floral midi dress short sleeve",
      "romantic summer dress puff sleeves"
    ],
    "non_fashion": false
  },
  "userMessage": "Floral puff-sleeve midi dress with a fitted waist and soft flowing skirt."
}

Example 3 — Sneakers
Input description: White low-top leather sneakers with rubber sole and minimal branding.
Expected output:
{
  "status": "completed",
  "identification": {
    "visual_observation": "White low-top leather sneakers with a rubber sole and minimal branding.",
    "item_type": "sneakers",
    "subtype": "low-top leather sneakers",
    "primary_color": "white",
    "secondary_colors": [],
    "pattern": "solid",
    "material_estimate": "leather upper, rubber sole",
    "silhouette": "low-top",
    "fit": "standard",
    "length": null,
    "sleeve_length": null,
    "neckline_or_lapel": null,
    "closure": "lace-up",
    "distinctive_features": ["minimal branding", "rubber sole"],
    "style_tags": ["minimalist", "casual", "streetwear"],
    "occasion_tags": ["casual", "everyday", "travel"],
    "visible_brand_text": null,
    "logo_detected": false,
    "brand_guess": null,
    "confidence_score": 0.87,
    "search_queries": [
      "white low top leather sneakers rubber sole",
      "minimalist white leather sneakers",
      "casual white low top sneakers"
    ],
    "non_fashion": false
  },
  "userMessage": "White low-top leather sneakers with a rubber sole and minimal branding."
}

Example 4 — Non-Fashion
Input description: A coffee mug on a desk.
Expected output:
{
  "status": "non_fashion",
  "identification": {
    "visual_observation": "This is a coffee mug, not a fashion item.",
    "item_type": "NON_FASHION",
    "subtype": null,
    "primary_color": null,
    "secondary_colors": [],
    "pattern": null,
    "material_estimate": null,
    "silhouette": null,
    "fit": null,
    "length": null,
    "sleeve_length": null,
    "neckline_or_lapel": null,
    "closure": null,
    "distinctive_features": [],
    "style_tags": [],
    "occasion_tags": [],
    "visible_brand_text": null,
    "logo_detected": false,
    "brand_guess": null,
    "confidence_score": 0.95,
    "search_queries": [],
    "non_fashion": true
  },
  "userMessage": "This does not appear to be a fashion item. Try scanning clothing, shoes, bags, or accessories."
}

Rules:
- Return JSON only. No markdown, no prose outside the JSON.
- If uncertain about any field, use null, unknown, or [].
- Do not include people, identity, or demographic fields under any key.
- If a person or face appears, state in visual_observation that they were ignored and focus only on the clothing or accessory.
- For non_fashion, item_type must be "NON_FASHION" and non_fashion must be true.
- userMessage should be a concise, friendly summary derived from visual_observation.`;

const TEXT_IDENTIFY_PROMPT = `You are a high-fidelity fashion identification engine. Analyze this fashion text query and identify the described item.

If the query describes clothing, footwear, accessories, or fashion styling, return detailed fashion attributes.
If the query is about non-fashion topics (landscapes, food, animals, interiors, etc.), return non_fashion.

Be specific. Prefer "black double-breasted blazer with gold buttons" over "jacket." Prefer "white ribbed sleeveless tank top" over "shirt." Prefer "floral puff-sleeve midi dress" over "dress."

Never hallucinate a brand, SKU, exact material, or exact product name. Use unknown, null, or [] when uncertain. Only set brand_guess when visible brand text/logo or strong evidence exists.

Return strict JSON only, matching exactly this shape:
{
  "status": "completed" | "non_fashion",
  "identification": {
    "visual_observation": "A concise 1-2 sentence description of the described fashion item.",
    "item_type": "blazer",
    "subtype": "double-breasted blazer",
    "primary_color": "black",
    "secondary_colors": [],
    "pattern": "solid",
    "material_estimate": "wool blend",
    "silhouette": "structured",
    "fit": "tailored",
    "length": "hip length",
    "sleeve_length": "long sleeve",
    "neckline_or_lapel": "peak lapel",
    "closure": "front buttons",
    "distinctive_features": ["gold buttons", "structured shoulders"],
    "style_tags": ["tailored", "minimalist", "polished"],
    "occasion_tags": ["workwear", "evening", "smart casual"],
    "visible_brand_text": null,
    "logo_detected": false,
    "brand_guess": null,
    "confidence_score": 0.84,
    "search_queries": [
      "black double breasted blazer gold buttons",
      "tailored black blazer structured shoulders",
      "minimalist black blazer peak lapel"
    ],
    "non_fashion": false
  },
  "userMessage": "Black double-breasted blazer with structured shoulders, peak lapels, and gold buttons."
}

Rules:
- Return JSON only. No markdown, no prose outside the JSON.
- If uncertain about any field, use null, unknown, or [].
- For non_fashion, item_type must be "NON_FASHION" and non_fashion must be true.
- userMessage should be a concise, friendly summary derived from visual_observation.`;

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
  identification?: Record<string, unknown>,
) {
  const out: Record<string, unknown> = {
    status,
    recommendedProducts: [],
    userMessage,
  };
  if (status === 'completed' && attributes) out.attributes = attributes;
  if (status === 'completed' && identification) out.identification = identification;
  return out;
}

function safeString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const t = value.replace(/\s+/g, ' ').trim();
  if (!t) return undefined;
  return t.slice(0, MAX_STRING_LEN);
}

function safeVisualObservation(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const t = value.replace(/\s+/g, ' ').trim();
  if (!t) return undefined;
  return t.slice(0, MAX_VISUAL_OBSERVATION_LEN);
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

function safeBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1 || value === '1') return true;
  if (value === 'false' || value === 0 || value === '0') return false;
  return undefined;
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

/**
 * Build a sanitized identification object from raw model output.
 */
function sanitizeIdentification(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const src = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const key of IDENTIFICATION_STRING_KEYS) {
    const v = safeString(src[key]);
    if (v) out[key] = v;
  }
  for (const key of IDENTIFICATION_ARRAY_KEYS) {
    const v = safeStringArray(src[key]);
    if (v) out[key] = v;
  }
  for (const key of IDENTIFICATION_BOOLEAN_KEYS) {
    const v = safeBoolean(src[key]);
    if (v !== undefined) out[key] = v;
  }
  for (const key of IDENTIFICATION_NUMBER_KEYS) {
    const v = safeConfidence(src[key]);
    if (v !== undefined) out[key] = v;
  }

  // visual_observation gets a longer cap
  const vo = safeVisualObservation(src.visual_observation);
  if (vo) out.visual_observation = vo;

  return Object.keys(out).length ? out : undefined;
}

/**
 * Map the new rich identification shape back to the legacy FashionAttributes
 * shape so the existing app contract is preserved.
 */
function buildAttributesFromIdentification(
  identification: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!identification) return undefined;
  const out: Record<string, unknown> = {};

  const itemType = safeString(identification.item_type);
  const subtype = safeString(identification.subtype);
  if (itemType) out.category = itemType;
  if (subtype || itemType) out.itemType = subtype || itemType;

  const silhouette = safeString(identification.silhouette);
  if (silhouette) out.silhouette = silhouette;

  const colors: string[] = [];
  const primaryColor = safeString(identification.primary_color);
  if (primaryColor) colors.push(primaryColor);
  const secondaryColors = safeStringArray(identification.secondary_colors);
  if (secondaryColors) colors.push(...secondaryColors);
  if (colors.length) out.colorPalette = colors;

  const material = safeString(identification.material_estimate);
  if (material) out.materialEstimate = material;

  const pattern = safeString(identification.pattern);
  if (pattern) out.pattern = pattern;

  const styleTags = safeStringArray(identification.style_tags);
  if (styleTags) out.styleTags = styleTags;

  const occasionTags = safeStringArray(identification.occasion_tags);
  if (occasionTags?.length) out.occasion = occasionTags[0];

  const confidence = safeConfidence(identification.confidence_score);
  if (confidence !== undefined) out.confidenceScore = confidence;

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

    // Try the new rich identification shape first.
    const identification = sanitizeIdentification(parsed.identification);
    let attributes: Record<string, unknown> | undefined;
    if (identification) {
      attributes = buildAttributesFromIdentification(identification);
    }
    // Fallback: old direct attributes shape for backward compatibility.
    if (!attributes) {
      attributes = sanitizeAttributes(parsed.attributes);
    }

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

    // Prefer the rich visual_observation for userMessage when available.
    const userMessage = safeStringMessage(parsed.userMessage) ??
      (identification?.visual_observation
        ? safeVisualObservation(identification.visual_observation)
        : undefined) ??
      (mode === 'text'
        ? 'Analyzed your fashion request.'
        : 'Identified a fashion item from your scan.');

    console.log(
      '[scan-identify] ok uid=%s mode=%s source=%s status=completed attrKeys=%d idKeys=%d elapsedMs=%d',
      userId.slice(0, 8),
      mode,
      source,
      Object.keys(attributes).length,
      identification ? Object.keys(identification).length : 0,
      elapsedMs,
    );
    return json(normalized('completed', userMessage, attributes, identification), 200);
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
