/**
 * CI-05 — Option C compatibility layer tests. Everything here proves Option B
 * stays NON-EXECUTING while the future boundary is specified and tested.
 */
import assert from 'node:assert/strict';
import {
  ACTION_PROPOSAL_V2_CONTRACT_VERSION,
  CAPABILITY_IDS,
  CAPABILITY_REGISTRY_V1,
  capabilitiesForTask,
  COMPLETION_CLAIM_RE,
  evaluateExecutionEligibility,
  OPTION_B_ACTIVE,
  parseActionProposalV2,
  type Permission,
  type ServerApprovalRecord,
} from './capabilityBoundary.ts';
import { validateCorporateOutput } from './outputValidation.ts';
import { validateCorporateTaskV1 } from './contracts.ts';
import { assembleTask, CI03_NOW } from './testSupport/ci03Tasks.ts';

const NOW = CI03_NOW;
const ALL_PERMISSIONS: Permission[] = ['authenticated_non_anonymous', 'ai_processing_consent', 'account_active', 'kplus_entitlement', 'fresh_reauthentication'];
const actor = { actorId: 'actor-a', permissions: ALL_PERMISSIONS };
const proposal = (over: Record<string, unknown> = {}) => ({
  contractVersion: ACTION_PROPOSAL_V2_CONTRACT_VERSION,
  proposalId: 'prop_0123456789abcdef',
  capabilityId: 'open_look',
  arguments: { lookRef: 'look_ref_1' },
  sourceRefs: ['look:look_ref_1'],
  status: 'proposed',
  expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
  ...over,
});
const approval = (over: Partial<ServerApprovalRecord> = {}): ServerApprovalRecord => ({
  source: 'app_control_event', proposalId: 'prop_0123456789abcdef', actorId: 'actor-a', capabilityId: 'open_look',
  argumentsHash: 'h1', approvedAt: NOW.toISOString(), expiresAt: new Date(NOW.getTime() + 60_000).toISOString(), consumed: false, ...over,
});

Deno.test('CI-05 registry: closed, frozen, versioned; every state change is server-only and needs an app approval', () => {
  assert.equal(OPTION_B_ACTIVE, true);
  assert.ok(Object.isFrozen(CAPABILITY_REGISTRY_V1));
  for (const id of CAPABILITY_IDS) {
    const c = CAPABILITY_REGISTRY_V1[id];
    assert.ok(Object.isFrozen(c) && Object.isFrozen(c.requiredPermissions), id);
    assert.equal(c.id, id);
    if (c.class === 'read_only_recommendation') {
      assert.equal(c.approval, 'none');
      assert.equal(c.optionB, 'text_only');
    } else {
      assert.equal(c.executionAuthority, 'server_only', id);
      assert.notEqual(c.approval, 'none', id);
    }
    if (c.class === 'financial' || c.id === 'edit_account' || c.id === 'register_merchant') assert.equal(c.approval, 'app_control_tap_plus_reauth', id);
    if (['account_mutation', 'external_effect', 'financial'].includes(c.class)) assert.equal(c.optionB, 'not_available', id);
  }
  for (const required of ['purchase', 'open_checkout', 'save_item_to_closet', 'send_external_message', 'register_merchant', 'edit_account']) {
    assert.ok(CAPABILITY_IDS.includes(required), required);
  }
});

Deno.test('CI-05 Option B: capabilities exposed to the model are always empty, whatever the actor holds', () => {
  for (const permissions of [[], ALL_PERMISSIONS] as Permission[][]) {
    const c = capabilitiesForTask({ actorId: 'a', permissions });
    assert.deepEqual(c, { proposable: [], executable: [] });
  }
  // The task contract itself rejects any non-empty capability array.
  const task = assembleTask();
  assert.equal(validateCorporateTaskV1(task, NOW).ok, true);
  for (const caps of [{ proposable: ['purchase'], executable: [] }, { proposable: [], executable: ['open_look'] }]) {
    assert.equal(validateCorporateTaskV1({ ...task, capabilities: caps }, NOW).ok, false, JSON.stringify(caps));
  }
  assert.equal(validateCorporateTaskV1({ ...task, actionContractRef: 'action-proposal-v2-draft' }, NOW).ok, false);
});

Deno.test('CI-05 proposals: a well-formed v2 proposal is still NOT proposable in Option B', () => {
  const r = parseActionProposalV2(proposal(), NOW);
  assert.deepEqual(r, { ok: false, errors: ['capability_not_proposable_in_option_b'] });
});

