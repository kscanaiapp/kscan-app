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
// Model routing: allowlist-bound via _shared/llmModelRouting.ts. Scanner runs
// gemini-3.6-flash with one gemini-3.5-flash-lite fallback; TextScan is pinned
// to gemini-3.5-flash-lite with one same-model retry and never escalates.
// SCAN_GEMINI_MODEL / SCAN_GEMINI_FALLBACK_MODEL may only select an already
// approved model; the generic GEMINI_MODEL variable cannot influence routing.

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
  getFastCommerceResults,
  enrichCommerceOffers,
  type ScanCommerceResult,
} from './scanCommerceRouter.ts';
// Phase 2B.1 activation. Explicit `.ts` specifiers (Deno requirement) also put
// both modules into the governed scan-identify dependency closure, so the
// manifest/parity gate covers them from here on.
import {
  buildTechnicalFailureResultV2,
  buildTransitionalResponse,
  buildV2Telemetry,
  findJsonUnsafePath,
  resolveCommerceDecision,
  routeScanIdentifyRequest,
  validateFashionIdentificationResultV2,
  type InternalScanRequest,
  type V2Telemetry,
} from './v2Activation.ts';
import {
  normalizeToV2,
  shouldCaptureScanArtifacts,
  type FashionIdentificationResultV2,
} from '../_shared/fashionIdentificationV2.ts';
import {
  findSimilarityMatches,
  type SimilarityMatch,
} from './similarityMatcher.ts';
import { captureScanIntelligence } from './scanIntelligenceCapture.ts';
import { assertAccountActiveIfAuthenticated } from '../_shared/deletion/assertAccountActiveIfAuthenticated.ts';
import {
  classifyProviderHttpFailure,
  isRetryableProviderFailure,
  nextAttemptModel,
  resolveRetryDelayMs,
  resolveRoutePlan,
  type ProviderFailureKind,
} from '../_shared/llmModelRouting.ts';
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
import {
  isScannerIntelligenceEnabled,
  SCANNER_INTELLIGENCE_VERSION,
} from './scannerIntelligenceConfig.ts';
import {
  isCommerceRelevanceEnabled,
  COMMERCE_RELEVANCE_VERSION,
} from './commerceRelevanceConfig.ts';
import {
  isCommerceIdentityEnabled,
  COMMERCE_IDENTITY_VERSION,
} from './commerceIdentityConfig.ts';
import {
  isCommerceRetrievalEnabled,
  COMMERCE_RETRIEVAL_VERSION,
} from './commerceRetrievalConfig.ts';
import {
  isCommerceFunnelEnabled,
  COMMERCE_FUNNEL_VERSION,
} from './commerceFunnelConfig.ts';
import { buildCanonicalCommerce } from './canonicalCommerce.ts';
import {
  mapFastCommerceFailureReason,
  mapToFailureReason,
} from './commerceRelevanceFailure.ts';
import {
  isTextScanCommerceParityEnabled,
  TEXTSCAN_COMMERCE_PARITY_VERSION,
} from './textScanCommerceParityConfig.ts';
import {
  captureCommerceOutcome as persistCommerceOutcomeRow,
  captureCommerceOutcomeNonBlocking,
} from './commerceOutcomeCapture.ts';
import {
  buildRoutedIdentifyPrompt,
  resolveScannerCategoryRoute,
  type ScannerCategoryRoute,
} from './scannerCategoryRoute.ts';
import {
  applyScannerQualityGate,
  type QualityGateResult,
} from './scannerQualityGate.ts';
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
const DEFAULT_MIME = 'image/jpeg';
const ANON_SCAN_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const ANON_SCAN_RATE_LIMIT_MAX = 6;
// MODE B (commerce-only) has no bearer-token requirement at all — verify_jwt
// is off for this function and an attacker can simply omit the Authorization
// header, so gating by auth state would not bound anything. This is the same
// IP+UA fingerprint authority the anonymous image path already uses, applied
// uniformly regardless of auth state, so it is the actual spend boundary
// rather than a check an attacker can route around. The window matches the
// image-scan limiter; the max is higher because one legitimate scan issues
// roughly 2-3 MODE B calls (discovery, optional enrichment, an occasional
// user retry) against potentially several scans in one session.
const COMMERCE_ONLY_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const COMMERCE_ONLY_RATE_LIMIT_MAX = 40;
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

/**
 * v124 commerce-identity evidence keys. Additive and gated: when the identity
 * flag is off these are dropped exactly as any unknown key was before, so the
 * sanitized identification is byte-identical to v123.
 */
const IDENTIFICATION_IDENTITY_STRING_KEYS = [
  'brand_confidence',
  'exact_item_hypothesis',
  'exact_match_confidence',
] as const;

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
  /**
   * True when the verified Supabase user is an anonymous identity
   * (auth.signInAnonymously()), read directly off the already-fetched
   * getUser() result — no extra network call. Distinct from isAuthenticated:
   * an anonymous identity IS an authenticated session (it has a valid,
   * verifiable JWT and its own auth.uid()), it is just not a K Scan AI
   * account eligible to spend paid-AI budget. See isEligiblePaidAIActor().
   */
  isAnonymous: boolean;
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
  /** v127: commerce was deferred to a follow-up commerce-only (MODE B) request. */
  deferred?: boolean;
  funnelVersion?: string;
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
// A separate map from `anonymousScanRateLimits`: that one only ever sees
// anonymous image scans, and MODE B is checked for every caller regardless of
// auth state. Sharing the map would let commerce-only traffic exhaust an
// anonymous user's scan budget, or vice versa.
const commerceOnlyRateLimits = new Map<string, AnonymousRateEntry>();

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

/**
 * v124 selected-item schema — the v123 contract plus optional commercial
 * identity evidence.
 *
 * Strictly additive: every existing property and every entry in `required` is
 * carried over unchanged, and all new fields are optional, so a response valid
 * under the v123 schema stays valid here and older clients see no difference.
 * Selected only when BACKEND_COMMERCE_IDENTITY_ENABLED is on.
 */
const SELECTED_ITEM_RESPONSE_SCHEMA_V124 = {
  type: 'OBJECT',
  properties: {
    ...SELECTED_ITEM_RESPONSE_SCHEMA.properties,
    identification: {
      type: 'OBJECT',
      properties: {
        ...SELECTED_ITEM_RESPONSE_SCHEMA.properties.identification.properties,
        // ── Commercial identity evidence (all optional) ──────────────────────
        visible_brand_text: { type: 'STRING' },
        logo_detected: { type: 'BOOLEAN' },
        brand_guess: { type: 'STRING' },
        brand_confidence: { type: 'STRING', enum: ['low', 'medium', 'high'] },
        exact_item_hypothesis: { type: 'STRING' },
        exact_match_confidence: { type: 'STRING', enum: ['low', 'medium', 'high'] },
        distinctive_features: { type: 'ARRAY', items: { type: 'STRING' }, maxItems: 8 },
        style_tags: { type: 'ARRAY', items: { type: 'STRING' }, maxItems: 6 },
      },
      required: [...SELECTED_ITEM_RESPONSE_SCHEMA.properties.identification.required],
    },
  },
  required: [...SELECTED_ITEM_RESPONSE_SCHEMA.required],
} as const;

const SELECTED_ITEM_COMMERCE_IDENTITY_PROMPT = `
Also perform a bounded commercial identity analysis of the same selected garment.
This is for shopping match quality only. It never changes which garment you analyzed.

Add these optional identification fields when — and only when — the image supports them:
- visible_brand_text: brand wording, wordmark, or tag text you can actually read on the garment. Omit if none is legible.
- logo_detected: true only when a brand logo or monogram is actually visible.
- brand_guess: the brand you believe made this item.
- brand_confidence: "high" | "medium" | "low"
    high   = you can see a logo, wordmark, or tag identifying the brand.
    medium = no readable wordmark, but distinctive construction, hardware, a recognizable
             model/family detail, silhouette, or pattern makes the brand visually plausible.
    low    = a weak hypothesis with little supporting visual evidence.
- exact_item_hypothesis: the specific purchasable product or product family the item
  appears to be, for example "L01 Motorcycle Jacket", "Speedy 30", "Air Jordan 1 High",
  "Rockstud Pump". Omit this field entirely when the product family cannot be
  responsibly inferred. Do not invent a model name to fill the field.
- exact_match_confidence: "high" | "medium" | "low", graded the same way.
- distinctive_features: up to 8 short, concrete, fashion-specific construction details that
  would help distinguish this exact item from look-alikes, for example "asymmetric zipper",
  "silver-tone hardware", "belted hem", "quilted construction", "chain strap",
  "monogram pattern", "contrast stitching", "distinctive pocket layout".
  Keep each entry a short noun phrase. No sentences, no marketing prose, no adjectives
  such as luxury, designer, premium, vintage, or inspired.
- style_tags: up to 6 short style descriptors.

Rules:
- Omitting a field is always better than guessing one. "low" is the correct grade for a
  weak hypothesis; do not inflate it.
- Never state or imply certainty you do not have.
- Never identify a person, and never infer age, race, gender identity, body type, health,
  religion, income, or any other protected trait — including from a brand or price signal.
- Analyze only the selected garment. Ignore the person, face, body, background, and every
  unselected garment.`;

