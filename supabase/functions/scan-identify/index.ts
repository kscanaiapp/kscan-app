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
//   - recommendedProducts: live commerce products.
//   - similarityMatches: image-mode catalog similarity products.
//
// Kill switch: set SCAN_IDENTIFY_AI_ENABLED=false (trim/case-insensitive) to disable.
// Model precedence: SCAN_GEMINI_MODEL, then GEMINI_MODEL, else DEFAULT_MODEL.

import {
  cleanAiJsonText,
  deriveConfidenceLabel,
  normalizeIdentification,
  deriveLegacyAttributesFromIdentification,
  ensureLegacyAttributes,
  buildAuditEvent,
  logScanIdentificationAudit,
  safeParseAiJson,
  type NormalizedIdentification,
  type RankedScanProduct,
} from '../_shared/scanHelpers.ts';
import {
  fetchCatalogCandidates,
  adaptCatalogCandidate,
} from '../_shared/catalogRetrieval.ts';
import {
  getShoppingResults,
  buildShoppingQuery,
} from './shoppingProvider.ts';
import {
  getScanCommerceResults,
} from './scanCommerceRouter.ts';
import {
  findSimilarityMatches,
  type SimilarityMatch,
} from './similarityMatcher.ts';
import { captureScanIntelligence } from './scanIntelligenceCapture.ts';
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
const MAX_OUTPUT_TOKENS = 2048;
// Provider call timeout. Target is ~5s; an 8s hard cap absorbs cold starts / free
// tier latency without hanging. Operator-tunable via SCAN_GEMINI_TIMEOUT_MS.
const DEFAULT_GEMINI_TIMEOUT_MS = 8_000;
const SCAN_INTELLIGENCE_TIMEOUT_MS = 500;
const SIMILARITY_TIMEOUT_MS = 300;
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
  'scan_quality_note',
] as const;
const IDENTIFICATION_ARRAY_KEYS = [
  'secondary_colors',
  'distinctive_features',
  'style_tags',
  'occasion_tags',
  'search_queries',
  'styling_suggestions',
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

const IDENTIFY_PROMPT = `You are K Scan AI's fashion identification engine.

Analyze the uploaded image and identify the dominant fashion item only.

Ignore people, faces, bodies, bystanders, mirrors, rooms, vehicles, license plates, furniture, and background clutter.

Do not identify people.
Do not infer age, race, gender identity, body type, health, religion, income, or any protected trait.

Real camera scan rules:
- If multiple clothing items are present, identify the dominant, most central, or largest fashion item.
- Ignore accessories unless they are the primary subject.
- Focus on garment cut, silhouette, color, texture, material, pattern, and distinctive construction details.
- Do not infer brand unless a logo, tag, or text is clearly visible.
- If the item is partially obscured, describe only what is visible and lower confidence_score.
- If the image is too dark, too blurry, too far away, or the item is too small, include scan_quality_note.
- If a jacket, coat, blazer, dress, or other garment is the dominant item, classify the scan as that garment even if a bag, shoe, hat, or other accessory is also visible. Never classify the scan as a bag or accessory when a garment is clearly the main subject.
- Choose exactly one dominant item. Do not blend two items into one result.
- If uncertain between two categories, return item_type: "unknown" with a lower confidence_score rather than forcing a confident wrong category.

Return strict JSON only.
No markdown.
No commentary.

Use the existing response shape:
- status
- userMessage
- attributes
- recommendedProducts
- identification

The \`attributes\` object is legacy and must remain populated for the current app.

The optional \`identification\` object must include:
- visual_observation
- item_type
- subtype
- primary_color
- secondary_colors
- pattern
- material_estimate
- silhouette
- fit
- length
- sleeve_length
- neckline_or_lapel
- closure
- distinctive_features
- style_tags
- occasion_tags
- visible_brand_text
- logo_detected
- brand_guess
- confidence_score
- search_queries
- non_fashion
- styling_suggestions
- scan_quality_note

If the item is a common fashion staple such as blazer, jeans, white shirt, black dress, sneakers, handbag, coat, or top, include 2 practical styling_suggestions.

If confidence_score is below 0.60, you MUST include a scan_quality_note explaining what would improve the scan, such as "Try a clearer front view" or "Move closer to the item."

If confidence_score is between 0.60 and 0.79, include a scan_quality_note only when the image is blurry, dark, far away, or the item is partially visible.

If confidence_score is 0.80 or higher and the item is clearly visible, set scan_quality_note to null.

Return strict JSON only, matching exactly this shape:
{
  "status": "completed" | "non_fashion",
  "attributes": {
    "category": "blazer",
    "itemType": "double-breasted blazer",
    "silhouette": "structured",
    "colorPalette": ["black"],
    "materialEstimate": "wool blend",
    "pattern": "solid",
    "texture": "wool blend",
    "styleTags": ["tailored", "minimalist", "polished"],
    "occasion": "workwear",
    "confidenceScore": 0.84
  },
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
    "non_fashion": false,
    "styling_suggestions": ["Pair with tailored trousers and a silk blouse.", "Layer over a monochrome dress for a sharp look."],
    "scan_quality_note": null
  },
  "recommendedProducts": [],
  "userMessage": "Black double-breasted blazer with structured shoulders, peak lapels, and gold buttons."
}

Few-shot examples:

Example 1 — Black Blazer
Input description: A black tailored blazer with structured shoulders, gold buttons, and peak lapels.
Expected output:
{
  "status": "completed",
  "attributes": {
    "category": "blazer",
    "itemType": "double-breasted blazer",
    "silhouette": "structured",
    "colorPalette": ["black"],
    "materialEstimate": "wool blend",
    "pattern": "solid",
    "texture": "wool blend",
    "styleTags": ["tailored", "minimalist", "polished"],
    "occasion": "workwear",
    "confidenceScore": 0.92
  },
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
    "non_fashion": false,
    "styling_suggestions": ["Pair with tailored trousers and a silk blouse.", "Layer over a monochrome dress for a sharp look."],
    "scan_quality_note": null
  },
  "recommendedProducts": [],
  "userMessage": "Black double-breasted blazer with structured shoulders, peak lapels, and gold buttons."
}

Example 2 — Floral Midi Dress
Input description: A floral midi dress with short puff sleeves, fitted waist, and soft flowing skirt.
Expected output:
{
  "status": "completed",
  "attributes": {
    "category": "dress",
    "itemType": "puff-sleeve midi dress",
    "silhouette": "A-line",
    "colorPalette": ["multi", "green", "pink"],
    "materialEstimate": "lightweight cotton or viscose",
    "pattern": "floral",
    "texture": "lightweight cotton or viscose",
    "styleTags": ["feminine", "romantic", "summer"],
    "occasion": "daytime",
    "confidenceScore": 0.89
  },
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
    "non_fashion": false,
    "styling_suggestions": ["Style with strappy sandals and a woven clutch for brunch.", "Add a denim jacket and white sneakers for a casual day out."],
    "scan_quality_note": null
  },
  "recommendedProducts": [],
  "userMessage": "Floral puff-sleeve midi dress with a fitted waist and soft flowing skirt."
}

Example 3 — Sneakers
Input description: White low-top leather sneakers with rubber sole and minimal branding.
Expected output:
{
  "status": "completed",
  "attributes": {
    "category": "sneakers",
    "itemType": "low-top leather sneakers",
    "silhouette": "low-top",
    "colorPalette": ["white"],
    "materialEstimate": "leather upper, rubber sole",
    "pattern": "solid",
    "texture": "leather upper, rubber sole",
    "styleTags": ["minimalist", "casual", "streetwear"],
    "occasion": "casual",
    "confidenceScore": 0.87
  },
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
    "non_fashion": false,
    "styling_suggestions": ["Wear with cropped jeans and a plain tee for a clean look.", "Pair with a midi skirt and oversized sweater for contrast."],
    "scan_quality_note": null
  },
  "recommendedProducts": [],
  "userMessage": "White low-top leather sneakers with a rubber sole and minimal branding."
}

Example 4 — Non-Fashion
Input description: A coffee mug on a desk.
Expected output:
{
  "status": "non_fashion",
  "recommendedProducts": [],
  "userMessage": "This does not appear to be a fashion item. Try scanning clothing, shoes, bags, or accessories.",
  "attributes": {
    "category": "unknown",
    "itemType": "NON_FASHION",
    "silhouette": "unknown",
    "colorPalette": [],
    "materialEstimate": "unknown",
    "pattern": "unknown",
    "texture": "unknown",
    "styleTags": [],
    "occasion": "unknown",
    "confidenceScore": 0.95
  },
  "identification": {
    "visual_observation": "The image appears to show a non-fashion item.",
    "item_type": "NON_FASHION",
    "subtype": "unknown",
    "primary_color": "unknown",
    "secondary_colors": [],
    "pattern": "unknown",
    "material_estimate": "unknown",
    "silhouette": "unknown",
    "fit": "unknown",
    "length": "unknown",
    "sleeve_length": "unknown",
    "neckline_or_lapel": "unknown",
    "closure": "unknown",
    "distinctive_features": [],
    "style_tags": [],
    "occasion_tags": [],
    "visible_brand_text": null,
    "logo_detected": false,
    "brand_guess": null,
    "confidence_score": 0.95,
    "search_queries": [],
    "non_fashion": true,
    "styling_suggestions": [],
    "scan_quality_note": null
  }
}

Rules:
- Return JSON only. No markdown, no prose outside the JSON.
- If uncertain about any field, use null, unknown, or [].
- Do not include people, identity, or demographic fields under any key.
- If a person or face appears, state in visual_observation that they were ignored and focus only on the clothing or accessory.
- For non_fashion, item_type must be "NON_FASHION" and non_fashion must be true.
- userMessage should be a concise, friendly summary derived from visual_observation.
- The AI must return BOTH attributes and identification. If attributes is missing, derive it from identification.`;

const TEXT_IDENTIFY_PROMPT = `You are K Scan AI's fashion identification engine.

Analyze this fashion text query and identify the described item.

Ignore people, faces, bodies, bystanders, mirrors, rooms, vehicles, license plates, furniture, and background clutter.

Do not identify people.
Do not infer age, race, gender identity, body type, health, religion, income, or any protected trait.

Return strict JSON only.
No markdown.
No commentary.

Use the existing response shape:
- status
- userMessage
- attributes
- recommendedProducts
- identification

The \`attributes\` object is legacy and must remain populated for the current app.

The optional \`identification\` object must include:
- visual_observation
- item_type
- subtype
- primary_color
- secondary_colors
- pattern
- material_estimate
- silhouette
- fit
- length
- sleeve_length
- neckline_or_lapel
- closure
- distinctive_features
- style_tags
- occasion_tags
- visible_brand_text
- logo_detected
- brand_guess
- confidence_score
- search_queries
- non_fashion
- styling_suggestions
- scan_quality_note

If the item is a common fashion staple such as blazer, jeans, white shirt, black dress, sneakers, handbag, coat, or top, include 2 practical styling_suggestions.

If confidence_score is below 0.60, you MUST include a scan_quality_note explaining what would improve the scan, such as "Try a clearer front view" or "Move closer to the item."

If confidence_score is between 0.60 and 0.79, include a scan_quality_note only when the image is blurry, dark, far away, or the item is partially visible.

If confidence_score is 0.80 or higher and the item is clearly visible, set scan_quality_note to null.

Return strict JSON only, matching exactly this shape:
{
  "status": "completed" | "non_fashion",
  "attributes": {
    "category": "blazer",
    "itemType": "double-breasted blazer",
    "silhouette": "structured",
    "colorPalette": ["black"],
    "materialEstimate": "wool blend",
    "pattern": "solid",
    "texture": "wool blend",
    "styleTags": ["tailored", "minimalist", "polished"],
    "occasion": "workwear",
    "confidenceScore": 0.84
  },
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
    "non_fashion": false,
    "styling_suggestions": ["Pair with tailored trousers and a silk blouse.", "Layer over a monochrome dress for a sharp look."],
    "scan_quality_note": null
  },
  "recommendedProducts": [],
  "userMessage": "Black double-breasted blazer with structured shoulders, peak lapels, and gold buttons."
}

Rules:
- Return JSON only. No markdown, no prose outside the JSON.
- If uncertain about any field, use null, unknown, or [].
- For non_fashion, item_type must be "NON_FASHION" and non_fashion must be true.
- userMessage should be a concise, friendly summary derived from visual_observation.
- The AI must return BOTH attributes and identification. If attributes is missing, derive it from identification.`;

// ── Helpers ──────────────────────────────────────────────────────────────────

const readTrimmedEnv = (name: string): string | undefined => {
  const value = Deno.env.get(name)?.trim();
  return value ? value : undefined;
};

function buildDisplayResult(
  identification: Record<string, unknown> | undefined,
  confidenceScore?: number,
): Record<string, unknown> | undefined {
  if (!identification) return undefined;
  const out: Record<string, unknown> = {};
  const vo = safeVisualObservation(identification.visual_observation);
  if (vo) out.headline = vo;
  const detailsParts: string[] = [];
  const cat = safeString(identification.item_type);
  if (cat) detailsParts.push(cat);
  const color = safeString(identification.primary_color);
  if (color) detailsParts.push(color);
  const mat = safeString(identification.material_estimate);
  if (mat) detailsParts.push(mat);
  const fit = safeString(identification.fit);
  if (fit) detailsParts.push(fit);
  const sil = safeString(identification.silhouette);
  if (sil) detailsParts.push(sil);
  if (detailsParts.length) out.details = detailsParts.join(' · ');
  const styling = safeStringArray(identification.styling_suggestions);
  if (styling?.length) out.styling = styling;
  if (confidenceScore !== undefined) {
    const hasQualityNote =
      typeof identification.scan_quality_note === 'string' &&
      identification.scan_quality_note.trim().length > 0;
    const label = deriveConfidenceLabel(confidenceScore, {
      hasQualityNote,
      itemType: safeString(identification.item_type),
    });
    if (label) out.confidenceLabel = label;
  }
  return Object.keys(out).length ? out : undefined;
}

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

/**
 * Build a minimal identification object from legacy attributes. Used when the
 * model returns only the legacy `attributes` shape (no `identification`), so
 * catalog retrieval -- which keys off identification -> canonicalCategory --
 * still has a category, color, and silhouette to work with.
 */
function buildIdentificationFromAttributes(
  attributes: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!attributes) return undefined;
  const out: Record<string, unknown> = {};
  const category = safeString(attributes.category);
  const itemType = safeString(attributes.itemType);
  if (category) out.item_type = category;
  if (itemType) out.subtype = itemType;
  const palette = safeStringArray(attributes.colorPalette);
  if (palette?.length) {
    out.primary_color = palette[0];
    if (palette.length > 1) out.secondary_colors = palette.slice(1);
  }
  const sil = safeString(attributes.silhouette);
  if (sil) out.silhouette = sil;
  const mat = safeString(attributes.materialEstimate);
  if (mat) out.material_estimate = mat;
  const pat = safeString(attributes.pattern);
  if (pat) out.pattern = pat;
  const styleTags = safeStringArray(attributes.styleTags);
  if (styleTags?.length) out.style_tags = styleTags;
  const occasion = safeString(attributes.occasion);
  if (occasion) out.occasion_tags = [occasion];
  const conf = safeConfidence(attributes.confidenceScore);
  if (conf !== undefined) out.confidence_score = conf;
  return Object.keys(out).length ? out : undefined;
}

