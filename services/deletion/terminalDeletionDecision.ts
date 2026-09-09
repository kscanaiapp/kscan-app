/**
 * The terminal decision — the one place local destruction can be authorised.
 *
 * This module is pure. It takes a lifecycle answer and returns one of four
 * dispositions; it performs no I/O, holds no state, and cannot be persuaded by
 * a caller. Everything that could authorise destruction is expressed here, once,
 * so the rule can be read in full and tested exhaustively.
 *
 * THE DOUBLE LOCK:
 *
 *     purge  ⟺  state === 'purged'  AND  purgeAuthorized === true
 *
 * Both halves are required, and there is no third route to `purge`. Neither
 * half alone is sufficient — not `state === 'purged'` on its own (the backend
 * reports that shape for a row that claims to be terminal but cannot say when),
 * and not `purgeAuthorized === true` on its own (a boolean that arrived beside
 * a state this contract does not recognise is a contract change, not a
 * permission).
 *
 * Everything else — pending, restored, failed, an unknown state, a 404, a 400,
 * a 503, a transport failure, an undeployed endpoint, a lost binding — retains
 * both the marker and the user's data. Nothing here is authorised by elapsed
 * time, by a local clock, by the absence of an account, by a 401/403, by a
 * failed sign-in, by the user pressing Delete Account, or by a successful
 * deletion REQUEST. A deletion request is a promise; only the purge is a fact.
 */

import type { DeletionStatusOutcome } from './deletionStatusClient';
import type { ReceiptBindingState } from './pendingDeletionStore';

export type TerminalDecision =
  /** Destroy this owner's local data, then retire the marker. The only one. */
  | { action: 'purge'; purgedAt: string | null }
  /**
   * The lifecycle resolved WITHOUT destruction: the account is usable again.
   * Retire the marker, keep every byte of local data.
   */
  | { action: 'release'; reason: 'restored' }
  /** Keep the marker and the data; ask again at a later lifecycle boundary. */
  | { action: 'retain'; reason: string };

/**
 * Whether a marker in this binding state may be asked about at all.
 *
 * `unconfirmed` is deliberately included. It is the LOST-RESPONSE state: the
 * intake request may well have committed before the response was lost, and the
 * only way to find out is to ask. Asking is safe — an unbound capability simply
 * resolves to `not_found`, which authorises nothing.
 *
 * `unbound` and `unsupported` are excluded because the backend has already told
 * us the hash never reached the database, so no lookup can ever succeed. Those
 * markers are inert by construction, not by policy.
 */
export function isBindingQueryable(binding: ReceiptBindingState): boolean {
  return binding === 'bound' || binding === 'unconfirmed';
}

/**
 * The complete decision table.
 *
 * @param outcome the normalized answer from deletionStatusClient
 * @param binding how the backend reported the capability binding at intake
 */
export function decideTerminalAction(
  outcome: DeletionStatusOutcome,
  binding: ReceiptBindingState,
): TerminalDecision {
  // A capability the backend never stored cannot resolve anything, so no
  // answer carried alongside it may be acted on. Checked before the outcome so
  // a spoofed or stale `lifecycle` result cannot reach the purge branch.
  if (!isBindingQueryable(binding)) {
    return { action: 'retain', reason: `binding_${binding}` };
  }

  switch (outcome.kind) {
    case 'lifecycle': {
      if (outcome.state === 'purged' && outcome.purgeAuthorized === true) {
        return { action: 'purge', purgedAt: outcome.purgedAt };
      }
      if (outcome.state === 'purged') {
        // Claims terminal, backend withheld authority. Fail closed.
        return { action: 'retain', reason: 'purged_unauthorized' };
      }
      if (outcome.purgeAuthorized === true) {
        // Authority beside a non-terminal state is an inconsistency, never a
        // permission. This branch is the reason the lock has two halves.
        return { action: 'retain', reason: 'authorized_without_purged_state' };
      }
      if (outcome.state === 'restored') {
        return { action: 'release', reason: 'restored' };
      }
      if (outcome.state === 'failed') {
        // The contract treats `failed` as unresolved, not terminal: the worker
        // can still retry, so the capability stays useful and the marker stays.
        return { action: 'retain', reason: 'lifecycle_failed' };
      }
      return { action: 'retain', reason: 'lifecycle_pending' };
    }
    case 'not_found':
      // Well-formed capability, nothing matched. Could be a lost intake that
      // never committed, or a lifecycle not yet visible. Never a purge.
      return { action: 'retain', reason: 'not_found' };
    case 'invalid_request':
      return { action: 'retain', reason: 'invalid_request' };
    case 'unavailable':
      return { action: 'retain', reason: 'unavailable' };
    case 'endpoint_unavailable':
      return { action: 'retain', reason: 'endpoint_unavailable' };
    case 'network_error':
      return { action: 'retain', reason: 'network_error' };
    case 'malformed':
      return { action: 'retain', reason: 'malformed_response' };
    default: {
      // Unreachable while the outcome union is exhaustive; if it ever widens,
      // the new member retains rather than falling through to anything.
      const exhaustive: never = outcome;
      void exhaustive;
      return { action: 'retain', reason: 'unknown_outcome' };
    }
  }
}
