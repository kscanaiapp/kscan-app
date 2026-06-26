// services/privacyLensDetector.js
// K Scan AI — Privacy Lens Face Detection Adapter (Phase 2)
//
// This is an adapter boundary. It attempts optional real dependencies via dynamic import.
// If no real detector is available, it checks for dev-only mock mode.
// If neither is available, it returns { ok: false } so the orchestrator fails closed.
//
// No face metadata is logged, persisted, or transmitted outside the local pipeline.

// ── Feature flags ────────────────────────────────────────────────────────────
const PRIVACY_LENS_ALLOW_DEV_MOCKS = false;

const DEV_MOCKS_ENABLED =
  typeof __DEV__ !== 'undefined' &&
  __DEV__ === true &&
  PRIVACY_LENS_ALLOW_DEV_MOCKS === true;

// ── Safe errors ───────────────────────────────────────────────────────────────
const SAFE_ERRORS = Object.freeze({
  detectorUnavailable: 'Privacy Lens face detection is not available on this device.',
  detectorFailed: 'Privacy Lens face detection could not complete.',
});

// ── Detector interface ───────────────────────────────────────────────────────
/**
 * @typedef {Object} FaceBounds
 * @property {number} x Pixel x-coordinate relative to the image.
 * @property {number} y Pixel y-coordinate relative to the image.
 * @property {number} width Pixel width.
 * @property {number} height Pixel height.
 */

/**
 * @typedef {Object} FaceDetectionResult
 * @property {boolean} ok
 * @property {Array<{id: string, bounds: FaceBounds, confidence?: number}>} faces
 * @property {string} [reason]
 */

/**
 * Attempt to load a real face detector dependency.
 *
 * This is a future integration point for:
 *   - @react-native-mlkit/face-detection (MLKit still-image detector)
 *   - expo-face-detector (if ever restored in Expo SDK)
 *   - Custom native module wrapping Android MLKit / iOS Vision
 *
 * @returns {Promise<null|Function>}
 */
async function loadRealDetector() {
  // Attempt optional dependencies in order of preference.
  // Each is wrapped in try/catch so missing packages do not crash the bundle.

  const candidates = [
    // '@react-native-mlkit/face-detection',
    // 'expo-face-detector',
    // './privacyLensNativeDetector', // placeholder for custom native module
  ];

  for (const moduleName of candidates) {
    try {
      const mod = await import(/* webpackIgnore: true */ moduleName);
      if (mod && typeof mod.detectFaces === 'function') {
        return mod.detectFaces;
      }
      if (mod && typeof mod.default === 'function') {
        return mod.default;
      }
    } catch (_err) {
      // Dependency not installed — expected in this prototype phase.
      // Do not log the module name or error to avoid leaking dependency internals.
    }
  }

  return null;
}

// ── Mock detector (dev-only, opt-in) ────────────────────────────────────────
/**
 * Dev-only mock detector. Returns a single hardcoded face region.
 *
 * NEVER enable in production. Requires both __DEV__ and PRIVACY_LENS_ALLOW_DEV_MOCKS.
 *
 * @returns {FaceDetectionResult}
 */
function runMockDetector() {
  return {
    ok: true,
    faces: [
      {
        id: 'mock-face-001',
        bounds: { x: 60, y: 60, width: 120, height: 120 },
        confidence: 0.95,
      },
    ],
  };
}

// ── Public adapter ───────────────────────────────────────────────────────────
/**
 * Detect faces in an image for Privacy Lens processing.
 *
 * Rules:
 *   - Attempts real detector via dynamic import first.
 *   - Falls back to mock detector only if __DEV__ && PRIVACY_LENS_ALLOW_DEV_MOCKS.
 *   - Returns { ok: false } if no detector is available.
 *   - Never logs face coordinates, bounds, landmarks, or contours.
 *   - Never sends face metadata to backend, analytics, or crash reporting.
 *
 * @param {string} imagePayload base64 data URI or image reference string
 * @param {Object} [options]
 * @returns {Promise<FaceDetectionResult>}
 */
export async function detectFacesForPrivacyLens(imagePayload, options = {}) {
  // Validate input is a non-empty string
  if (!imagePayload || typeof imagePayload !== 'string') {
    return { ok: false, faces: [], reason: SAFE_ERRORS.detectorFailed };
  }

  // 1. Attempt real detector
  const realDetector = await loadRealDetector();
  if (realDetector) {
    try {
      // Real detector would be called here.
      // The real detector should return normalized or pixel bounds.
      // For now, since no real detector is wired, this path is unreachable.
      return { ok: false, faces: [], reason: SAFE_ERRORS.detectorUnavailable };
    } catch (_err) {
      return { ok: false, faces: [], reason: SAFE_ERRORS.detectorFailed };
    }
  }

  // 2. Dev-only mock fallback
  if (DEV_MOCKS_ENABLED) {
    return runMockDetector();
  }

  // 3. No detector available — orchestrator must treat this as fatal
  return { ok: false, faces: [], reason: SAFE_ERRORS.detectorUnavailable };
}
