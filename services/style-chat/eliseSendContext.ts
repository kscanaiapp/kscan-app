// Send-time canonical fashion context assembly (Phase 2B.3).
//
// WHAT THIS OWNS: turning the per-attachment identities held on the composer's
// drafts into the ONE `fashionContextV2` object that goes on the wire, and
// deciding when there is nothing legitimate to send.
//
// WHY A SEPARATE MODULE: the composer hook already owns a lot of lifecycle state,
// and this decision is pure. Keeping it here means the "may this message claim
// visual grounding" question is answerable in a test with no store, no hook and
// no transport.
//
// ORDERING IS SOURCE ORDERING. Attachments complete in whatever order the network
// settles them; the context is rebuilt from each attachment's recorded
// `sourceIndex`, so the third photo the user picked stays the third item no matter
// when its identification returned.

import {
  ELISE_FASHION_CONTEXT_V2,
  type EliseFashionContextSource,
  type EliseFashionContextV2,
  type EliseFashionItemState,
} from '../../types/fashionIdentificationV2';
import { isRecord } from '../fashionIdentificationV2Core';
import {
  prepareContextForTransport,
  validateEliseFashionContextV2,
} from './eliseFashionContextV2';

/**
 * Merges several single-source contexts into one.
 *
 * A composer draft can hold more than one attachment, and each carries its own
 * one-item context. The wire contract is a single object, so they are combined
 * here — with `sourceIndex` RENUMBERED across the merged set, because two
 * independently-built contexts both start at index 0 and keeping both would make
 * the indices ambiguous.
 *
 * `source` collapses to the shared value when every input agrees, and otherwise
 * to the first input's source. A mixed-source draft is real (a Closet item plus a
 * fresh photo), and the per-item identities are what matter for grounding; the
 * top-level source is provenance framing for the prompt.
 */
export function mergeEliseFashionContexts(
  contexts: Array<unknown>,
): EliseFashionContextV2 | null {
  const valid: EliseFashionContextV2[] = [];
  for (const candidate of contexts) {
    const validated = validateEliseFashionContextV2(candidate);
    if (validated.kind === 'ok') valid.push(validated.context);
  }
  if (valid.length === 0) return null;

  const sources = new Set(valid.map((context) => context.source));
  const source: EliseFashionContextSource = sources.size === 1
    ? valid[0].source
    : valid[0].source;

  const items: EliseFashionContextV2['items'] = [];
  let nextIndex = 0;
  for (const context of valid) {
    // Each context's own items are already sorted by their local sourceIndex;
    // renumbering preserves that relative order while making the merged indices
    // unique.
    for (const item of context.items) {
      items.push({ ...item, sourceIndex: nextIndex });
      nextIndex += 1;
    }
  }

  return { contractVersion: ELISE_FASHION_CONTEXT_V2, source, items };
}

export type SendContextDecision =
  | { kind: 'none' }
  | { kind: 'send'; context: EliseFashionContextV2 }
  | { kind: 'pending'; pendingCount: number }
  | { kind: 'blocked'; reason: string };

/**
 * Attachment lifecycle states that mean "still working".
 *
 * A draft in one of these has not finished identifying, so it has no identity yet
 * — and its absence of one is not a failure.
 */
const PENDING_STATES: ReadonlySet<string> = new Set([
  'selected',
  'sanitizing',
  'identifying',
  'awaiting_review',
  'creating_record',
  'uploading_media',
  'finalizing',
]);

/**
 * The send-time gate.
 *
 *   `none`    — no visual attachments at all. A text-only send, unchanged.
 *   `pending` — something is still identifying. An image-grounded send waits,
 *               because a reply written now would be missing that garment while
 *               the transcript shows its photo.
 *   `send`    — a validated, transport-safe context with real evidence. Emitted
 *               even when SOME siblings failed: one bad photo must not veto the
 *               good ones. The failures travel as non-groundable items, so they
 *               are visible to the caller but can never be read as identified.
 *   `blocked` — visual attachments exist and none of them is groundable, or the
 *               assembled context failed its transport check.
 *
 * `blocked` is deliberately NOT silently downgraded to `none`. Sending an
 * image-backed message with no identity, as a plain text message, is precisely
 * the defect this phase removes: the user sees their photo in the transcript and
 * the reply was written without it.
 */
export function resolveSendFashionContext(
  drafts: Array<{ fashionContext?: unknown; state?: string }>,
): SendContextDecision {
  if (!Array.isArray(drafts) || drafts.length === 0) return { kind: 'none' };

  const live = drafts.filter((draft) => isRecord(draft) && draft.state !== 'cancelled');
  const carriers = live.filter((draft) => draft.fashionContext != null);
  // A pending sibling holds the send only when at least one attachment is
  // actually image-backed. A pending Closet lookup alongside no photos is the
  // existing attachment-readiness concern, not this one.
  const pending = live.filter((draft) => PENDING_STATES.has(String(draft.state)));
  if (carriers.length === 0) {
    return pending.length > 0 && live.some((d) => d.fashionContext !== undefined)
      ? { kind: 'pending', pendingCount: pending.length }
      : { kind: 'none' };
  }
  if (pending.length > 0) return { kind: 'pending', pendingCount: pending.length };

  const merged = mergeEliseFashionContexts(carriers.map((draft) => draft.fashionContext));
  if (!merged) return { kind: 'blocked', reason: 'no_valid_context' };

  const prepared = prepareContextForTransport(merged);
  if (prepared.kind !== 'ok') return { kind: 'blocked', reason: prepared.reason };

  const groundable = prepared.context.items.filter(
    (item) => item.state === 'ready' || item.state === 'partial',
  );
  // Every attachment failed. There is nothing to ground on, and sending the
  // failures alone would represent them as understood.
  if (groundable.length === 0) return { kind: 'blocked', reason: 'no_groundable_items' };

  return { kind: 'send', context: prepared.context };
}

/**
 * Maps an orchestrator outcome onto a context item state.
 *
 * `needs_selection`, `cancelled` and `legacy_fallback` have no item state because
 * they are not outcomes for a garment — they are outcomes for the OPERATION, and
 * the caller handles each one before an item is ever built.
 */
export function itemStateForIdentifyResult(
  state: string,
): EliseFashionItemState | null {
  switch (state) {
    case 'ready':
      return 'ready';
    case 'partial':
      return 'partial';
    case 'insufficient_evidence':
      return 'insufficient_evidence';
    case 'non_fashion':
      return 'non_fashion';
    case 'technical_failure':
      return 'technical_failure';
    default:
      return null;
  }
}
