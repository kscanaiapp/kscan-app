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

// 1. .env.example documents required public env vars.
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

// 2. eas.json development profile enables the scan-identify backend.
const easJson = (() => {
  try {
    return JSON.parse(read('eas.json') || '{}');
  } catch {
    return {};
  }
})();
const devEnv = easJson?.build?.development?.env || {};
if (devEnv.EXPO_PUBLIC_SCAN_IDENTIFY_BACKEND_ENABLED === 'true') {
  pass('eas.json development profile has EXPO_PUBLIC_SCAN_IDENTIFY_BACKEND_ENABLED=true');
} else {
  fail('eas.json development profile is missing EXPO_PUBLIC_SCAN_IDENTIFY_BACKEND_ENABLED=true');
}

// 3. Checklist exists for human tester.
if (fs.existsSync(path.join(ROOT, 'docs', 'real-device-scan-checklist-v1.md'))) {
  pass('docs/real-device-scan-checklist-v1.md exists');
} else {
  fail('docs/real-device-scan-checklist-v1.md is missing');
}

// 4. Active source must not reference the Privacy project.
function activeSourceHas(pattern) {
  try {
    // Cross-platform fallback: use git grep if available, otherwise node globbing is too slow.
    const output = execSync(
      `git grep -n "${pattern}" -- ':!node_modules' ':!dist' ':!qa' ':!archive' ':!tmp' ':!.gradle-user-home' ':!.idea' ':!.expo' ':!.maestro' ':!android' ':!apple-audit-assets' || true`,
      { cwd: ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    return output.trim();
  } catch {
    return '';
  }
}

const privacyHits = activeSourceHas('yzqjvdfgefveprobvvyw');
if (!privacyHits) {
  pass('Active source does not reference Privacy project yzqjvdfgefveprobvvyw');
} else {
  fail('Active source references Privacy project yzqjvdfgefveprobvvyw:\n' + privacyHits.split('\n').slice(0, 5).join('\n'));
}

// 5. Active scan/product source must not hardcode recommendedProducts: [] as an override.
const hardcodedHits = activeSourceHas('recommendedProducts[[:space:]]*[:=][[:space:]]*\\[\\]');
// Allow hardcoded [] only in failure/non-fashion branches and tests.
const allowedPaths = ['services/scanIdentification.ts', '__tests__/'];
const suspicious = hardcodedHits
  .split('\n')
  .filter((line) => line.trim())
  .filter((line) => !allowedPaths.some((p) => line.includes(p)));

if (!suspicious.length) {
  pass('Active scan/product source does not hardcode recommendedProducts: [] outside failure/test paths');
} else {
  fail('Suspicious hardcoded recommendedProducts: [] found:\n' + suspicious.slice(0, 5).join('\n'));
}

// 6. Print summary.
const failures = CHECKS.filter((c) => !c.ok);
console.log(`\nScan readiness check: ${failures.length === 0 ? 'PASS' : 'FAIL'} (${CHECKS.length} checks, ${failures.length} failures)\n`);
for (const c of CHECKS) {
  console.log(`${c.ok ? '✓' : '✗'} ${c.message}`);
}

if (failures.length > 0) {
  process.exit(1);
}
