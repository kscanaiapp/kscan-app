'use strict';

// Regression coverage for the master/staging runtime provenance resolution.
//
// These assertions lock in three decisions that were previously recorded as
// REQUIRES_OWNER_DECISION in docs/release/master-staging-provenance-map.md:
//
//   1. The legacy Render /api/analyze proxy is retired (no runtime consumer).
//   2. This Render service owns transactional email; the Supabase deletion flow
//      is an existing consumer of /internal/email/account-deletion-restoration.
//   3. No non-production EAS build profile may target the production Supabase
//      project.
//
// They are deliberately content-level (not network) assertions so they run
// deterministically in CI without deploying anything.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

const server = read('server.js');
const renderConfig = read('render.yaml');
const easConfig = JSON.parse(read('eas.json'));
const deletionCommon = read('supabase', 'functions', '_shared', 'deletion', 'common.ts');

const PRODUCTION_SUPABASE_REF = 'wyyuqfdxucjksghsmhry';
const STAGING_SUPABASE_REF = 'yzqjvdfgefveprobvvyw';

// ── 1. Legacy Render analyze retirement ──────────────────────────────────────

test('legacy Render analyze route is an unconditional pre-body tombstone', () => {
  assert.match(
    server,
    /app\.all\('\/api\/analyze'[\s\S]*?status\(410\)[\s\S]*?LEGACY_ANALYZE_DISABLED/,
    'server.js must expose an unconditional 410 tombstone for /api/analyze',
  );
  assert.doesNotMatch(
    server,
    /app\.post\('\/api\/analyze'/,
    'the legacy POST /api/analyze handler must not be reachable',
  );
  assert.ok(
    server.indexOf("app.all('/api/analyze'") < server.indexOf("app.use(express.json({ limit: '15mb' }))"),
    'the tombstone must execute before the shared request-body parser',
  );
});

test('no feature flag can re-enable the retired analyze route', () => {
  assert.doesNotMatch(server, /KSCAN_LEGACY_ANALYZE_ENABLED/);
  // The tombstone must not be wrapped in a conditional.
  const tombstoneIndex = server.indexOf("app.all('/api/analyze'");
  const precedingLine = server.slice(0, tombstoneIndex).split('\n').slice(-2).join('\n');
  assert.doesNotMatch(precedingLine, /^\s*(if|else)\b/m, 'the tombstone must not be conditionally registered');
});

test('Render configuration carries no paid LLM provider credentials', () => {
  for (const key of ['GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'OPENROUTER_MODEL', 'USE_OPENROUTER']) {
    assert.doesNotMatch(renderConfig, new RegExp(key), `${key} must not be provisioned on the Render service`);
  }
});

test('QA scripts cannot silently fall back to the retired hosted endpoint', () => {
  for (const script of ['qa-fixtures.js', 'qa-convergence.js']) {
    const content = read('scripts', script);
    assert.doesNotMatch(
      content,
      /\|\|\s*'https:\/\/kscan-app-1\.onrender\.com/,
      `${script} must not default to the retired hosted analyze host`,
    );
    assert.match(content, /no legacy hosted default exists/, `${script} must fail loudly when unconfigured`);
  }
});

// The scan runtime must remain on the authenticated, rate-limited Edge Function.
test('scan runtime routes through scan-identify, not the retired Render proxy', () => {
  const useKScan = read('hooks', 'useKScan.js');
  assert.match(useKScan, /SCAN_IDENTIFY_BACKEND_ENABLED/);
  assert.doesNotMatch(
    useKScan,
    /await\s+analyzeImage\s*\(/,
    'the camera path must not call the legacy Render analyze client',
  );
});

// ── 2. Transactional email ownership ─────────────────────────────────────────

test('this service owns the transactional email routes its Supabase consumer calls', () => {
  assert.ok(
    fs.existsSync(path.join(ROOT, 'services', 'transactionalEmail.js')),
    'services/transactionalEmail.js must exist in this repository',
  );
  for (const route of ['/internal/email/waitlist-welcome', '/internal/email/account-deletion-restoration']) {
    assert.ok(server.includes(`'${route}'`), `server.js must register ${route}`);
  }
});

test('the deployed restoration route matches the Supabase deletion consumer', () => {
  // supabase/functions/_shared/deletion/common.ts POSTs to this exact path with
  // this exact header. A rename on either side silently drops restoration email.
  assert.match(deletionCommon, /\/internal\/email\/account-deletion-restoration/);
  assert.match(deletionCommon, /'x-kscan-email-secret'/);
  assert.ok(server.includes("'/internal/email/account-deletion-restoration'"));
  assert.ok(server.includes("req.headers['x-kscan-email-secret']"));
});

test('internal email routes authenticate before parsing any request body', () => {
  const authIndex = server.indexOf('function requireInternalEmailAuth');
  assert.ok(authIndex > -1, 'requireInternalEmailAuth must exist');

  for (const route of ['/internal/email/waitlist-welcome', '/internal/email/account-deletion-restoration']) {
    const routeIndex = server.indexOf(`'${route}'`);
    const block = server.slice(routeIndex, routeIndex + 400);
    const guardIndex = block.indexOf('requireInternalEmailAuth');
    const parserIndex = block.indexOf('express.json(');
    assert.ok(guardIndex > -1, `${route} must be guarded by requireInternalEmailAuth`);
    assert.ok(parserIndex > -1, `${route} must declare its own bounded body parser`);
    assert.ok(guardIndex < parserIndex, `${route} must authenticate before parsing the body`);
  }
});

test('email secrets are referenced but never committed', () => {
  for (const key of ['RESEND_API_KEY', 'KSCAN_EMAIL_INTERNAL_SECRET']) {
    assert.match(renderConfig, new RegExp(`key: ${key}[\\s\\S]*?sync: false`), `${key} must be sync:false`);
  }
  assert.doesNotMatch(renderConfig, /re_[A-Za-z0-9]{16,}/, 'no literal Resend key may be committed');
});

// The catalog image mount is still a live staging surface and must not be
// retired alongside /api/analyze — data/catalog.json resolves image URLs to it.
test('catalog image hosting remains served', () => {
  assert.match(server, /'\/catalog-images'/);
  assert.doesNotMatch(
    server,
    /app\.all\('\/catalog-images\/\*'[\s\S]{0,200}status\(410\)/,
    'catalog-images must not be tombstoned while catalog.json still references it',
  );
});

// ── 3. EAS environment targeting ─────────────────────────────────────────────

test('no non-production build profile targets the production Supabase project', () => {
  for (const [name, profile] of Object.entries(easConfig.build)) {
    if (name === 'production') continue;
    const env = profile.env || {};
    const url = env.EXPO_PUBLIC_SUPABASE_URL;
    if (!url) continue;
    assert.ok(
      !url.includes(PRODUCTION_SUPABASE_REF),
      `build profile "${name}" must not target the production Supabase project`,
    );
    assert.ok(
      url.includes(STAGING_SUPABASE_REF),
      `build profile "${name}" must target the staging Supabase project`,
    );
    assert.ok(
      !(env.EXPO_PUBLIC_SUPABASE_ANON_KEY || '').includes('Ind5eXVxZmR4'),
      `build profile "${name}" must not carry the production anon key`,
    );
  }
});

test('the production build profile still targets production', () => {
  const env = easConfig.build.production.env || {};
  assert.ok(env.EXPO_PUBLIC_SUPABASE_URL.includes(PRODUCTION_SUPABASE_REF));
});

test('every build profile declares an explicit Supabase target', () => {
  for (const [name, profile] of Object.entries(easConfig.build)) {
    const env = profile.env || {};
    assert.ok(
      typeof env.EXPO_PUBLIC_SUPABASE_URL === 'string' && env.EXPO_PUBLIC_SUPABASE_URL.length > 0,
      `build profile "${name}" must declare EXPO_PUBLIC_SUPABASE_URL rather than inherit it`,
    );
  }
});

test('iOS store metadata binding is preserved', () => {
  assert.equal(easConfig.submit.production.ios.metadataPath, './store.config.json');
});
