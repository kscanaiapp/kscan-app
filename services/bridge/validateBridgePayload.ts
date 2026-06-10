/**
 * Bridge capture payload validation (Phase 16 alpha).
 *
 * Mirrors the glasses web app `capturePhoto()` boundary: only
 * `data:image/jpeg;base64,...` capture payloads are accepted.
 *
 * Privacy rules enforced here:
 * - Never log the raw payload.
 * - Never include the raw payload (or fragments of it) in thrown errors.
 *
 * Scope note: this is syntax validation only. A syntactically valid
 * `data:image/jpeg;base64,...` string whose base64 bytes are not a real
 * JPEG passes here and may fail later in image decode/sanitizer stages
 * downstream. Backend upload must never receive unsanitized images; no
 * upload happens in this phase.
 */

export const JPEG_DATA_URL_PREFIX = 'data:image/jpeg;base64,';

export class InvalidCapturePayloadError extends Error {
  code: 'INVALID_CAPTURE_RESPONSE';

  constructor(reason: string) {
    // `reason` must be a static description, never payload content.
    super(`Invalid capture payload: ${reason}`);
    this.name = 'InvalidCapturePayloadError';
    this.code = 'INVALID_CAPTURE_RESPONSE';
  }
}

/**
 * Validates and normalizes a bridge capture image payload.
 * Returns the trimmed payload string when valid.
 * Throws InvalidCapturePayloadError (code INVALID_CAPTURE_RESPONSE) when not.
 */
export function validateBridgePayload(payload: unknown): string {
  if (typeof payload !== 'string') {
    throw new InvalidCapturePayloadError('payload is not a string');
  }

  const normalized = payload.trim();

  if (normalized.length === 0) {
    throw new InvalidCapturePayloadError('payload is empty');
  }

  // Exact, case-sensitive prefix match. No PNG, HEIC/HEIF, blob URLs,
  // remote URLs, or raw base64 without the data-URL prefix.
  if (!normalized.startsWith(JPEG_DATA_URL_PREFIX)) {
    throw new InvalidCapturePayloadError(
      'payload does not start with the required JPEG data URL prefix'
    );
  }

  if (normalized.length <= JPEG_DATA_URL_PREFIX.length) {
    throw new InvalidCapturePayloadError('payload has no data after the base64 comma');
  }

  return normalized;
}

/** Non-throwing variant for callers that prefer a boolean check. */
export function isValidBridgePayload(payload: unknown): boolean {
  try {
    validateBridgePayload(payload);
    return true;
  } catch {
    return false;
  }
}
