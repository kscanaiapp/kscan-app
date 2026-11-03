// Build 35 W2: valid JSON null and primitive watch actions must fail closed.
// Executes the REAL input-validation block extracted from commerce-watch-refresh.
// Does not bypass auth: the source block lives after requireUser(), and this
// harness deliberately exercises only the post-auth body contract.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.resolve(__dirname, '..', 'supabase/functions/commerce-watch-refresh/index.ts'), 'utf8');

const begin = source.indexOf('  let body: UserActionBody;');
const end = source.indexOf('  // Revalidate account state', begin);
assert.ok(begin > 0 && end > begin, 'actual watchlist validation block must be found');
const block = source.slice(begin, end).replace('let body: UserActionBody;', 'let body;');
const execute = new Function('req', 'json', 'return (async () => {\n' + block + '\nreturn { validated: true, body };\n})()');
const respond = (body, status) => ({ body, status });
const parse = body => execute({ json: async () => body }, respond);

for (const [label, body] of [
  ['JSON null', null],
  ['JSON array', []],
  ['JSON number', 123],
  ['JSON boolean', false],
  ['JSON string', 'refresh'],
]) {
  test(label + ' is a controlled 400 invalid_body, not an uncontrolled throw', async () => {
    const result = await parse(body);
    assert.equal(result.status, 400);
    assert.equal(result.body.error, 'invalid_body');
    assert.equal(result.body.code, 'invalid_body');
    assert.equal(result.validated, undefined);
  });
}

test('malformed JSON is also a controlled 400', async () => {
  const result = await execute({ json: async () => { throw new SyntaxError('fixture bad json'); } }, respond);
  assert.equal(result.status, 400);
  assert.equal(result.body.code, 'invalid_body');
});

test('valid object continues to the existing user-action dispatch', async () => {
  const body = { action: 'refresh', watchId: '11111111-1111-4111-8111-111111111111' };
  const result = await parse(body);
  assert.equal(result.validated, true);
  assert.equal(result.body, body);
});

test('validator executes after authentication and before any action access', () => {
  const auth = source.indexOf('authUser = await requireUser(req)');
  const guard = source.indexOf("if (body === null || typeof body !== 'object' || Array.isArray(body))");
  const action = source.indexOf("if (typeof body.action === 'string'", guard);
  assert.ok(auth > 0 && auth < guard && guard < action);
});
