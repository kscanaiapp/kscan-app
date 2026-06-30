#!/usr/bin/env node
/**
 * Terminal-only scan readiness self-check.
 *
 * Verifies static/local facts required for the scan → recommendedProducts →
 * ProductShelf → dressing-room snapshot path. Does NOT require a device,
 * Supabase login, secrets, or backend redeploy.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const CHECKS = [];

function fail(message) {
  CHECKS.push({ ok: false, message });
}

function pass(message) {
  CHECKS.push({ ok: true, message });
}

function read(rel) {
  try {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
  } catch {
    return null;
  }
}

function hasText(rel, text) {
  const content = read(rel);
  return content ? content.includes(text) : false;
}

// ── git grep helper ───────────────────────────────────────────────────────────

function activeSourceHas(pattern, extraExcludes = []) {
  const base = [
    ':!node_modules', ':!dist', ':!qa', ':!archive', ':!tmp',
    ':!.gradle-user-home', ':!.idea', ':!.expo', ':!.maestro',
    ':!android', ':!apple-audit-assets', ':!scripts/seed-test-catalog.sql',
    ':!supabase/migrations',
  ];
  const excludes = [...base, ...extraExcludes].map((e) => `'${e}'`).join(' ');
  try {
    const output = execSync(
      `git grep -n "${pattern}" -- ${excludes} || true`,
      { cwd: ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    return output.trim();
  } catch {
    return '';
  }
}

// ── 1. .env.example documents required public env vars ───────────────────────

if (hasText('.env.example', 'EXPO_PUBLIC_SUPABASE_URL')) {
  pass('.env.example documents EXPO_PUBLIC_SUPABASE_URL');
} else {
  fail('.env.example is missing EXPO_PUBLIC_SUPABASE_URL');
}

if (hasText('.env.example', 'EXPO_PUBLIC_SCAN_IDENTIFY_BACKEND_ENABLED')) {
  pass('.env.example documents EXPO_PUBLIC_SCAN_IDENTIFY_BACKEND_ENABLED');
} else {
  fail('.env.example is missing EXPO_PUBLIC_SCAN_IDENTIFY_BACKEND_ENABLED');
}

// 1b. .env.example must document App Staging URL (not just the key name).
if (hasText('.env.example', 'wyyuqfdxucjksghsmhry.supabase.co')) {
  pass('.env.example documents App Staging Supabase URL (wyyuqfdxucjksghsmhry.supabase.co)');
} else {
  fail('.env.example is missing the App Staging Supabase URL (wyyuqfdxucjksghsmhry.supabase.co)');
}

// ── 2. eas.json development profile ──────────────────────────────────────────

const easJson = (() => {
  try { return JSON.parse(read('eas.json') || '{}'); } catch { return {}; }
})();
const devEnv = easJson?.build?.development?.env || {};

if (devEnv.EXPO_PUBLIC_SCAN_IDENTIFY_BACKEND_ENABLED === 'true') {
  pass('eas.json development profile has EXPO_PUBLIC_SCAN_IDENTIFY_BACKEND_ENABLED=true');
} else {
  fail('eas.json development profile is missing EXPO_PUBLIC_SCAN_IDENTIFY_BACKEND_ENABLED=true');
}

// ── 3. Human checklist exists and contains required warnings ─────────────────

const checklistPath = path.join(ROOT, 'docs', 'real-device-scan-checklist-v1.md');
if (fs.existsSync(checklistPath)) {
  pass('docs/real-device-scan-checklist-v1.md exists');
} else {
  fail('docs/real-device-scan-checklist-v1.md is missing');
}

const checklist = read('docs/real-device-scan-checklist-v1.md') || '';

if (checklist.includes('real-device') || checklist.toLowerCase().includes('real device') || checklist.includes('physical device')) {
  pass('Checklist warns: real-device validation required');
} else {
  fail('Checklist is missing real-device validation warning');
}

if (checklist.includes('.env.local') || checklist.includes('env.local')) {
  pass('Checklist mentions .env.local / Metro env setup');
} else {
  fail('Checklist is missing .env.local / Metro env setup warning');
}

if (checklist.includes('LAN') || checklist.includes('192.168') || checklist.includes('Wi-Fi') || checklist.includes('WiFi')) {
  pass('Checklist mentions LAN/IP note for physical device Metro testing');
} else {
  fail('Checklist is missing LAN/IP note for physical device Metro testing');
}

if (checklist.toLowerCase().includes('restart') || checklist.toLowerCase().includes('metro')) {
  pass('Checklist mentions Metro restart after env changes');
} else {
  fail('Checklist is missing Metro restart after env changes warning');
}

// ── 4. Active source must not reference Privacy project ──────────────────────

const privacyHits = activeSourceHas('yzqjvdfgefveprobvvyw', [':!docs', ':!scripts/check-scan-readiness.js']);
if (!privacyHits) {
  pass('Active source does not reference Privacy project yzqjvdfgefveprobvvyw');
} else {
  fail('Active source references Privacy project yzqjvdfgefveprobvvyw:\n' + privacyHits.split('\n').slice(0, 5).join('\n'));
}

// ── 5. No test.example.com in runtime code ───────────────────────────────────

const testExampleHits = activeSourceHas('test\\.example\\.com', [
  ':!docs', ':!scripts/seed-test-catalog.sql', ':!supabase/migrations',
]);
if (!testExampleHits) {
  pass('Active runtime code does not reference test.example.com');
} else {
  fail('Active runtime code references test.example.com:\n' + testExampleHits.split('\n').slice(0, 5).join('\n'));
}

// ── 6. No hardcoded recommendedProducts: [] override outside failure/test ────

const hardcodedHits = activeSourceHas('recommendedProducts[[:space:]]*[:=][[:space:]]*\\[\\]');
// Allow hardcoded [] only in explicit failure/non-fashion branches and tests.
const allowedPaths = [
  'services/scanIdentification.ts',
  '__tests__/',
  'services/textScan',
];
const suspicious = hardcodedHits
  .split('\n')
  .filter((line) => line.trim())
  .filter((line) => !allowedPaths.some((p) => line.includes(p)));

if (!suspicious.length) {
  pass('Active scan/product source does not hardcode recommendedProducts: [] outside failure/test paths');
} else {
  fail('Suspicious hardcoded recommendedProducts: [] found:\n' + suspicious.slice(0, 5).join('\n'));
}

// ── 7. Smoke script exists ───────────────────────────────────────────────────

if (fs.existsSync(path.join(ROOT, 'scripts', 'smoke-scan-identify.js'))) {
  pass('scripts/smoke-scan-identify.js exists');
} else {
  fail('scripts/smoke-scan-identify.js is missing — run smoke test cannot be run by owner with JWT');
}

// ── Summary ──────────────────────────────────────────────────────────────────

const failures = CHECKS.filter((c) => !c.ok);
console.log(`\nScan readiness check: ${failures.length === 0 ? 'PASS' : 'FAIL'} (${CHECKS.length} checks, ${failures.length} failures)\n`);
for (const c of CHECKS) {
  console.log(`${c.ok ? '✓' : '✗'} ${c.message}`);
}

if (failures.length > 0) {
  process.exit(1);
}
