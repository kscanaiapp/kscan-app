/**
 * Deno-safe gateway contract aligned with root types/aiGateway.ts.
 * No Node/Expo/browser dependencies. Pure TypeScript types and constants.
 */

export const AI_GATEWAY_API_VERSION = "1.0" as const;

export type KScanAISurface = 'mobile_scan' | 'text_scan' | 'style_match' | 'xr_debug' | 'debug';
export type KScanAIInputType = 'image' | 'text' | 'mixed';
export type KScanAIStatus = 'success' | 'partial' | 'fallback' | 'error';
export type KScanAIProvider = 'gemini' | 'openrouter' | 'llama' | 'local' | 'mock' | 'fallback' | 'unknown';
export type KScanAIMaskingMode = 'none' | 'pass_through' | 'blur' | 'pixelate' | 'redact' | 'unknown';

export type KScanAIPrivacy = {
  piiMasked: boolean;
  rawImageSent: boolean;
  maskingMode?: KScanAIMaskingMode;
  privacyVerifiedBy?: string;
  privacyVerified?: boolean;
  legacyLocalPrivacyFiltered?: boolean;
};

export type KScanAIInput = {
  imageBase64?: string;
  imageMimeType?: string;
  textQuery?: string;
  imageBytes?: number;
};

export type KScanAIIntent = {
  declaredGoal?: string;
  inferredGoal?: string;
  nextActions?: string[];
};

export type KScanAISession = {
  scanSessionId?: string;
  conversationId?: string;
  roomId?: string;
  sharedByUserId?: string;
  priorContext?: Record<string, unknown>;
};

export type KScanAIClient = {
  clientVersion?: string;
  platform?: string;
  deviceId?: string;
};

export type KScanFashionItem = {
  category?: string;
  itemType?: string;
  silhouette?: string;
  colorPalette?: string[];
  materialEstimate?: string;
  pattern?: string;
  texture?: string;
  styleTags?: string[];
  occasion?: string;
  confidenceScore?: number;
};

export type KScanAIProduct = {
  id?: string;
  name?: string;
  brand?: string;
  category?: string;
  price?: string;
  currency?: string;
  productUrl?: string;
  imageUrl?: string;
  matchScore?: number;
  source?: string;
};

export type KScanAIError = {
  code: string;
  userMessage: string;
  debugMessage?: string;
  recoverable: boolean;
  retryAfterMs?: number;
};

export type KScanAISource = {
  primary: KScanAIProvider;
  fallbackFrom?: KScanAIProvider;
  modelName?: string;
  modelVersion?: string;
};

export type KScanAITelemetry = {
  requestId: string;
  surface: KScanAISurface;
  inputType: KScanAIInputType;
  latencyMs?: number;
  providerLatencyMs?: number;
  fallbackUsed?: boolean;
  privacyVerified?: boolean;
  privacyWarnings?: string[];
  errorCodes?: string[];
  provider?: KScanAIProvider;
  apiVersion: string;
};

export type KScanAIRequest = {
  apiVersion: typeof AI_GATEWAY_API_VERSION;
  requestId: string;
  surface: KScanAISurface;
  inputType: KScanAIInputType;
  privacy: KScanAIPrivacy;
  input: KScanAIInput;
  intent?: KScanAIIntent;
  session?: KScanAISession;
  client?: KScanAIClient;
  timestamp?: string;
};

export type KScanAIResponse = {
  apiVersion: typeof AI_GATEWAY_API_VERSION;
  requestId: string;
  status: KScanAIStatus;
  source: KScanAISource;
  fashionAnalysis: {
    items: KScanFashionItem[];
    styleAttributes?: Record<string, unknown>;
    summary?: string;
  };
  userIntent: KScanAIIntent;
  products: KScanAIProduct[];
  errors: KScanAIError[];
  telemetry: KScanAITelemetry;
};

export type KScanAIValidationResult =
  | { ok: true; value: KScanAIRequest }
  | { ok: false; response: KScanAIResponse };

// Limits
export const MAX_GATEWAY_TEXT_LENGTH = 1000;
export const MAX_GATEWAY_IMAGE_BYTES = 5 * 1024 * 1024;
export const GATEWAY_ALLOWED_IMAGE_MIME_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp'];
