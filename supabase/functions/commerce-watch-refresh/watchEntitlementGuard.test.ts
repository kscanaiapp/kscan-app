import { runEntitledWatchObservation } from './watchEntitlementGuard.ts';

Deno.test('lapse before provider dispatch skips work and reactivation resumes', async () => {
  let active = true;
  let calls = 0;
  const read = async () => active;
  const observe = async () => { calls++; return 'observed'; };
  await runEntitledWatchObservation('synthetic', read, observe);
  active = false;
  const skipped = await runEntitledWatchObservation('synthetic', read, observe);
  if (skipped !== null || calls !== 1) throw Error('lapse dispatched premium work');
  active = true;
  await runEntitledWatchObservation('synthetic', read, observe);
  if (Number(calls) !== 2) throw Error('reactivation did not resume');
});

Deno.test('unavailable or nonboolean entitlement fails closed', async () => {
  let calls = 0;
  const observe = async () => ++calls;
  await runEntitledWatchObservation('synthetic', async () => { throw Error('unavailable'); }, observe);
  await runEntitledWatchObservation('synthetic', async () => 'true' as unknown as boolean, observe);
  if (calls !== 0) throw Error('unproven access dispatched premium work');
});
