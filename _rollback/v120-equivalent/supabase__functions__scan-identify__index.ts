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
// Security guarantees (mirrors stylechat-generate where user data is involved):
//   - Signed-in users are verified via auth.getUser() before user-owned data work
//   - Image mode can run analysis-only for project-authenticated anon/reviewer calls
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
  type ScanCommerceResult,
} from './scanCommerceRouter.ts';
import {
  findSimilarityMatches,
  type SimilarityMatch,
} from './similarityMatcher.ts';
import { captureScanIntelligence } from './scanIntelligenceCapture.ts';
import {
  rawDetectedGarmentCount,
  sanitizeDetectedGarments,
  type SanitizedDetectedGarment,
} from './multiItemGarments.ts';
import { isQualityTuneEnabled, QUALITY_TUNE_VERSION } from './qualityTuneConfig.ts';
import { applyQualityTaxonomyTune } from './qualityTuneNormalize.ts';
import {
  buildWeightedCommerceQueries,
  filterAndDedupeProducts,
  shouldRunFallbackQuery,
  QUALITY_TUNE_MIN_VALID_PRODUCTS,
} from './qualityTuneCommerce.ts';
import {
  buildQualityTuneMetrics,
  logQualityTuneMetrics,
} from './qualityTuneTelemetry.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';

/** Appended to vision/text prompts when quality tune is enabled. Response shape unchanged. */
const QUALITY_TUNE_PROMPT_ADDENDUM = `

Quality precision rules (mandatory):
- Prioritize: category, subtype, silhouette, fit, material, pattern, dominant color, secondary color when useful, construction details, style descriptors, and visible brand evidence only.
- Prefer concise specific descriptions (e.g. "Cropped black faux-leather moto jacket", "High-waisted charcoal wide-leg trousers", "White low-profile leather sneakers").
- Avoid redundant stacked descriptors (e.g. "black dark black jacket coat outerwear").
- Do not invent unsupported attributes such as lamb leather, luxury, designer, vintage, or brand names unless a readable wordmark, logo, or label is clearly visible.
- Brand fields (visible_brand_text, brand_guess, logo_detected) must stay null/false unless high-confidence visible brand evidence exists. Never infer brand from resemblance, shape, aesthetic, color, or vibe.
- Never use generic labels such as "Fashion Item", "Clothing", "Apparel", "Unknown", or "Item" when a more specific category or subtype is visible.
- Keep the exact JSON response shape. Do not add or rename fields.
`;

// ── Constants ──────────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-scan-id, x-request-id',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Max compressed base64 payload accepted from the client (2 MB of base64 chars).
const MAX_IMAGE_BASE64_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_QUERY_LEN = 500;
const MAX_OUTPUT_TOKENS = 2048;
// Provider call timeout. Target is ~5s; a 14s hard cap absorbs cold starts / free
// tier latency without hanging. Operator-tunable via SCAN_GEMINI_TIMEOUT_MS.
const DEFAULT_GEMINI_TIMEOUT_MS = 14_000;
const SCAN_INTELLIGENCE_TIMEOUT_MS = 500;
const SIMILARITY_TIMEOUT_MS = 300;
const IMAGE_MODE_COMMERCE_TIMEOUT_MS = 3000;
const TEXT_MODE_COMMERCE_TIMEOUT_MS = 5000;
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-1.5-flash';
const DEFAULT_MIME = 'image/jpeg';
const ANON_SCAN_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const ANON_SCAN_RATE_LIMIT_MAX = 6;
const SCAN_IDENTIFY_IMAGE_DAILY_LIMIT_DEFAULT = 30;
const SCAN_IDENTIFY_TEXT_DAILY_LIMIT_DEFAULT = 50;
const PROJECT_ACCESS_CACHE_MS = 5 * 60 * 1000;

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
const NO_IMAGE_PROVIDED_MESSAGE =
  'No image provided. Please retake the photo and try again.';
const INVALID_IMAGE_MESSAGE =
  'Image payload is invalid. Please retake the photo and try again.';
const SAFE_NON_FASHION_MESSAGE =
  'This does not appear to be a fashion item. Try scanning clothing, shoes, bags, or accessories.';
const IMAGE_TOO_LARGE_MESSAGE =
  'Image too large. Please retake the photo closer or in better light.';
const SAFE_TEXT_FAILED_MESSAGE =
  "We couldn't analyze this request. Please try describing a garment, style, or outfit.";
const SAFE_TEXT_NON_FASHION_MESSAGE =
  "This doesn't appear to be a fashion query. Try describing a garment, style, or outfit.";

type AuthContext = {
  userId: string | null;
  isAuthenticated: boolean;
  hasProjectAccess: boolean;
  authError: boolean;
};

type ShoppingMeta = {
  provider: string;
  query: string;
  count: number;
  providersTried?: string[];
  catalogCount?: number;
  similarityMatches?: number;
  commerceSkipped?: boolean;
  reason?: string;
};

type AnonymousRateEntry = {
  windowStart: number;
  count: number;
};

type ProjectAccessCacheEntry = {
  valid: boolean;
  expiresAt: number;
};

const anonymousScanRateLimits = new Map<string, AnonymousRateEntry>();
const projectAccessCache = new Map<string, ProjectAccessCacheEntry>();

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

const MULTI_ITEM_IDENTIFY_PROMPT = `You are K Scan AI's multi-item fashion detection engine.

Analyze the uploaded image and identify genuinely distinct visible garments or fashion accessories.

Ignore people, faces, bodies, bystanders, mirrors, rooms, vehicles, license plates, furniture, and background clutter.

Do not identify people.
Do not infer age, race, gender identity, body type, health, religion, income, or any protected trait.

Multi-item rules:
- Return one to five distinct fashion items only.
- Preserve deterministic visual order: top-to-bottom, then left-to-right.
- This is a real-world image. Clothing may be layered, worn, partially occluded, or surrounded by background clutter.
- Return a candidate when the garment category and approximate location are visible, even when fine attributes are uncertain.
- Do not duplicate the same garment.
- Do not split one garment into artificial sub-items.
- Do not combine multiple garments into one item.
- Ignore background objects and non-fashion objects.
- Never fabricate candidates to reach a target count.
- If uncertain about a field, use null, "unknown", or [].

Return strict JSON only.
No markdown.
No commentary.

Use exactly this response shape:
{
  "status": "completed" | "non_fashion",
  "detectedGarments": [
    {
      "label": "black blazer",
      "category": "blazer",
      "subtype": "double-breasted blazer",
      "bounds": { "x": 0.12, "y": 0.08, "width": 0.76, "height": 0.54 },
      "confidenceScore": 0.86,
      "visual_observation": "Black structured blazer in the upper half of the image.",
      "item_type": "blazer",
      "primary_color": "black"
    }
  ],
  "recommendedProducts": [],
  "userMessage": "Detected multiple fashion items."
}

For non_fashion, return detectedGarments: [] and the standard non-fashion userMessage.
Bounds are normalized image coordinates from 0 to 1 and must tightly enclose the visible garment.
Keep each candidate compact. Do not return full styling analysis or shopping queries in this first pass.
Return only approved garment schema fields.`;

