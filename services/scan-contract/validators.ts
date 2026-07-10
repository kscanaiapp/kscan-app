import { SCAN_CONTRACT_VERSION } from './version';
import type { ScanRequest, ScanSource, ScanImageInput, ScanPrivacyContext, ScanDeviceContext } from './request';
import type { ScanResponse, ScanStatus } from './response';
import type { FashionAttributes } from './fashionAttributes';
import type { ProductMatch } from './productMatch';
import type { ScanErrorCode } from './errors';

const VALID_SOURCES: ScanSource[] = ['mobile_camera', 'mobile_upload', 'text_scan', 'wearable_mock'];
const VALID_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
const VALID_MODES: Array<ScanPrivacyContext['mode']> = ['passthrough', 'masked', 'metadata_only'];
const VALID_DEVICE_CLASSES: Array<ScanDeviceContext['deviceClass']> = [
  'mobile',
  'meta_glasses',
  'android_xr',
  'wearable_mock',
];
const VALID_STATUSES: ScanStatus[] = ['success', 'non_fashion', 'partial', 'error'];
const VALID_ERROR_CODES: ScanErrorCode[] = [
  'INVALID_REQUEST',
  'IMAGE_TOO_LARGE',
  'UNSUPPORTED_IMAGE_TYPE',
  'PRIVACY_SANITIZATION_REQUIRED',
  'ANALYSIS_TIMEOUT',
  'PROVIDER_UNAVAILABLE',
  'NON_FASHION_INPUT',
  'RATE_LIMITED',
  'AUTH_REQUIRED',
  'UNKNOWN_ERROR',
];

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

function addError(errors: string[], message: string): void {
  errors.push(message);
}

export function validateScanRequest(value: unknown): ValidationResult {
  const errors: string[] = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, errors: ['Request must be an object.'] };
  }
  const req = value as Record<string, unknown>;

  if (req.contractVersion !== SCAN_CONTRACT_VERSION) {
    addError(errors, `contractVersion must be "${SCAN_CONTRACT_VERSION}".`);
  }

  if (typeof req.requestId !== 'string' || !req.requestId.trim()) {
    addError(errors, 'requestId must be a non-empty string.');
  }

  if (!VALID_SOURCES.includes(req.source as ScanSource)) {
    addError(errors, `source must be one of: ${VALID_SOURCES.join(', ')}.`);
  }

  const hasImage = validateImageInput(req.image, errors, false);
  const hasText = typeof req.textQuery === 'string' && req.textQuery.trim().length > 0;

  if (!hasImage && !hasText) {
    addError(errors, 'Request must include a valid image or a non-empty textQuery.');
  }

  validatePrivacyContext(req.privacy, errors);
  if (req.device !== undefined) {
    validateDeviceContext(req.device, errors);
  }

  return { valid: errors.length === 0, errors };
}

function validateImageInput(value: unknown, errors: string[], required: boolean): boolean {
  if (value === undefined) {
    if (required) addError(errors, 'image is required.');
    return false;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    addError(errors, 'image must be an object when provided.');
    return false;
  }
  const img = value as Record<string, unknown>;
  if (typeof img.base64 !== 'string' || !img.base64.trim()) {
    addError(errors, 'image.base64 must be a non-empty string.');
    return false;
  }
  if (!VALID_IMAGE_MIME_TYPES.includes(img.mimeType as typeof VALID_IMAGE_MIME_TYPES[number])) {
    addError(errors, `image.mimeType must be one of: ${VALID_IMAGE_MIME_TYPES.join(', ')}.`);
  }
  if (img.width !== undefined && (typeof img.width !== 'number' || !Number.isInteger(img.width) || img.width <= 0)) {
    addError(errors, 'image.width must be a positive integer.');
  }
  if (img.height !== undefined && (typeof img.height !== 'number' || !Number.isInteger(img.height) || img.height <= 0)) {
    addError(errors, 'image.height must be a positive integer.');
  }
  return true;
}

function validatePrivacyContext(value: unknown, errors: string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    addError(errors, 'privacy must be an object.');
    return;
  }
  const privacy = value as Record<string, unknown>;
  if (typeof privacy.sanitizerVersion !== 'string' || !privacy.sanitizerVersion.trim()) {
    addError(errors, 'privacy.sanitizerVersion must be a non-empty string.');
  }
  if (!VALID_MODES.includes(privacy.mode as ScanPrivacyContext['mode'])) {
    addError(errors, `privacy.mode must be one of: ${VALID_MODES.join(', ')}.`);
  }
  if (typeof privacy.faceDetectionPerformed !== 'boolean') {
    addError(errors, 'privacy.faceDetectionPerformed must be a boolean.');
  }
  if (typeof privacy.faceMaskApplied !== 'boolean') {
    addError(errors, 'privacy.faceMaskApplied must be a boolean.');
  }
}