Deno.test('CI-05 negative cases: unauthorized capability, fabricated completion, approval smuggling, escalation, expiry', () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ['unknown capability', { capabilityId: 'transfer_funds' }, 'unknown_capability'],
    ['fabricated completion status', { status: 'executed' }, 'completion_claim'],
    ['fabricated success status', { status: 'success' }, 'completion_claim'],
    ['model-authored approval field', { approved: true }, 'approval_claim'],
    ['model-authored authorization field', { authorizedBy: 'user' }, 'approval_claim'],
    ['actor escalation argument', { arguments: { actorId: 'actor-b' } }, 'forbidden_argument'],
    ['price injection argument', { arguments: { price: '1.00' } }, 'forbidden_argument'],
    ['ownership injection argument', { arguments: { ownership: 'verified' } }, 'forbidden_argument'],
    ['nested executable shape', { arguments: { lookRef: { sql: 'drop' } } }, 'bad_arguments'],
    ['expired', { expiresAt: new Date(NOW.getTime() - 1).toISOString() }, 'expired'],
    ['wrong contract version', { contractVersion: 'action-proposal-v1-draft' }, 'bad_version'],
  ];
  for (const [name, over, expected] of cases) {
    const r = parseActionProposalV2(proposal(over), NOW);
    assert.equal(r.ok, false, name);
    assert.ok(!r.ok && r.errors.includes(expected as never), `${name}: ${JSON.stringify(!r.ok && r.errors)}`);
  }
});

Deno.test('CI-05 approval gate: even a fully valid server approval is non-executing in Option B', () => {
  const p = { ...proposal(), status: 'proposed' } as never;
  const ok = evaluateExecutionEligibility({ proposal: p, approval: approval(), actor, argumentsHash: 'h1', now: NOW });
  assert.deepEqual(ok, { executable: false, denials: ['option_b_non_executing'] });
  const checks: [string, Parameters<typeof evaluateExecutionEligibility>[0], string][] = [
    ['no approval', { proposal: p, approval: null, actor, argumentsHash: 'h1', now: NOW }, 'no_server_approval'],
    ['approval from model text', { proposal: p, approval: approval({ source: 'model_output' as never }), actor, argumentsHash: 'h1', now: NOW }, 'approval_not_from_app'],
    ['other actor', { proposal: p, approval: approval({ actorId: 'actor-b' }), actor, argumentsHash: 'h1', now: NOW }, 'actor_mismatch'],
    ['arguments changed after approval', { proposal: p, approval: approval(), actor, argumentsHash: 'h2', now: NOW }, 'arguments_changed'],
    ['replayed approval', { proposal: p, approval: approval({ consumed: true }), actor, argumentsHash: 'h1', now: NOW }, 'approval_replayed'],
    ['expired approval', { proposal: p, approval: approval({ expiresAt: new Date(NOW.getTime() - 1).toISOString() }), actor, argumentsHash: 'h1', now: NOW }, 'approval_expired'],
    ['missing permission', { proposal: p, approval: approval(), actor: { actorId: 'actor-a', permissions: [] }, argumentsHash: 'h1', now: NOW }, 'missing_permission'],
  ];
  for (const [name, input, expected] of checks) {
    const r = evaluateExecutionEligibility(input);
    assert.equal(r.executable, false, name);
    assert.ok(r.denials.includes(expected as never) && r.denials.includes('option_b_non_executing'), `${name}: ${r.denials}`);
  }
  const purchase = { ...proposal({ capabilityId: 'purchase' }) } as never;
  const p2 = evaluateExecutionEligibility({ proposal: purchase, approval: approval({ capabilityId: 'purchase' }), actor, argumentsHash: 'h1', now: NOW });
  assert.ok(p2.denials.includes('capability_not_available') && p2.denials.includes('reauthentication_required'));
});

Deno.test('CI-05 permitted read-only recommendations pass the CI-03 validator; fabricated completions do not', () => {
  const task = assembleTask();
  const registry = { knownMerchantNames: [] };
  const permitted = [
    'Try the navy blazer with cream trousers and white leather sneakers for a relaxed office look.',
    'A camel coat works with charcoal and denim; keep accessories minimal.',
    'You can open the Look from the button below if you want to see it again.',
    "I've shared a few ideas below; the loafers keep it polished.",
  ];
  for (const text of permitted) {
    const v = validateCorporateOutput({ task, candidate: { text }, registry, origin: 'primary_initial', now: NOW });
    assert.equal(v.verdict, 'accept', `${text}: ${JSON.stringify(v.failures)}`);
  }
  const fabricated = [
    "I've added the blazer to your cart.",
    'I saved this look to your closet for you.',
    'I have placed the order and it ships tomorrow.',
    'Done! I sent the merchant your registration.',
  ];
  for (const text of fabricated) {
    assert.ok(COMPLETION_CLAIM_RE.test(text), `screen misses: ${text}`);
    const v = validateCorporateOutput({ task, candidate: { text }, registry, origin: 'primary_initial', now: NOW });
    assert.equal(v.verdict, 'reject', text);
  }
});

Deno.test('CI-05 isolation: the capability boundary is imported by no runtime module', async () => {
  const root = new URL('../../', import.meta.url);
  const importers: string[] = [];
  async function walk(dir: URL) {
    for await (const e of Deno.readDir(dir)) {
      const child = new URL(e.name + (e.isDirectory ? '/' : ''), dir);
      if (e.isDirectory) { if (e.name !== 'node_modules') await walk(child); continue; }
      if (!e.name.endsWith('.ts') || e.name.endsWith('.test.ts') || e.name === 'capabilityBoundary.ts') continue;
      if (/capabilityBoundary/.test(await Deno.readTextFile(child))) importers.push(child.pathname);
    }
  }
  await walk(root);
  assert.deepEqual(importers, []);
});
