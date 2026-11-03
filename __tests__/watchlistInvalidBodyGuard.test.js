// Build 35 Watchlist: exercise the actual authenticated body-validation
// source segment with synthetic request objects, before any action dispatch.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '..', 'supabase/functions/commerce-watch-refresh/index.ts'), 'utf8');
const start = source.indexOf('  let body: UserActionBody;', source.indexOf('Deno.serve('));
const end = source.indexOf('  // Revalidate account state before any watch mutation.', start);
assert.ok(start > 0 && end > start, 'Watchlist real request-body guard must exist');

// The segment is copied verbatim from the Deno.serve handler, TypeScript
// transpiled, and run with controlled req/json. No network, auth or provider.
const compiled = ts.transpileModule(
  'async function routeBody(req) {\n' + source.slice(start, end) + '\nreturn body;\n}',
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;
const runner = new Function('json', compiled + '\nreturn routeBody;');
const bodyGuard = runner((payload, status) => ({ payload, status }));

for (const value of [null, [], ['create'], 1, true, false, 'create']) {
  test('invalid action payload safely returns 400 for ' + JSON.stringify(value), async () => {
    const result = await bodyGuard({ json: async () => value });
    assert.equal(result.status, 400);
    assert.equal(result.payload.code, 'invalid_body');
  });
}
test('malformed JSON returns bounded 400', async () => {
  const result = await bodyGuard({ json: async () => { throw new SyntaxError('bad json'); } });
  assert.equal(result.status, 400);
  assert.equal(result.payload.code, 'invalid_body');
});
test('object action reaches normal action routing without changing content', async () => {
  const v = { action: 'refresh', watchId: 'synthetic-watch' };
  const result = await bodyGuard({ json: async () => v });
  assert.equal(result, v);
});
test('empty object can be handled by the existing unknown-action branch', async () => {
  const v = {};
  assert.equal(await bodyGuard({ json: async () => v }), v);
});
