/**
 * Faithful, cited PORT of `supabase/functions/_shared/net/safeRemoteMedia.ts`
 * (SEC-KPLUS-002) into this Node/CommonJS package.
 *
 * `sourceLoad.ts`'s original comment anticipated exactly this: "A future
 * session wiring in READ_ONLY_REAL_PRODUCT https sources MUST reuse
 * safeRemoteMedia.ts's assertSafeRemoteMediaUrl validation rules ... that
 * function is Deno-only and unreachable from this Node package, so the
 * rules must be ported, not imported, and kept cited so the two do not
 * silently drift apart." That module is in fact NOT Deno-specific at the
 * source level (no `Deno.*` API is used anywhere in it — only `URL`,
 * `fetch`, `Response`, `AbortSignal`, all standard and present in Node 18+),
 * but it lives inside `supabase/functions/**`, which this Node package's
 * own `tsconfig.json` root excludes and which is deployed as a Deno Edge
 * Function with its own separate build/import-map pipeline — importing
 * across that boundary is not a supported path, hence a port rather than
 * an import, exactly as anticipated.
 *
 * DO NOT let this drift from the source file. Every function name,
 * rejection reason, and check below is deliberately identical to the
 * original. If the original changes, this must be re-ported, not
 * reinterpreted.
 */

/** Ports a legitimate public image host would serve on. */
const ALLOWED_PORTS = new Set(['', '443']);

/** 10 MiB — matches the source file's REMOTE_MEDIA_MAX_BYTES exactly. */
export const REMOTE_MEDIA_MAX_BYTES = 10 * 1024 * 1024;

export const ALLOWED_MEDIA_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
] as const;

export type SafeUrlRejection =
  | 'not_a_url'
  | 'scheme_not_https'
  | 'embedded_credentials'
  | 'port_not_allowed'
  | 'host_not_public';

export type SafeUrlOutcome =
  | { ok: true; url: string }
  | { ok: false; reason: SafeUrlRejection };

/** Ported verbatim from safeRemoteMedia.ts — see that file's own doc comment for the full rationale per check. */
export function isNonPublicHost(rawHost: string): boolean {
  const host = rawHost.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;

  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === 'localhost.localdomain') return true;
  if (!host.includes('.') && !host.includes(':')) return true;

  if (host === '::1' || host === '::') return true;
  if (host.startsWith('fe80:')) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;
  const mappedDotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
  if (mappedDotted) return isNonPublicHost(mappedDotted[1]);
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (mappedHex) {
    const high = Number.parseInt(mappedHex[1], 16);
    const low = Number.parseInt(mappedHex[2], 16);
    if (Number.isFinite(high) && Number.isFinite(low)) {
      const dotted = [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
      return isNonPublicHost(dotted);
    }
    return true;
  }
  if (host.startsWith('::ffff:')) return true;

  const quad = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (quad) {
    const [a, b] = [Number(quad[1]), Number(quad[2])];
    if ([a, b, Number(quad[3]), Number(quad[4])].some((n) => !Number.isFinite(n) || n > 255)) {
      return true;
    }
    if (a === 0 || a === 127 || a === 10) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 192 && b === 0) return true;
    if (a >= 224) return true;
    return false;
  }

  if (/^\d+$/.test(host)) return true;
  if (/^0x[0-9a-f]+$/.test(host)) return true;
  if (/^0\d+$/.test(host)) return true;

  return false;
}

/** Ported verbatim from safeRemoteMedia.ts. */
export function assertSafeRemoteMediaUrl(value: unknown): SafeUrlOutcome {
  if (typeof value !== 'string' || !value.trim()) {
    return { ok: false, reason: 'not_a_url' };
  }
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return { ok: false, reason: 'not_a_url' };
  }
  if (parsed.protocol !== 'https:') return { ok: false, reason: 'scheme_not_https' };
  if (parsed.username || parsed.password) return { ok: false, reason: 'embedded_credentials' };
  if (!ALLOWED_PORTS.has(parsed.port)) return { ok: false, reason: 'port_not_allowed' };
  if (isNonPublicHost(parsed.hostname)) return { ok: false, reason: 'host_not_public' };
  return { ok: true, url: parsed.toString() };
}

/** Ported verbatim from safeRemoteMedia.ts — manual redirect-following so every hop is re-validated. */
export async function resolveSafeRemoteMedia(
  value: unknown,
  deps: {
    fetch: typeof fetch;
    maxRedirects?: number;
    signal?: AbortSignal;
    maxBytes?: number;
  },
): Promise<
  | { ok: true; url: string; contentType: string | null; contentLength: number | null }
  | { ok: false; reason: SafeUrlRejection | 'too_many_redirects' | 'unreachable' | 'content_type_not_allowed' | 'too_large' }
> {
  const first = assertSafeRemoteMediaUrl(value);
  if (!first.ok) return first;

  const maxRedirects = deps.maxRedirects ?? 3;
  const maxBytes = deps.maxBytes ?? REMOTE_MEDIA_MAX_BYTES;
  let current = first.url;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    let response: Response;
    try {
      response = await deps.fetch(current, {
        method: 'HEAD',
        redirect: 'manual',
        signal: deps.signal,
      });
    } catch {
      return { ok: false, reason: 'unreachable' };
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return { ok: false, reason: 'unreachable' };
      let next: string;
      try {
        next = new URL(location, current).toString();
      } catch {
        return { ok: false, reason: 'not_a_url' };
      }
      const checked = assertSafeRemoteMediaUrl(next);
      if (!checked.ok) return checked;
      current = checked.url;
      continue;
    }

    if (!response.ok) return { ok: false, reason: 'unreachable' };

    const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (contentType && !(ALLOWED_MEDIA_CONTENT_TYPES as readonly string[]).includes(contentType)) {
      return { ok: false, reason: 'content_type_not_allowed' };
    }
    const lengthHeader = response.headers.get('content-length');
    const contentLength = lengthHeader !== null && /^\d+$/.test(lengthHeader)
      ? Number(lengthHeader)
      : null;
    if (contentLength !== null && contentLength > maxBytes) {
      return { ok: false, reason: 'too_large' };
    }

    return { ok: true, url: current, contentType: contentType || null, contentLength };
  }

  return { ok: false, reason: 'too_many_redirects' };
}
