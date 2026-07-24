/**
 * TextScan commerce router parity control (v123).
 *
 * Builds on repaired v122 commerce relevance:
 *   parity OFF → exact repaired-v122 TextScan behavior (getShoppingResults only)
 *   parity ON  → TextScan uses getScanCommerceResults (KicksCrew → Farfetch → Serper/Brave)
 *                with the v122 relevance stack
 *
 * Rollback without redeploy: set BACKEND_TEXTSCAN_COMMERCE_PARITY_ENABLED=false
 *
 * Activation depends on quality + intelligence + relevance all being ON
 * (wired by the caller).
 */

export const TEXTSCAN_COMMERCE_PARITY_VERSION = 'v123';

/**
 * Default ON after validation. Env override wins:
 *   BACKEND_TEXTSCAN_COMMERCE_PARITY_ENABLED=false → disabled (repaired-v122 TextScan)
 *   BACKEND_TEXTSCAN_COMMERCE_PARITY_ENABLED=true  → enabled
 */
export const TEXTSCAN_COMMERCE_PARITY_DEFAULT_ENABLED = true;

export function isTextScanCommerceParityEnabled(
  envGet: (key: string) => string | undefined = (key) => {
    try {
      return Deno.env.get(key);
    } catch {
      return undefined;
    }
  },
): boolean {
  const raw = envGet('BACKEND_TEXTSCAN_COMMERCE_PARITY_ENABLED')?.trim().toLowerCase();
  if (raw === 'false' || raw === '0' || raw === 'off' || raw === 'no') return false;
  if (raw === 'true' || raw === '1' || raw === 'on' || raw === 'yes') return true;
  return TEXTSCAN_COMMERCE_PARITY_DEFAULT_ENABLED;
}

export function textScanCommerceParityTreatmentBucket(
  enabled: boolean,
): 'textscan_commerce_parity_on' | 'textscan_commerce_parity_off' {
  return enabled ? 'textscan_commerce_parity_on' : 'textscan_commerce_parity_off';
}
