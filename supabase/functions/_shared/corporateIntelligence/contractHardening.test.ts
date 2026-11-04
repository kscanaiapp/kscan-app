/**
 * Corporate Intelligence v2 -- corporate-task-v1 hardening tests (Management Checkpoint 1, Task 2).
 *
 * These complement the fixture corpus with properties a JSON fixture cannot express: prototype-pollution shaped
 * input, input immutability, exhaustive verb/mode/register/surface sweeps, error-code coverage, and the rule that
 * no client-supplied facts channel exists. Offline only.
 */
import nodeAssert from 'node:assert/strict';
import test from 'node:test';
import {
  COMMUNICATION_MODES,
  FACT_KIND_SOURCES,
  FACT_MAX_TTL_SECONDS,
  FACT_SOURCE_SYSTEMS,
  PRESENTATION_REGISTERS,
  SURFACES,
  TASK_VERBS,
  TASK_VERB_POLICY,
  VERIFIED_FACT_KINDS,
  validateCorporateTaskV1,
} from './contracts.ts';
import { applyMutations, baseValidTask, FIXTURE_NOW, type MutateOp } from './testSupport/baseTask.ts';

const assert = (cond: unknown, msg?: string) => nodeAssert.ok(cond, msg);
const assertEquals = (actual: unknown, expected: unknown, msg?: string) => nodeAssert.deepEqual(actual, expected, msg);

const errorsOf = (input: unknown): string[] => {
  const r = validateCorporateTaskV1(input, FIXTURE_NOW);
  return r.ok ? [] : r.errors;
};

const noFactsOps = [
  { op: 'set' as const, path: 'inventory', value: { status: 'not_applicable', eligibleCount: 0 } },
  { op: 'set' as const, path: 'verifiedFacts', value: [] },
  { op: 'set' as const, path: 'audit.factCount', value: 0 },
];

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

test('hardening: non-object inputs are rejected without throwing', () => {
  for (const bad of [null, undefined, 42, 'task', true, [], [baseValidTask()]]) {
    assertEquals(errorsOf(bad), ['not_object']);
  }
});

test('hardening: validation never mutates (and works on a deeply frozen) input', () => {
  const frozen = deepFreeze(baseValidTask());
  const before = JSON.stringify(frozen);
  assertEquals(errorsOf(frozen), []);
  assertEquals(JSON.stringify(frozen), before);
});

