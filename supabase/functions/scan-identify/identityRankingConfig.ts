/**
 * Scanner Identity-Aware Ranking v1 control (Build 42 Sprint 2, B42-SCAN-02).
 *
 * disabled → exact pre-v1 ranking: the v122 relevance path (agreement score,
 *            coverage selection, soft diversity, same-brand preference) runs
 *            byte-for-byte as before and the response is unchanged.
 * enabled  → within the existing v122 relevance path only:
 *              - listings whose brand agrees with the scanned (wordmark / high
 *                confidence logo) brand, and that name the hypothesised model,
 *                rank first even when their titles carry no colour/material words;
 *              - listings that name a different brand (declared or in the title)
 *                rank after brand-neutral alternatives;
 *              - unsupported offers (replicas, accessories/parts, below-usable
 *                coverage fills) are no longer used to pad the shelf.
 *            Query construction, providers, provider order, timeouts, dedupe
 *            keys, destinations and every response field are unchanged.
 *
 * Rollback without redeploy: set SCANNER_IDENTITY_RANKING_V1_ENABLED=false
 * (or leave it unset — the default is OFF).
 */

export const IDENTITY_RANKING_VERSION = 1 as const;

/** Default OFF until the Staging evidence required by issue #768 Gate A exists. */
export const IDENTITY_RANKING_DEFAULT_ENABLED = false;

export function isIdentityRankingEnabled(
  envGet: (key: string) => string | undefined = (key) => {
    try {
      return Deno.env.get(key);
    } catch {
      return undefined;
    }
  },
): boolean {
  const raw = envGet('SCANNER_IDENTITY_RANKING_V1_ENABLED')?.trim().toLowerCase();
  if (raw === 'false' || raw === '0' || raw === 'off' || raw === 'no') return false;
  if (raw === 'true' || raw === '1' || raw === 'on' || raw === 'yes') return true;
  return IDENTITY_RANKING_DEFAULT_ENABLED;
}
