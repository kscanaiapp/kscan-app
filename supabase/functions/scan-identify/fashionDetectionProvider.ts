// fashionDetectionProvider.ts — Optional COMMERCE enrichment only (Phase 3).
//
// Does NOT replace Gemini Scanner identification and is never authoritative
// for category, brand, item detection, or multi-item segmentation. Fix #9
// does not reopen Scanner accuracy.
//
// Provider history during Phase 3 contract discovery:
//   - fashion-detection-api-recognize-clothing-with-labels.p.rapidapi.com
//     (the host originally named for this role) returned HTTP 502 "The API
//     is unreachable" on every attempt (form-urlencoded, JSON, and multipart
//     bodies all tried) — confirmed upstream outage, independently
//     reproduced by the project owner.
//   - fashion4.p.rapidapi.com POST /v2/results was supplied as a working
//     replacement and IS live: it returns per-garment bounding boxes plus
//     classified labels with confidence scores (e.g. {"shirt":0.95}). This
//     adapter targets that host.
//
// Same privacy boundary as Similar Clothes applies: this endpoint also takes
// an image URL (`url=<image>`), and K Scan has no governed sanitized-image
// transport to hand a third-party vendor today (see
// similarClothesProvider.ts). BLOCKED_BY_PRIVACY_TRANSPORT applies equally
// here — implemented and contract-verified, not wired into the live path.
//
// The RapidAPI subscription observed during probing had a 25-credit total
// quota (20 remaining after ~5 calls) — this is not a call to make casually
// or on every scan even once enabled.
//
// Backend-only. No API keys, headers, raw provider payloads, or user PII are
// logged or returned to the mobile app.

// ── Types ────────────────────────────────────────────────────────────────────

export type FashionDetectionGarment = {
  /** Normalized 0-1 [x, y, width, height], as returned by the provider. */
  box: [number, number, number, number];
  label: string;
  confidence: number;
};

export type FashionDetectionResult = {
  garments: FashionDetectionGarment[];
  provider: 'fashion4';
  errorType?: string;
};

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_HOST = 'fashion4.p.rapidapi.com';
const PROVIDER_TIMEOUT_MS = 6_000;
const MAX_GARMENTS = 12;

// ── Env access (Deno) ────────────────────────────────────────────────────────

