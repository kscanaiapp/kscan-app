// B41 audit K-14: a member's request can never bypass the server cooldown.
import { assertEquals, assertMatch, assertNotMatch } from 'jsr:@std/assert@1';
import { parsePullReconcileRequest } from './pullReconcileRequest.ts';

Deno.test('pull-reconcile request: accepted shapes', () => {
  assertEquals(parsePullReconcileRequest({}), { ok: true, trigger: 'check_again' });
  for (const trigger of ['post_purchase_unresolved', 'restore_unresolved', 'check_again'] as const) {
    assertEquals(parsePullReconcileRequest({ trigger }), { ok: true, trigger });
    assertEquals(parsePullReconcileRequest({ trigger, force: false }), { ok: true, trigger });
  }
});

Deno.test('pull-reconcile request: force:true is refused (403), never passed to the cooldown claim', () => {
  assertEquals(parsePullReconcileRequest({ force: true }), { ok: false, httpStatus: 403, status: 'force_not_permitted' });
  assertEquals(parsePullReconcileRequest({ trigger: 'check_again', force: true }), { ok: false, httpStatus: 403, status: 'force_not_permitted' });
});

Deno.test('pull-reconcile request: actor injection and malformed input are refused (400)', () => {
  const malformed = { ok: false, httpStatus: 400, status: 'malformed_request' } as const;
  for (const body of [
    null, [], 'x', 7,
    { userId: '11111111-1111-4111-8111-111111111111' },
    { trigger: 'check_again', actorId: 'x' },
    { trigger: 'grant_me' },
    { trigger: 3 },
    { force: 'true' },
    { force: 1 },
  ]) {
    assertEquals(parsePullReconcileRequest(body), malformed, JSON.stringify(body));
  }
});

Deno.test('pull-reconcile entry: the cooldown claim never receives a client-controlled force', async () => {
  const src = await Deno.readTextFile(new URL('../../kplus-revenuecat-pull-reconcile/index.ts', import.meta.url));
  assertMatch(src, /parsePullReconcileRequest\(body\)/);
  assertMatch(src, /p_force: false,/);
  assertNotMatch(src, /p_force: (?!false)/);
  assertNotMatch(src, /input\.force/);
});