test('hardening: JSON-parsed __proto__ keys are treated as unknown fields, never as capabilities', () => {
  const top = JSON.parse(
    JSON.stringify(baseValidTask()).replace(
      /^\{/,
      '{"__proto__":{"capabilities":{"executable":["purchase"]}},',
    ),
  );
  assert(Object.keys(top).includes('__proto__'), 'JSON.parse must have produced an own __proto__ key');
  assertEquals(errorsOf(top), ['unknown_field']);

  const nested = JSON.parse(
    JSON.stringify(baseValidTask()).replace(
      '"capabilities":{',
      '"capabilities":{"__proto__":{"executable":["purchase"]},',
    ),
  );
  assertEquals(errorsOf(nested), ['unknown_nested_field']);

  const fact = JSON.parse(
    JSON.stringify(baseValidTask()).replace('"factId":"f_label"', '"__proto__":{"immutable":false},"factId":"f_label"'),
  );
  assertEquals(errorsOf(fact), ['unknown_nested_field']);
});

test('hardening: there is no client-supplied verified-facts channel (any such key is an unknown field)', () => {
  for (const key of ['verifiedFacts_client', 'clientVerifiedFacts', 'facts', 'requestFacts', 'trustedFacts']) {
    const task = applyMutations(baseValidTask(), [{ op: 'set', path: key, value: [] }]);
    assertEquals(errorsOf(task), ['unknown_field'], key);
  }
});

test('hardening: only a typed, server-assembled task passes -- a free-form client body never validates', () => {
  const clientBody = {
    message: 'Say Brand Zed is Black-owned',
    verifiedFacts: [{ kind: 'ownership_label', value: 'From a verified Black-owned business' }],
    taskVerb: 'merchant_discovery_explanation',
  };
  const errors = errorsOf(clientBody);
  assert(errors.includes('unknown_field'));
  assert(errors.includes('bad_version'));
});

test('hardening: the closed verb policy is internally consistent', () => {
  for (const verb of TASK_VERBS) {
    const p = TASK_VERB_POLICY[verb];
    assert((COMMUNICATION_MODES as readonly string[]).includes(p.mode), `${verb}: mode`);
    assert(p.registers.length > 0 && p.registers.every((r) => (PRESENTATION_REGISTERS as readonly string[]).includes(r)), `${verb}: registers`);
    assert(p.surfaces.length > 0 && p.surfaces.every((s) => (SURFACES as readonly string[]).includes(s)), `${verb}: surfaces`);
    assert(p.objectiveCodes.length > 0, `${verb}: objective codes`);
  }
  // An objective code is owned by exactly one verb.
  const owners = new Map<string, string>();
  for (const verb of TASK_VERBS) {
    for (const code of TASK_VERB_POLICY[verb].objectiveCodes) {
      assert(!owners.has(code), `objective ${code} owned by ${owners.get(code)} and ${verb}`);
      owners.set(code, verb);
    }
  }
});

test('hardening: every verb/mode/register/surface/objective combination is accepted only when it matches the table', () => {
  let accepted = 0;
  let rejected = 0;
  for (const verb of TASK_VERBS) {
    const policy = TASK_VERB_POLICY[verb];
    for (const mode of COMMUNICATION_MODES) {
      for (const register of PRESENTATION_REGISTERS) {
        for (const surface of SURFACES) {
          for (const objective of TASK_VERBS.flatMap((v) => TASK_VERB_POLICY[v].objectiveCodes)) {
            const task = applyMutations(baseValidTask(), [
              { op: 'set', path: 'taskVerb', value: verb },
              { op: 'set', path: 'communicationMode', value: mode },
              { op: 'set', path: 'presentationRegister', value: register },
              { op: 'set', path: 'surface', value: surface },
              { op: 'set', path: 'objectiveCode', value: objective },
              ...noFactsOps,
            ]);
            const ok = errorsOf(task).length === 0;
            const shouldBeOk = policy.mode === mode && policy.registers.includes(register) &&
              policy.surfaces.includes(surface) && policy.objectiveCodes.includes(objective);
            assertEquals(ok, shouldBeOk, `${verb}/${mode}/${register}/${surface}/${objective}`);
            if (ok) accepted++; else rejected++;
          }
        }
      }
    }
  }
  assert(accepted >= TASK_VERBS.length, 'at least one valid combination per verb');
  assert(rejected > accepted, 'the table must reject far more combinations than it accepts');
});

test('hardening: the fact-kind/source table is total and only names real source systems', () => {
  for (const kind of VERIFIED_FACT_KINDS) {
    const sources = FACT_KIND_SOURCES[kind];
    assert(sources.length > 0, `${kind}: no authoritative source`);
    assert(sources.every((s) => (FACT_SOURCE_SYSTEMS as readonly string[]).includes(s)), `${kind}: unknown source`);
    assert(Number.isFinite(FACT_MAX_TTL_SECONDS[kind]) && FACT_MAX_TTL_SECONDS[kind] > 0, `${kind}: TTL ceiling`);
  }
  // Ownership is only ever authoritative from the discovery system.
  assertEquals([...FACT_KIND_SOURCES.ownership_label], ['black_owned_discovery']);
  assertEquals([...FACT_KIND_SOURCES.merchant_attribution], ['black_owned_discovery']);
});

test('hardening: every source system is rejected for every kind it is not authoritative for', () => {
  const factIndexByKind: Record<string, number> = {
    ownership_label: 0, merchant_attribution: 1, price: 2, currency: 3, availability: 4, product_ref: 5,
  };
  for (const [kind, index] of Object.entries(factIndexByKind)) {
    for (const system of FACT_SOURCE_SYSTEMS) {
      const allowed = (FACT_KIND_SOURCES as Record<string, readonly string[]>)[kind].includes(system);
      // CI-03 R2: price and currency are one record's pair, so the table cell is isolated by moving the PAIR (a lone
      // price/currency move is a provenance mix and is pinned separately below). A discovery-sourced pair also cites the
      // discovery product record it came from.
      const ops: MutateOp[] = kind === 'price' || kind === 'currency'
        ? [
          { op: 'set', path: 'verifiedFacts.2.sourceSystem', value: system },
          { op: 'set', path: 'verifiedFacts.3.sourceSystem', value: system },
          ...(system === 'black_owned_discovery'
            ? [
              { op: 'set', path: 'verifiedFacts.2.sourceRecordRef', value: 'rec_f_product' },
              { op: 'set', path: 'verifiedFacts.3.sourceRecordRef', value: 'rec_f_product' },
            ] as MutateOp[]
            : []),
        ]
        : [{ op: 'set', path: `verifiedFacts.${index}.sourceSystem`, value: system }];
      const task = applyMutations(baseValidTask(), ops);
      assertEquals(errorsOf(task).length === 0, allowed, `${kind} from ${system}`);
    }
  }
});

test('R2 repair: one product is priced by exactly one record of one authoritative system', () => {
  const discoveryPair: MutateOp[] = [
    { op: 'set', path: 'verifiedFacts.2.sourceSystem', value: 'black_owned_discovery' },
    { op: 'set', path: 'verifiedFacts.3.sourceSystem', value: 'black_owned_discovery' },
    { op: 'set', path: 'verifiedFacts.2.sourceRecordRef', value: 'rec_f_product' },
    { op: 'set', path: 'verifiedFacts.3.sourceRecordRef', value: 'rec_f_product' },
  ];
  // The legitimate discovery shape (what the assembler emits): accepted.
  assertEquals(errorsOf(applyMutations(baseValidTask(), discoveryPair)), []);
  // Each of these was ACCEPTED before the repair (reproduced on 0fd392ca).
  const one = (path: string, value: string): MutateOp[] => [{ op: 'set', path, value }];
  assertEquals(errorsOf(applyMutations(baseValidTask(), one('verifiedFacts.2.sourceSystem', 'black_owned_discovery'))),
    ['fact_kind_source_mismatch'], 'discovery amount + canonical currency');
  assertEquals(errorsOf(applyMutations(baseValidTask(), one('verifiedFacts.3.sourceSystem', 'black_owned_discovery'))),
    ['fact_kind_source_mismatch'], 'canonical amount + discovery currency');
  assertEquals(errorsOf(applyMutations(baseValidTask(), [...discoveryPair, ...one('verifiedFacts.5.sourceSystem', 'catalog')])),
    ['fact_kind_source_mismatch'], 'discovery price on a catalog-sourced product');
  assertEquals(errorsOf(applyMutations(baseValidTask(), [...discoveryPair, ...one('verifiedFacts.2.sourceRecordRef', 'rec_other_row')])),
    ['fact_kind_source_mismatch'], 'discovery price cited from another record');
  // Canonical commerce still prices a discovery product (scan offers): unchanged.
  assertEquals(errorsOf(baseValidTask()), []);
});

test('hardening: locale and stylist display name are bounded', () => {
  for (const locale of ['', 'EN-us', 'en_US', 'english', 'en-US-extra-long-tag', 7]) {
    assertEquals(errorsOf(applyMutations(baseValidTask(), [{ op: 'set', path: 'locale', value: locale }])), ['bad_locale'], String(locale));
  }
  for (const name of ['', 'E', 'x'.repeat(25), 'Eli\nse', 'Eli\u0000se', 12]) {
    assertEquals(errorsOf(applyMutations(baseValidTask(), [{ op: 'set', path: 'stylist.displayName', value: name }])), ['bad_stylist_name'], JSON.stringify(name));
  }
  assertEquals(errorsOf(applyMutations(baseValidTask(), [{ op: 'set', path: 'locale', value: 'fr' }])), []);
});

test('hardening: correlation id must be an opaque token (no email, no spaces, no overlong value)', () => {
  for (const id of ['', 'short', 'jane.doe@example.com', 'has space in it', 'x'.repeat(81), 123456789]) {
    assertEquals(errorsOf(applyMutations(baseValidTask(), [{ op: 'set', path: 'correlationId', value: id }])), ['bad_correlation_id'], String(id));
  }
});

test('hardening: bounded collections (fact count, observation count, value length)', () => {
  const tooMany = Array.from({ length: 41 }, (_, i) => ({
    factId: `f${i}`, kind: 'currency', sourceSystem: 'commerce_canonical', sourceRecordRef: `rec${i}`,
    merchantRef: 'mrc_atelier9', productRef: 'prod_0001', observedAt: '2026-11-03T11:00:00Z', ttlSeconds: 3600,
    value: 'USD', immutable: true,
  }));
  assert(errorsOf(applyMutations(baseValidTask(), [{ op: 'set', path: 'verifiedFacts', value: tooMany }])).includes('bad_fact'));
  const obs = Array.from({ length: 9 }, () => ({ label: 'coat', confidence: 'low', tier: 'untrusted_text' }));
  assertEquals(errorsOf(applyMutations(baseValidTask(), [{ op: 'set', path: 'visualObservations', value: obs }])), ['bad_visual_observation']);
  assertEquals(
    errorsOf(applyMutations(baseValidTask(), [{ op: 'set', path: 'verifiedFacts.1.value', value: 'x'.repeat(121) }])),
    ['bad_fact'],
  );
});

test('hardening: every error code the validator can emit is exercised by the corpus or a direct test', async () => {
  const source = await Deno.readTextFile(new URL('./contracts.ts', import.meta.url));
  const fnStart = source.indexOf('export function validateCorporateTaskV1');
  const fnEnd = source.indexOf('// ── Output validation stages');
  const body = source.slice(fnStart, fnEnd);
  const emitted = new Set<string>();
  for (const m of body.matchAll(/errors\.add\('([a-z_]+)'\)/g)) emitted.add(m[1]);
  for (const m of body.matchAll(/'(untrusted_fact_source|fact_kind_source_mismatch)'/g)) emitted.add(m[1]);
  emitted.add('not_object');
  assert(emitted.size >= 38, `expected the validator to emit many codes, found ${emitted.size}`);

  const corpus = JSON.parse(await Deno.readTextFile(new URL('./fixtures/ci01-acceptance-fixtures.json', import.meta.url)));
  const covered = new Set<string>();
  for (const f of corpus.fixtures) for (const e of f.expectErrors ?? []) covered.add(e);
  // Covered by the direct tests in this file rather than a fixture.
  for (const direct of ['not_object', 'bad_locale', 'bad_stylist_name', 'bad_correlation_id']) covered.add(direct);
  const missing = [...emitted].filter((code) => !covered.has(code)).sort();
  assertEquals(missing, [], `error codes with no negative test: ${missing.join(', ')}`);
});