/** Strip markdown fences and parse the first JSON object from model text. */
function parseModelJson(text: string): Record<string, unknown> | null {
  try {
    const parsed = safeParseAiJson(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
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

  // ── Service-role client for catalog retrieval (safe, no public RLS read) ──
  const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const catalogClient = supabaseUrl && supabaseServiceRoleKey
    ? createClient(supabaseUrl, supabaseServiceRoleKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      })
    : null;
  if (!catalogClient) {
    console.log('[scan-identify] catalog_client_not_available');
  }

  // ── 2. Parse and validate request body ──────────────────────────────────────
  let body: {
    mode?: unknown;
    imageBase64?: unknown;
    textQuery?: unknown;
    source?: unknown;
    appPlatform?: unknown;
    appVersion?: unknown;
    localPrivacyFiltered?: unknown;
    clientTimestamp?: unknown;
    scanId?: unknown;
    scan_id?: unknown;
    id?: unknown;
  } = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const mode = typeof body.mode === 'string' ? body.mode.toLowerCase() : 'image';
  const source = typeof body.source === 'string' ? body.source : 'unknown';
  const appPlatform = typeof body.appPlatform === 'string' && body.appPlatform.trim()
    ? body.appPlatform.trim()
    : null;
  const appVersion = typeof body.appVersion === 'string' && body.appVersion.trim()
    ? body.appVersion.trim()
    : null;
  let imageBase64 = '';
  let textQuery = '';

  const requestScanId = typeof body.scanId === 'string' && body.scanId.trim()
    ? body.scanId.trim()
    : typeof body.scan_id === 'string' && body.scan_id.trim()
    ? body.scan_id.trim()
    : typeof body.id === 'string' && body.id.trim()
    ? body.id.trim()
    : req.headers.get('x-scan-id') || req.headers.get('x-request-id') || crypto.randomUUID();
  const scanId = mode === 'image' ? crypto.randomUUID() : requestScanId;

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
      // Audit log failure
      const failureAudit = buildAuditEvent(
        { status: 'failed' },
        null,
        [],
        elapsedMs,
        scanId,
      );
      failureAudit.error_reason = 'gemini_http_error';
      logScanIdentificationAudit(failureAudit);
      return json(normalized('failed', safeFailed), 200);
    }

    let data: GeminiResponse;
    try {
      data = JSON.parse(raw);
    } catch {
      console.warn('[scan-identify] gemini_parse_failure mode=%s source=%s elapsedMs=%d', mode, source, elapsedMs);
      const failureAudit = buildAuditEvent(
        { status: 'failed' },
        null,
        [],
        elapsedMs,
        scanId,
      );
      failureAudit.error_reason = 'gemini_parse_failure';
      logScanIdentificationAudit(failureAudit);
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
      const failureAudit = buildAuditEvent(
        { status: 'failed' },
        null,
        [],
        elapsedMs,
        scanId,
      );
      failureAudit.error_reason = 'gemini_empty';
      logScanIdentificationAudit(failureAudit);
      return json(normalized('failed', safeFailed), 200);
    }

    const parsed = parseModelJson(text);
    if (!parsed) {
      console.warn('[scan-identify] model_json_unparseable mode=%s source=%s elapsedMs=%d', mode, source, elapsedMs);
      const failureAudit = buildAuditEvent(
        { status: 'failed' },
        null,
        [],
        elapsedMs,
        scanId,
      );
      failureAudit.error_reason = 'model_json_unparseable';
      logScanIdentificationAudit(failureAudit);
      return json(normalized('failed', safeFailed), 200);
    }

    const rawStatus = typeof parsed.status === 'string' ? parsed.status.toLowerCase() : '';

    // Try the new rich identification shape first.
    let identification = sanitizeIdentification(parsed.identification);
    let attributes: Record<string, unknown> | undefined;
    if (identification) {
      attributes = buildAttributesFromIdentification(identification);
    }
    // Fallback: old direct attributes shape for backward compatibility.
    if (!attributes) {
      attributes = sanitizeAttributes(parsed.attributes);
    }
    // If the model returned only legacy attributes (no identification), derive a
    // minimal identification so catalog retrieval still gets a canonicalCategory.
    if (!identification && attributes && rawStatus === 'completed') {
      identification = sanitizeIdentification(buildIdentificationFromAttributes(attributes));
    }

    // Non-fashion (explicit, or completed with no usable attributes).
    if (rawStatus.includes('non') || (!attributes && rawStatus !== 'completed')) {
      const msg = safeStringMessage(parsed.userMessage) ?? safeNonFashion;
      console.log('[scan-identify] ok uid=%s mode=%s source=%s status=non_fashion elapsedMs=%d', userId.slice(0, 8), mode, source, elapsedMs);
      // Build non-fashion response with safe attributes and identification
      const nonFashionIdentification = identification ?? {
        visual_observation: 'The image appears to show a non-fashion item.',
        item_type: 'NON_FASHION',
        subtype: 'unknown',
        primary_color: 'unknown',
        secondary_colors: [],
        pattern: 'unknown',
        material_estimate: 'unknown',
        silhouette: 'unknown',
        fit: 'unknown',
        length: 'unknown',
        sleeve_length: 'unknown',
        neckline_or_lapel: 'unknown',
        closure: 'unknown',
        distinctive_features: [],
        style_tags: [],
        occasion_tags: [],
        visible_brand_text: null,
        logo_detected: false,
        brand_guess: null,
        confidence_score: 0.95,
        search_queries: [],
        non_fashion: true,
        styling_suggestions: [],
        scan_quality_note: null,
      };
      const nonFashionAttributes = attributes ?? {
        category: 'unknown',
        itemType: 'NON_FASHION',
        silhouette: 'unknown',
        colorPalette: [],
        materialEstimate: 'unknown',
        pattern: 'unknown',
        texture: 'unknown',
        styleTags: [],
        occasion: 'unknown',
        confidenceScore: 0.95,
      };
      const nonFashionResponse = normalized('non_fashion', msg, nonFashionAttributes, nonFashionIdentification);
      const nonFashionResponseWithAttributes = ensureLegacyAttributes(nonFashionResponse);
      const nonFashionNormalizedId = normalizeIdentification(
        nonFashionResponseWithAttributes.identification as Partial<NormalizedIdentification> | null | undefined,
      );
      // Non-fashion scans never surface catalog products. Even though the model
      // marks the scan non_fashion, it can still emit a plausible item_type
      // (e.g. "bag"), which would otherwise leak real catalog rows of that
      // category into a non-fashion result. Force an empty shelf here.
      const finalResponse = {
        ...nonFashionResponseWithAttributes,
        ...(mode === 'image' ? { scanId } : {}),
        recommendedProducts: [],
        displayResult: buildDisplayResult(nonFashionResponseWithAttributes.identification as Record<string, unknown> | undefined, 0.95),
      };
      if (mode === 'image') {
        await captureImageModeScanIntelligence({
          scanId,
          userId,
          identification: nonFashionResponseWithAttributes.identification as Record<string, unknown> | undefined,
          attributes: nonFashionResponseWithAttributes.attributes as Record<string, unknown> | undefined,
          isFashion: false,
          commerce: undefined,
          recommendedProducts: [],
          appPlatform,
          appVersion,
        });
      }
      const auditEvent = buildAuditEvent(
        finalResponse,
        nonFashionNormalizedId,
        [],
        elapsedMs,
        scanId,
      );
      logScanIdentificationAudit(auditEvent);
      return json(finalResponse, 200);
    }

    if (!attributes) {
      console.warn('[scan-identify] completed_without_attributes mode=%s source=%s elapsedMs=%d', mode, source, elapsedMs);
      const failureAudit = buildAuditEvent(
        { status: 'failed' },
        null,
        [],
        elapsedMs,
        scanId,
      );
      failureAudit.error_reason = 'completed_without_attributes';
      logScanIdentificationAudit(failureAudit);
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

    const completedResponse = normalized('completed', userMessage, attributes, identification);
    const completedResponseWithAttributes = ensureLegacyAttributes(completedResponse);
    const completedNormalizedId = normalizeIdentification(
      completedResponseWithAttributes.identification as Partial<NormalizedIdentification> | null | undefined,
    );
    // Product recommendations.
    //   - Text mode: real shopping providers (Serper primary, Brave fallback).
    //   - Image (camera) mode: existing catalog retrieval (unchanged).
    let finalRecommendedProducts: RankedScanProduct[];
    let finalSimilarityMatches: SimilarityMatch[] = [];
    let rankedProductsForAudit: RankedScanProduct[];
    let shoppingMeta:
      | {
        provider: string;
        query: string;
        count: number;
        providersTried?: string[];
        catalogCount?: number;
        similarityMatches?: number;
      }
      | undefined;

    if (mode === 'text') {
      const shoppingQuery = buildShoppingQuery({
        searchQueries: identification?.search_queries,
        brand: identification?.brand_guess ?? identification?.visible_brand_text,
        color: identification?.primary_color,
        category: identification?.item_type ?? identification?.subtype,
        material: identification?.material_estimate,
        silhouette: identification?.silhouette,
        style: Array.isArray(identification?.style_tags)
          ? (identification.style_tags as unknown[]).join(' ')
          : identification?.style_tags,
        text: textQuery,
      });
      const shopping = await getShoppingResults({ query: shoppingQuery, limit: 8 });
      finalRecommendedProducts = shopping.products.slice(0, 8).map((p) => ({
        id: p.id,
        name: p.title,
        title: p.title,
        source: p.source,
        retailer: p.source,
        url: p.productUrl,
        product_url: p.productUrl,
        imageUrl: p.imageUrl,
        price: p.price,
        type: p.type,
      })) as RankedScanProduct[];
      rankedProductsForAudit = finalRecommendedProducts;
      shoppingMeta = {
        provider: shopping.provider,
        query: shopping.query,
        count: finalRecommendedProducts.length,
      };
    } else {
      // Image (camera) mode: live commerce first, then deterministic catalog
      // similarity scoring. The similarity matcher runs non-blocking and is
      // allowed to return fewer than 2 matches; the UI hides the section then.
      const commerce = await getScanCommerceResults({
        mode: 'image',
        identification: (completedResponseWithAttributes.identification as Record<string, unknown> | undefined) ||
          {},
        attributes: completedResponseWithAttributes.attributes as Record<string, unknown> | undefined,
        searchQueries: Array.isArray(completedNormalizedId?.normalizedSearchQueries)
          ? completedNormalizedId.normalizedSearchQueries
          : undefined,
        limit: 10,
      });

      const liveProducts = commerce.products.map((p) => ({
        id: p.id,
        name: p.title,
        title: p.title,
        source: p.source,
        retailer: p.source,
        price: p.price,
        type: p.type,
        imageUrl: p.imageUrl,
        image_url: p.imageUrl,
        productUrl: p.productUrl,
        product_url: p.productUrl,
        url: p.productUrl,
      }));

      finalRecommendedProducts = liveProducts.slice(0, 10) as RankedScanProduct[];

      // Score catalog candidates separately after live commerce. Timeout/error
      // returns [] so Similar Items hides without suppressing purchase options.
      const similarity = await buildImageSimilarityMatches({
        catalogClient,
        normalizedIdentification: completedNormalizedId,
      });
      finalSimilarityMatches = similarity.matches;

      rankedProductsForAudit = finalSimilarityMatches as RankedScanProduct[];
      shoppingMeta = {
        provider: commerce.provider,
        providersTried: commerce.providersTried,
        query: commerce.query,
        count: liveProducts.length,
        catalogCount: similarity.catalogCount,
        similarityMatches: finalSimilarityMatches.length,
      };
    }

    const finalResponse = {
      ...completedResponseWithAttributes,
      ...(mode === 'image' ? { scanId } : {}),
      recommendedProducts: finalRecommendedProducts,
      ...(mode === 'image' ? { similarityMatches: finalSimilarityMatches } : {}),
      ...(mode === 'text' && shoppingMeta ? { shopping: shoppingMeta } : {}),
      ...(mode === 'image' && shoppingMeta ? { commerce: shoppingMeta } : {}),
      displayResult: buildDisplayResult(
        completedResponseWithAttributes.identification as Record<string, unknown> | undefined,
        typeof (completedResponseWithAttributes.identification as Record<string, unknown> | undefined)?.confidence_score === 'number'
          ? ((completedResponseWithAttributes.identification as Record<string, unknown>).confidence_score as number)
          : undefined,
      ),
    };
    if (mode === 'image') {
      await captureImageModeScanIntelligence({
        scanId,
        userId,
        identification: completedResponseWithAttributes.identification as Record<string, unknown> | undefined,
        attributes: completedResponseWithAttributes.attributes as Record<string, unknown> | undefined,
        isFashion: true,
        commerce: shoppingMeta,
        recommendedProducts: finalRecommendedProducts,
        appPlatform,
        appVersion,
      });
    }
    const auditEvent = buildAuditEvent(
      finalResponse,
      completedNormalizedId,
      rankedProductsForAudit,
      elapsedMs,
      scanId,
    );
    logScanIdentificationAudit(auditEvent);
    return json(finalResponse, 200);
  } catch (err) {
    const isTimeout = err instanceof DOMException && err.name === 'AbortError';
    const elapsedMs = Date.now() - startedAt;
    console.warn('[scan-identify] %s mode=%s source=%s elapsedMs=%d', isTimeout ? 'timeout' : 'error', mode, source, elapsedMs);
    const failureAudit = buildAuditEvent(
      { status: 'failed' },
      null,
      [],
      elapsedMs,
      scanId,
    );
    failureAudit.error_reason = isTimeout ? 'timeout' : 'exception';
    logScanIdentificationAudit(failureAudit);
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

async function buildImageSimilarityMatches(input: {
  catalogClient: unknown;
  normalizedIdentification: NormalizedIdentification | null;
}): Promise<{ matches: SimilarityMatch[]; catalogCount: number }> {
  if (!input.normalizedIdentification) {
    return { matches: [], catalogCount: 0 };
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const work = (async (): Promise<{
    matches: SimilarityMatch[];
    catalogCount: number;
    error?: unknown;
  }> => {
    try {
      const catalogCandidates = await fetchCatalogCandidates(
        input.catalogClient,
        input.normalizedIdentification,
        { limit: 30 },
      );
      const adaptedCatalogCandidates = catalogCandidates.map(adaptCatalogCandidate);
      const matches = await findSimilarityMatches({
        normalizedIdentification: input.normalizedIdentification,
        candidates: adaptedCatalogCandidates,
        options: {
          threshold: 60,
          maxMatches: 10,
          timeoutMs: SIMILARITY_TIMEOUT_MS,
          candidateCap: 500,
        },
      });
      return { matches, catalogCount: adaptedCatalogCandidates.length };
    } catch (error) {
      return { matches: [], catalogCount: 0, error };
    }
  })();

  const result = await Promise.race([
    work,
    new Promise<'timeout'>((resolve) => {
      timeoutId = setTimeout(() => resolve('timeout'), SIMILARITY_TIMEOUT_MS);
    }),
  ]);
  if (timeoutId) clearTimeout(timeoutId);

  if (result === 'timeout') {
    console.warn('[scan-identify] similarity matcher timed out after %dms', SIMILARITY_TIMEOUT_MS);
    return { matches: [], catalogCount: 0 };
  }

  if (result.error) {
    const msg = result.error instanceof Error ? result.error.message : String(result.error);
    console.warn('[scan-identify] similarity matcher failed: %s', msg);
  }
  return { matches: result.matches, catalogCount: result.catalogCount };
}

async function captureImageModeScanIntelligence(input: {
  scanId: string;
  userId: string | null;
  identification?: Record<string, unknown>;
  attributes?: Record<string, unknown>;
  isFashion: boolean;
  commerce?: {
    provider: string;
    query: string;
    count: number;
    providersTried?: string[];
    catalogCount?: number;
  };
  recommendedProducts?: unknown[];
  appPlatform: string | null;
  appVersion: string | null;
}): Promise<void> {
  try {
    const captureResult = await Promise.race([
      captureScanIntelligence({
        scanId: input.scanId,
        userId: input.userId,
        mode: 'image',
        identification: input.identification || {},
        attributes: input.attributes,
        isFashion: input.isFashion,
        commerce: input.commerce,
        recommendedProducts: input.recommendedProducts,
        imageHash: null,
        appPlatform: input.appPlatform,
        appVersion: input.appVersion,
      }).then(() => 'captured' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), SCAN_INTELLIGENCE_TIMEOUT_MS)),
    ]);
    if (captureResult === 'timeout') {
      console.warn('[ScanIntelligence]', {
        event: 'capture_timeout',
        errorType: 'timeout',
        table: 'scan_intelligence_events',
        scanId: input.scanId,
      });
    }
  } catch (error) {
    console.warn('[ScanIntelligence]', {
      event: 'capture_timeout_or_error',
      errorType: error instanceof Error ? error.name : 'unknown',
      table: 'scan_intelligence_events',
      scanId: input.scanId,
    });
  }
}
