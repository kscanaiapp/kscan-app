/**
 * Backend Scanner Intelligence Layer control (v121).
 *
 * Builds on v120 quality tune:
 *   intelligence OFF → exact v120 behavior
 *   intelligence ON  → v120 quality tune + category-aware routing + quality gate
 *
 * Rollback without redeploy: set BACKEND_SCANNER_INTELLIGENCE_ENABLED=false
 * (same env-gate pattern as BACKEND_QUALITY_TUNE_ENABLED).
 *
 * Do not disable BACKEND_QUALITY_TUNE_ENABLED unless v120 itself is implicated.
 */

export const SCANNER_INTELLIGENCE_VERSION = 'v121';

/**
 * Default ON after validation for this release. Env override wins:
 *   BACKEND_SCANNER_INTELLIGENCE_ENABLED=false → disabled (v120-equivalent)
 *   BACKEND_SCANNER_INTELLIGENCE_ENABLED=true  → enabled
 */
export const SCANNER_INTELLIGENCE_DEFAULT_ENABLED = true;

export function isScannerIntelligenceEnabled(
  envGet: (key: string) => string | undefined = (key) => {
    try {
      return Deno.env.get(key);
    } catch {
      return undefined;
    }
  },
): boolean {
  const raw = envGet('BACKEND_SCANNER_INTELLIGENCE_ENABLED')?.trim().toLowerCase();
  if (raw === 'false' || raw === '0' || raw === 'off' || raw === 'no') return false;
  if (raw === 'true' || raw === '1' || raw === 'on' || raw === 'yes') return true;
  return SCANNER_INTELLIGENCE_DEFAULT_ENABLED;
}

export function scannerIntelligenceTreatmentBucket(
  enabled: boolean,
): 'scanner_intelligence_on' | 'scanner_intelligence_off' {
  return enabled ? 'scanner_intelligence_on' : 'scanner_intelligence_off';
}
