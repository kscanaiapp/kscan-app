/**
 * Legacy Render /api/analyze retirement.
 *
 * Scanner, TextScan and Elise all route through Supabase Edge Functions. The
 * public Render analysis surface is permanently retired and must answer 410
 * without parsing a body, authenticating, invoking a model provider, falling
 * back, or forwarding the request.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const serverSource = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('the retired analyze surface answers 410 for every method', () => {
  assert.match(
    serverSource,
    /app\.all\('\/api\/analyze',\s*\(_req,\s*res\)\s*=>\s*res\.status\(410\)/,
    'a single app.all tombstone must cover every HTTP method',
  );
  assert.match(serverSource, /LEGACY_ANALYZE_DISABLED/);
});

test('the tombstone is registered before JSON body parsing', () => {
  const tombstoneAt = serverSource.indexOf("app.all('/api/analyze'");
  const jsonParserAt = serverSource.indexOf('app.use(express.json(');
  assert.ok(tombstoneAt > -1, 'tombstone present');
  assert.ok(jsonParserAt > -1, 'json parser present');
  assert.ok(
    tombstoneAt < jsonParserAt,
    'a retired route must never parse or log the request body',
  );
});

test('no live analyze route can shadow the tombstone', () => {
  const code = stripComments(serverSource);
  assert.doesNotMatch(
    code,
    /app\.(post|get|put|patch|delete)\(\s*'\/api\/analyze'/,
    'the legacy method-specific route must not be re-registered',
  );
});

test('the retired surface invokes no model provider', () => {
  const code = stripComments(serverSource);
  // The tombstone body itself must be a pure status response.
  const tombstone = code.slice(
    code.indexOf("app.all('/api/analyze'"),
    code.indexOf("app.use(express.json("),
  );
  for (const forbidden of ['fetch(', 'generateContent', 'gemini', 'openrouter', 'next(']) {
    assert.equal(
      tombstone.toLowerCase().includes(forbidden.toLowerCase()),
      false,
      `retired route must not reference ${forbidden}`,
    );
  }
});

test('the retired Gemini experimental model is absent from the server', () => {
  assert.doesNotMatch(serverSource, /gemini-2\.0-flash-exp/);
});
