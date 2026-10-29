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
  const currentPermission = async () => Response.json([]);
  expect(await requireGeminiConsent(A, read, currentPermission), null);
  rows = []; expect((await requireGeminiConsent(A, read, currentPermission))?.status, 403);
  rows = receipt(); expect(await requireGeminiConsent(A, read, currentPermission), null);
  expect(paths.length, 3);
  const query = new URL('https://example.test/'+paths[0]).searchParams;
  expect(query.get('user_id'), 'eq.'+A); expect(query.get('policy_version'), 'eq.'+GEMINI_CONSENT_VERSION);
});
Deno.test('Scanner commerce-only routing remains before Gemini consent authority', async () => {
  const source = await Deno.readTextFile(new URL('../scan-identify/index.ts', import.meta.url));
  expect(source.indexOf('MODE B: commerce-only request') < source.indexOf('await requireGeminiConsent(userId)'), true);
});

for (const [label, payload, status] of [
  ['existing receipt without override', [], null],
  ['explicit re-consent', [{ user_id: A, policy_version: GEMINI_CONSENT_VERSION, granted: true }], null],
  ['durable withdrawal', [{ user_id: A, policy_version: GEMINI_CONSENT_VERSION, granted: false }], 403],
  ['foreign permission', [{ user_id: B, policy_version: GEMINI_CONSENT_VERSION, granted: true }], 503],
  ['wrong version', [{ user_id: A, policy_version: 'v1', granted: true }], 503],
  ['string grant', [{ user_id: A, policy_version: GEMINI_CONSENT_VERSION, granted: 'true' }], 503],
  ['null body', null, 503], ['object body', {}, 503],
  ['duplicate rows', [{ granted: true }, { granted: true }], 503],
] as const) {
  Deno.test(`Gemini current permission: ${label}`, async () => {
    const response = await requireGeminiConsent(A, async () => Response.json(receipt()), async () => Response.json(payload));
    expect(response?.status ?? null, status);
  });
}
for (const status of [401, 429, 500]) {
  Deno.test(`Gemini permission lookup HTTP ${status} blocks dispatch`, async () => {
    const response = await requireGeminiConsent(A, async () => Response.json(receipt()), async () => new Response('', { status }));
    expect(response?.status, 503);
  });
}
for (const body of ['', '{']) {
  Deno.test(`Gemini permission lookup invalid JSON ${JSON.stringify(body)} blocks dispatch`, async () => {
    expect((await requireGeminiConsent(A, async () => Response.json(receipt()), async () => new Response(body)))?.status, 503);
  });
}
Deno.test('Gemini permission timeout blocks dispatch', async () => {
  expect((await requireGeminiConsent(A, async () => Response.json(receipt()), async () => {
    throw new DOMException('timeout', 'TimeoutError');
  }))?.status, 503);
});
Deno.test('durable withdrawal and re-consent change subsequent requests without mutating receipts or caching permission', async () => {
  let granted = true; let lookups = 0;
  const read = async (path: string) => {
    lookups++;
    const query = new URL('https://fixture.invalid/' + path).searchParams;
    expect(query.get('user_id'), 'eq.' + A);
    return Response.json([{ user_id: A, policy_version: GEMINI_CONSENT_VERSION, granted }]);
  };
  const receipts = async () => Response.json(receipt());
  expect(await requireGeminiConsent(A, receipts, read), null);
  granted = false; expect((await requireGeminiConsent(A, receipts, read))?.status, 403);
  granted = true; expect(await requireGeminiConsent(A, receipts, read), null);
  expect(lookups, 3);
});