const MULTI_ITEM_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    status: { type: 'STRING', enum: ['completed', 'non_fashion'] },
    detectedGarments: {
      type: 'ARRAY',
      maxItems: 5,
      items: {
        type: 'OBJECT',
        properties: {
          label: { type: 'STRING' },
          category: { type: 'STRING' },
          subtype: { type: 'STRING' },
          bounds: {
            type: 'OBJECT',
            properties: {
              x: { type: 'NUMBER', minimum: 0, maximum: 1 },
              y: { type: 'NUMBER', minimum: 0, maximum: 1 },
              width: { type: 'NUMBER', minimum: 0, maximum: 1 },
              height: { type: 'NUMBER', minimum: 0, maximum: 1 },
            },
            required: ['x', 'y', 'width', 'height'],
          },
          confidenceScore: { type: 'NUMBER', minimum: 0, maximum: 1 },
          visual_observation: { type: 'STRING' },
          item_type: { type: 'STRING' },
          primary_color: { type: 'STRING' },
        },
        required: [
          'label',
          'category',
          'subtype',
          'bounds',
          'confidenceScore',
          'visual_observation',
          'item_type',
          'primary_color',
        ],
      },
    },
    recommendedProducts: { type: 'ARRAY', maxItems: 0, items: { type: 'OBJECT' } },
    userMessage: { type: 'STRING' },
  },
  required: ['status', 'detectedGarments', 'recommendedProducts', 'userMessage'],
} as const;

const SELECTED_ITEM_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    status: { type: 'STRING', enum: ['completed'] },
    attributes: {
      type: 'OBJECT',
      properties: {
        category: { type: 'STRING' },
        itemType: { type: 'STRING' },
        silhouette: { type: 'STRING' },
        colorPalette: { type: 'ARRAY', items: { type: 'STRING' }, maxItems: 4 },
        materialEstimate: { type: 'STRING' },
        pattern: { type: 'STRING' },
        confidenceScore: { type: 'NUMBER', minimum: 0, maximum: 1 },
      },
      required: ['category', 'itemType', 'colorPalette', 'confidenceScore'],
    },
    identification: {
      type: 'OBJECT',
      properties: {
        visual_observation: { type: 'STRING' },
        item_type: { type: 'STRING' },
        subtype: { type: 'STRING' },
        primary_color: { type: 'STRING' },
        pattern: { type: 'STRING' },
        material_estimate: { type: 'STRING' },
        silhouette: { type: 'STRING' },
        fit: { type: 'STRING' },
        confidence_score: { type: 'NUMBER', minimum: 0, maximum: 1 },
        non_fashion: { type: 'BOOLEAN' },
      },
      required: [
        'visual_observation',
        'item_type',
        'subtype',
        'primary_color',
        'confidence_score',
        'non_fashion',
      ],
    },
    recommendedProducts: { type: 'ARRAY', maxItems: 0, items: { type: 'OBJECT' } },
    userMessage: { type: 'STRING' },
  },
  required: ['status', 'attributes', 'identification', 'recommendedProducts', 'userMessage'],
} as const;

function buildSelectedItemPrompt(candidate: {
  candidateId: string;
  category: string;
  subtype?: string;
  bounds?: { x: number; y: number; width: number; height: number };
}): string {
  const target = JSON.stringify(candidate);
  return `You are K Scan AI's selected-garment identification engine.

The client selected this candidate from a prior detection pass: ${target}

Analyze only that garment in the original parent image.
Use its normalized bounds to locate it.
Do not switch to a larger, more central, or more recognizable garment.
Ignore the person, face, body, background, and every unselected garment.
Do not guess a brand unless clearly visible on the selected garment.

Return strict JSON only in the existing single-item response shape:
- status must be completed
- attributes must describe the selected garment
- identification must describe the selected garment
- recommendedProducts must be []
- userMessage must concisely describe the selected garment
- do not return detectedGarments

If an attribute is uncertain, use "unknown" rather than switching garments.`;
}

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
    identification: identification && typeof identification === 'object' ? identification : {},
    attributes: attributes && typeof attributes === 'object' ? attributes : {},
    recommendedProducts: [],
    products: [],
    purchaseOptions: [],
    similarityMatches: [],
    shoppingMeta: {},
    userMessage,
  };
  return out;
}

function withSafeImageArrays(
  response: Record<string, unknown>,
  options: {
    recommendedProducts?: unknown[];
    products?: unknown[];
    purchaseOptions?: unknown[];
    similarityMatches?: unknown[];
    shoppingMeta?: ShoppingMeta;
  } = {},
): Record<string, unknown> {
  const recommendedProducts = Array.isArray(options.recommendedProducts)
    ? options.recommendedProducts
    : Array.isArray(response.recommendedProducts)
    ? response.recommendedProducts
    : [];
  const similarityMatches = Array.isArray(options.similarityMatches)
    ? options.similarityMatches
    : Array.isArray(response.similarityMatches)
    ? response.similarityMatches
    : [];
  return {
    ...response,
    recommendedProducts,
    products: Array.isArray(options.products) ? options.products : similarityMatches,
    purchaseOptions: Array.isArray(options.purchaseOptions) ? options.purchaseOptions : recommendedProducts,
    similarityMatches,
    shoppingMeta: options.shoppingMeta && typeof options.shoppingMeta === 'object' ? options.shoppingMeta : {},
  };
}

function primaryGarmentResponseFields(
  garments: SanitizedDetectedGarment[],
): {
  attributes?: Record<string, unknown>;
  identification?: Record<string, unknown>;
  userMessage?: string;
} {
  const primary = garments[0];
  if (!primary) return {};
  return {
    attributes: primary.attributes,
    identification: primary.identification,
    userMessage:
      typeof primary.identification.visual_observation === 'string'
        ? primary.identification.visual_observation
        : primary.label,
  };
}

function extractBearerToken(authHeader: string | null): string {
  if (!authHeader) return '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? '';
}

function safeHeaderValue(value: string | null): string {
  return typeof value === 'string' ? value.trim() : '';
}

