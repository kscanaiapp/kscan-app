/**
 * Pure public-host test, kept in its own dependency-free module so the mobile
 * bundle and TypeScript graph can share the exact logic without pulling in the
 * rest of the server-side media fetcher. safeRemoteMedia re-exports it.
 */

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
