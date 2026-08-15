/**
 * DEF-008 / DEF-009 — cold launch must always reach a terminal state.
 *
 * Both defects produced the same user-visible outcome: the app parked on the
 * full-screen K-SCAN spinner forever. They are pinned together because the
 * invariant is one invariant —
 *
 *   cold launch
 *     -> required privacy/auth bootstrap completes or fails recoverably
 *     -> navigation becomes available
 *     -> no indefinite loading state
 *
 * Neither fix may be replaced by a timeout that navigates *past* the guard:
 * bounded waiting is the fix, bypassing initialization is not.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function readSource(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

// ── DEF-008 — navigation readiness ─────────────────────────────────────────

test('DEF-008: readiness polling has no give-up deadline', () => {
  const layout = readSource('app/_layout.tsx');
  const block = layout.slice(
    layout.indexOf('if (!navigationRef) return;'),
    layout.indexOf('const waitingForAuthCallbackRoute'),
  );
  assert.ok(block.length > 0, 'navigation readiness effect not found');

  // The exact regression: a timer that stopped the poll without ever
  // recording readiness, stranding navReady at false forever.
  assert.ok(
    !/setTimeout\s*\(\s*\(\s*\)\s*=>\s*clearInterval/.test(block),
    'the poll must not be cancelled by a deadline that never sets navReady',
  );
  assert.ok(
    !/\b2000\b/.test(block),
    'the 2s give-up deadline must be gone, not merely lengthened',
  );
});

test('DEF-008: readiness stops the poll once it actually arrives', () => {
  const layout = readSource('app/_layout.tsx');
  const block = layout.slice(
    layout.indexOf('if (!navigationRef) return;'),
    layout.indexOf('const waitingForAuthCallbackRoute'),
  );
  // Success must both latch navReady and stop the interval.
  assert.ok(
    /clearInterval\(id\)[\s\S]{0,80}setNavReady\(true\)/.test(block),
    'observing readiness must clear the interval and set navReady',
  );
  assert.ok(/return \(\) => clearInterval\(id\)/.test(block), 'unmount must clear the interval');
});

test('DEF-008: waiting longer never bypasses the auth/privacy guard', () => {
  const layout = readSource('app/_layout.tsx');
  // navReady may only gate whether the router can accept a navigation. The
  // decision to navigate stays with guardState.
  assert.ok(
    /guardState\.action !== 'redirect'[\s\S]{0,120}!navReady/.test(layout),
    'the redirect effect must still require guardState to say redirect',
  );
  assert.ok(
    !/setNavReady\(true\)[\s\S]{0,200}router\.replace/.test(layout),
    'readiness must never itself trigger a navigation',
  );
});

// ── DEF-009 — privacy bootstrap ────────────────────────────────────────────

test('DEF-009: every privacy request is bounded and cancellable', () => {
  const source = readSource('services/supabasePrivacy.js');

  assert.ok(/new AbortController\(\)/.test(source), 'requests must be cancellable');
  assert.ok(/signal: controller\.signal/.test(source), 'the signal must reach fetch');
  assert.ok(
    /setTimeout\(\(\) => controller\.abort\(\)/.test(source),
    'the deadline must abort the request, not merely abandon the promise',
  );
  assert.ok(/clearTimeout\(timer\)/.test(source), 'the timer must be cleared on every path');

  const timeout = source.match(/PRIVACY_REQUEST_TIMEOUT_MS\s*=\s*(\d+)/);
  assert.ok(timeout, 'the timeout must be a named constant');
  const ms = Number(timeout[1]);
  // Long enough not to punish a merely slow network, short enough that a dead
  // socket cannot hold the boot spinner for a user-visible eternity.
  assert.ok(ms >= 5000 && ms <= 15000, `timeout ${ms}ms outside the sane 5-15s band`);
});

test('DEF-009: a timed-out request rejects, so the existing catch can run', () => {
  const source = readSource('services/supabasePrivacy.js');
  assert.ok(
    /AbortError[\s\S]{0,200}throw new Error/.test(source),
    'an aborted request must reject with a readable error, never resolve',
  );
  // Resolving on timeout would make a dead network look like a successful
  // empty read and silently reset the user's privacy preferences.
  assert.ok(
    !/AbortError[\s\S]{0,200}return (null|\{|\[)/.test(source),
    'a timeout must never be converted into a successful empty result',
  );
});

test('DEF-009: boot is released even when the remote read fails', () => {
  const context = readSource('contexts/PrivacyPreferencesContext.tsx');

  // The catch must degrade rather than rethrow...
  assert.ok(
    /catch \(error\)[\s\S]{0,400}setRemoteFetchFailed\(true\)/.test(context),
    'a failed remote read must be recorded as a degraded state',
  );
  // ...and hydrate must still reach its terminal setBootStatus('ready'), which
  // is what actually releases the routing gate.
  const tail = context.slice(context.indexOf('} else if (!auth.isAuthenticated) {'));
  assert.ok(
    /setBootStatus\('ready'\)/.test(tail),
    'hydrate must reach a terminal ready state after the auth branch',
  );
});