async function hasValidProjectAccess(
  req: Request,
  supabaseUrl: string,
  supabaseAnonKey: string,
): Promise<boolean> {
  const bearerToken = extractBearerToken(req.headers.get('Authorization'));
  const apiKey = safeHeaderValue(req.headers.get('apikey')) || safeHeaderValue(req.headers.get('x-api-key'));
  if (bearerToken === supabaseAnonKey || apiKey === supabaseAnonKey) return true;

  const candidate = apiKey || bearerToken;
  if (!candidate) return false;
  return validateProjectAccessKey(supabaseUrl, candidate);
}

async function validateProjectAccessKey(supabaseUrl: string, candidate: string): Promise<boolean> {
  const keyHash = await sha256Hex(candidate);
  const now = Date.now();
  const cached = projectAccessCache.get(keyHash);
  if (cached && cached.expiresAt > now) return cached.valid;

  let valid = false;
  try {
    const res = await fetch(`${supabaseUrl.replace(/\/$/, '')}/auth/v1/settings`, {
      method: 'GET',
      headers: { apikey: candidate },
    });
    valid = res.ok;
  } catch {
    valid = false;
  }

  projectAccessCache.set(keyHash, {
    valid,
    expiresAt: now + PROJECT_ACCESS_CACHE_MS,
  });
  return valid;
}

async function resolveAuthContext(
  req: Request,
  supabaseUrl: string,
  supabaseAnonKey: string,
): Promise<AuthContext> {
  const authHeader = req.headers.get('Authorization');
  const bearerToken = extractBearerToken(authHeader);
  const hasProjectAccess = await hasValidProjectAccess(req, supabaseUrl, supabaseAnonKey);

  if (!bearerToken || bearerToken === supabaseAnonKey) {
    return {
      userId: null,
      isAuthenticated: false,
      hasProjectAccess,
      authError: false,
    };
  }

  const userClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader ?? '' } },
  });

  const { data: { user }, error: authError } = await userClient.auth.getUser();
  return {
    userId: authError || !user ? null : user.id,
    isAuthenticated: Boolean(!authError && user),
    hasProjectAccess,
    authError: Boolean(authError || !user),
  };
}

function getClientFingerprintMaterial(req: Request): string {
  const forwardedFor = safeHeaderValue(req.headers.get('x-forwarded-for')).split(',')[0]?.trim() ?? '';
  const ip =
    forwardedFor ||
    safeHeaderValue(req.headers.get('cf-connecting-ip')) ||
    safeHeaderValue(req.headers.get('x-real-ip')) ||
    'unknown-ip';
  const userAgent = safeHeaderValue(req.headers.get('user-agent')) || 'unknown-agent';
  return `${ip}|${userAgent}`;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function getScanIdentifyDailyLimit(mode: string): number {
  const raw = readTrimmedEnv(
    mode === 'text' ? 'SCAN_IDENTIFY_TEXT_DAILY_LIMIT' : 'SCAN_IDENTIFY_IMAGE_DAILY_LIMIT',
  );
  const parsed = raw !== undefined ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : (mode === 'text' ? SCAN_IDENTIFY_TEXT_DAILY_LIMIT_DEFAULT : SCAN_IDENTIFY_IMAGE_DAILY_LIMIT_DEFAULT);
}

async function checkAuthenticatedScanQuota(
  catalogClient: unknown,
  userId: string,
  mode: string,
  logUserId: string,
): Promise<{ allowed: boolean; count: number; limit: number }> {
  if (!catalogClient) {
    console.warn(
      '[scan-identify] quota_check_error user=%s mode=%s reason=missing_service_role_client',
      logUserId,
      mode,
    );
    return { allowed: true, count: 0, limit: 0 };
  }

  const dailyLimit = getScanIdentifyDailyLimit(mode);

  try {
    const { data, error } = await (catalogClient as any).rpc('check_and_increment_scan_identify_daily_usage', {
      p_user_id: userId,
      p_mode: mode,
      p_daily_limit: dailyLimit,
    });

    if (error) throw error;

    const row = Array.isArray(data) ? data[0] : data;
    if (!row || typeof row.allowed !== 'boolean') {
      throw new Error('malformed_rpc_response');
    }

    const allowed = row.allowed;
    const count = typeof row.count === 'number' ? row.count : 0;
    const limit = typeof row.limit === 'number' ? row.limit : dailyLimit;

    return { allowed, count, limit };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[scan-identify] quota_check_error user=%s mode=%s error=%s', logUserId, mode, msg);
    return { allowed: true, count: 0, limit: 0 };
  }
}

function buildRateLimitedResponse(): Record<string, unknown> {
  return {
    status: 'rate_limited',
    identification: null,
    attributes: {},
    recommendedProducts: [],
    products: [],
    purchaseOptions: [],
    similarityMatches: [],
    shoppingMeta: {
      provider: 'rate_limited',
      query: '',
      count: 0,
      providersTried: [],
      catalogCount: 0,
      similarityMatches: 0,
      reason: 'daily_limit',
    },
    userMessage: 'Daily scan limit reached. Try again tomorrow.',
  };
}

function checkAnonymousImageRateLimit(fingerprint: string): {
  allowed: boolean;
  retryAfterSeconds: number;
  count: number;
} {
  const now = Date.now();
  if (anonymousScanRateLimits.size > 1000) {
    for (const [key, entry] of anonymousScanRateLimits.entries()) {
      if (now - entry.windowStart > ANON_SCAN_RATE_LIMIT_WINDOW_MS * 2) {
        anonymousScanRateLimits.delete(key);
      }
    }
  }

  const current = anonymousScanRateLimits.get(fingerprint);
  const entry = !current || now - current.windowStart >= ANON_SCAN_RATE_LIMIT_WINDOW_MS
    ? { windowStart: now, count: 0 }
    : current;
  entry.count += 1;
  anonymousScanRateLimits.set(fingerprint, entry);

  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((entry.windowStart + ANON_SCAN_RATE_LIMIT_WINDOW_MS - now) / 1000),
  );
  return {
    allowed: entry.count <= ANON_SCAN_RATE_LIMIT_MAX,
    retryAfterSeconds,
    count: entry.count,
  };
}

function validateImageBase64(imageBase64: string): string | undefined {
  if (imageBase64.length < 16) return 'too_short';
  if (imageBase64.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(imageBase64)) {
    return 'invalid_base64';
  }

  let prefix = '';
  try {
    const prefixLength = Math.min(imageBase64.length, 128);
    const chunk = imageBase64.slice(0, prefixLength);
    const paddedChunk = chunk.padEnd(Math.ceil(chunk.length / 4) * 4, '=');
    prefix = atob(paddedChunk);
  } catch {
    return 'invalid_base64';
  }

  const bytes = Array.from(prefix).map((ch) => ch.charCodeAt(0));
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isPng =
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a;
  const isWebp =
    prefix.slice(0, 4) === 'RIFF' &&
    prefix.slice(8, 12) === 'WEBP';

  return isJpeg || isPng || isWebp ? undefined : 'unsupported_image';
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

function safeCorrelationId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return /^[A-Za-z0-9_-]{1,80}$/.test(trimmed) ? trimmed : undefined;
}

