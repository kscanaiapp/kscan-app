// REG-KPLUS-001 — the legacy VTO proxy must stay retired.
// GOV-KPLUS-002 — the perimeter manifest must not claim protections it lacks.
//
// tryon-clothes-pro was the ORIGINAL virtual-try-on proxy: unauthenticated POST,
// reads the shared RAPIDAPI_KEY, calls the paid provider directly. It was
// DELETED from staging for exactly that reason — it is an anon-key bypass of
// auth, K+, the kill switch and quota, all of which vto-generate now enforces.
//
// The provider-capable SOURCE nonetheless survived into the Build 34 integration
// branch, leaving the deletion one `supabase functions deploy` away from being
// undone. And the perimeter manifest described it as hardened, quota-protected
// and CORS-restricted — none of which was true of the source it described.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

// The retirement notice/refusal is split across two files: index.ts is the
// Deno.serve entry point only, and retiredHandler.ts holds the actual refusal
// as an exported function so it can be exercised as a function rather than
// only asserted about as source text. Both together are "the handler" this
// file certifies -- reading only index.ts would miss everything the split
// moved out of it.
const HANDLER_RAW = [
  read('supabase', 'functions', 'tryon-clothes-pro', 'index.ts'),
  read('supabase', 'functions', 'tryon-clothes-pro', 'retiredHandler.ts'),
].join('\n');

/**
 * Assertions below are about what the handler DOES, not what it documents.
 * The retirement notice legitimately explains that the old proxy read
 * RAPIDAPI_KEY, so comments are stripped before matching -- otherwise the
 * explanation of the defect would read as the defect.
 */
const HANDLER = HANDLER_RAW
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');
const PERIMETER = JSON.parse(read('security', 'perimeter', 'public-ingress-manifest.json'));

function perimeterEntry(name) {
  let found = null;
  (function walk(node) {
    if (found) return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node && typeof node === 'object') {
      if (node.name === name) { found = node; return; }
      Object.values(node).forEach(walk);
    }
  })(PERIMETER);
  return found;
}

// ── REG-KPLUS-001: the handler cannot spend money ────────────────────────────

test('the retired handler NEVER reads the provider credential', () => {
  assert.doesNotMatch(
    HANDLER,
    /RAPIDAPI_KEY/,
    'a retired endpoint must not read the shared provider key at all',
  );
  assert.doesNotMatch(HANDLER, /Deno\.env\.get/, 'it needs no secrets whatsoever');
});

test('the retired handler NEVER calls the provider', () => {
  assert.doesNotMatch(HANDLER, /\bfetch\s*\(/, 'no outbound request may be made');
  assert.doesNotMatch(HANDLER, /rapidapi\.com/i, 'no provider host may remain');
  assert.doesNotMatch(HANDLER, /try-on-clothes-pro\.p\./i);
});

test('the retired handler answers 410 endpoint_retired', () => {
  assert.match(HANDLER, /status:\s*410/);
  assert.match(HANDLER, /endpoint_retired/);
  assert.match(HANDLER, /vto-generate/, 'it must name its replacement');
});

test('the retired handler parses no request body', () => {
  // A retired endpoint that still parses a person image is still handling
  // sensitive data it has no reason to touch.
  assert.doesNotMatch(HANDLER, /req\.json\(\)/);
  assert.doesNotMatch(HANDLER, /person_image/);
  assert.doesNotMatch(HANDLER, /top_garment|bottom_garment/);
});

test('the provider proxy architecture is not reintroduced anywhere in the file', () => {
  for (const marker of ['UPSTREAM_TIMEOUT', 'RAPIDAPI_HOST', 'RAPIDAPI_URL', 'parseRequest']) {
    assert.doesNotMatch(HANDLER, new RegExp(marker), `${marker} must be gone`);
  }
});

test('the retired function stays OFF the staging deployment allowlist', () => {
  const allowlist = read('security', 'scripts', 'staging-deployment-allowlist.js');
  const list = allowlist.slice(
    allowlist.indexOf('const STAGING_DEPLOYMENT_ALLOWLIST'),
    allowlist.indexOf('];', allowlist.indexOf('const STAGING_DEPLOYMENT_ALLOWLIST')),
  );
  // It may be MENTIONED in the deliberately-not-listed comment, but never as an
  // active entry.
  assert.doesNotMatch(
    list,
    /^\s*'tryon-clothes-pro',/m,
    'the retired proxy must never be approved for automatic deployment',
  );
});

// ── GOV-KPLUS-002: the manifest tells the truth ──────────────────────────────

test('the perimeter manifest no longer claims protections the handler lacks', () => {
  const entry = perimeterEntry('tryon-clothes-pro');
  assert.ok(entry, 'the perimeter manifest must still describe the endpoint');

  // Each of these was previously asserted and was false against the source.
  assert.doesNotMatch(
    entry.accessControl,
    /verify_jwt is true \+ account-state check \(hardened\)/,
    'the handler performs no authentication at all',
  );
  assert.doesNotMatch(
    entry.rateLimitStatus,
    /quota reservation/,
    'the handler has no quota',
  );
  assert.doesNotMatch(
    entry.corsStatus,
    /caller-aware allowlist/,
    'the handler does not implement a caller-aware CORS allowlist',
  );
  assert.doesNotMatch(entry.environment, /hardened in source/);
});

test('the perimeter manifest states the retirement and the absence of cost exposure', () => {
  const entry = perimeterEntry('tryon-clothes-pro');
  assert.match(entry.environment, /RETIRED/);
  assert.match(entry.riskClassification, /RETIRED/);
  assert.match(entry.providerCostExposure, /none/i);
  assert.match(entry.deploymentStatus, /NOT deployed/);
});

test('the manifest claim matches the source: no credential read, no provider call', () => {
  // The point of GOV-KPLUS-002 is that the manifest and the source must agree.
  // Prove the agreement, rather than asserting the manifest in isolation.
  const entry = perimeterEntry('tryon-clothes-pro');
  const claimsNoCost = /none/i.test(entry.providerCostExposure);
  const sourceReadsKey = /RAPIDAPI_KEY/.test(HANDLER);
  const sourceCallsProvider = /\bfetch\s*\(/.test(HANDLER);
  assert.equal(
    claimsNoCost && !sourceReadsKey && !sourceCallsProvider,
    true,
    'the manifest claims no provider cost exposure; the source must actually have none',
  );
});

test('vto-generate remains the only virtual try-on path', () => {
  assert.match(HANDLER, /vto-generate/);
  // And the retired file must not be an alias that forwards to it either.
  assert.doesNotMatch(HANDLER, /functions\/v1\/vto-generate/);
});
