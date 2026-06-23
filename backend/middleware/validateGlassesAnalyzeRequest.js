/**
 * Validates incoming requests for the glasses analyze debug endpoint.
 * Enforces:
 *   - POST only
 *   - application/json
 *   - required image field as a JPEG data URL
 *   - 8 MB payload ceiling
 *   - required Bearer token auth (when KSCAN_GLASSES_ANALYZE_ENABLED is true)
 *   - backend enabled flag (KSCAN_GLASSES_ANALYZE_ENABLED === 'true')
 *
 * Never logs image payloads or request bodies.
 */

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function validateGlassesAnalyzeRequest(req, _res, next) {
  if (req.method !== 'POST') {
    return next(Object.assign(new Error('METHOD_NOT_ALLOWED'), { status: 405 }));
  }

  if (!req.is || !req.is('application/json')) {
    return next(Object.assign(new Error('INVALID_JSON'), { status: 400 }));
  }

  const body = req.body || {};
  const { image, requestId, client } = body;

  if (typeof image !== 'string' || !image) {
    return next(Object.assign(new Error('MISSING_IMAGE'), { status: 400 }));
  }

  if (!image.startsWith('data:image/jpeg;base64,')) {
    return next(Object.assign(new Error('INVALID_IMAGE'), { status: 415 }));
  }

  if (image.length > MAX_IMAGE_BYTES) {
    return next(Object.assign(new Error('PAYLOAD_TOO_LARGE'), { status: 413 }));
  }

  // Config gate
  if (process.env.KSCAN_GLASSES_ANALYZE_ENABLED !== 'true') {
    return next(Object.assign(new Error('CONFIG_DISABLED'), { status: 503 }));
  }

  // Safety: enabled requires a token to prevent accidental unauthenticated exposure
  const expectedToken = process.env.KSCAN_GLASSES_ANALYZE_DEBUG_TOKEN;
  if (!expectedToken) {
    return next(Object.assign(new Error('CONFIG_DISABLED'), { status: 503 }));
  }

  const authHeader = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  if (authHeader !== expectedToken) {
    return next(Object.assign(new Error('UNAUTHORIZED'), { status: 401 }));
  }

  // Propagate safe metadata for downstream use
  req.glassesRequestId =
    typeof requestId === 'string' && requestId
      ? requestId
      : `glasses-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  req.glassesClient =
    typeof client === 'string' && client ? client : 'unknown';

  next();
}

module.exports = { validateGlassesAnalyzeRequest };