function buildSelectedItemPrompt(candidate: {
  candidateId: string;
  category: string;
  subtype?: string;
  bounds?: { x: number; y: number; width: number; height: number };
}, commerceIdentityEnabled = false): string {
  const target = JSON.stringify(candidate);
  return `You are K Scan AI's selected-garment identification engine.

The client selected this candidate from a prior detection pass: ${target}

Analyze only that garment in the original parent image.
Use its normalized bounds to locate it.
Do not switch to a larger, more central, or more recognizable garment.
Ignore the person, face, body, background, and every unselected garment.
${
    commerceIdentityEnabled
      ? 'Report brand only as graded evidence, per the commercial identity section below.'
      : 'Do not guess a brand unless clearly visible on the selected garment.'
  }

Return strict JSON only in the existing single-item response shape:
- status must be completed
- attributes must describe the selected garment
- identification must describe the selected garment
- recommendedProducts must be []
- userMessage must concisely describe the selected garment
- do not return detectedGarments

If an attribute is uncertain, use "unknown" rather than switching garments.${
    commerceIdentityEnabled ? `
${SELECTED_ITEM_COMMERCE_IDENTITY_PROMPT}` : ''
  }`;
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

/**
 * Emits the bounded V2 adoption line.
 *
 * Every field is an enum, a boolean or a count — see buildV2Telemetry, which is
 * the only thing allowed to construct this. Notably absent: the evidence id,
 * image bytes or references, local URIs, the request body, filenames, user or
 * device identifiers, and raw provider output.
 */
function logV2Telemetry(telemetry: V2Telemetry): void {
  console.log(
    '[scan-identify] v2_adoption path=%s intent=%s intentDefaulted=%s mode=%s entryPath=%s platform=%s evidence=%d status=%s resolution=%s commerce=%s skipReason=%s validated=%s',
    telemetry.contractPath,
    telemetry.intent,
    String(telemetry.intentDefaulted),
    telemetry.mode,
    telemetry.entryPath ?? 'none',
    telemetry.platform ?? 'none',
    telemetry.evidenceCount,
    telemetry.status ?? 'none',
    telemetry.resolutionLevel ?? 'none',
    String(telemetry.commerceExecuted),
    telemetry.skipReason ?? 'none',
    String(telemetry.responseValidationOk),
  );
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
      isAnonymous: false,
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
    // Supabase populates this on the verified user record for a session
    // created via auth.signInAnonymously() — already present on the same
    // getUser() response used for isAuthenticated, so reading it costs
    // nothing extra.
    isAnonymous: Boolean((user as { is_anonymous?: boolean } | null)?.is_anonymous),
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

/** Shared sliding-window limiter body. Each caller owns its own map/budget. */
function checkSlidingWindowRateLimit(
  map: Map<string, AnonymousRateEntry>,
  fingerprint: string,
  windowMs: number,
  max: number,
): { allowed: boolean; retryAfterSeconds: number; count: number } {
  const now = Date.now();
  if (map.size > 1000) {
    for (const [key, entry] of map.entries()) {
      if (now - entry.windowStart > windowMs * 2) {
        map.delete(key);
      }
    }
  }

  const current = map.get(fingerprint);
  const entry = !current || now - current.windowStart >= windowMs
    ? { windowStart: now, count: 0 }
    : current;
  entry.count += 1;
  map.set(fingerprint, entry);

  const retryAfterSeconds = Math.max(1, Math.ceil((entry.windowStart + windowMs - now) / 1000));
  return { allowed: entry.count <= max, retryAfterSeconds, count: entry.count };
}

function checkAnonymousImageRateLimit(fingerprint: string): {
  allowed: boolean;
  retryAfterSeconds: number;
  count: number;
} {
  return checkSlidingWindowRateLimit(
    anonymousScanRateLimits,
    fingerprint,
    ANON_SCAN_RATE_LIMIT_WINDOW_MS,
    ANON_SCAN_RATE_LIMIT_MAX,
  );
}

/**
 * Bound MODE B provider spend (P1-A repair).
 *
 * MODE B has no bearer-token requirement — `verify_jwt` is off for this
 * function, so an attacker can omit the Authorization header entirely and
 * gating by auth state would not bound anything. Checked for EVERY caller
 * regardless of auth state, before any provider work, using the same IP+UA
 * fingerprint authority the anonymous image path already uses.
 */
function checkCommerceOnlyRateLimit(fingerprint: string): {
  allowed: boolean;
  retryAfterSeconds: number;
  count: number;
} {
  return checkSlidingWindowRateLimit(
    commerceOnlyRateLimits,
    fingerprint,
    COMMERCE_ONLY_RATE_LIMIT_WINDOW_MS,
    COMMERCE_ONLY_RATE_LIMIT_MAX,
  );
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
// ── v127 MODE B helpers (commerce-only request) ─────────────────────────────

/** A commerce-only request is opt-in and explicit — never inferred. */
function isCommerceOnlyRequest(body: { requestMode?: unknown }): boolean {
  return body.requestMode === 'commerce_only';
}

/**
 * Optional per-item correlation id for a MODE B request (Build 32 multi-item
 * commerce). Pure passthrough: echoed on the response unchanged, never read
 * by ranking, filtering, or provider selection. Absent on every pre-Build-32
 * caller, so its absence changes nothing.
 */
function readCommerceOnlyCandidateId(body: { candidateId?: unknown }): string | undefined {
  return safeString(body.candidateId);
}

/**
 * Hard privacy gate for MODE B.
 *
 * The commerce-only path must operate on structured evidence, so an image
 * payload is not merely unnecessary here — accepting one would create a second
 * route by which image bytes could reach the commerce stack. Any image-shaped
 * field is a rejected request, not a silently ignored field, so a client bug
 * cannot quietly start shipping images.
 */
const PROHIBITED_IMAGE_KEYS = [
  'imageBase64',
  'image',
  'imageUrl',
  'imageUri',
  'photo',
  'base64',
  'evidence',
];

function rejectImagePayloadForCommerceOnly(
  body: Record<string, unknown>,
  path = '',
  depth = 0,
): string | null {
  // Checked at every level, not only the top: `attributes` reaches the provider
  // query without an allowlist, so a top-level-only sweep left
  // `attributes.imageBase64` as a second route for image bytes to enter the
  // commerce stack. Depth is bounded so a hostile body cannot cost time here.
  if (depth > 4) return null;
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null) continue;
    const here = path ? `${path}.${key}` : key;
    if (PROHIBITED_IMAGE_KEYS.includes(key)) return `image_payload_rejected:${here}`;
    if (typeof value === 'object' && !Array.isArray(value)) {
      const nested = rejectImagePayloadForCommerceOnly(
        value as Record<string, unknown>,
        here,
        depth + 1,
      );
      if (nested) return nested;
    }
  }
  return null;
}

/**
 * Bound the free-text MODE B attributes carry.
 *
 * Keys are preserved — the ranker and the v125 query builder read named
 * attributes, and an allowlist here would silently drop commerce signal on the
 * deferred path only. Values are capped exactly as `searchQueries` already is,
 * because named attribute values are concatenated into the outbound provider
 * query and were the one uncapped caller-controlled text on this route.
 */
function boundCommerceAttributes(
  raw: Record<string, unknown>,
  depth = 0,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') {
      const bounded = safeString(value);
      if (bounded !== undefined) out[key] = bounded;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    } else if (Array.isArray(value)) {
      out[key] = value
        .slice(0, MAX_ARRAY_ITEMS)
        .map((entry) => (typeof entry === 'string' ? safeString(entry) : undefined))
        .filter((entry): entry is string => entry !== undefined);
    } else if (value && typeof value === 'object' && depth < 2) {
      out[key] = boundCommerceAttributes(value as Record<string, unknown>, depth + 1);
    }
  }
  return out;
}

type CommerceOnlyEvidence = {
  identification: Record<string, unknown>;
  attributes?: Record<string, unknown>;
  searchQueries?: string[];
  market?: { locale?: string | null; currency?: string | null; country?: string | null };
};

/** Read the structured evidence MODE B accepts. Nothing else is consumed. */
function readCommerceOnlyEvidence(
  body: { identification?: unknown; attributes?: unknown; searchQueries?: unknown; market?: unknown },
): CommerceOnlyEvidence | null {
  const identification = sanitizeIdentification(body.identification, true);
  if (!identification) return null;

  const attributes = body.attributes && typeof body.attributes === 'object' && !Array.isArray(body.attributes)
    ? boundCommerceAttributes(body.attributes as Record<string, unknown>)
    : undefined;
  const searchQueries = safeStringArray(body.searchQueries) ?? undefined;

  let market: CommerceOnlyEvidence['market'];
  if (body.market && typeof body.market === 'object' && !Array.isArray(body.market)) {
    const m = body.market as Record<string, unknown>;
    market = {
      locale: safeString(m.locale) ?? null,
      currency: safeString(m.currency) ?? null,
      country: safeString(m.country) ?? null,
    };
  }

  return { identification, attributes, searchQueries, market };
}

