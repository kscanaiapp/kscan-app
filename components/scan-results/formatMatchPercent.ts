/**
 * Normalizes backend AI confidence values to a 0–100 percentage.
 *
 * Backends may return either a decimal (0.96) or a whole number (96).
 * Rules:
 *   - value ≤ 1   → multiply by 100
 *   - value > 1   → treat as already a percentage
 *   - clamp to [0, 100]
 *   - round to nearest integer
 */
export function formatMatchPercent(value?: number): number | null {
  if (typeof value !== 'number' || Number.isNaN(value)) return null;

  const normalized = value <= 1 ? value * 100 : value;
  return Math.max(0, Math.min(100, Math.round(normalized)));
}