function validateDeviceContext(value: unknown, errors: string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    addError(errors, 'device must be an object when provided.');
    return;
  }
  const device = value as Record<string, unknown>;
  if (!VALID_DEVICE_CLASSES.includes(device.deviceClass as ScanDeviceContext['deviceClass'])) {
    addError(errors, `device.deviceClass must be one of: ${VALID_DEVICE_CLASSES.join(', ')}.`);
  }
}

export function validateScanResponse(value: unknown): ValidationResult {
  const errors: string[] = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, errors: ['Response must be an object.'] };
  }
  const resp = value as Record<string, unknown>;

  if (resp.contractVersion !== SCAN_CONTRACT_VERSION) {
    addError(errors, `contractVersion must be "${SCAN_CONTRACT_VERSION}".`);
  }
  if (typeof resp.requestId !== 'string' || !resp.requestId.trim()) {
    addError(errors, 'requestId must be a non-empty string.');
  }
  if (!VALID_STATUSES.includes(resp.status as ScanStatus)) {
    addError(errors, `status must be one of: ${VALID_STATUSES.join(', ')}.`);
  }

  if (resp.attributes !== undefined) {
    validateFashionAttributes(resp.attributes, errors);
  }
  if (resp.products !== undefined) {
    validateProductArray(resp.products, errors);
  }
  if (resp.error !== undefined) {
    validateScanError(resp.error, errors);
  }

  return { valid: errors.length === 0, errors };
}

function validateFashionAttributes(value: unknown, errors: string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    addError(errors, 'attributes must be an object when provided.');
    return;
  }
  const attrs = value as Record<string, unknown>;
  const stringKeys: (keyof FashionAttributes)[] = [
    'category',
    'subcategory',
    'silhouette',
    'fit',
    'color',
    'pattern',
    'materialEstimate',
    'texture',
  ];
  for (const key of stringKeys) {
    const v = attrs[key];
    if (v !== undefined && (typeof v !== 'string' || !v.trim())) {
      addError(errors, `attributes.${String(key)} must be a non-empty string when provided.`);
    }
  }
  const arrayKeys: (keyof FashionAttributes)[] = ['colorPalette', 'styleTags', 'seasonality', 'occasionTags'];
  for (const key of arrayKeys) {
    const v = attrs[key];
    if (v !== undefined && !Array.isArray(v)) {
      addError(errors, `attributes.${String(key)} must be an array when provided.`);
    }
  }
  if (attrs.confidence !== undefined && (typeof attrs.confidence !== 'number' || !Number.isFinite(attrs.confidence))) {
    addError(errors, 'attributes.confidence must be a finite number when provided.');
  }
}

function validateProductArray(value: unknown, errors: string[]): void {
  if (!Array.isArray(value)) {
    addError(errors, 'products must be an array when provided.');
    return;
  }
  for (let i = 0; i < value.length; i++) {
    validateProductMatch(value[i], errors, i);
  }
}

function validateProductMatch(value: unknown, errors: string[], index: number): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    addError(errors, `products[${index}] must be an object.`);
    return;
  }
  const p = value as Record<string, unknown>;
  if (typeof p.title !== 'string' || !p.title.trim()) {
    addError(errors, `products[${index}].title is required.`);
  }
  if (typeof p.retailer !== 'string' || !p.retailer.trim()) {
    addError(errors, `products[${index}].retailer is required.`);
  }
  if (p.price !== undefined && (typeof p.price !== 'number' || !Number.isFinite(p.price) || p.price < 0)) {
    addError(errors, `products[${index}].price must be a non-negative number.`);
  }
}

function validateScanError(value: unknown, errors: string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    addError(errors, 'error must be an object when provided.');
    return;
  }
  const err = value as Record<string, unknown>;
  if (!VALID_ERROR_CODES.includes(err.code as ScanErrorCode)) {
    addError(errors, `error.code must be one of: ${VALID_ERROR_CODES.join(', ')}.`);
  }
  if (typeof err.message !== 'string' || !err.message.trim()) {
    addError(errors, 'error.message must be a non-empty string.');
  }
}

// Lightweight type guards for consumers that prefer guards over validators.
export function isScanSource(value: unknown): value is ScanSource {
  return typeof value === 'string' && VALID_SOURCES.includes(value as ScanSource);
}

export function isScanStatus(value: unknown): value is ScanStatus {
  return typeof value === 'string' && VALID_STATUSES.includes(value as ScanStatus);
}
