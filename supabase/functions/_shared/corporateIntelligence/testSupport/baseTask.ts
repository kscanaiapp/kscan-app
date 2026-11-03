/** Test support: a known-valid corporate-task-v1 object and JSON-path mutation helper for fixtures. */

export const FIXTURE_NOW = new Date('2026-11-03T12:00:00Z');

export function baseValidTask(): Record<string, unknown> {
  const fact = (
    factId: string,
    kind: string,
    sourceSystem: string,
    value: string,
  ) => ({
    factId,
    kind,
    sourceSystem,
    sourceRecordRef: `rec_${factId}`,
    observedAt: '2026-11-03T11:00:00Z',
    ttlSeconds: 6 * 3600,
    value,
    immutable: true,
  });
  return {
    contractVersion: 'corporate-task-v1',
    correlationId: 'req_8f3a91c2d4',
    taskVerb: 'merchant_discovery_explanation',
    objectiveCode: 'explain_verified_discovery_result',
    surface: 'discovery_shelf',
    locale: 'en-US',
    brandPolicyVersion: 'kscan-corporate-charter-v1-draft',
    stylist: { displayName: 'Elise' },
    verifiedFacts: [
      fact('f_label', 'ownership_label', 'black_owned_discovery', 'From a verified Black-owned business'),
      fact('f_merchant', 'merchant_attribution', 'black_owned_discovery', 'Atelier Nine'),
      fact('f_price', 'price', 'commerce_canonical', '148.00'),
      fact('f_currency', 'currency', 'commerce_canonical', 'USD'),
      fact('f_avail', 'availability', 'catalog', 'in_stock'),
      fact('f_product', 'product_ref', 'black_owned_discovery', 'prod_0001'),
    ],
    visualObservations: [{ label: 'structured navy wool coat', confidence: 'medium', tier: 'untrusted_text' }],
    policyRefs: ['policy:ownership-label-v1', 'policy:no-invented-commerce-facts-v1'],
    forbiddenActions: [
      'purchase', 'save_item', 'edit_account', 'modify_inventory', 'execute_tool',
      'verify_ownership', 'claim_action_completed', 'commit_company_policy',
    ],
    immutableFields: ['ownership_label', 'merchant_attribution', 'price', 'currency', 'availability'],
    communicationMode: 'professional',
    presentationRegister: 'merchant_explanation',
    tokenBudget: { staticMax: 1200, dynamicMax: 1600, outputMax: 400 },
    allowedReadCapabilities: ['read_verified_facts', 'read_visual_observations', 'read_policy_refs'],
    inventory: { status: 'eligible', eligibleCount: 1 },
    actionContractRef: null,
    capabilities: { proposable: [], executable: [] },
  };
}

export interface MutateOp {
  op: 'set' | 'delete';
  path: string;
  value?: unknown;
}

/** Applies dotted-path mutations (numeric segments index arrays). Returns a new object. */
export function applyMutations<T>(base: T, ops: MutateOp[]): T {
  const clone = structuredClone(base) as Record<string, unknown>;
  for (const { op, path, value } of ops) {
    const segs = path.split('.');
    let cursor: any = clone;
    for (let i = 0; i < segs.length - 1; i++) cursor = cursor[segs[i]];
    const last = segs[segs.length - 1];
    if (op === 'set') cursor[last] = structuredClone(value);
    else delete cursor[last];
  }
  return clone as T;
}

export function baseValidProposal(): Record<string, unknown> {
  return {
    proposalId: 'prop_0123456789abcdef',
    contractVersion: 'action-proposal-v1-draft',
    capabilityId: 'save_item_to_closet',
    arguments: { itemRef: 'scan_abc123' },
    sourceRefs: ['scan_abc123'],
    confirmationPolicy: 'explicit_user_tap',
    expiresAt: '2026-11-03T12:10:00Z',
    status: 'proposed',
  };
}
