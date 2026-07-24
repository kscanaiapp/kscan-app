/**
 * Backend Scanner Quality Tune control (v120).
 *
 * disabled → exact v119-equivalent behavior
 * enabled  → fashion precision, taxonomy recovery, commerce query/filter tune
 *
 * Rollback without redeploy: set BACKEND_QUALITY_TUNE_ENABLED=false
 * (same env-gate pattern as SCAN_MULTI_ITEM_ENABLED).
 */

export const QUALITY_TUNE_VERSION = 'v120';

/** Named configurable commerce fallback threshold (valid products). */
export const QUALITY_TUNE_MIN_VALID_PRODUCTS = 3;

/**
 * Default for this release once deployed. Env override wins:
 *   BACKEND_QUALITY_TUNE_ENABLED=false → disabled (v119-equivalent)
 *   BACKEND_QUALITY_TUNE_ENABLED=true  → enabled
 */
export const QUALITY_TUNE_DEFAULT_ENABLED = true;

export function isQualityTuneEnabled(
  envGet: (key: string) => string | undefined = (key) => {
    try {
      return Deno.env.get(key);
    } catch {
      return undefined;
    }
  },
): boolean {
  const raw = envGet('BACKEND_QUALITY_TUNE_ENABLED')?.trim().toLowerCase();
  if (raw === 'false' || raw === '0' || raw === 'off' || raw === 'no') return false;
  if (raw === 'true' || raw === '1' || raw === 'on' || raw === 'yes') return true;
  return QUALITY_TUNE_DEFAULT_ENABLED;
}

export function qualityTuneTreatmentBucket(enabled: boolean): 'quality_tune_on' | 'quality_tune_off' {
  return enabled ? 'quality_tune_on' : 'quality_tune_off';
}
