/**
 * Independent authorization for model-suggested actions.
 * The model is never an authority for mutations, routes, RPC, SQL, or storage.
 */

import { isSafeHttpUrl, isUuid, rejectForbiddenModelShape } from './outputValidation.ts';

export type AuthorizationActor = {
  actorId: string;
  authenticated: boolean;
};

export type OwnedResourceIndex = {
  itemKeys: Set<string>;
  lookIds: Set<string>;
  productIds?: Set<string>;
};

export type AuthorizationDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason:
        | 'unauthenticated'
        | 'unknown_action'
        | 'forbidden_shape'
        | 'foreign_resource'
        | 'invalid_id'
        | 'unsafe_url'
        | 'placeholder_id'
        | 'feature_disabled'
        | 'not_supported';
      detail?: string;
    };

const PLACEHOLDER_IDS = new Set([
  '00000000-0000-0000-0000-000000000000',
  '11111111-1111-1111-1111-111111111111',
  'ffffffff-ffff-ffff-ffff-ffffffffffff',
]);

export function authorizeModelAction(input: {
  actor: AuthorizationActor;
  actionType: string;
  allowedActionTypes: readonly string[];
  payload?: Record<string, unknown> | null;
  owned: OwnedResourceIndex;
  featureEnabled?: boolean;
}): AuthorizationDecision {
  if (!input.actor.authenticated || !input.actor.actorId) {
    return { allowed: false, reason: 'unauthenticated' };
  }
  if (input.featureEnabled === false) {
    return { allowed: false, reason: 'feature_disabled' };
  }
  if (!input.allowedActionTypes.includes(input.actionType)) {
    return { allowed: false, reason: 'unknown_action', detail: input.actionType };
  }

  const payload = input.payload ?? {};
  const shape = rejectForbiddenModelShape(payload);
  if (!shape.ok) {
    return { allowed: false, reason: 'forbidden_shape', detail: shape.detail };
  }

  const anchor = payload.anchor;
  if (anchor && typeof anchor === 'object') {
    const record = anchor as Record<string, unknown>;
    const sourceType = record.sourceType;
    const sourceId = typeof record.sourceId === 'string' ? record.sourceId.toLowerCase() : '';
    if (sourceType !== 'saved_scan' && sourceType !== 'inspiration_item') {
      return { allowed: false, reason: 'not_supported', detail: 'anchor.sourceType' };
    }
    if (!isUuid(sourceId) || PLACEHOLDER_IDS.has(sourceId)) {
      return { allowed: false, reason: 'invalid_id', detail: 'anchor.sourceId' };
    }
    if (!input.owned.itemKeys.has(`${sourceType}:${sourceId}`)) {
      return { allowed: false, reason: 'foreign_resource', detail: `${sourceType}:${sourceId}` };
    }
  }

  if (typeof payload.lookId === 'string') {
    const lookId = payload.lookId.toLowerCase();
    if (!isUuid(lookId) || PLACEHOLDER_IDS.has(lookId)) {
      return { allowed: false, reason: 'invalid_id', detail: 'lookId' };
    }
    if (!input.owned.lookIds.has(lookId)) {
      return { allowed: false, reason: 'foreign_resource', detail: lookId };
    }
  }

  if (typeof payload.productId === 'string') {
    const productId = payload.productId.toLowerCase();
    if (!isUuid(productId) || PLACEHOLDER_IDS.has(productId)) {
      return { allowed: false, reason: 'invalid_id', detail: 'productId' };
    }
    if (input.owned.productIds && !input.owned.productIds.has(productId)) {
      return { allowed: false, reason: 'foreign_resource', detail: productId };
    }
  }

  for (const key of ['url', 'productUrl', 'href', 'link']) {
    if (payload[key] != null && !isSafeHttpUrl(payload[key])) {
      return { allowed: false, reason: 'unsafe_url', detail: key };
    }
  }

  return { allowed: true };
}

/** Reject model-selected executable targets that must never be honored. */
export function rejectExecutableInstruction(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  const banned = [
    'rpc',
    'sql',
    'route',
    'tool',
    'edgeFunction',
    'storagePath',
    'table',
    'mutation',
  ];
  return banned.some((key) => key in record);
}
