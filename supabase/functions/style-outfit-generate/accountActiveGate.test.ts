import { assertEquals } from 'jsr:@std/assert';
import { isOutfitAccountActive } from './accountActiveGate.ts';
Deno.test('outfit lifecycle must use the shared fail-closed account authority before request parsing', async () => {
  const source = await Deno.readTextFile(new URL('./index.ts', import.meta.url));
  assertEquals(source.includes('await isOutfitAccountActive(userId)'), true);
  assertEquals(source.indexOf('await isOutfitAccountActive(userId)') < source.indexOf('let body: unknown'), true);
});

for (const failure of ['missing profile', 'database unavailable', 'deactivated', 'account locked', 'pending deletion']) {
  Deno.test(`outfit account gate: ${failure} cannot authorize downstream work`, async () => {
    let downstream = 0;
    if (await isOutfitAccountActive('synthetic-user', async () => { throw new Error(failure); })) downstream++;
    assertEquals(downstream, 0);
  });
}

Deno.test('outfit account gate: verified active account proceeds with its verified identity', async () => {
  let checked = '';
  assertEquals(await isOutfitAccountActive('synthetic-user', async (id) => { checked = id; }), true);
  assertEquals(checked, 'synthetic-user');
});
