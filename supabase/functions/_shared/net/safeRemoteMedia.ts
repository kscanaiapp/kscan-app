/**
 * SEC-KPLUS-002 — safety guard for caller-supplied remote media URLs.
 *
 * DELIBERATELY NARROW. This is not a general network-security framework: it is
 * the minimum needed so a URL that a CALLER chose cannot be used to make the
 * server fetch something it should not reach, or to hand an attacker-controlled
 * host to a paid third-party provider.
 *
 * Why it exists: vto-generate accepted any `garment.imageUrl` whose protocol was
 * `https:` and passed it straight to the provider. `https://127.0.0.1:9000/…`,
 * `https://169.254.169.254/latest/meta-data/…` and `https://10.0.0.5/…` all
 * satisfy that check.
 *
 * Retailer-neutral by design: there is no allowlist of retailers here. What is
 * rejected is network TOPOLOGY (loopback, private ranges, link-local/metadata,
 * odd ports, embedded credentials), never a brand.
 *
 * NOTE ON DUPLICATION. scan-identify's shoppingProvider.ts has its own
 * module-private isPrivateHost for commerce destinations, and the Watchlist has
 * its own eligibility check. Those are deliberately left alone: consolidating
 * them is a refactor with its own blast radius, and this repair is scoped to the
 * paid-provider boundary that the audit actually flagged. This module is the
 * shared home if that consolidation is done later.
 */

/** Ports a legitimate public image host would serve on. */
const ALLOWED_PORTS = new Set(['', '443']);

/** 10 MiB. A garment image far above this is not a garment image. */
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

/**
 * Hosts that must never be reachable from the server.
 *
 * Covers the textual forms an attacker can reach a private address through:
 * names, IPv4 dotted-quad ranges, IPv4-mapped IPv6, and the IPv6 loopback /
 * unique-local / link-local prefixes. Numeric obfuscations (decimal, octal and
 * hex integer literals) are rejected too, since `https://2130706433/` is
 * 127.0.0.1.
 */
export function isNonPublicHost(rawHost: string): boolean {
  const host = rawHost.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;

  // Names.
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === 'localhost.localdomain') return true;
  // A bare hostname with no dot cannot be a public DNS name.
  if (!host.includes('.') && !host.includes(':')) return true;

  // IPv6.
  if (host === '::1' || host === '::') return true;
  if (host.startsWith('fe80:')) return true;          // link-local
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;   // unique-local fc00::/7
  // IPv4-mapped IPv6. Note the URL parser REWRITES the dotted form into hex:
  // `[::ffff:127.0.0.1]` is normalized to `[::ffff:7f00:1]`, so matching only
  // the dotted spelling let loopback through. Handle both.
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
  // Any other ::ffff: form we cannot decode is refused rather than allowed.
  if (host.startsWith('::ffff:')) return true;

  // IPv4 dotted quad.
  const quad = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (quad) {
    const [a, b] = [Number(quad[1]), Number(quad[2])];
    if ([a, b, Number(quad[3]), Number(quad[4])].some((n) => !Number.isFinite(n) || n > 255)) {
      return true;
    }
    if (a === 0 || a === 127 || a === 10) return true;          // this-host, loopback, RFC1918
    if (a === 169 && b === 254) return true;                    // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;           // RFC1918
    if (a === 192 && b === 168) return true;                    // RFC1918
    if (a === 100 && b >= 64 && b <= 127) return true;          // CGNAT
    if (a === 192 && b === 0) return true;                      // IETF protocol assignments
    if (a >= 224) return true;                                  // multicast + reserved
    return false;
  }

  // A purely numeric host is an integer-encoded IPv4 (e.g. 2130706433).
  if (/^\d+$/.test(host)) return true;
  // Hex / octal integer forms.
  if (/^0x[0-9a-f]+$/.test(host)) return true;
  if (/^0\d+$/.test(host)) return true;

  return false;
}

/**
 * Validates a caller-supplied media URL. Returns the normalized URL string, or
 * the specific reason it was rejected. Fails closed on anything unparseable.
 */
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

/**
 * Follows redirects MANUALLY so every hop is re-validated.
 *
 * A public URL that 302s to 169.254.169.254 defeats a one-shot check, so the
 * final destination — and every intermediate one — must satisfy the same rules
 * as the original. Also enforces the declared content type and size.
 *
 * Returns the final safe URL; the caller passes THAT to the provider, never the
 * caller's original string.
 */
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
        // Manual, so a redirect target is re-validated rather than followed
        // blindly by the runtime.
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
      // A redirect that escapes to a prohibited host is rejected, not followed.
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
