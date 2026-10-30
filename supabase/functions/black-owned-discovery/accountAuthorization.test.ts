import { createDiscoveryAuthenticator } from './accountAuthorization.ts';
import { createDiscoveryHandler } from './handler.ts';
import { input } from './fixtures.test.ts';
const actor = '11111111-1111-4111-8111-111111111111';
function equal(a: unknown, b: unknown) { if (JSON.stringify(a) !== JSON.stringify(b)) throw Error(`${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }
for (const state of ['active', 'pending_deletion', 'locked', 'lookup_failure', 'anonymous', 'invalid_token', 'disabled']) {
  Deno.test(`discovery current account authorization: ${state}`, async () => {
    const calls: string[] = [];
    const authenticate = createDiscoveryAuthenticator(async () => {
      calls.push('identity');
      if (state === 'invalid_token') throw new Response(null, { status: 401 });
      return { id: actor, isAnonymous: state === 'anonymous' };
    }, async (id) => {
      equal(id, actor); calls.push('account');
      if (['pending_deletion', 'locked'].includes(state)) throw new Response(null, { status: 403 });
      if (state === 'lookup_failure') throw new Error('fixture lookup failed');
    });
    const handle = createDiscoveryHandler({
      flags: () => ({ discovery: state !== 'disabled', badges: false, sponsored: false }),
      authenticate,
      claim: async (id) => { equal(id, actor); calls.push('quota'); return true; },
      discover: async () => { calls.push('catalog'); return { status: 'empty' }; },
    });
    const result = await handle(new Request('https://fixture.invalid', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-user-id': 'foreign-actor' },
      body: JSON.stringify(input),
    }));
    if (state === 'active') { equal(calls, ['identity', 'account', 'quota', 'catalog']); equal((await result.json()).status, 'empty'); }
    else if (state === 'disabled') equal(calls, []);
    else if (state === 'anonymous') { equal(calls, ['identity']); equal(result.status, 403); }
    else if (state === 'invalid_token') { equal(calls, ['identity']); equal(result.status, 401); }
    else { equal(calls, ['identity', 'account']); equal((await result.json()).status, 'unavailable'); }
  });
}
Deno.test('actual discovery index binds verified identity to shared account authority', async () => {
  const source = await Deno.readTextFile(new URL('./index.ts', import.meta.url));
  if (!/authenticate:\s*createDiscoveryAuthenticator\(requireUser,\s*assertAccountActive\)/.test(source)) throw Error('Missing deployed account authorization wiring');
});
