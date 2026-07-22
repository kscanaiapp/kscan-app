const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const expoRoute = fs.readFileSync(path.join(ROOT, 'app', 'api', 'analyze+api.js'), 'utf8');
const renderConfig = fs.readFileSync(path.join(ROOT, 'render.yaml'), 'utf8');
const easConfig = fs.readFileSync(path.join(ROOT, 'eas.json'), 'utf8');
const mobileApi = fs.readFileSync(path.join(ROOT, 'services', 'api.js'), 'utf8');
const fixtureScript = fs.readFileSync(path.join(ROOT, 'scripts', 'qa-fixtures.js'), 'utf8');
const convergenceScript = fs.readFileSync(path.join(ROOT, 'scripts', 'qa-convergence.js'), 'utf8');

test('legacy Node analyze route is an unconditional pre-body tombstone', () => {
  assert.match(server, /app\.all\('\/api\/analyze'[\s\S]*status\(410\)[\s\S]*LEGACY_ANALYZE_DISABLED/);
  assert.doesNotMatch(server, /app\.post\('\/api\/analyze'/);
  assert.ok(
    server.indexOf("app.all('/api/analyze'") < server.indexOf('express.json('),
    'the tombstone must execute before request-body parsing',
  );
});

test('legacy Expo analyze route contains no provider implementation', () => {
  assert.match(expoRoute, /export async function GET\(\)/);
  assert.match(expoRoute, /export async function POST\(\)/);
  assert.match(expoRoute, /status: 410/);
  assert.match(expoRoute, /LEGACY_ANALYZE_DISABLED/);
  assert.doesNotMatch(expoRoute, /GEMINI_API_KEY|generativelanguage|OPENROUTER|fetch\(/i);
});

test('Render production configuration contains no paid LLM provider credentials', () => {
  assert.doesNotMatch(renderConfig, /GEMINI_API_KEY/);
  assert.doesNotMatch(renderConfig, /OPENROUTER_API_KEY/);
  assert.doesNotMatch(renderConfig, /OPENROUTER_MODEL/);
  assert.doesNotMatch(renderConfig, /USE_OPENROUTER/);
});

test('release and QA callers cannot silently fall back to the retired Render host', () => {
  for (const [name, content] of Object.entries({
    'eas.json': easConfig,
    'services/api.js': mobileApi,
    'scripts/qa-fixtures.js': fixtureScript,
    'scripts/qa-convergence.js': convergenceScript,
  })) {
    assert.doesNotMatch(content, /kscan-app-1\.onrender\.com/, name);
  }
  assert.doesNotMatch(mobileApi, /HOSTED_BETA_BASE_URL/);
  assert.match(mobileApi, /KSCAN_API_URL_NOT_CONFIGURED/);
});
