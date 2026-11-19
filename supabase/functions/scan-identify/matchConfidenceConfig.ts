/**
 * Scanner Match Confidence v1 control (Build 42 Sprint 1).
 *
 * disabled → exact pre-v1 response: no `matchConfidence` field on any offer,
 *            no `match_confidence_v1` log line.
 * enabled  → every Scanner commerce offer carries an additive, evidence-bound
 *            `matchConfidence` record (verified_exact | probable | similar |
 *            unsupported). Ranking, filtering, query construction, provider
 *            order and every existing field are unchanged either way.
 *
 * Rollback without redeploy: set SCANNER_MATCH_CONFIDENCE_V1_ENABLED=false
 * (or leave it unset — the default is OFF).
 */

export const MATCH_CONFIDENCE_VERSION = 1 as const;

/**
 * Default OFF. This layer only describes evidence that the pipeline already
 * computes; it is enabled by an explicit env override after Staging review.
 */
export const MATCH_CONFIDENCE_DEFAULT_ENABLED = false;

export function isMatchConfidenceEnabled(
  envGet: (key: string) => string | undefined = (key) => {
    try {
      return Deno.env.get(key);
    } catch {
      return undefined;
    }
  },
): boolean {
  const raw = envGet('SCANNER_MATCH_CONFIDENCE_V1_ENABLED')?.trim().toLowerCase();
  if (raw === 'false' || raw === '0' || raw === 'off' || raw === 'no') return false;
  if (raw === 'true' || raw === '1' || raw === 'on' || raw === 'yes') return true;
  return MATCH_CONFIDENCE_DEFAULT_ENABLED;
}
