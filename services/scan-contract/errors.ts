/**
 * Stable, user-safe error codes for the shared scan contract.
 *
 * These codes are returned to clients. They must never expose stack traces,
 * API keys, internal URLs, raw provider errors, database details, or tokens.
 */
export type ScanErrorCode =
  | 'INVALID_REQUEST'
  | 'IMAGE_TOO_LARGE'
  | 'UNSUPPORTED_IMAGE_TYPE'
  | 'PRIVACY_SANITIZATION_REQUIRED'
  | 'ANALYSIS_TIMEOUT'
  | 'PROVIDER_UNAVAILABLE'
  | 'NON_FASHION_INPUT'
  | 'RATE_LIMITED'
  | 'AUTH_REQUIRED'
  | 'UNKNOWN_ERROR';

export interface ScanError {
  code: ScanErrorCode;
  message: string;
}

/**
 * Default user-facing message for each error code.
 */
export function defaultErrorMessage(code: ScanErrorCode): string {
  switch (code) {
    case 'INVALID_REQUEST':
      return 'We could not understand that request. Please try again.';
    case 'IMAGE_TOO_LARGE':
      return 'The image is too large. Please use a smaller photo.';
    case 'UNSUPPORTED_IMAGE_TYPE':
      return 'That image format is not supported.';
    case 'PRIVACY_SANITIZATION_REQUIRED':
      return 'Privacy sanitization is required before this scan can continue.';
    case 'ANALYSIS_TIMEOUT':
      return 'Analysis took too long. Please try again.';
    case 'PROVIDER_UNAVAILABLE':
      return 'The analysis service is unavailable. Please try again later.';
    case 'NON_FASHION_INPUT':
      return 'This does not appear to be a fashion item. Try scanning clothing, shoes, bags, or accessories.';
    case 'RATE_LIMITED':
      return 'Too many scans. Please wait a moment and try again.';
    case 'AUTH_REQUIRED':
      return 'Please sign in to scan and identify fashion items.';
    case 'UNKNOWN_ERROR':
    default:
      return "We couldn't complete this scan. Please try again.";
  }
}

export function createScanError(code: ScanErrorCode, message?: string): ScanError {
  return {
    code,
    message: message ?? defaultErrorMessage(code),
  };
}