function readEnv(name: string): string | undefined {
  try {
    // deno-lint-ignore no-explicit-any
    const env = (globalThis as any)?.Deno?.env;
    const v = env?.get?.(name);
    return typeof v === 'string' ? v.trim() : undefined;
  } catch {
    return undefined;
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function readApiKey(): { key: string | undefined; keySource: string } {
  const dedicated = readEnv('FASHION4_RAPIDAPI_KEY');
  if (dedicated) return { key: dedicated, keySource: 'FASHION4_RAPIDAPI_KEY' };
  const shared = readEnv('RAPIDAPI_KEY');
  if (shared) return { key: shared, keySource: 'RAPIDAPI_KEY' };
  return { key: undefined, keySource: 'missing' };
}

/** Same BLOCKED_BY_PRIVACY_TRANSPORT reasoning as similarClothesProvider.ts. */
function isEnabled(): boolean {
  return readEnv('FASHION4_ENABLED')?.toLowerCase() === 'true';
}

function getHost(): string {
  return readEnv('FASHION4_RAPIDAPI_HOST') || DEFAULT_HOST;
}

function logFashion4(status: number, latencyMs: number, count: number, keySource: string, errorType?: string): void {
  console.log(
    '[FashionDetectionProvider] status=%d latencyMs=%d count=%d keySource=%s error=%s',
    status,
    latencyMs,
    count,
    keySource,
    errorType ?? 'none',
  );
}

// ── Response mapping ─────────────────────────────────────────────────────────

function isBox(v: unknown): v is [number, number, number, number] {
  return Array.isArray(v) && v.length === 4 && v.every((n) => typeof n === 'number' && Number.isFinite(n));
}

function mapEntities(entities: unknown, out: FashionDetectionGarment[]): void {
  if (!Array.isArray(entities)) return;
  for (const entity of entities) {
    if (out.length >= MAX_GARMENTS) return;
    if (!entity || typeof entity !== 'object') continue;
    const e = entity as Record<string, unknown>;
    if (e.kind === 'objects' && Array.isArray(e.objects)) {
      for (const obj of e.objects) {
        if (out.length >= MAX_GARMENTS) return;
        if (!obj || typeof obj !== 'object') continue;
        const o = obj as Record<string, unknown>;
        if (!isBox(o.box)) continue;
        const classEntity = Array.isArray(o.entities)
          ? (o.entities as unknown[]).find(
            (x) => x && typeof x === 'object' && (x as Record<string, unknown>).kind === 'classes',
          )
          : undefined;
        const classes = classEntity && typeof classEntity === 'object'
          ? (classEntity as Record<string, unknown>).classes
          : undefined;
        if (!classes || typeof classes !== 'object') continue;
        let bestLabel: string | undefined;
        let bestScore = 0;
        for (const [label, score] of Object.entries(classes as Record<string, unknown>)) {
          if (typeof score === 'number' && score > bestScore) {
            bestScore = score;
            bestLabel = label;
          }
        }
        if (bestLabel) {
          out.push({ box: o.box as [number, number, number, number], label: bestLabel, confidence: bestScore });
        }
      }
    }
  }
}

// ── Public entry point ───────────────────────────────────────────────────────

/**
 * Detect per-garment bounding boxes and labels for a sanitized image URL.
 *
 * `sanitizedImageUrl` must already be a K Scan-governed, sanitized-image URL
 * — see the privacy note in the header. No caller supplies one today.
 */
export async function detectFashionGarments(
  sanitizedImageUrl: string,
): Promise<FashionDetectionResult> {
  const started = Date.now();

  if (!isEnabled()) {
    return { garments: [], provider: 'fashion4', errorType: 'disabled' };
  }

  const { key, keySource } = readApiKey();
  if (!key) {
    logFashion4(0, 0, 0, keySource, 'no_key');
    return { garments: [], provider: 'fashion4', errorType: 'no_key' };
  }

  const imageUrl = str(sanitizedImageUrl);
  if (!imageUrl) {
    return { garments: [], provider: 'fashion4', errorType: 'empty_image_url' };
  }

  const host = getHost();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);

  try {
    const res = await fetch(`https://${host}/v2/results`, {
      method: 'POST',
      headers: {
        'x-rapidapi-key': key,
        'x-rapidapi-host': host,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: `image=&url=${encodeURIComponent(imageUrl)}`,
      signal: controller.signal,
    });
    const latency = Date.now() - started;

    if (!res.ok) {
      let errorType = 'http_error';
      if (res.status === 401 || res.status === 403) errorType = 'auth_error';
      else if (res.status === 429) errorType = 'rate_limit';
      else if (res.status === 502) errorType = 'upstream_unavailable';
      else if (res.status >= 500) errorType = 'server_error';
      logFashion4(res.status, latency, 0, keySource, errorType);
      return { garments: [], provider: 'fashion4', errorType };
    }

    const data = await res.json().catch(() => null);
    const results = data && typeof data === 'object' ? (data as Record<string, unknown>).results : undefined;
    const first = Array.isArray(results) ? results[0] : undefined;
    if (!first || typeof first !== 'object') {
      logFashion4(res.status, latency, 0, keySource, 'invalid_json');
      return { garments: [], provider: 'fashion4', errorType: 'invalid_json' };
    }

    const garments: FashionDetectionGarment[] = [];
    mapEntities((first as Record<string, unknown>).entities, garments);
    logFashion4(res.status, latency, garments.length, keySource);
    return { garments, provider: 'fashion4' };
  } catch (err) {
    const latency = Date.now() - started;
    const errorType = err instanceof Error && err.name === 'AbortError' ? 'timeout' : 'network_error';
    logFashion4(0, latency, 0, keySource, errorType);
    return { garments: [], provider: 'fashion4', errorType };
  } finally {
    clearTimeout(timeout);
  }
}
