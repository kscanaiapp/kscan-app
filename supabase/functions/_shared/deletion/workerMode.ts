// Deletion-worker activation-safety primitives.
//
// These live in their own module rather than in _shared/deletion/common.ts on
// purpose: common.ts is bundled into every deletion-adjacent Edge Function
// (scan-identify, stylechat-generate, the privacy pair, the paid-provider
// pair, kplus-*, vto-generate ...), so editing it moves fourteen governed
// bundle hashes for a change only the purge worker uses. Keeping it here
// means exactly one governed bundle changes, which is what a release-closure
// safety repair should cost.

import { rest } from './common.ts';

/**
 * The five distinguishable states of a governed `app_config` boolean flag.
 *
 * `readAppConfigFlag` in ./common.ts collapses all of these to `false`, which is the
 * CORRECT reading for a kill switch (`*_worker_enabled`): uncertainty about
 * whether a worker may run must mean "do not run". It is the WRONG reading for
 * an inverted SAFETY flag such as `account_deletion_worker_dry_run`, where
 * `false` means "perform irreversible deletions". Collapsing "we could not
 * read the safety flag" into "the safety flag is off" lets an unreadable or
 * malformed row authorize permanent account erasure.
 *
 * Rather than change `readAppConfigFlag`'s global meaning -- its only other
 * consumer, commerce-watch-refresh's `watchlist_worker_enabled`, is a kill
 * switch that depends on exactly that collapse -- this reader preserves the
 * distinction so each caller can choose which states are safe for it.
 */
export type AppConfigFlagState =
  | 'explicit_true'
  | 'explicit_false'
  | 'missing'
  | 'malformed'
  | 'read_error';

/**
 * Reads a governed `app_config` flag WITHOUT collapsing uncertainty.
 *
 * The governed row shape is `{"enabled": true | false}`. `enabled` must be a
 * real boolean: a truthy string like "true" is reported as `malformed` rather
 * than silently coerced, because a value nobody intended must never be read as
 * an instruction to delete.
 */
export async function readAppConfigFlagState(key: string): Promise<AppConfigFlagState> {
  let response: Response;
  try {
    response = await rest(`app_config?key=eq.${encodeURIComponent(key)}&select=value`, {
      method: 'GET',
    });
  } catch {
    return 'read_error';
  }
  if (!response.ok) return 'read_error';

  let rows: unknown;
  try {
    rows = await response.json();
  } catch {
    return 'malformed';
  }

  if (!Array.isArray(rows)) return 'malformed';
  if (rows.length === 0) return 'missing';

  const value = (rows[0] as { value?: unknown } | null)?.value;
  if (value === null || value === undefined) return 'missing';
  if (typeof value !== 'object' || Array.isArray(value)) return 'malformed';

  const enabled = (value as { enabled?: unknown }).enabled;
  if (enabled === true) return 'explicit_true';
  if (enabled === false) return 'explicit_false';
  // Absent field, wrong type, or a truthy non-boolean: intent is not established.
  return 'malformed';
}

export type DeletionWorkerMode = 'live' | 'dry_run';

/**
 * The deletion worker's destructive-mode decision, as one pure function.
 *
 * INVARIANT: any uncertainty resolves to `dry_run`. Live erasure requires a
 * positively read, explicitly false dry-run flag AND a positively read,
 * explicitly true kill switch AND no emergency environment override. Every
 * other combination -- missing row, malformed value, failed lookup -- is
 * non-destructive.
 *
 * The environment override may only FORCE SAFETY. There is deliberately no
 * environment variable that can force live mode: an operator who wants live
 * deletion must set the governed database flag, which is auditable and which
 * `claim_deletion_requests_for_purge` independently re-checks in the database
 * before it will return any claimable work.
 */
export function resolveDeletionWorkerMode(input: {
  enabled: AppConfigFlagState;
  dryRun: AppConfigFlagState;
  envDryRun: boolean;
}): DeletionWorkerMode {
  if (input.envDryRun) return 'dry_run';
  if (input.enabled !== 'explicit_true') return 'dry_run';
  if (input.dryRun !== 'explicit_false') return 'dry_run';
  return 'live';
}
