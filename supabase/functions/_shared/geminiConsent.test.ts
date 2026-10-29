for (const [file, marker] of [
  ['../scan-identify/index.ts', 'await requireGeminiConsent(userId)'],
  ['../stylechat-generate/index.ts', 'await requireGeminiConsent(userId)'],
  ['../style-outfit-generate/index.ts', 'await requireGeminiConsent(userId)'],
  ['../purchase-import-extract/handler.ts', 'await deps.checkGeminiConsent(user.id)'],
]) {
  Deno.test(`Gemini receipt authority is attached at ${file}`, async () => {
    const source = await Deno.readTextFile(new URL(file, import.meta.url));
    if (!source.includes(marker)) throw new Error('Missing before-transfer consent authority: ' + marker);
  });
}

import { requireGeminiConsent, GEMINI_CONSENT_VERSION } from './geminiConsent.ts';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const receipt = (user = A, version = GEMINI_CONSENT_VERSION) => [{ user_id: user, acceptance_type: 'ai_processing', policy_version: version }];
function expect(value: unknown, expected: unknown) { if (value !== expected) throw new Error(`${value} !== ${expected}`); }
for (const [label, payload] of [
  ['absent', []], ['old version', receipt(A, 'v1')], ['foreign actor', receipt(B)],
  ['null', null], ['object', {}], ['duplicate array', [...receipt(), ...receipt()]],
  ['wrong type', [{ user_id: A, acceptance_type: 'privacy', policy_version: GEMINI_CONSENT_VERSION }]],
] as const) {
  Deno.test(`Gemini receipt rejects ${label} before provider dispatch`, async () => {
    let dispatched = 0;
    const denied = await requireGeminiConsent(A, async () => Response.json(payload));
    if (!denied) dispatched++;
    expect(denied?.status, 403); expect(dispatched, 0);
  });
}
for (const actor of [null, '', B + "' OR 1=1", '../'+A, 'localhost', '\uFF11'.repeat(36)]) {
  Deno.test(`Gemini receipt rejects invalid actor ${JSON.stringify(actor)} without a lookup`, async () => {
    let lookups = 0;
    const denied = await requireGeminiConsent(actor, async () => { lookups++; return Response.json(receipt()); });
    expect(denied?.status, 403); expect(lookups, 0);
  });
}
for (const status of [401,429,500]) {
  Deno.test(`Gemini receipt lookup HTTP ${status} fails closed`, async () => {
    expect((await requireGeminiConsent(A, async () => new Response('', {status})))?.status, 503);
  });
}
for (const raw of ['', '{bad json']) {
  Deno.test(`Gemini receipt malformed/empty response ${JSON.stringify(raw)} fails closed`, async () => {
    expect((await requireGeminiConsent(A, async () => new Response(raw)))?.status, 503);
  });
}
Deno.test('Gemini receipt timeout fails closed', async () => {
  expect((await requireGeminiConsent(A, async () => { throw new DOMException('timeout','TimeoutError'); }))?.status, 503);
});
Deno.test('Gemini receipt current actor, withdrawal and re-consent are rechecked without cache', async () => {
  let rows = receipt(); const paths: string[] = [];
  const read = async (path: string) => { paths.push(path); return Response.json(rows); };
  expect(await requireGeminiConsent(A, read), null);
  rows = []; expect((await requireGeminiConsent(A, read))?.status, 403);
  rows = receipt(); expect(await requireGeminiConsent(A, read), null);
  expect(paths.length, 3);
  const query = new URL('https://example.test/'+paths[0]).searchParams;
  expect(query.get('user_id'), 'eq.'+A); expect(query.get('policy_version'), 'eq.'+GEMINI_CONSENT_VERSION);
});
Deno.test('Scanner commerce-only routing remains before Gemini consent authority', async () => {
  const source = await Deno.readTextFile(new URL('../scan-identify/index.ts', import.meta.url));
  expect(source.indexOf('MODE B: commerce-only request') < source.indexOf('await requireGeminiConsent(userId)'), true);
});
