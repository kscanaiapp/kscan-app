/**
 * GlassesAnalyzeService interface.
 *
 * RealGlassesAnalyzeService proxies to the existing K Scan backend /api/analyze
 * so the model client, prompt, and product matching are reused without duplication.
 *
 * MockGlassesAnalyzeService returns a safe HUD-ready response for debug smoke tests.
 *
 * To plug in a direct model client (e.g., Gemini or OpenRouter) instead of proxying:
 *   1. Implement a new class (e.g., DirectGlassesAnalyzeService) extending GlassesAnalyzeService.
 *   2. In createGlassesAnalyzeService(), return it when the relevant env vars are set.
 *   3. Ensure the direct client does not log images, prompts, or raw responses.
 */

class GlassesAnalyzeService {
  async analyze(_payload) {
    throw Object.assign(new Error('SAFE_BACKEND_FAILURE'), { status: 500 });
  }
}

/**
 * Fail-closed service used when the debug endpoint is disabled.
 * Never returns mock success for a disabled configuration.
 */
class DisabledGlassesAnalyzeService extends GlassesAnalyzeService {
  async analyze(_payload) {
    throw Object.assign(new Error('CONFIG_DISABLED'), { status: 503 });
  }
}

class MockGlassesAnalyzeService extends GlassesAnalyzeService {
  constructor(options = {}) {
    super();
    this.model = options.model || 'mock';
  }

  async analyze(payload) {
    const requestId = payload.requestId || `glasses-mock-${Date.now()}`;
    return {
      ok: true,
      requestId,
      result: {
        title: 'Mock Fashion Analysis',
        summary: 'This is a safe mock response for the glasses smoke test.',
        confidence: 0.0,
        attributes: [
          { name: 'category', value: 'jacket' },
          { name: 'color', value: 'black' },
          { name: 'silhouette', value: 'oversized' },
        ],
        suggestions: ['Pair with slim jeans for a clean look.'],
        safeForHud: true,
      },
      meta: {
        source: 'debug-backend',
        mode: 'debug',
        model: this.model,
      },
    };
  }
}

/**
 * Strips a data-URL prefix so upstream /api/analyze receives bare base64
 * (see shared/api-contract.md). Non-data-URL strings are returned unchanged.
 */
function toBareBase64(image) {
  if (typeof image !== 'string') return image;
  const match = /^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/s.exec(image);
  return match ? match[1] : image;
}

class RealGlassesAnalyzeService extends GlassesAnalyzeService {
  constructor(options = {}) {
    super();
    this.backendUrl = options.backendUrl;
    this.model = options.model || 'unknown';
  }

  async analyze(payload) {
    if (!this.backendUrl || !this.backendUrl.startsWith('https://')) {
      throw Object.assign(new Error('MODEL_UNAVAILABLE'), { status: 503 });
    }

    // Proxy to the existing K Scan backend /api/analyze
    // 15-second timeout to prevent indefinite hangs; never logs payloads or raw responses.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`${this.backendUrl}/api/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: toBareBase64(payload.image) }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        if (response.status === 429) {
          throw Object.assign(new Error('RATE_LIMITED'), { status: 429 });
        }
        throw Object.assign(new Error('MODEL_UNAVAILABLE'), { status: 503 });
      }

      let data;
      try {
        data = await response.json();
      } catch {
        throw Object.assign(new Error('SAFE_BACKEND_FAILURE'), { status: 500 });
      }

      const requestId = payload.requestId || `glasses-${Date.now()}`;
      const isFashion = data && data.type === 'fashion';

      return {
        ok: true,
        requestId,
        result: {
          title: isFashion ? 'Fashion Match' : 'Non-Fashion',
          summary: isFashion
            ? String(data.result || 'Fashion item detected.').slice(0, 120)
            : String(data.message || 'Not a fashion item.').slice(0, 120),
          confidence: 0.0,
          attributes:
            isFashion && data.metadata
              ? Object.entries(data.metadata)
                  .filter(([, v]) => v)
                  .map(([name, value]) => ({
                    name,
                    value: String(value).slice(0, 30),
                  }))
              : [],
          suggestions:
            Array.isArray(data.products) && data.products.length > 0
              ? data.products.slice(0, 2).map((p) => {
                  const line = `Top pick: ${p.name || 'Product'} (${p.retailer || 'Unknown'})`;
                  return line.slice(0, 60);
                })
              : [],
          safeForHud: true,
        },
        meta: {
          source: 'debug-backend',
          mode: 'debug',
          model: this.model,
        },
      };
    } catch (err) {
      clearTimeout(timeout);
      if (err.name === 'AbortError') {
        throw Object.assign(new Error('MODEL_UNAVAILABLE'), { status: 503 });
      }
      throw err;
    }
  }
}

function createGlassesAnalyzeService() {
  const enabled = process.env.KSCAN_GLASSES_ANALYZE_ENABLED === 'true';
  const backendUrl = process.env.KSCAN_GLASSES_ANALYZE_BACKEND_URL;
  const model = process.env.KSCAN_GLASSES_ANALYZE_MODEL || 'mock';

  if (!enabled) {
    // Validation middleware should already block this; keep fail-closed defensive fallback.
    return new DisabledGlassesAnalyzeService();
  }

  if (backendUrl) {
    return new RealGlassesAnalyzeService({ backendUrl, model });
  }

  return new MockGlassesAnalyzeService({ model });
}

module.exports = {
  GlassesAnalyzeService,
  DisabledGlassesAnalyzeService,
  MockGlassesAnalyzeService,
  RealGlassesAnalyzeService,
  createGlassesAnalyzeService,
  toBareBase64,
};