function sanitizeIdentification(
  raw: unknown,
  allowCommerceIdentity = false,
): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const src = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const key of IDENTIFICATION_STRING_KEYS) {
    const v = safeString(src[key]);
    if (v) out[key] = v;
  }
  if (allowCommerceIdentity) {
    for (const key of IDENTIFICATION_IDENTITY_STRING_KEYS) {
      const v = safeString(src[key]);
      if (v) out[key] = v;
    }
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

  // ── 0. Account-state gate ───────────────────────────────────────────────────
  // Runs before request parsing, rate limiting, quota reservation and any
  // provider call, so a pending-deletion / deactivated / purged actor can never
  // consume quota or reach Gemini. A valid JWT can outlive the client routing
  // that blocks those accounts, so the server is the authority.
  //
  // Anonymous scanning is unaffected: with no Authorization header the guard
  // returns null and the existing anonymous rate-limited path is used.
  const accountGate = await assertAccountActiveIfAuthenticated(req);
  if (accountGate) return accountGate;

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
    // v127 MODE B (commerce-only). No image field is read on this route.
    identification?: unknown;
    attributes?: unknown;
    searchQueries?: unknown;
    market?: unknown;
    enrich?: unknown;
    // Build 32: optional per-item correlation id, echoed back unchanged.
    candidateId?: unknown;
  } = {};
  try {
    body = await req.json();
  } catch {
    return json({ ...normalized('failed', INVALID_IMAGE_MESSAGE), error: 'Invalid JSON' }, 400);
  }

  // ── 2a. Contract-version routing (Phase 2B.1) ───────────────────────────────
  // Runs before any interpretation of the body. An unknown contract version must
  // never fall through to legacy: a client asking for a contract this build does
  // not implement would otherwise get a response shaped for a different contract
  // with no way to detect the substitution.
  const contractRoute = routeScanIdentifyRequest(body);
  if (contractRoute.kind === 'contract_error') {
    return json(contractRoute.body, contractRoute.httpStatus);
  }
  const internalRequest: InternalScanRequest = contractRoute.internal;
  const isV2Request = contractRoute.kind === 'v2';

  // Style-intent scans persist NO Scanner-domain artifacts — no per-user scan
  // intelligence row, no commerce outcome row, on success or failure. The gate
  // wraps the capture entry points once so every existing call site inherits
  // it; quota accounting is usage, not an artifact, and is not gated here.
  const captureScanArtifacts = shouldCaptureScanArtifacts(internalRequest.intent);
  const captureCommerceOutcome: typeof persistCommerceOutcomeRow = (input, envGet) => {
    if (!captureScanArtifacts) {
      return Promise.resolve({ attempted: false, ok: true, reason: 'style_intent' as string | null });
    }
    return persistCommerceOutcomeRow(input, envGet);
  };

  // A V2 request carries `mode: detect_items | identify_selected_item`, which
  // collides with the legacy `mode: image | text`. V2 is always an image
  // request; its own mode travels in internalRequest.resolvedMode.
  const mode = isV2Request
    ? 'image'
    : typeof body.mode === 'string'
    ? body.mode.toLowerCase()
    : 'image';
  // V2 sends a structured source object, so the legacy string read would yield
  // 'unknown'. The specific entry path is preserved instead.
  const source = isV2Request
    ? internalRequest.entryPath ?? 'unknown'
    : safeString(body.source) ?? 'unknown';
  const multiItemRequested = isV2Request
    ? internalRequest.multiItemDetection
    : body.multiItemDetection === true;
  const multiItemEnabled =
    Deno.env.get('SCAN_MULTI_ITEM_ENABLED')?.trim().toLowerCase() === 'true';
  const useMultiItemProvider =
    mode === 'image' &&
    multiItemEnabled &&
    multiItemRequested;
  const requestMode = isV2Request
    ? internalRequest.requestMode
    : body.requestMode === 'selected_item'
    ? 'selected_item'
    : body.requestMode === 'multi_item_detection'
    ? 'multi_item_detection'
    : 'legacy_single_item';
  // The V2 candidate was already validated and mapped into exactly the shape
  // sanitizeSelectedCandidate produces, so the downstream pipeline is unchanged.
  const selectedCandidate = isV2Request
    ? internalRequest.selectedCandidate
    : sanitizeSelectedCandidate(body.selectedCandidate);
  const useSelectedItemProvider =
    useMultiItemProvider &&
    requestMode === 'selected_item' &&
    Boolean(selectedCandidate);
  const useMultiItemDetectionProvider =
    useMultiItemProvider && requestMode !== 'selected_item';
  const scanSessionId = safeCorrelationId(body.scanSessionId) ?? crypto.randomUUID();
  const suppliedImageDigestPrefix = safeDigestPrefix(body.imageDigestPrefix);
  const appPlatform = isV2Request
    ? internalRequest.platform ?? null
    : typeof body.appPlatform === 'string' && body.appPlatform.trim()
    ? body.appPlatform.trim()
    : null;
  const appVersion = typeof body.appVersion === 'string' && body.appVersion.trim()
    ? body.appVersion.trim()
    : null;
  // Request clock for outcome capture / early exits (Gemini uses its own startedAt).
  const requestStartedAt = Date.now();
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
    '[scan-identify] request_start mode=%s source=%s auth=%s uid=%s projectAccess=%s supabaseAnon=%s',
    mode,
    source,
    auth.isAuthenticated ? 'authenticated' : 'anonymous',
    logUserId,
    String(auth.hasProjectAccess),
    String(auth.isAnonymous),
  );

  // v127 flag resolution for the commerce-only route. Same env helpers the
  // inline path uses; resolved here because MODE B returns before the inline
  // Gemini section where those locals are declared.
  const commerceFunnelEnabled = isCommerceFunnelEnabled();
  const qualityTuneEnabledForCommerceOnly = isQualityTuneEnabled();
  const intelligenceEnabledForCommerceOnly = qualityTuneEnabledForCommerceOnly &&
    isScannerIntelligenceEnabled();
  const relevanceEnabledForCommerceOnly = intelligenceEnabledForCommerceOnly &&
    isCommerceRelevanceEnabled();
  const commerceIdentityEnabledForCommerceOnly = relevanceEnabledForCommerceOnly &&
    isCommerceIdentityEnabled();
  const commerceRetrievalEnabledForCommerceOnly = commerceIdentityEnabledForCommerceOnly &&
    isCommerceRetrievalEnabled();

  // ── v127 MODE B: commerce-only request ──────────────────────────────────
  //
  // Structured evidence in, ranked offers out. No image is accepted and none is
  // required: this path exists precisely so the scan result can render before
  // commerce has finished, and so a commerce retry never re-runs Gemini.
  //
  // It reuses the same query construction, ranking, filtering, and provider
  // normalization as the inline path — there is exactly one commerce
  // implementation, this mode only changes when it runs.
  if (commerceFunnelEnabled && isCommerceOnlyRequest(body)) {
    const commerceOnlyStarted = Date.now();

    // Rate limit before anything else in this block: no provider call, no
    // evidence parsing, no ranking work happens for a request this rejects.
    const commerceOnlyFingerprint = await sha256Hex(getClientFingerprintMaterial(req));
    const commerceOnlyRate = checkCommerceOnlyRateLimit(commerceOnlyFingerprint);
    if (!commerceOnlyRate.allowed) {
      console.warn(
        '[scan-identify] commerce_only_rate_limited fingerprint=%s count=%d',
        commerceOnlyFingerprint.slice(0, 12),
        commerceOnlyRate.count,
      );
      return json(
        {
          status: 'failed',
          error: 'commerce_only_rate_limited',
          retryAfterSeconds: commerceOnlyRate.retryAfterSeconds,
          purchaseOptions: [],
          recommendedProducts: [],
        },
        429,
      );
    }

    const rejected = rejectImagePayloadForCommerceOnly(body);
    if (rejected) {
      console.warn('[scan-identify] commerce_only_rejected reason=%s', rejected);
      return json(
        { status: 'failed', error: 'commerce_only_invalid', reason: rejected, purchaseOptions: [], recommendedProducts: [] },
        400,
      );
    }

    const evidence = readCommerceOnlyEvidence(body);
    if (!evidence) {
      return json(
        { status: 'failed', error: 'commerce_only_invalid', reason: 'missing_identification', purchaseOptions: [], recommendedProducts: [] },
        400,
      );
    }
    const commerceOnlyCandidateId = readCommerceOnlyCandidateId(body);

    const gated = applyScannerQualityGate(evidence.identification, evidence.attributes, {
      commerceIdentityEnabled: commerceIdentityEnabledForCommerceOnly,
    });
    // Must match the inline MODE A call exactly (see the `commerceCategoryRoute`
    // resolution on the image route): `selected_item` without a
    // `selectedCandidate` returns 'general' unconditionally, and
    // `identification` is not an input field, so routing by it silently
    // collapsed every deferred query onto the general template while the
    // flag-off path kept the category-specific one.
    const route = resolveScannerCategoryRoute({
      requestMode: 'legacy_single_item',
      knownCategory: typeof gated.identification?.item_type === 'string'
        ? gated.identification.item_type
        : null,
      knownSubtype: typeof gated.identification?.subtype === 'string'
        ? gated.identification.subtype
        : null,
    });

    const fast = await getFastCommerceResults({
      mode: 'image',
      identification: gated.identification,
      attributes: gated.attributes,
      searchQueries: evidence.searchQueries,
      limit: 10,
      market: evidence.market,
      ...(intelligenceEnabledForCommerceOnly
        ? {
          qualityDetailLevel: gated.commerceQueryDetailLevel,
          materialAllowed: !gated.materialSuppressed && gated.qualityBand !== 'low',
          brandAllowed: !gated.brandSuppressed && hasBrandEvidenceForCommerce(gated.identification),
        }
        : {}),
      ...(relevanceEnabledForCommerceOnly
        ? { relevanceEnabled: true, relevanceRoute: route, qualityBand: gated.qualityBand }
        : {}),
      ...(commerceIdentityEnabledForCommerceOnly
        ? {
          commerceIdentityEnabled: true,
          commerceIdentity: gated.commerceIdentity,
          commerceRetrievalEnabled: commerceRetrievalEnabledForCommerceOnly,
        }
        : {}),
    }).catch((err) => {
      console.warn('[scan-identify] commerce_only provider error:', err);
      return null;
    });

    if (!fast) {
      // Commerce failure is never a scan failure — the caller already has a
      // rendered scan result and simply gets an empty, retryable shelf.
      //
      // Best-effort scrubbed outcome persistence — never blocks the response.
      // This is the deferred commerce attempt actually completing (with a
      // genuine provider failure), not a fabricated outcome: MODE A's own
      // 'deferred' response never reaches captureCommerceOutcome, so without
      // this call every MODE B provider error was previously invisible to
      // commerce telemetry.
      captureCommerceOutcomeNonBlocking({
        requestMode: 'commerce_only',
        sourceClass: null,
        appPlatform,
        appVersion,
        status: 'completed',
        isFashion: true,
        categoryRoute: route,
        qualityBand: gated.qualityBand,
        commerceQueryDetailLevel: gated.commerceQueryDetailLevel,
        providerOutcome: 'error',
        providersTried: null,
        primaryResultCount: 0,
        fallbackUsed: false,
        productsBeforeFilter: 0,
        productsAfterFilter: 0,
        productsBeforeDedupe: 0,
        productsAfterDedupe: 0,
        categoryMismatchRemovals: 0,
        retailerCount: 0,
        commerceDurationMs: Date.now() - commerceOnlyStarted,
        totalDurationMs: Date.now() - commerceOnlyStarted,
        failureReason: mapToFailureReason({ providerOutcome: 'error' }),
        textScanParityEnabled: false,
        correlationHash: typeof commerceOnlyCandidateId === 'string'
          ? commerceOnlyCandidateId.slice(0, 12)
          : null,
        // No fast result exists on this path, so there is no query strategy
        // or agreement score to report — only that v124/v127 were active.
        commerceIdentityEnabled: commerceIdentityEnabledForCommerceOnly,
        commerceFunnelEnabled: true,
      }, captureCommerceOutcome);
      return json({
        status: 'completed',
        purchaseOptions: [],
        recommendedProducts: [],
        commerce: { available: false, retryable: true, errorType: 'provider_error' },
        ...(commerceOnlyCandidateId ? { candidateId: commerceOnlyCandidateId } : {}),
      }, 200);
    }

    // Optional bounded enrichment hop, requested explicitly by the client after
    // first paint. Never runs on the first commerce response.
    let products = fast.products;
    let enrichment: Awaited<ReturnType<typeof enrichCommerceOffers>> | null = null;
    if (body.enrich === true && fast.enrichmentCandidates.length > 0) {
      enrichment = await enrichCommerceOffers(products, fast.enrichmentCandidates, {
        includeBrand: commerceIdentityEnabledForCommerceOnly,
      }).catch(() => null);
      if (enrichment) products = enrichment.products;
    }

    const canonical = buildCanonicalCommerce(products);

    console.log(
      '[scan-identify] commerce_only_done v=%s cacheHit=%s discoveryMs=%d early=%s offers=%d enriched=%d totalMs=%d',
      COMMERCE_FUNNEL_VERSION,
      String(fast.funnel.cacheHit),
      fast.funnel.discoveryMs,
      String(fast.funnel.earlyExit),
      products.length,
      enrichment?.succeeded ?? 0,
      Date.now() - commerceOnlyStarted,
    );

    // Best-effort scrubbed outcome persistence — never blocks the response.
    // Mirrors the image-mode capture below field-for-field (one normalized
    // commerce-outcome contract for both MODE A and MODE B): qualityTune is
    // absent on a cache hit, since those stats were computed at cache-write
    // time and were never stored, so every count here falls back to the
    // shelf actually returned to the caller — the same fallback idiom the
    // image-mode call already uses when its own stats are unavailable.
    {
      const qt = fast.qualityTune;
      const beforeFilter = qt?.productsBeforeFilter ?? products.length;
      const beforeDedupe = qt?.productsBeforeDedupe ?? products.length;
      const afterDedupe = qt?.productsAfterDedupe ?? products.length;
      const mismatchRemovals = qt?.categoryMismatchRemovals ?? 0;
      const retailerCount = qt?.retailerCount ?? new Set(
        products
          .map((p) =>
            typeof (p as { source?: string }).source === 'string'
              ? (p as { source: string }).source
              : ''
          )
          .filter(Boolean),
      ).size;
      // MODE B never runs a fallback query — getFastCommerceResults only ever
      // executes resolved.query, never resolved.fallbackQuery — so
      // fallbackUsed is always false here, not a placeholder.
      const modeBFailureReason = mapFastCommerceFailureReason({
        errorType: fast.errorType,
        productCount: products.length,
        providerOutcomes: fast.funnel.providers.map((provider) => provider.outcome),
      });

      captureCommerceOutcomeNonBlocking({
        requestMode: 'commerce_only',
        sourceClass: null,
        appPlatform,
        appVersion,
        status: 'completed',
        isFashion: fast.errorType !== 'non_fashion',
        categoryRoute: route,
        qualityBand: gated.qualityBand,
        commerceQueryDetailLevel: gated.commerceQueryDetailLevel,
        providerOutcome: fast.provider,
        providersTried: fast.providersTried,
        primaryResultCount: products.length,
        fallbackUsed: false,
        productsBeforeFilter: beforeFilter,
        productsAfterFilter: afterDedupe,
        productsBeforeDedupe: beforeDedupe,
        productsAfterDedupe: afterDedupe,
        categoryMismatchRemovals: mismatchRemovals,
        retailerCount,
        commerceDurationMs: Date.now() - commerceOnlyStarted,
        totalDurationMs: Date.now() - commerceOnlyStarted,
        failureReason: modeBFailureReason,
        textScanParityEnabled: false,
        correlationHash: typeof commerceOnlyCandidateId === 'string'
          ? commerceOnlyCandidateId.slice(0, 12)
          : null,
        queryStrategy: fast.queryStrategy ?? null,
        topAgreementScore: qt?.topAgreementScore ?? null,
        topAgreementBand: qt?.topAgreementBand ?? null,
        commerceIdentityEnabled: commerceIdentityEnabledForCommerceOnly,
        commerceFunnelEnabled: true,
      }, captureCommerceOutcome);
    }

    return json({
      status: 'completed',
      purchaseOptions: products,
      recommendedProducts: products,
      canonicalProducts: canonical.products,
      ...(commerceOnlyCandidateId ? { candidateId: commerceOnlyCandidateId } : {}),
      commerce: {
        available: products.length > 0,
        retryable: products.length === 0,
        provider: fast.provider,
        providersTried: fast.providersTried,
        count: products.length,
        ...(fast.errorType ? { errorType: fast.errorType } : {}),
        enrichmentCandidates: fast.enrichmentCandidates,
        enrichmentAttempted: enrichment?.attempted ?? 0,
        enrichmentSucceeded: enrichment?.succeeded ?? 0,
      },
      funnel: {
        version: COMMERCE_FUNNEL_VERSION,
        cacheHit: fast.funnel.cacheHit,
        cacheAgeMs: fast.funnel.cacheAgeMs,
        cacheLookupMs: fast.funnel.cacheLookupMs,
        discoveryMs: fast.funnel.discoveryMs,
        earlyExit: fast.funnel.earlyExit,
        deadlineMs: fast.funnel.deadlineMs,
        salvagedFromPartial: fast.funnel.salvagedFromPartial,
        providers: fast.funnel.providers,
        enrichmentMs: enrichment?.durationMs ?? 0,
        totalMs: Date.now() - commerceOnlyStarted,
      },
    }, 200);
  }

  if (useMultiItemProvider && requestMode === 'selected_item' && !selectedCandidate) {
    console.warn(
      '[scan-identify] selected_item_invalid scanSessionId=%s requestMode=%s',
      scanSessionId,
      requestMode,
    );
    void captureCommerceOutcome({
      requestMode: 'selected_item',
      sourceClass: typeof source === 'string' ? source : null,
      appPlatform,
      appVersion,
      status: 'failed',
      isFashion: false,
      categoryRoute: null,
      qualityBand: null,
      commerceQueryDetailLevel: null,
      providerOutcome: null,
      providersTried: null,
      primaryResultCount: 0,
      fallbackUsed: false,
      productsBeforeFilter: 0,
      productsAfterFilter: 0,
      productsBeforeDedupe: 0,
      productsAfterDedupe: 0,
      categoryMismatchRemovals: 0,
      retailerCount: 0,
      commerceDurationMs: null,
      totalDurationMs: Date.now() - requestStartedAt,
      failureReason: mapToFailureReason({ candidateInvalid: true }),
      textScanParityEnabled: false,
    });
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

  // ── Build 32 paid-AI ingress authority (single, non-bypassable) ──────────
  //
  // The publishable/anon project key (surfaced here as auth.hasProjectAccess)
  // proves the request targets this project. A Supabase anonymous identity
  // (auth.isAnonymous) proves a session exists. Neither proves the caller is
  // a K Scan AI account eligible to spend Gemini budget, so neither may admit
  // a request into text or image identification. This is the ONLY authority
  // that decides that question for this route, it runs before any quota
  // check, commerce retrieval, or provider call, and it has no fallback: an
  // actor that fails this check is rejected outright, never re-admitted by
  // project-key presence, rate-limit headroom, or a verification error.
  //
  // (MODE B, the commerce-only request above, is unaffected — it never
  // reaches Gemini and is out of scope for this authority.)
  const isEligiblePaidAIActor = auth.isAuthenticated && !auth.isAnonymous;

  if (!isEligiblePaidAIActor) {
    if (mode === 'text') {
      void captureCommerceOutcome({
        requestMode: 'text',
        sourceClass: typeof source === 'string' ? source : null,
        appPlatform,
        appVersion,
        status: 'failed',
        isFashion: false,
        categoryRoute: null,
        qualityBand: null,
        commerceQueryDetailLevel: null,
        providerOutcome: null,
        providersTried: null,
        primaryResultCount: 0,
        fallbackUsed: false,
        productsBeforeFilter: 0,
        productsAfterFilter: 0,
        productsBeforeDedupe: 0,
        productsAfterDedupe: 0,
        categoryMismatchRemovals: 0,
        retailerCount: 0,
        commerceDurationMs: null,
        totalDurationMs: Date.now() - requestStartedAt,
        failureReason: mapToFailureReason({ authRequired: true }),
        textScanParityEnabled: false,
      });
      return json({ error: 'Not authenticated' }, 401);
    }
    return json(
      {
        ...normalized('failed', SAFE_FAILED_MESSAGE),
        error: 'Not authenticated',
      },
      401,
    );
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
    // V2 carries the payload inside the single validated evidence entry; legacy
    // carries it at the top level. Both converge here, so every downstream
    // guard (size, base64 shape, magic-byte sniff, digest) is unchanged.
    imageBase64 = isV2Request
      ? internalRequest.imageBase64 ?? ''
      : typeof body.imageBase64 === 'string'
      ? body.imageBase64
      : '';
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
      void captureCommerceOutcome({
        requestMode: useSelectedItemProvider ? 'selected_item' : useMultiItemDetectionProvider ? 'multi_item_detection' : 'legacy_single_item',
        sourceClass: typeof source === 'string' ? source : null,
        appPlatform,
        appVersion,
        status: 'failed',
        isFashion: false,
        categoryRoute: null,
        qualityBand: null,
        commerceQueryDetailLevel: null,
        providerOutcome: null,
        providersTried: null,
        primaryResultCount: 0,
        fallbackUsed: false,
        productsBeforeFilter: 0,
        productsAfterFilter: 0,
        productsBeforeDedupe: 0,
        productsAfterDedupe: 0,
        categoryMismatchRemovals: 0,
        retailerCount: 0,
        commerceDurationMs: null,
        totalDurationMs: Date.now() - requestStartedAt,
        failureReason: mapToFailureReason({ invalidImage: true }),
        textScanParityEnabled: false,
      });
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
      void captureCommerceOutcome({
        requestMode: 'selected_item',
        sourceClass: typeof source === 'string' ? source : null,
        appPlatform,
        appVersion,
        status: 'failed',
        isFashion: false,
        categoryRoute: null,
        qualityBand: null,
        commerceQueryDetailLevel: null,
        providerOutcome: null,
        providersTried: null,
        primaryResultCount: 0,
        fallbackUsed: false,
        productsBeforeFilter: 0,
        productsAfterFilter: 0,
        productsBeforeDedupe: 0,
        productsAfterDedupe: 0,
        categoryMismatchRemovals: 0,
        retailerCount: 0,
        commerceDurationMs: null,
        totalDurationMs: Date.now() - requestStartedAt,
        failureReason: mapToFailureReason({
          digestMissing: !suppliedImageDigestPrefix,
          digestMismatch: !!suppliedImageDigestPrefix,
        }),
        textScanParityEnabled: false,
        correlationHash: typeof imageDigestPrefix === 'string' ? imageDigestPrefix : null,
      });
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
      void captureCommerceOutcome({
        requestMode: mode === 'text' ? 'text' : 'legacy_single_item',
        sourceClass: typeof source === 'string' ? source : null,
        appPlatform,
        appVersion,
        status: 'rate_limited',
        isFashion: false,
        categoryRoute: null,
        qualityBand: null,
        commerceQueryDetailLevel: null,
        providerOutcome: null,
        providersTried: null,
        primaryResultCount: 0,
        fallbackUsed: false,
        productsBeforeFilter: 0,
        productsAfterFilter: 0,
        productsBeforeDedupe: 0,
        productsAfterDedupe: 0,
        categoryMismatchRemovals: 0,
        retailerCount: 0,
        commerceDurationMs: null,
        totalDurationMs: Date.now() - requestStartedAt,
        failureReason: mapToFailureReason({ quotaExceeded: true }),
        textScanParityEnabled: false,
      });
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

  // Routing is allowlist-bound. Scanner may use its approved fallback once;
  // TextScan stays on Lite and gets one same-model retry with no escalation.
  // The generic GEMINI_MODEL variable deliberately has no influence here.
  const routePlan = resolveRoutePlan(mode === 'text' ? 'textscan' : 'scanner', readTrimmedEnv);
  const modelName = routePlan.primaryModel;
  const timeoutMs = (() => {
    const raw = readTrimmedEnv('SCAN_GEMINI_TIMEOUT_MS');
    const parsed = raw !== undefined ? parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) && parsed >= 2_000 && parsed <= 20_000
      ? parsed
      : DEFAULT_GEMINI_TIMEOUT_MS;
  })();

  // ── 4. Call Gemini with a timeout guard ──────────────────────────────────────
  const buildGeminiUrl = (model: string): string => {
    const u = new URL(`${GEMINI_API_BASE}/${model}:generateContent`);
    u.searchParams.set('key', geminiKey);
    return u.toString();
  };

  const qualityTuneEnabled = isQualityTuneEnabled();
  // Intelligence requires quality-tune ON; when intelligence OFF → exact v120 behavior.
  const intelligenceEnabled = qualityTuneEnabled && isScannerIntelligenceEnabled();
  // Relevance requires intelligence ON; when relevance OFF → exact v121 behavior.
  const relevanceEnabled = intelligenceEnabled && isCommerceRelevanceEnabled();
  // TextScan parity requires relevance ON; when OFF → exact repaired-v122 TextScan behavior.
  const textScanParityEnabled = relevanceEnabled && isTextScanCommerceParityEnabled();
  // Commerce identity requires relevance ON; when OFF → exact repaired-v123 behavior.
  // Ranking-only: it never changes the commerce query, provider order, or call count.
  const commerceIdentityEnabled = relevanceEnabled && isCommerceIdentityEnabled();
  // Retrieval enrichment consumes v124's graded evidence, so it requires
  // identity ON. The reverse does not hold: v124 ON + v125 OFF is valid and is
  // the state this repository ships by default.
  const commerceRetrievalEnabled = commerceIdentityEnabled && isCommerceRetrievalEnabled();

  const requestModeForRoute = useMultiItemDetectionProvider
    ? 'multi_item_detection' as const
    : useSelectedItemProvider
    ? 'selected_item' as const
    : mode === 'text'
    ? 'text' as const
    : 'legacy_single_item' as const;

  const categoryRoute: ScannerCategoryRoute = intelligenceEnabled
    ? resolveScannerCategoryRoute({
      requestMode: requestModeForRoute,
      selectedCandidate: selectedCandidate
        ? {
          category: selectedCandidate.category,
          subtype: selectedCandidate.subtype,
          label: (selectedCandidate as { label?: string }).label,
          providerCategory: selectedCandidate.category,
        }
        : null,
      textQuery: mode === 'text' ? textQuery : null,
    })
    : 'general';

  const withQualityAndRoute = (base: string): string => {
    let prompt = base;
    if (qualityTuneEnabled) prompt = `${prompt}${QUALITY_TUNE_PROMPT_ADDENDUM}`;
    if (intelligenceEnabled) prompt = buildRoutedIdentifyPrompt(prompt, categoryRoute);
    return prompt;
  };

  const identifyPrompt = withQualityAndRoute(IDENTIFY_PROMPT);
  const multiItemPrompt = withQualityAndRoute(MULTI_ITEM_IDENTIFY_PROMPT);
  const textIdentifyPrompt = withQualityAndRoute(TEXT_IDENTIFY_PROMPT);
  const selectedItemPrompt = selectedCandidate
    ? withQualityAndRoute(buildSelectedItemPrompt(selectedCandidate, commerceIdentityEnabled))
    : '';

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
                  ? selectedItemPrompt
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
            ? {
              responseSchema: commerceIdentityEnabled
                ? SELECTED_ITEM_RESPONSE_SCHEMA_V124
                : SELECTED_ITEM_RESPONSE_SCHEMA,
            }
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
    // Bounded attempt loop. One logical request: at most plan.maxAttempts
    // provider calls, no loops, and no unapproved model can ever be selected.
    // A permanent failure (4xx, auth, safety, quota/billing exhaustion,
    // oversized context, invalid model) stops immediately.
    let res!: Response;
    let raw = '';
    let servedModel = modelName;
    let attempt = 0;
    let lastFailureKind: ProviderFailureKind | null = null;

    while (attempt < routePlan.maxAttempts) {
      attempt += 1;
      const attemptModel = nextAttemptModel(routePlan, attempt);
      if (!attemptModel) break;
      servedModel = attemptModel;

      res = await fetch(buildGeminiUrl(attemptModel), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(geminiBody),
        signal: controller.signal,
      });
      raw = await res.text().catch(() => '');

      if (res.ok) break;

      const attemptMeta = extractGeminiErrorMeta(raw);
      lastFailureKind = classifyProviderHttpFailure(res.status, attemptMeta);
      const canRetry = isRetryableProviderFailure(lastFailureKind)
        && attempt < routePlan.maxAttempts
        && nextAttemptModel(routePlan, attempt + 1) !== null;

      console.warn(
        '[scan-identify] gemini_attempt_failed uid=%s mode=%s surface=%s attempt=%d model=%s httpStatus=%d kind=%s retrying=%s',
        logUserId,
        mode,
        routePlan.surface,
        attempt,
        attemptModel,
        res.status,
        lastFailureKind,
        String(canRetry),
      );

      if (!canRetry) break;

      const delayMs = resolveRetryDelayMs(attempt, res.headers.get('retry-after'));
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    const elapsedMs = Date.now() - startedAt;

    if (!res.ok) {
      const meta = extractGeminiErrorMeta(raw);
      console.warn(
        '[scan-identify] gemini_http_error uid=%s mode=%s source=%s httpStatus=%d code=%s status=%s kind=%s attempts=%d elapsedMs=%d',
        logUserId,
        mode,
        source,
        res.status,
        String(meta.code ?? 'none'),
        String(meta.status ?? 'none'),
        String(lastFailureKind ?? 'none'),
        attempt,
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
      '[scan-identify] gemini_success elapsedMs=%d mode=%s source=%s surface=%s model=%s attempt=%d',
      elapsedMs,
      mode,
      source,
      routePlan.surface,
      servedModel,
      attempt,
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
      // v120-v123 full-tree audit repair: this terminal branch previously
      // returned without ever calling captureCommerceOutcome, so a whole class
      // of legitimate multi-item requests (detection completed, zero garments
      // survived sanitization) was invisible to scan_commerce_events, despite
      // the unified v123 outcome table being designed to cover every request.
      void captureCommerceOutcome({
        requestMode: 'multi_item_detection',
        sourceClass: typeof source === 'string' ? source : null,
        appPlatform,
        appVersion,
        status: 'failed',
        isFashion: false,
        categoryRoute: null,
        qualityBand: null,
        commerceQueryDetailLevel: null,
        providerOutcome: null,
        providersTried: null,
        primaryResultCount: 0,
        fallbackUsed: false,
        productsBeforeFilter: 0,
        productsAfterFilter: 0,
        productsBeforeDedupe: 0,
        productsAfterDedupe: 0,
        categoryMismatchRemovals: 0,
        retailerCount: 0,
        commerceDurationMs: null,
        totalDurationMs: Date.now() - requestStartedAt,
        failureReason: mapToFailureReason({ modelMalformed: true }),
        textScanParityEnabled: false,
      });
      return json(normalized('failed', safeFailed), 200);
    }

    // Try the new rich identification shape first.
    let identification = sanitizeIdentification(
      primaryGarmentFields.identification ?? parsed.identification,
      commerceIdentityEnabled,
    );
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
      identification = sanitizeIdentification(
        buildIdentificationFromAttributes(attributes),
        commerceIdentityEnabled,
      );
    }

    // Quality-tune: deterministic taxonomy normalization + generic recovery.
    // Flag OFF preserves exact v119-equivalent path (this block skipped).
    // Intelligence gate runs after v120 normalization when intelligence ON.
    let qualityNormCorrectionCount = 0;
    let qualityNormRuleIds: string[] = [];
    let qualityGenericLabelOccurrence = 0;
    let qualityInvalidPairsResolved = 0;
    let intelligenceGate: QualityGateResult | null = null;
    if (qualityTuneEnabled && rawStatus === 'completed') {
      if (useMultiItemDetectionProvider && detectedGarments.length > 0) {
        for (let i = 0; i < detectedGarments.length; i++) {
          const g = detectedGarments[i];
          let tuned = applyQualityTaxonomyTune(
            g.identification as Record<string, unknown>,
            g.attributes as Record<string, unknown>,
          );
          if (intelligenceEnabled) {
            const gated = applyScannerQualityGate(tuned.identification, tuned.attributes, {
              commerceIdentityEnabled,
            });
            tuned = {
              ...tuned,
              identification: gated.identification,
              attributes: gated.attributes,
            };
            if (i === 0) intelligenceGate = gated;
          }
          g.identification = tuned.identification;
          if (tuned.attributes) g.attributes = tuned.attributes;
          if (typeof tuned.identification.item_type === 'string' && tuned.identification.item_type) {
            g.category = String(tuned.identification.item_type);
            g.label = typeof tuned.identification.subtype === 'string' && tuned.identification.subtype
              ? String(tuned.identification.subtype)
              : (intelligenceGate?.label || g.category);
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
        identification = sanitizeIdentification(primaryTuned.identification, commerceIdentityEnabled) ??
          identification;
        attributes = (primaryTuned.attributes as Record<string, unknown> | undefined) ?? attributes;
      } else if (identification || attributes) {
        let tuned = applyQualityTaxonomyTune(
          (identification ?? {}) as Record<string, unknown>,
          attributes as Record<string, unknown> | undefined,
        );
        if (intelligenceEnabled) {
          intelligenceGate = applyScannerQualityGate(tuned.identification, tuned.attributes, {
            commerceIdentityEnabled,
          });
          tuned = {
            ...tuned,
            identification: intelligenceGate.identification,
            attributes: intelligenceGate.attributes,
          };
        }
        identification = sanitizeIdentification(tuned.identification, commerceIdentityEnabled) ??
          identification;
        if (tuned.attributes) attributes = tuned.attributes;
        qualityNormCorrectionCount = tuned.correctionCount;
        qualityNormRuleIds = tuned.ruleIds;
        qualityGenericLabelOccurrence = tuned.genericLabelOccurrence;
        qualityInvalidPairsResolved = tuned.invalidPairResolved;
      }
    }

    // v122 repair: commerce must route on the FINAL normalized identification,
    // not the pre-model prompt route (always 'general' for legacy_single_item,
    // and possibly 'general' for ambiguous TextScan even after Gemini resolves
    // a specific category). `categoryRoute` (used for the Gemini prompt) is
    // left untouched; this only affects which commerce query template runs.
    const commerceCategoryRoute: ScannerCategoryRoute = intelligenceEnabled
      ? resolveScannerCategoryRoute({
        requestMode: 'legacy_single_item',
        knownCategory: typeof identification?.item_type === 'string' ? identification.item_type : null,
        knownSubtype: typeof identification?.subtype === 'string' ? identification.subtype : null,
      })
      : 'general';

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
      if (mode === 'image' && auth.isAuthenticated && captureScanArtifacts) {
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
      // v120-v123 full-tree audit repair: non_fashion is an explicit, valid
      // status in the outcome-row schema (ALLOWED_STATUS) and has its own
      // stable failure reason (FAILURE_REASON_NON_FASHION), but this branch
      // never called captureCommerceOutcome, so non-fashion scans — a
      // legitimate, non-trivial share of Scanner traffic — were structurally
      // invisible to scan_commerce_events.
      void captureCommerceOutcome({
        requestMode: useSelectedItemProvider
          ? 'selected_item'
          : useMultiItemDetectionProvider
          ? 'multi_item_detection'
          : mode === 'text'
          ? 'text'
          : 'legacy_single_item',
        sourceClass: typeof source === 'string' ? source : null,
        appPlatform,
        appVersion,
        status: 'non_fashion',
        isFashion: false,
        categoryRoute: null,
        qualityBand: null,
        commerceQueryDetailLevel: null,
        providerOutcome: null,
        providersTried: null,
        primaryResultCount: 0,
        fallbackUsed: false,
        productsBeforeFilter: 0,
        productsAfterFilter: 0,
        productsBeforeDedupe: 0,
        productsAfterDedupe: 0,
        categoryMismatchRemovals: 0,
        retailerCount: 0,
        commerceDurationMs: null,
        totalDurationMs: Date.now() - requestStartedAt,
        failureReason: mapToFailureReason({ isNonFashion: true }),
        textScanParityEnabled: false,
      });
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
    const intelligenceLabelMessage = intelligenceEnabled && intelligenceGate?.label
      ? safeStringMessage(intelligenceGate.label)
      : undefined;
    const userMessage = intelligenceLabelMessage ??
      safeStringMessage(parsed.userMessage) ??
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

    // ── Canonical V2 normalization (Phase 2B.1) ─────────────────────────────
    // ONE normalized result. The legacy fields built above and the V2 result
    // built here are two projections of the same sanitized identification,
    // which is what makes them structurally unable to disagree. There is no
    // second visual-classification pipeline.
    const v2EvidenceIds = internalRequest.evidenceId ? [internalRequest.evidenceId] : [];
    const v2DetectionCandidates = useMultiItemDetectionProvider && detectedGarments.length > 0
      ? detectedGarments.map((garment) => ({
        candidateId: garment.candidateId,
        // Every candidate keeps the id of the image it came from, so the
        // follow-up selected-item request stays correlated to this detection.
        evidenceId: v2EvidenceIds[0] ?? '',
        category: garment.category ?? null,
        subtype: garment.subtype ?? null,
        ...(garment.bounds ? { bounds: garment.bounds } : {}),
      }))
      : undefined;
    const v2Result: FashionIdentificationResultV2 = normalizeToV2({
      requestId: internalRequest.requestId ?? scanId,
      outcome: v2DetectionCandidates ? 'multiple_items_need_selection' : 'classified',
      evidenceIds: v2EvidenceIds,
      identification: completedResponseWithAttributes.identification as
        | Record<string, unknown>
        | undefined,
      attributes: completedResponseWithAttributes.attributes as Record<string, unknown> | undefined,
      ...(v2DetectionCandidates ? { candidates: v2DetectionCandidates } : {}),
    });

    // ── Hard commerce decision (Phase 2B.1) ─────────────────────────────────
    // Evaluated HERE, before any commerce client, catalog query, similarity
    // matcher or network promise exists. Starting providers and discarding the
    // results later would still spend the quota, the latency and the
    // third-party calls that style intent exists to avoid.
    const commerceDecision = resolveCommerceDecision({
      intent: internalRequest.intent,
      resolvedMode: internalRequest.resolvedMode,
      status: v2Result.status,
    });
    // Product recommendations.
    //   - Text mode: real shopping providers (Serper primary, Brave fallback).
    //   - Image (camera) mode: live commerce router first, then catalog
    //     similarity scoring. Live commerce is bounded by a 3s timeout so that
    //     a slow provider cannot block the similarity shelf.
    let finalRecommendedProducts: RankedScanProduct[];
    let finalSimilarityMatches: SimilarityMatch[] = [];
    let rankedProductsForAudit: RankedScanProduct[];
    let shoppingMeta: ShoppingMeta | undefined;
    // v122 repair: real filter/fallback stats for truthful commerceRelevance
    // telemetry (was previously hardcoded/derived from the final array only).
    let commerceRelevanceStats: {
      fallbackUsed: boolean;
      productsBeforeDedupe: number;
      productsAfterDedupe: number;
      categoryMismatchRemovals: number;
      productsBeforeFilter?: number;
      retailerCount?: number;
    } | null = null;
    let commerceStartedAt = 0;
    let commerceDurationMs: number | null = null;

    if (mode === 'text') {
      console.log('[scan-identify] commerce_started mode=%s source=%s parity=%s', mode, source, String(textScanParityEnabled));
      commerceStartedAt = Date.now();

      if (textScanParityEnabled) {
        // v123: TextScan uses the same commerce router as image mode.
        const commerce = await Promise.race([
          getScanCommerceResults({
            mode: 'text',
            allowTextMode: true,
            identification: (identification ?? {}) as Record<string, unknown>,
            attributes: attributes as Record<string, unknown> | undefined,
            searchQueries: Array.isArray(identification?.search_queries)
              ? (identification?.search_queries as string[])
              : undefined,
            originalText: textQuery,
            limit: 8,
            ...(intelligenceEnabled && intelligenceGate
              ? {
                qualityDetailLevel: intelligenceGate.commerceQueryDetailLevel,
                materialAllowed: !intelligenceGate.materialSuppressed &&
                  intelligenceGate.qualityBand !== 'low',
                brandAllowed: !intelligenceGate.brandSuppressed &&
                  hasBrandEvidenceForCommerce(identification as Record<string, unknown> | undefined),
              }
              : {}),
            ...(relevanceEnabled && intelligenceGate
              ? {
                relevanceEnabled: true,
                relevanceRoute: commerceCategoryRoute,
                qualityBand: intelligenceGate.qualityBand,
              }
              : {}),
            ...(commerceIdentityEnabled && intelligenceGate
              ? {
                commerceIdentityEnabled: true,
                commerceIdentity: intelligenceGate.commerceIdentity,
                commerceRetrievalEnabled,
              }
              : {}),
          }).catch((err) => {
            console.warn('[scan-identify] text commerce router error:', err);
            return {
              provider: 'error',
              providersTried: [],
              query: '',
              products: [],
              count: 0,
            } as unknown as ScanCommerceResult;
          }),
          new Promise<'text_commerce_timeout'>((resolve) => {
            setTimeout(() => resolve('text_commerce_timeout'), TEXT_MODE_COMMERCE_TIMEOUT_MS);
          }),
        ]);
        commerceDurationMs = Date.now() - commerceStartedAt;

        if (commerce === 'text_commerce_timeout') {
          console.warn(
            '[scan-identify] commerce_timeout timeoutMs=%d mode=%s source=%s',
            TEXT_MODE_COMMERCE_TIMEOUT_MS,
            mode,
            source,
          );
          finalRecommendedProducts = [];
          shoppingMeta = {
            provider: 'timeout',
            query: '',
            count: 0,
            providersTried: [],
            reason: 'text_commerce_timeout',
          };
        } else {
          finalRecommendedProducts = commerce.products.slice(0, 8).map((p) => ({
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
            provider: commerce.provider,
            query: commerce.query,
            count: finalRecommendedProducts.length,
            providersTried: commerce.providersTried,
          };
          if (commerce.qualityTune) {
            commerceRelevanceStats = {
              fallbackUsed: !!commerce.qualityTune.fallbackUsed,
              productsBeforeDedupe: commerce.qualityTune.productsBeforeDedupe,
              productsAfterDedupe: commerce.qualityTune.productsAfterDedupe,
              categoryMismatchRemovals: commerce.qualityTune.categoryMismatchRemovals,
              productsBeforeFilter: commerce.qualityTune.productsBeforeFilter,
              retailerCount: commerce.qualityTune.retailerCount,
            };
          }
        }
      } else {
        // Repaired-v122 TextScan path: Serper/Brave via getShoppingResults only.
        const weightedText = qualityTuneEnabled
          ? buildWeightedCommerceQueries({
            identification: (identification ?? {}) as Record<string, unknown>,
            attributes: attributes as Record<string, unknown> | undefined,
            searchQueries: Array.isArray(identification?.search_queries)
              ? (identification?.search_queries as string[])
              : undefined,
            originalText: textQuery,
            ...(intelligenceEnabled && intelligenceGate
              ? {
                detailLevel: intelligenceGate.commerceQueryDetailLevel,
                materialAllowed: !intelligenceGate.materialSuppressed &&
                  intelligenceGate.qualityBand !== 'low',
                brandAllowed: !intelligenceGate.brandSuppressed &&
                  hasBrandEvidenceForCommerce(identification as Record<string, unknown> | undefined),
              }
              : {}),
            ...(relevanceEnabled && intelligenceGate
              ? {
                relevanceRoute: commerceCategoryRoute,
                qualityBand: intelligenceGate.qualityBand,
                detailLevel: intelligenceGate.commerceQueryDetailLevel,
                materialAllowed: !intelligenceGate.materialSuppressed &&
                  intelligenceGate.qualityBand !== 'low',
                brandAllowed: !intelligenceGate.brandSuppressed &&
                  hasBrandEvidenceForCommerce(identification as Record<string, unknown> | undefined),
              }
              : {}),
            ...(commerceRetrievalEnabled && intelligenceGate?.commerceIdentity
              ? { commerceIdentity: intelligenceGate.commerceIdentity }
              : {}),
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
        commerceDurationMs = Date.now() - commerceStartedAt;

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
            const textRelevance = relevanceEnabled
              ? {
                enabled: true as const,
                categoryRoute: commerceCategoryRoute,
                qualityBand: intelligenceGate?.qualityBand ?? null,
                ...(commerceIdentityEnabled && intelligenceGate?.commerceIdentity
                  ? { commerceIdentity: intelligenceGate.commerceIdentity }
                  : {}),
              }
              : undefined;
            const filtered = filterAndDedupeProducts(
              textProducts,
              (identification ?? {}) as Record<string, unknown>,
              textRelevance,
            );
            textProducts = filtered.products;
            if (relevanceEnabled) {
              commerceRelevanceStats = {
                fallbackUsed: false,
                productsBeforeDedupe: filtered.stats.productsBeforeDedupe,
                productsAfterDedupe: filtered.stats.productsAfterDedupe,
                categoryMismatchRemovals: filtered.stats.categoryMismatchRemovals,
                productsBeforeFilter: filtered.stats.productsBeforeFilter,
                retailerCount: filtered.stats.retailerCount,
              };
            }
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
                textRelevance,
              );
              if (relevanceEnabled) {
                commerceRelevanceStats = {
                  fallbackUsed: true,
                  productsBeforeDedupe: fallbackFiltered.stats.productsBeforeDedupe,
                  productsAfterDedupe: fallbackFiltered.stats.productsAfterDedupe,
                  categoryMismatchRemovals:
                    (commerceRelevanceStats?.categoryMismatchRemovals || 0) +
                    fallbackFiltered.stats.categoryMismatchRemovals,
                  productsBeforeFilter: fallbackFiltered.stats.productsBeforeFilter,
                  retailerCount: fallbackFiltered.stats.retailerCount,
                };
              }
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
    } else if (isV2Request && !commerceDecision.run) {
      // Phase 2B.1 short-circuit. Deliberately gated on isV2Request: legacy
      // commerce behaviour must not shift during activation, and the two skips
      // legacy already performs (detection, anonymous) are handled by the
      // branches around this one. Nothing below is constructed — no KicksCrew,
      // Farfetch, Serper or Brave client, no product_catalog query, no
      // similarity matcher, no network promise.
      console.log(
        '[scan-identify] commerce_skipped reason=%s intent=%s mode=%s',
        commerceDecision.skipReason ?? 'unknown',
        internalRequest.intent,
        internalRequest.resolvedMode,
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
        reason: commerceDecision.skipReason ?? 'unknown',
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
    } else if (commerceFunnelEnabled) {
      // ── v127 MODE A: commerce leaves the scan critical path ───────────────
      //
      // The scan result is complete once Gemini has answered. Holding this
      // response open for provider latency is what made the scanner feel slow,
      // so under v127 no provider promise is created here at all — not started
      // and abandoned, not raced against a timeout, simply not on this route.
      //
      // The client renders immediately and issues a MODE B commerce-only
      // request, which reuses this same commerce stack with a bounded fast
      // deadline. Commerce is deferred, never cancelled.
      console.log(
        '[scan-identify] commerce_deferred v=%s mode=%s source=%s',
        COMMERCE_FUNNEL_VERSION,
        mode,
        source,
      );
      // Commerce is deferred, so this response carries no offers. These must
      // still be assigned: the response builder, the audit event, and the
      // commerce telemetry below all dereference them unconditionally, and an
      // unassigned binding here throws and is caught by the handler's outer
      // catch — turning a successful scan into `failed` for every signed-in
      // user the moment the funnel flag is enabled.
      finalRecommendedProducts = [];
      finalSimilarityMatches = [];
      rankedProductsForAudit = [];
      shoppingMeta = {
        provider: 'deferred',
        query: '',
        count: 0,
        providersTried: [],
        catalogCount: 0,
        similarityMatches: 0,
        commerceSkipped: true,
        // Explicit client contract: fetch commerce with a MODE B request.
        deferred: true,
        funnelVersion: COMMERCE_FUNNEL_VERSION,
        reason: 'deferred_to_commerce_only_request',
      };
    } else {
      // Image (camera) mode: live commerce first, then deterministic catalog
      // similarity scoring. The similarity matcher runs non-blocking and is
      // allowed to return fewer than 2 matches; the UI hides the section then.
      // Live commerce is capped at IMAGE_MODE_COMMERCE_TIMEOUT_MS so a slow
      // provider cannot block the Similar Items shelf.
      console.log('[scan-identify] commerce_started mode=%s source=%s', mode, source);
      commerceStartedAt = Date.now();
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
          ...(intelligenceEnabled && intelligenceGate
            ? {
              qualityDetailLevel: intelligenceGate.commerceQueryDetailLevel,
              materialAllowed: !intelligenceGate.materialSuppressed &&
                intelligenceGate.qualityBand !== 'low',
              brandAllowed: !intelligenceGate.brandSuppressed &&
                hasBrandEvidenceForCommerce(
                  completedResponseWithAttributes.identification as Record<string, unknown> | undefined,
                ),
            }
            : {}),
          ...(relevanceEnabled && intelligenceGate
            ? {
              relevanceEnabled: true,
              relevanceRoute: commerceCategoryRoute,
              qualityBand: intelligenceGate.qualityBand,
            }
            : {}),
          ...(commerceIdentityEnabled && intelligenceGate
            ? {
              commerceIdentityEnabled: true,
              commerceIdentity: intelligenceGate.commerceIdentity,
              commerceRetrievalEnabled,
            }
            : {}),
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
      commerceDurationMs = Date.now() - commerceStartedAt;

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
        if (relevanceEnabled && commerce.qualityTune) {
          commerceRelevanceStats = {
            fallbackUsed: commerce.qualityTune.fallbackUsed,
            productsBeforeDedupe: commerce.qualityTune.productsBeforeDedupe,
            productsAfterDedupe: commerce.qualityTune.productsAfterDedupe,
            categoryMismatchRemovals: commerce.qualityTune.categoryMismatchRemovals,
            productsBeforeFilter: commerce.qualityTune.productsBeforeFilter,
            retailerCount: commerce.qualityTune.retailerCount,
          };
        }
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

    const legacyFinalResponse = withSafeImageArrays(
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

    // ── Transitional response (Phase 2B.1) ──────────────────────────────────
    // Legacy fields are untouched and legacy requests receive exactly what they
    // received before. A V2 request additionally gets `contractVersion` and
    // `identificationV2`, both derived from the same normalized result.
    //
    // The result is validated AND checked for JSON safety before it is
    // attached. `undefined` is the failure that matters: it passes an in-memory
    // check and then silently deletes its key during serialization, so the
    // client receives a contract the server believed it had sent.
    let finalResponse: Record<string, unknown> = legacyFinalResponse;
    if (isV2Request) {
      const v2Validation = validateFashionIdentificationResultV2(v2Result);
      const unsafePath = findJsonUnsafePath(v2Result);
      if (v2Validation.ok && unsafePath === null) {
        finalResponse = buildTransitionalResponse(legacyFinalResponse, v2Result);
      } else {
        // Scrubbed category only — never the offending value, which would put
        // provider output into a log line.
        console.warn(
          '[scan-identify] v2_response_validation_failed category=%s jsonUnsafe=%s',
          v2Validation.ok ? 'json_unsafe' : v2Validation.category,
          String(unsafePath !== null),
        );
        // A V2 client still receives a bounded, parseable technical-failure
        // contract rather than an opaque 500 or a malformed identificationV2.
        finalResponse = buildTransitionalResponse(
          legacyFinalResponse,
          buildTechnicalFailureResultV2(internalRequest.requestId ?? scanId, v2EvidenceIds),
        );
      }
      logV2Telemetry(buildV2Telemetry({
        internal: internalRequest,
        evidenceCount: v2EvidenceIds.length,
        result: v2Result,
        commerce: commerceDecision,
        responseValidationOk: v2Validation.ok && unsafePath === null,
      }));
    }
    if (mode === 'image' && auth.isAuthenticated && captureScanArtifacts) {
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
      const requestModeLabel = useMultiItemDetectionProvider
        ? 'multi_item_detection'
        : useSelectedItemProvider
        ? 'selected_item'
        : mode === 'text'
        ? 'text'
        : 'legacy_single_item';
      const productCount = typeof shoppingMeta?.count === 'number'
        ? shoppingMeta.count
        : finalRecommendedProducts.length;
      const providerOutcome = typeof shoppingMeta?.provider === 'string' ? shoppingMeta.provider : null;
      const fallbackUsed = commerceRelevanceStats?.fallbackUsed ?? false;
      const beforeFilter = commerceRelevanceStats?.productsBeforeFilter ??
        commerceRelevanceStats?.productsBeforeDedupe ??
        productCount;
      const afterDedupe = commerceRelevanceStats?.productsAfterDedupe ?? productCount;
      const beforeDedupe = commerceRelevanceStats?.productsBeforeDedupe ?? productCount;
      const mismatchRemovals = commerceRelevanceStats?.categoryMismatchRemovals ?? 0;
      const retailerCount = commerceRelevanceStats?.retailerCount ?? new Set(
        finalRecommendedProducts
          .map((p) =>
            typeof (p as { source?: string }).source === 'string'
              ? (p as { source: string }).source
              : typeof (p as { retailer?: string }).retailer === 'string'
              ? (p as { retailer: string }).retailer
              : ''
          )
          .filter(Boolean),
      ).size;
      const failureReason = mapToFailureReason({
        providerOutcome,
        commercePrimaryEmpty: !fallbackUsed && productCount === 0 &&
          !(shoppingMeta as { commerceSkipped?: boolean } | undefined)?.commerceSkipped,
        commerceFallbackUsed: fallbackUsed && productCount > 0,
        commerceFallbackEmpty: fallbackUsed && productCount === 0,
        productFilterEmpty: beforeFilter > 0 && afterDedupe === 0,
        categoryMismatchRemoved: mismatchRemovals > 0,
        productDedupeReduction: beforeDedupe > afterDedupe,
      });

      logQualityTuneMetrics(buildQualityTuneMetrics({
        enabled: true,
        requestMode: requestModeLabel,
        totalDurationMs: elapsedMs,
        commerceDurationMs,
        providerOutcome,
        candidateCount: useMultiItemDetectionProvider ? detectedGarments.length : 1,
        genericLabelOccurrence: qualityGenericLabelOccurrence,
        normalizationCorrectionCount: qualityNormCorrectionCount,
        normalizationRuleIds: qualityNormRuleIds,
        primaryCommerceResultCount: productCount,
        fallbackQueryUsage: fallbackUsed,
        productsBeforeDedupe: beforeDedupe,
        productsAfterDedupe: afterDedupe,
        categoryMismatchRemovals: mismatchRemovals,
        emptyResultOccurrence: productCount === 0 ? 1 : 0,
        errorCategory: failureReason,
        ...(intelligenceEnabled && intelligenceGate
          ? {
            intelligence: {
              categoryRoute: commerceCategoryRoute,
              qualityScoreBand: intelligenceGate.qualityBand,
              qualityScoreValue: intelligenceGate.qualityScore,
              consistencyConflictCount: intelligenceGate.consistencyConflicts.length,
              suppressedAttributeCount: intelligenceGate.suppressedAttributes.length,
              commerceQueryDetailLevel: intelligenceGate.commerceQueryDetailLevel,
              brandSuppressed: intelligenceGate.brandSuppressed,
              materialSuppressed: intelligenceGate.materialSuppressed,
            },
          }
          : {}),
        ...(relevanceEnabled
          ? {
            commerceRelevance: {
              failureReason,
              productsBeforeFilter: beforeFilter,
              productsAfterFilter: afterDedupe,
              retailerCount,
              fallbackUsed,
              durationMs: commerceDurationMs ?? elapsedMs,
              intelligenceVersion: SCANNER_INTELLIGENCE_VERSION,
            },
          }
          : {}),
      }));
      console.log(
        '[scan-identify] quality_tune_version=%s enabled=true',
        QUALITY_TUNE_VERSION,
      );
      if (intelligenceEnabled) {
        console.log(
          '[scan-identify] scanner_intelligence_version=%s enabled=true route=%s band=%s score=%d',
          SCANNER_INTELLIGENCE_VERSION,
          commerceCategoryRoute,
          intelligenceGate?.qualityBand ?? 'n/a',
          intelligenceGate?.qualityScore ?? -1,
        );
      }
      if (relevanceEnabled) {
        console.log(
          '[scan-identify] commerce_relevance_version=%s enabled=true route=%s',
          COMMERCE_RELEVANCE_VERSION,
          commerceCategoryRoute,
        );
      }
      if (commerceIdentityEnabled) {
        // Grades only — never the brand string, model hypothesis, or any
        // free-text evidence, so this stays scrubbed of model-derived content.
        console.log(
          '[scan-identify] commerce_identity_version=%s enabled=true brand_grade=%s exact_grade=%s features=%d',
          COMMERCE_IDENTITY_VERSION,
          intelligenceGate?.commerceIdentity?.brandGrade ?? 'n/a',
          intelligenceGate?.commerceIdentity?.exactMatchGrade ?? 'n/a',
          intelligenceGate?.commerceIdentity?.distinctiveFeatures.length ?? 0,
        );
      }
      if (commerceRetrievalEnabled) {
        // Bounded strategy classification only — never the query string, which
        // the existing privacy policy keeps out of logs.
        console.log(
          '[scan-identify] commerce_retrieval_version=%s enabled=true route=%s',
          COMMERCE_RETRIEVAL_VERSION,
          commerceCategoryRoute,
        );
      }
      if (textScanParityEnabled && mode === 'text') {
        console.log(
          '[scan-identify] textscan_commerce_parity_version=%s enabled=true route=%s',
          TEXTSCAN_COMMERCE_PARITY_VERSION,
          commerceCategoryRoute,
        );
      }

      // Best-effort scrubbed outcome persistence — never blocks response.
      void captureCommerceOutcome({
        requestMode: requestModeLabel,
        sourceClass: typeof source === 'string' ? source : null,
        appPlatform,
        appVersion,
        status: 'completed',
        isFashion: true,
        categoryRoute: commerceCategoryRoute,
        qualityBand: intelligenceGate?.qualityBand ?? null,
        commerceQueryDetailLevel: intelligenceGate?.commerceQueryDetailLevel ?? null,
        providerOutcome,
        providersTried: Array.isArray((shoppingMeta as { providersTried?: string[] } | undefined)?.providersTried)
          ? (shoppingMeta as { providersTried: string[] }).providersTried
          : null,
        primaryResultCount: productCount,
        fallbackUsed,
        productsBeforeFilter: beforeFilter,
        productsAfterFilter: afterDedupe,
        productsBeforeDedupe: beforeDedupe,
        productsAfterDedupe: afterDedupe,
        categoryMismatchRemovals: mismatchRemovals,
        retailerCount,
        commerceDurationMs,
        totalDurationMs: Date.now() - requestStartedAt,
        failureReason,
        textScanParityEnabled: textScanParityEnabled && mode === 'text',
        correlationHash: typeof scanId === 'string' ? scanId.slice(0, 12) : null,
      });
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

function hasBrandEvidenceForCommerce(
  identification: Record<string, unknown> | null | undefined,
): boolean {
  if (!identification || typeof identification !== 'object') return false;
  if (identification.logo_detected === true) return true;
  return typeof identification.visible_brand_text === 'string' &&
    identification.visible_brand_text.trim().length > 0;
}

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
