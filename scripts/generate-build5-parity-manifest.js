#!/usr/bin/env node
/**
 * Build 5 — cross-platform parity manifest.
 *
 * WHY IT EXISTS: iOS and Android are separate branches with separate working
 * trees, so "the two platforms behave identically" is a claim nothing enforces
 * — a fix applied to one and forgotten on the other is invisible until a device
 * finds it. Every Build 5 file below is platform-neutral by design, so their
 * digests MUST match across the two branches. This writes those digests; the
 * test asserts the working tree still matches them, and comparing the two
 * committed manifests is what proves parity between branches.
 *
 * The two Home files are deliberately EXCLUDED: they legitimately differ (the
 * iOS hero button carries a KScanIcon the Android one must not), so only the
 * insertion is asserted there, by the mount suite, on each branch separately.
 *
 * Usage: node scripts/generate-build5-parity-manifest.js
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const FILES = [
  'types/todayWithElise.ts',
  'services/todayWithElise/actionRouting.ts',
  'services/todayWithElise/actorInvalidation.ts',
  'services/todayWithElise/analytics.ts',
  'services/todayWithElise/build4ConfidenceAdapter.ts',
  'services/todayWithElise/copyTemplates.ts',
  'services/todayWithElise/eligibility.ts',
  'services/todayWithElise/generatedGreeting.ts',
  'services/todayWithElise/handoff.ts',
  'services/todayWithElise/orchestrator.ts',
  'services/todayWithElise/presentation.ts',
  'services/todayWithElise/priorityEngine.ts',
  'services/todayWithElise/reporting.ts',
  'services/todayWithElise/weatherPolicy.ts',
  'hooks/useTodayWithElise.ts',
  'components/home/TodayWithEliseBoundary.tsx',
  'components/home/TodayWithEliseCard.tsx',
  'components/home/TodayWithEliseSection.tsx',
];

/** Line endings are a checkout artifact, not a behavioural difference. */
function digest(relPath) {
  const raw = fs.readFileSync(path.join(ROOT, relPath), 'utf8').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(raw).digest('hex');
}

const manifest = { schemaVersion: 1, files: {} };
for (const file of FILES) manifest.files[file] = digest(file);

const out = path.join(ROOT, 'docs', 'build5-today-with-elise-v1-parity.json');
fs.writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`Wrote ${Object.keys(manifest.files).length} digests to ${path.relative(ROOT, out)}`);

module.exports = { FILES, digest };