function safeDigestPrefix(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().toLowerCase();
  return /^[a-f0-9]{8,16}$/.test(trimmed) ? trimmed : undefined;
}

function safeCandidateLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return /^[A-Za-z0-9 /&+.'-]{1,80}$/.test(trimmed) ? trimmed : undefined;
}

function sanitizeSelectedCandidate(value: unknown): {
  candidateId: string;
  category: string;
  subtype?: string;
  bounds?: { x: number; y: number; width: number; height: number };
} | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const src = value as Record<string, unknown>;
  const candidateId = safeCorrelationId(src.candidateId);
  const category = safeCandidateLabel(src.category);
  if (!candidateId || !category) return undefined;

  const subtype = safeCandidateLabel(src.subtype);
  let bounds: { x: number; y: number; width: number; height: number } | undefined;
  if (src.bounds && typeof src.bounds === 'object' && !Array.isArray(src.bounds)) {
    const raw = src.bounds as Record<string, unknown>;
    const x = Number(raw.x);
    const y = Number(raw.y);
    const width = Number(raw.width);
    const height = Number(raw.height);
    if ([x, y, width, height].every(Number.isFinite)) {
      const safeX = Math.max(0, Math.min(1, x));
      const safeY = Math.max(0, Math.min(1, y));
      bounds = {
        x: safeX,
        y: safeY,
        width: Math.max(0.01, Math.min(1 - safeX, width)),
        height: Math.max(0.01, Math.min(1 - safeY, height)),
      };
    }
  }

  return { candidateId, category, ...(subtype ? { subtype } : {}), ...(bounds ? { bounds } : {}) };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  // ── 1. Verify authenticated user from JWT ────────────────────────────────────
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!supabaseUrl || !supabaseAnonKey) {
    console.error('[scan-identify] Supabase function env is not configured');
    return json({ error: 'Server configuration error' }, 500);
  }

  // ── Service-role client for catalog retrieval (safe, no public RLS read) ──
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
    multiItemDetection?: unknown;
    requestMode?: unknown;
    scanSessionId?: unknown;
    imageDigestPrefix?: unknown;
    selectedCandidate?: unknown;
    scanId?: unknown;
    scan_id?: unknown;
    id?: unknown;
  } = {};
  try {
    body = await req.json();
  } catch {
    return json({ ...normalized('failed', INVALID_IMAGE_MESSAGE), error: 'Invalid JSON' }, 400);
  }

  const mode = typeof body.mode === 'string' ? body.mode.toLowerCase() : 'image';
  const source = safeString(body.source) ?? 'unknown';
  const multiItemRequested = body.multiItemDetection === true;
  const multiItemEnabled =
    Deno.env.get('SCAN_MULTI_ITEM_ENABLED')?.trim().toLowerCase() === 'true';
  const useMultiItemProvider =
    mode === 'image' &&
    multiItemEnabled &&
    multiItemRequested;
  const requestMode = body.requestMode === 'selected_item'
    ? 'selected_item'
    : body.requestMode === 'multi_item_detection'
    ? 'multi_item_detection'
    : 'legacy_single_item';
  const selectedCandidate = sanitizeSelectedCandidate(body.selectedCandidate);
  const useSelectedItemProvider =
    useMultiItemProvider &&
    requestMode === 'selected_item' &&
    Boolean(selectedCandidate);
  const useMultiItemDetectionProvider =
    useMultiItemProvider && requestMode !== 'selected_item';
  const scanSessionId = safeCorrelationId(body.scanSessionId) ?? crypto.randomUUID();
  const suppliedImageDigestPrefix = safeDigestPrefix(body.imageDigestPrefix);
  const appPlatform = typeof body.appPlatform === 'string' && body.appPlatform.trim()
    ? body.appPlatform.trim()
    : null;
  const appVersion = typeof body.appVersion === 'string' && body.appVersion.trim()
    ? body.appVersion.trim()
    : null;
  let imageBase64 = '';
  let textQuery = '';
  let imageDigestPrefix = '';

  const requestScanId = typeof body.scanId === 'string' && body.scanId.trim()
    ? body.scanId.trim()
    : typeof body.scan_id === 'string' && body.scan_id.trim()
    ? body.scan_id.trim()
    : typeof body.id === 'string' && body.id.trim()
    ? body.id.trim()
    : req.headers.get('x-scan-id') || req.headers.get('x-request-id') || crypto.randomUUID();
  const scanId = mode === 'image' ? crypto.randomUUID() : requestScanId;

  const auth = await resolveAuthContext(req, supabaseUrl, supabaseAnonKey);
  const userId = auth.userId;
  const isAnonymousImageAnalysis = mode !== 'text' && !auth.isAuthenticated;
  const logUserId = userId ? userId.slice(0, 8) : 'anon';

  console.log(
    '[scan-identify] request_start mode=%s source=%s auth=%s uid=%s projectAccess=%s',
    mode,
    source,
    auth.isAuthenticated ? 'authenticated' : 'anonymous',
    logUserId,
    String(auth.hasProjectAccess),
  );

  if (useMultiItemProvider && requestMode === 'selected_item' && !selectedCandidate) {
    console.warn(
      '[scan-identify] selected_item_invalid scanSessionId=%s requestMode=%s',
      scanSessionId,
      requestMode,
    );
    return json(normalized('failed', 'The selected garment could not be analyzed. Please return to the outfit and select it again.'), 200);
  }
  console.log(
    '[scan-identify] multi_item_env_gate enabled=%s',
    String(multiItemEnabled),
  );
  console.log(
    '[scan-identify] multi_item_request requested=%s enabled=%s',
    String(multiItemRequested),
    String(useMultiItemProvider),
  );

  if (mode === 'text' && !auth.isAuthenticated) {
    return json({ error: 'Not authenticated' }, 401);
  }

  if (isAnonymousImageAnalysis && !auth.hasProjectAccess) {
    return json(
      {
        ...normalized('failed', SAFE_FAILED_MESSAGE),
        error: 'Not authenticated',
      },
      401,
    );
  }

  if (isAnonymousImageAnalysis && auth.authError) {
    console.warn('[scan-identify] image_auth_fallback_to_analysis_only reason=user_jwt_unverified');
  }

  const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const catalogClient = auth.isAuthenticated && supabaseUrl && supabaseServiceRoleKey
    ? createClient(supabaseUrl, supabaseServiceRoleKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      })
    : null;
  if (auth.isAuthenticated && !catalogClient) {
    console.log('[scan-identify] catalog_client_not_available');
  }

  let anonymousFingerprint = '';

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
      return json(normalized('failed', NO_IMAGE_PROVIDED_MESSAGE), 200);
    }
    if (imageBase64.length > MAX_IMAGE_BASE64_BYTES) {
      console.warn('[scan-identify] image_too_large bytes=%d', imageBase64.length);
      return json(normalized('failed', IMAGE_TOO_LARGE_MESSAGE), 200);
    }
    const imageValidation = validateImageBase64(imageBase64);
    if (imageValidation) {
      console.warn('[scan-identify] invalid_image_payload reason=%s', imageValidation);
      return json(normalized('failed', INVALID_IMAGE_MESSAGE), 200);
    }

    imageDigestPrefix = (await sha256Hex(imageBase64)).slice(0, 12);
    if (
      useSelectedItemProvider &&
      (!suppliedImageDigestPrefix || suppliedImageDigestPrefix !== imageDigestPrefix)
    ) {
      console.warn(
        '[scan-identify] selected_item_image_mismatch scanSessionId=%s candidateId=%s requestMode=%s imageDigest=%s',
        scanSessionId,
        selectedCandidate?.candidateId ?? 'none',
        requestMode,
        imageDigestPrefix,
      );
      return json(normalized('failed', 'The original outfit image is no longer available. Please start a new scan.'), 200);
    }

    console.log(
      '[scan-identify] correlation scanSessionId=%s candidateId=%s requestMode=%s imageDigest=%s',
      scanSessionId,
      selectedCandidate?.candidateId ?? 'none',
      useSelectedItemProvider
        ? 'selected_item'
        : useMultiItemDetectionProvider
        ? 'multi_item_detection'
        : 'legacy_single_item',
      imageDigestPrefix,
    );

    if (isAnonymousImageAnalysis) {
      anonymousFingerprint = await sha256Hex(getClientFingerprintMaterial(req));
      const rateLimit = checkAnonymousImageRateLimit(anonymousFingerprint);
      console.log(
        '[scan-identify] anonymous_image_attempt fingerprint=%s count=%d allowed=%s',
        anonymousFingerprint.slice(0, 12),
        rateLimit.count,
        String(rateLimit.allowed),
      );
      if (!rateLimit.allowed) {
        return json(
          {
            ...normalized('failed', 'Scan limit reached. Please try again later.'),
            retryAfterSeconds: rateLimit.retryAfterSeconds,
          },
          429,
        );
      }
    }
  }

  // ── 2b. Authenticated per-user daily quota check ─────────────────────────────
  // Checked after mode/body validation and before any AI/commerce call.
  // Quota failures return an HTTP 200 app-safe body so mobile clients treat it
  // as a normal outcome rather than a network/system error.
  // DB or configuration errors fail open so a quota rollout issue cannot
  // break all scans.

  if (auth.isAuthenticated && userId) {
    const quota = await checkAuthenticatedScanQuota(catalogClient, userId, mode, logUserId);
    if (!quota.allowed) {
      console.log(
        '[scan-identify] quota_rate_limited user=%s mode=%s count=%d limit=%d',
        logUserId,
        mode,
        quota.count,
        quota.limit,
      );
      return json(buildRateLimitedResponse(), 200);
    }
    console.log(
      '[scan-identify] quota_allowed user=%s mode=%s count=%d limit=%d',
      logUserId,
      mode,
      quota.count,
      quota.limit,
    );
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
    return json(
      {
        ...normalized('failed', mode === 'text' ? SAFE_TEXT_FAILED_MESSAGE : SAFE_FAILED_MESSAGE),
        error: 'AI provider not configured',
      },
      500,
    );
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

  const qualityTuneEnabled = isQualityTuneEnabled();
  const identifyPrompt = qualityTuneEnabled
    ? `${IDENTIFY_PROMPT}${QUALITY_TUNE_PROMPT_ADDENDUM}`
    : IDENTIFY_PROMPT;
  const multiItemPrompt = qualityTuneEnabled
    ? `${MULTI_ITEM_IDENTIFY_PROMPT}${QUALITY_TUNE_PROMPT_ADDENDUM}`
    : MULTI_ITEM_IDENTIFY_PROMPT;
  const textIdentifyPrompt = qualityTuneEnabled
    ? `${TEXT_IDENTIFY_PROMPT}${QUALITY_TUNE_PROMPT_ADDENDUM}`
    : TEXT_IDENTIFY_PROMPT;

  const geminiBody = mode === 'text'
    ? {
        contents: [
          {
            role: 'user',
            parts: [
              { text: textIdentifyPrompt },
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
              {
                text: useSelectedItemProvider && selectedCandidate
                  ? (qualityTuneEnabled
                    ? `${buildSelectedItemPrompt(selectedCandidate)}${QUALITY_TUNE_PROMPT_ADDENDUM}`
                    : buildSelectedItemPrompt(selectedCandidate))
                  : useMultiItemDetectionProvider
                  ? multiItemPrompt
                  : identifyPrompt,
              },
              { inline_data: { mime_type: DEFAULT_MIME, data: imageBase64 } },
            ],
          },
        ],
        generationConfig: {
          temperature: useMultiItemDetectionProvider || useSelectedItemProvider ? 0 : 0.2,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          responseMimeType: 'application/json',
          ...(useMultiItemDetectionProvider
            ? { responseSchema: MULTI_ITEM_RESPONSE_SCHEMA }
            : useSelectedItemProvider
            ? { responseSchema: SELECTED_ITEM_RESPONSE_SCHEMA }
            : {}),
        },
      };

  console.log(
    '[scan-identify] gemini_start timeoutMs=%d model=%s mode=%s source=%s',
    timeoutMs,
    modelName,
    mode,
    source,
  );
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
        logUserId,
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
      console.log(
        '[scan-identify] final_status status=failed elapsedMs=%d mode=%s source=%s',
        elapsedMs,
        mode,
        source,
      );
      return json(normalized('failed', safeFailed), 200);
    }

    console.log(
      '[scan-identify] gemini_success elapsedMs=%d mode=%s source=%s',
      elapsedMs,
      mode,
      source,
    );

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
      console.log(
        '[scan-identify] final_status status=failed elapsedMs=%d mode=%s source=%s',
        elapsedMs,
        mode,
        source,
      );
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
      console.log(
        '[scan-identify] final_status status=failed elapsedMs=%d mode=%s source=%s',
        elapsedMs,
        mode,
        source,
      );
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
      console.log(
        '[scan-identify] final_status status=failed elapsedMs=%d mode=%s source=%s',
        elapsedMs,
        mode,
        source,
      );
      return json(normalized('failed', safeFailed), 200);
    }

    console.log(
      '[scan-identify] parse_success elapsedMs=%d mode=%s source=%s',
      elapsedMs,
      mode,
      source,
    );

    const rawStatus = typeof parsed.status === 'string' ? parsed.status.toLowerCase() : '';
    const detectedGarments = useMultiItemDetectionProvider
      ? sanitizeDetectedGarments(parsed.detectedGarments)
      : [];
    const rawGarmentCount = useMultiItemDetectionProvider
      ? rawDetectedGarmentCount(parsed.detectedGarments)
      : 0;
    if (useMultiItemDetectionProvider) {
      console.log('[scan-identify] multi_item_provider_count count=%d', rawGarmentCount);
      console.log('[scan-identify] multi_item_validated_count count=%d', detectedGarments.length);
      console.log(
        '[scan-identify] multi_item_dropped_count count=%d',
        Math.max(0, rawGarmentCount - detectedGarments.length),
      );
    }
    const primaryGarmentFields = useMultiItemDetectionProvider
      ? primaryGarmentResponseFields(detectedGarments)
      : {};

    if (useMultiItemDetectionProvider && rawStatus === 'completed' && detectedGarments.length === 0) {
      console.warn('[scan-identify] multi_item_no_valid_garments mode=%s source=%s elapsedMs=%d', mode, source, elapsedMs);
      console.log('[scan-identify] multi_item_response_count count=0');
      const failureAudit = buildAuditEvent(
        { status: 'failed' },
        null,
        [],
        elapsedMs,
        scanId,
      );
      failureAudit.error_reason = 'multi_item_no_valid_garments';
      logScanIdentificationAudit(failureAudit);
      console.log(
        '[scan-identify] final_status status=failed elapsedMs=%d mode=%s source=%s',
        elapsedMs,
        mode,
        source,
      );
      return json(normalized('failed', safeFailed), 200);
    }

    // Try the new rich identification shape first.
    let identification = sanitizeIdentification(primaryGarmentFields.identification ?? parsed.identification);
    let attributes: Record<string, unknown> | undefined;
    if (useMultiItemDetectionProvider && primaryGarmentFields.attributes) {
      attributes = primaryGarmentFields.attributes;
    } else if (identification) {
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

    // Quality-tune: deterministic taxonomy normalization + generic recovery.
    // Flag OFF preserves exact v119-equivalent path (this block skipped).
    let qualityNormCorrectionCount = 0;
    let qualityNormRuleIds: string[] = [];
    let qualityGenericLabelOccurrence = 0;
    let qualityInvalidPairsResolved = 0;
    if (qualityTuneEnabled && rawStatus === 'completed') {
      if (useMultiItemDetectionProvider && detectedGarments.length > 0) {
        for (let i = 0; i < detectedGarments.length; i++) {
          const g = detectedGarments[i];
          const tuned = applyQualityTaxonomyTune(
            g.identification as Record<string, unknown>,
            g.attributes as Record<string, unknown>,
          );
          g.identification = tuned.identification;
          if (tuned.attributes) g.attributes = tuned.attributes;
          if (typeof tuned.identification.item_type === 'string' && tuned.identification.item_type) {
            g.category = String(tuned.identification.item_type);
            g.label = typeof tuned.identification.subtype === 'string' && tuned.identification.subtype
              ? String(tuned.identification.subtype)
              : g.category;
          }
          if (typeof tuned.identification.subtype === 'string') {
            g.subtype = String(tuned.identification.subtype);
          }
          qualityNormCorrectionCount += tuned.correctionCount;
          qualityNormRuleIds.push(...tuned.ruleIds);
          qualityGenericLabelOccurrence += tuned.genericLabelOccurrence;
          qualityInvalidPairsResolved += tuned.invalidPairResolved;
        }
        const primaryTuned = primaryGarmentResponseFields(detectedGarments);
        identification = sanitizeIdentification(primaryTuned.identification) ?? identification;
        attributes = (primaryTuned.attributes as Record<string, unknown> | undefined) ?? attributes;
      } else if (identification || attributes) {
        const tuned = applyQualityTaxonomyTune(
          (identification ?? {}) as Record<string, unknown>,
          attributes as Record<string, unknown> | undefined,
        );
        identification = sanitizeIdentification(tuned.identification) ?? identification;
        if (tuned.attributes) attributes = tuned.attributes;
        qualityNormCorrectionCount = tuned.correctionCount;
        qualityNormRuleIds = tuned.ruleIds;
        qualityGenericLabelOccurrence = tuned.genericLabelOccurrence;
        qualityInvalidPairsResolved = tuned.invalidPairResolved;
      }
    }

    // Non-fashion (explicit, or completed with no usable attributes).
    if (rawStatus.includes('non') || (!attributes && rawStatus !== 'completed')) {
      const msg = safeStringMessage(parsed.userMessage) ?? safeNonFashion;
      console.log('[scan-identify] ok uid=%s mode=%s source=%s status=non_fashion elapsedMs=%d', logUserId, mode, source, elapsedMs);
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
      const finalResponse = withSafeImageArrays(
        {
          ...nonFashionResponseWithAttributes,
          ...(mode === 'image' ? { scanId, scanSessionId, imageDigestPrefix } : {}),
          ...(useMultiItemDetectionProvider ? { detectedGarments: [] } : {}),
          displayResult: buildDisplayResult(nonFashionResponseWithAttributes.identification as Record<string, unknown> | undefined, 0.95),
        },
        {
          recommendedProducts: [],
          products: [],
          purchaseOptions: [],
          similarityMatches: [],
          shoppingMeta: {
            provider: isAnonymousImageAnalysis ? 'anonymous_analysis_only' : 'none',
            query: '',
            count: 0,
            providersTried: [],
            catalogCount: 0,
            similarityMatches: 0,
            commerceSkipped: isAnonymousImageAnalysis,
            reason: isAnonymousImageAnalysis ? 'anonymous_non_fashion' : 'non_fashion',
          },
        },
      );
      if (mode === 'image' && auth.isAuthenticated) {
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
      if (isAnonymousImageAnalysis) {
        console.log(
          '[scan-identify] anonymous_image_result fingerprint=%s status=non_fashion elapsedMs=%d',
          anonymousFingerprint.slice(0, 12),
          elapsedMs,
        );
      } else {
        const auditEvent = buildAuditEvent(
          finalResponse,
          nonFashionNormalizedId,
          [],
          elapsedMs,
          scanId,
        );
        logScanIdentificationAudit(auditEvent);
      }
      console.log(
        '[scan-identify] final_status status=non_fashion elapsedMs=%d mode=%s source=%s',
        elapsedMs,
        mode,
        source,
      );
      if (useMultiItemDetectionProvider) {
        console.log('[scan-identify] multi_item_response_count count=0');
      }
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
      console.log(
        '[scan-identify] final_status status=failed elapsedMs=%d mode=%s source=%s',
        elapsedMs,
        mode,
        source,
      );
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
      logUserId,
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
    //   - Image (camera) mode: live commerce router first, then catalog
    //     similarity scoring. Live commerce is bounded by a 3s timeout so that
    //     a slow provider cannot block the similarity shelf.
    let finalRecommendedProducts: RankedScanProduct[];
    let finalSimilarityMatches: SimilarityMatch[] = [];
    let rankedProductsForAudit: RankedScanProduct[];
    let shoppingMeta: ShoppingMeta | undefined;

    if (mode === 'text') {
      const weightedText = qualityTuneEnabled
        ? buildWeightedCommerceQueries({
          identification: (identification ?? {}) as Record<string, unknown>,
          attributes: attributes as Record<string, unknown> | undefined,
          searchQueries: Array.isArray(identification?.search_queries)
            ? (identification?.search_queries as string[])
            : undefined,
          originalText: textQuery,
        })
        : null;
      const shoppingQuery = weightedText
        ? weightedText.primary
        : buildShoppingQuery({
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
      console.log('[scan-identify] commerce_started mode=%s source=%s', mode, source);
      const shopping = await Promise.race([
        getShoppingResults({ query: shoppingQuery, limit: 8 }).catch((err) => {
          console.warn('[scan-identify] text commerce provider error:', err);
          return { provider: 'error', products: [], query: shoppingQuery } as unknown as Awaited<
            ReturnType<typeof getShoppingResults>
          >;
        }),
        new Promise<'text_commerce_timeout'>((resolve) => {
          setTimeout(() => resolve('text_commerce_timeout'), TEXT_MODE_COMMERCE_TIMEOUT_MS);
        }),
      ]);

      if (shopping === 'text_commerce_timeout') {
        console.warn(
          '[scan-identify] commerce_timeout timeoutMs=%d mode=%s source=%s',
          TEXT_MODE_COMMERCE_TIMEOUT_MS,
          mode,
          source,
        );
        finalRecommendedProducts = [];
        shoppingMeta = {
          provider: 'timeout',
          query: shoppingQuery,
          count: 0,
          reason: 'text_commerce_timeout',
        };
      } else {
        let textProducts = shopping.products;
        if (qualityTuneEnabled && weightedText) {
          const filtered = filterAndDedupeProducts(
            textProducts,
            (identification ?? {}) as Record<string, unknown>,
          );
          textProducts = filtered.products;
          if (
            shouldRunFallbackQuery(textProducts.length, QUALITY_TUNE_MIN_VALID_PRODUCTS) &&
            weightedText.fallback &&
            weightedText.fallback !== shoppingQuery
          ) {
            const fallbackShopping = await getShoppingResults({
              query: weightedText.fallback,
              limit: 8,
            }).catch(() => ({ products: [] as typeof textProducts, provider: 'error', query: weightedText.fallback }));
            const fallbackFiltered = filterAndDedupeProducts(
              fallbackShopping.products,
              (identification ?? {}) as Record<string, unknown>,
            );
            if (fallbackFiltered.products.length > textProducts.length) {
              textProducts = fallbackFiltered.products;
            }
          }
        }
        finalRecommendedProducts = textProducts.slice(0, 8).map((p) => ({
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
        shoppingMeta = {
          provider: shopping.provider,
          query: shopping.query,
          count: finalRecommendedProducts.length,
        };
      }
      rankedProductsForAudit = finalRecommendedProducts;
    } else if (useMultiItemDetectionProvider) {
      console.log(
        '[scan-identify] commerce_skipped reason=multi_item_detection_only mode=%s source=%s',
        mode,
        source,
      );
      finalRecommendedProducts = [];
      finalSimilarityMatches = [];
      rankedProductsForAudit = [];
      shoppingMeta = {
        provider: 'none',
        query: '',
        count: 0,
        providersTried: [],
        catalogCount: 0,
        similarityMatches: 0,
        commerceSkipped: true,
        reason: 'multi_item_detection_only',
      };
    } else if (isAnonymousImageAnalysis) {
      console.log(
        '[scan-identify] commerce_skipped reason=anonymous_image_analysis mode=%s source=%s',
        mode,
        source,
      );
      console.log(
        '[scan-identify] similarity_skipped reason=anonymous_image_analysis mode=%s source=%s',
        mode,
        source,
      );
      finalRecommendedProducts = [];
      finalSimilarityMatches = [];
      rankedProductsForAudit = [];
      shoppingMeta = {
        provider: 'anonymous_analysis_only',
        query: '',
        count: 0,
        providersTried: [],
        catalogCount: 0,
        similarityMatches: 0,
        commerceSkipped: true,
        reason: 'anonymous_image_analysis',
      };
    } else {
      // Image (camera) mode: live commerce first, then deterministic catalog
      // similarity scoring. The similarity matcher runs non-blocking and is
      // allowed to return fewer than 2 matches; the UI hides the section then.
      // Live commerce is capped at IMAGE_MODE_COMMERCE_TIMEOUT_MS so a slow
      // provider cannot block the Similar Items shelf.
      console.log('[scan-identify] commerce_started mode=%s source=%s', mode, source);
      const commerce = await Promise.race([
        getScanCommerceResults({
          mode: 'image',
          identification: (completedResponseWithAttributes.identification as Record<string, unknown> | undefined) ||
            {},
          attributes: completedResponseWithAttributes.attributes as Record<string, unknown> | undefined,
          searchQueries: Array.isArray(completedNormalizedId?.normalizedSearchQueries)
            ? completedNormalizedId.normalizedSearchQueries
            : undefined,
          limit: 10,
        }).catch((err) => {
          console.warn('[scan-identify] image commerce provider error:', err);
          return {
            provider: 'error',
            providersTried: [],
            query: '',
            products: [],
            count: 0,
          } as unknown as ScanCommerceResult;
        }),
        new Promise<'commerce_timeout'>((resolve) => {
          setTimeout(() => resolve('commerce_timeout'), IMAGE_MODE_COMMERCE_TIMEOUT_MS);
        }),
      ]);

      let liveProducts: RankedScanProduct[] = [];
      let commerceProvider = 'none';
      let providersTried: string[] = [];
      let commerceQuery = '';

      if (commerce === 'commerce_timeout') {
        console.warn(
          '[scan-identify] commerce_timeout timeoutMs=%d mode=%s source=%s',
          IMAGE_MODE_COMMERCE_TIMEOUT_MS,
          mode,
          source,
        );
      } else {
        liveProducts = commerce.products.map((p) => ({
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
        })) as RankedScanProduct[];
        commerceProvider = commerce.provider;
        providersTried = commerce.providersTried;
        commerceQuery = commerce.query;
      }

      finalRecommendedProducts = liveProducts.slice(0, 10);

      // Score catalog candidates separately after live commerce. Timeout/error
      // returns [] so Similar Items hides without suppressing purchase options.
      const similarity = await buildImageSimilarityMatches({
        catalogClient,
        normalizedIdentification: completedNormalizedId,
        mode,
        source,
      });
      finalSimilarityMatches = similarity.matches;

      rankedProductsForAudit = finalSimilarityMatches as RankedScanProduct[];
      shoppingMeta = {
        provider: commerceProvider,
        providersTried,
        query: commerceQuery,
        count: liveProducts.length,
        catalogCount: similarity.catalogCount,
        similarityMatches: finalSimilarityMatches.length,
      };
    }

    const finalResponse = withSafeImageArrays(
      {
        ...completedResponseWithAttributes,
        ...(mode === 'image' ? { scanId, scanSessionId, imageDigestPrefix } : {}),
        ...(mode === 'text' && shoppingMeta ? { shopping: shoppingMeta } : {}),
        ...(mode === 'image' && shoppingMeta ? { commerce: shoppingMeta } : {}),
        ...(useMultiItemDetectionProvider ? { detectedGarments } : {}),
        displayResult: buildDisplayResult(
          completedResponseWithAttributes.identification as Record<string, unknown> | undefined,
          typeof (completedResponseWithAttributes.identification as Record<string, unknown> | undefined)?.confidence_score === 'number'
            ? ((completedResponseWithAttributes.identification as Record<string, unknown>).confidence_score as number)
            : undefined,
        ),
      },
      {
        recommendedProducts: finalRecommendedProducts,
        products: mode === 'image' ? finalSimilarityMatches : finalRecommendedProducts,
        purchaseOptions: finalRecommendedProducts,
        similarityMatches: mode === 'image' ? finalSimilarityMatches : [],
        shoppingMeta,
      },
    );
    if (mode === 'image' && auth.isAuthenticated) {
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
    if (isAnonymousImageAnalysis) {
      console.log(
        '[scan-identify] anonymous_image_result fingerprint=%s status=completed elapsedMs=%d',
        anonymousFingerprint.slice(0, 12),
        elapsedMs,
      );
    } else {
      const auditEvent = buildAuditEvent(
        finalResponse,
        completedNormalizedId,
        rankedProductsForAudit,
        elapsedMs,
        scanId,
      );
      logScanIdentificationAudit(auditEvent);
    }
    console.log(
      '[scan-identify] final_status status=completed elapsedMs=%d mode=%s source=%s',
      elapsedMs,
      mode,
      source,
    );
    if (useMultiItemDetectionProvider) {
      console.log('[scan-identify] multi_item_response_count count=%d', detectedGarments.length);
    }
    if (qualityTuneEnabled) {
      const commerceQt = (shoppingMeta as Record<string, unknown> | undefined);
      void commerceQt;
      logQualityTuneMetrics(buildQualityTuneMetrics({
        enabled: true,
        requestMode: useMultiItemDetectionProvider
          ? 'multi_item_detection'
          : useSelectedItemProvider
          ? 'selected_item'
          : mode === 'text'
          ? 'text'
          : 'legacy_single_item',
        totalDurationMs: elapsedMs,
        providerOutcome: typeof shoppingMeta?.provider === 'string' ? shoppingMeta.provider : null,
        candidateCount: useMultiItemDetectionProvider ? detectedGarments.length : 1,
        genericLabelOccurrence: qualityGenericLabelOccurrence,
        normalizationCorrectionCount: qualityNormCorrectionCount,
        normalizationRuleIds: qualityNormRuleIds,
        primaryCommerceResultCount: typeof shoppingMeta?.count === 'number' ? shoppingMeta.count : finalRecommendedProducts.length,
        fallbackQueryUsage: false,
        productsBeforeDedupe: finalRecommendedProducts.length,
        productsAfterDedupe: finalRecommendedProducts.length,
        categoryMismatchRemovals: qualityInvalidPairsResolved,
        emptyResultOccurrence: finalRecommendedProducts.length === 0 ? 1 : 0,
        errorCategory: null,
      }));
      console.log(
        '[scan-identify] quality_tune_version=%s enabled=true',
        QUALITY_TUNE_VERSION,
      );
    }
    return json(finalResponse, 200);
  } catch (err) {
    const isTimeout =
      (err instanceof DOMException && err.name === 'AbortError') ||
      (err && typeof err === 'object' && (err as Error).name === 'AbortError');
    const elapsedMs = Date.now() - startedAt;
    if (isTimeout) {
      console.warn(
        '[scan-identify] gemini_timeout elapsedMs=%d timeoutMs=%d mode=%s source=%s',
        elapsedMs,
        timeoutMs,
        mode,
        source,
      );
    } else {
      console.warn(
        '[scan-identify] gemini_error elapsedMs=%d mode=%s source=%s error=%s',
        elapsedMs,
        mode,
        source,
        err instanceof Error ? err.name : String(err),
      );
    }
    const failureAudit = buildAuditEvent(
      { status: 'failed' },
      null,
      [],
      elapsedMs,
      scanId,
    );
    failureAudit.error_reason = isTimeout ? 'timeout' : 'exception';
    logScanIdentificationAudit(failureAudit);
    console.log(
      '[scan-identify] final_status status=failed elapsedMs=%d mode=%s source=%s',
      elapsedMs,
      mode,
      source,
    );
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
  mode?: string;
  source?: string;
}): Promise<{ matches: SimilarityMatch[]; catalogCount: number }> {
  if (!input.normalizedIdentification) {
    console.log(
      '[scan-identify] similarity_skipped reason=no_identification mode=%s source=%s',
      input.mode,
      input.source,
    );
    return { matches: [], catalogCount: 0 };
  }

  console.log(
    '[scan-identify] similarity_started mode=%s source=%s',
    input.mode,
    input.source,
  );

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
    console.warn(
      '[scan-identify] similarity_timeout timeoutMs=%d mode=%s source=%s',
      SIMILARITY_TIMEOUT_MS,
      input.mode,
      input.source,
    );
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
