import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  cohortBucketFor,
  parseCohortPercent,
  resolveVri03Flags,
  VRI03_COHORT_PERCENT_ENV,
  VRI03_FLAG_NAME,
  VRI03_MASTER_ENV,
  VRI03_SUB_FLAG_ENV,
  VRI03_SUB_FLAGS,
} from './vri03ScanImprovementsFlag.ts';

const envOf = (vars: Record<string, string>) => (key: string) => vars[key];
const ALL_SUBS_ON = Object.fromEntries(Object.values(VRI03_SUB_FLAG_ENV).map((k) => [k, 'true']));

Deno.test('vri03 flag: default environment is fully OFF', () => {
  const state = resolveVri03Flags({ cohortKey: 'user-a', envGet: envOf({}) });
  assertEquals(state.flag, VRI03_FLAG_NAME);
  assertEquals(state.masterEnabled, false);
  assertEquals(state.cohortPercent, 0);
  assertEquals(state.inCohort, false);
  for (const sub of VRI03_SUB_FLAGS) assertEquals(state.subFlags[sub], false, sub);
});

Deno.test('vri03 flag: sub-flags stay OFF unless master AND cohort AND sub-flag', () => {
  // Sub-flags on, master off.
  let s = resolveVri03Flags({ cohortKey: 'user-a', envGet: envOf({ ...ALL_SUBS_ON, [VRI03_COHORT_PERCENT_ENV]: '100' }) });
  assert(VRI03_SUB_FLAGS.every((sub) => !s.subFlags[sub]));
  // Master + subs on, cohort 0%.
  s = resolveVri03Flags({ cohortKey: 'user-a', envGet: envOf({ ...ALL_SUBS_ON, [VRI03_MASTER_ENV]: 'true' }) });
  assert(VRI03_SUB_FLAGS.every((sub) => !s.subFlags[sub]));
  // Master + cohort 100%, subs off.
  s = resolveVri03Flags({ cohortKey: 'user-a', envGet: envOf({ [VRI03_MASTER_ENV]: 'true', [VRI03_COHORT_PERCENT_ENV]: '100' }) });
  assertEquals(s.inCohort, true);
  assert(VRI03_SUB_FLAGS.every((sub) => !s.subFlags[sub]));
});

Deno.test('vri03 flag: each sub-flag is independently attributable', () => {
  for (const sub of VRI03_SUB_FLAGS) {
    const s = resolveVri03Flags({
      cohortKey: 'user-a',
      envGet: envOf({ [VRI03_MASTER_ENV]: 'true', [VRI03_COHORT_PERCENT_ENV]: '100', [VRI03_SUB_FLAG_ENV[sub]]: 'true' }),
    });
    for (const other of VRI03_SUB_FLAGS) assertEquals(s.subFlags[other], other === sub, `${sub} -> ${other}`);
  }
});

Deno.test('vri03 flag: malformed values fail closed', () => {
  for (const bad of ['1', 'yes', 'on', 'TRUE ', ' True', 'enabled']) {
    const trimmedTrue = bad.trim().toLowerCase() === 'true';
    const s = resolveVri03Flags({ cohortKey: 'k', envGet: envOf({ [VRI03_MASTER_ENV]: bad, [VRI03_COHORT_PERCENT_ENV]: '100' }) });
    assertEquals(s.masterEnabled, trimmedTrue, JSON.stringify(bad));
  }
  for (const bad of ['-1', '101', '50.5', 'abc', '', ' ', '1e2']) assertEquals(parseCohortPercent(bad), 0, bad);
  assertEquals(parseCohortPercent(' 25 '), 25);
});

Deno.test('vri03 flag: no cohort key is never in cohort, even at 100%', () => {
  for (const cohortKey of [undefined, null, '', '   ']) {
    const s = resolveVri03Flags({ cohortKey, envGet: envOf({ ...ALL_SUBS_ON, [VRI03_MASTER_ENV]: 'true', [VRI03_COHORT_PERCENT_ENV]: '100' }) });
    assertEquals(s.inCohort, false);
    assertEquals(s.cohortBucket, null);
  }
});

Deno.test('vri03 flag: cohort bucket is deterministic and in range', () => {
  for (const key of ['a', 'user-1', 'user-2', 'x'.repeat(200)]) {
    const b = cohortBucketFor(key);
    assertEquals(b, cohortBucketFor(key));
    assert(Number.isInteger(b) && b >= 0 && b < 100);
  }
  // Roughly uniform: 1,000 synthetic keys at 30% should land 20-40% in cohort.
  let inCohort = 0;
  for (let i = 0; i < 1000; i++) {
    if (resolveVri03Flags({ cohortKey: `synthetic-${i}`, envGet: envOf({ [VRI03_MASTER_ENV]: 'true', [VRI03_COHORT_PERCENT_ENV]: '30' }) }).inCohort) inCohort++;
  }
  assert(inCohort > 200 && inCohort < 400, String(inCohort));
});

Deno.test('vri03 flag: contract is not yet wired into the scan path (Phase A BENCHMARK PENDING)', async () => {
  // Phase A did not pass its gate, so no change may be routed through this flag
  // yet. Wiring a sub-flag must come with its own benchmark row; update this
  // assertion in that same change.
  for (const file of ['./index.ts', './scanCommerceRouter.ts', './qualityTuneCommerce.ts', './commerceRelevanceQueries.ts', './scannerQualityGate.ts']) {
    const src = await Deno.readTextFile(new URL(file, import.meta.url));
    assert(!src.includes('vri03ScanImprovementsFlag'), `${file} must not import the VRI-03 flag yet`);
  }
});
