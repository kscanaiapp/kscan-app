/**
 * Bounded K+ Early Access source/feature taxonomy (Build 34 K+ Early Access
 * Discovery + Measurement Shell, section 9).
 *
 * Every K+ entry point in the app is labeled with exactly one of these
 * values -- never an arbitrary free-form string -- so telemetry can never
 * accumulate an unbounded set of source dimensions. A value is included only
 * when a real, reachable client surface backs it; 'unknown' is the fallback
 * for anything that does not resolve to a known surface, never a raw string.
 */
export const KPLUS_SOURCES = [
  'packing',
  'wardrobe_concierge',
  'vto',
  'watchlist',
  'voice_scan',
  'closet_intelligence',
  'account',
  'unknown',
] as const;

export type KPlusSource = (typeof KPLUS_SOURCES)[number];

const KPLUS_SOURCE_SET = new Set<string>(KPLUS_SOURCES);

/** Normalizes any input to a bounded KPlusSource, never a raw string. */
export function toKPlusSource(value: string | null | undefined): KPlusSource {
  return typeof value === 'string' && KPLUS_SOURCE_SET.has(value)
    ? (value as KPlusSource)
    : 'unknown';
}
