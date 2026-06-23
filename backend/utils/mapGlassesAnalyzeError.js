/**
 * Maps internal errors to safe, HUD-safe HTTP responses.
 * Never leaks raw exception messages, stack traces, or payloads.
 */

const ERROR_CODES = {
  METHOD_NOT_ALLOWED: { status: 405, message: 'Method not allowed.' },
  INVALID_JSON: { status: 400, message: 'Invalid request format.' },
  MISSING_IMAGE: { status: 400, message: 'No image was provided.' },
  INVALID_IMAGE: { status: 415, message: 'The image could not be analyzed.' },
  PAYLOAD_TOO_LARGE: { status: 413, message: 'The image is too large.' },
  UNAUTHORIZED: { status: 401, message: 'Authentication failed.' },
  CONFIG_DISABLED: { status: 503, message: 'The backend is unavailable.' },
  MODEL_UNAVAILABLE: { status: 503, message: 'The image could not be analyzed.' },
  RATE_LIMITED: { status: 429, message: 'Too many requests. Please try again later.' },
  SAFE_BACKEND_FAILURE: { status: 500, message: 'The image could not be analyzed.' },
};

function mapGlassesAnalyzeError(err, requestId = '') {
  const code = (err && err.message) || 'SAFE_BACKEND_FAILURE';
  const mapped = ERROR_CODES[code] || ERROR_CODES.SAFE_BACKEND_FAILURE;

  return {
    status: (err && err.status) || mapped.status,
    body: {
      ok: false,
      requestId,
      error: {
        code: code in ERROR_CODES ? code : 'SAFE_BACKEND_FAILURE',
        message: mapped.message,
      },
    },
  };
}

module.exports = { mapGlassesAnalyzeError };
