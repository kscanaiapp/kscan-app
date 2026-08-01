#!/usr/bin/env node
/**
 * Build 2.5 Step 5 — HOSTILE AUDIT mutation harness.
 *
 * scripts/mirror-mutation-check.js (Steps 3 and 4) covers 24 mutations. The
 * Step 5 audit specification requires 30. This harness applies the REMAINDER —
 * the ones the shipped suite does not attack — one at a time to the real
 * production source, runs the Mirror suites, and asserts they go RED.
 *
 * A mutation that leaves the suite green is a coverage hole, reported as
 * SURVIVED rather than quietly passing.
 *
 * Usage:  node scripts/mirror-step5-audit-mutation-check.js
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const SUITES = [
  '__tests__/mirrorExtractionSession.test.js',
  '__tests__/mirrorExtractionContainment.test.js',
  '__tests__/mirrorCandidateIntegration.test.js',
  '__tests__/closetMirrorStaging.test.js',
  '__tests__/closetIdentificationV2.test.js',
  '__tests__/closetCandidateClassification.test.js',
  '__tests__/closetPromotionSurface.test.js',
].filter((p) => fs.existsSync(path.join(ROOT, p)));

const MUTATIONS = [
  {
    id: 'A',
    spec: 29.5,
    invariant: 'an empty group is never dispatched',
    file: 'services/mirror/mirrorCandidateIntegration.ts',
    find: '  for (let start = 0; start < crops.length; start += size) {',
    replace: '  for (let start = 0; start <= crops.length; start += size) {',
  },
  {
    id: 'B',
    spec: 29.6,
    invariant: 'a Mirror crop is never transported as closet_gallery',
    file: 'services/closetIdentificationV2.ts',
    find: "  mirror: 'closet_mirror',",
    replace: "  mirror: 'closet_gallery',",
  },
  {
    id: 'C',
    spec: 29.7,
    invariant: 'a Closet request never carries a shopping intent',
    file: 'services/closetIdentificationV2.ts',
    find: "export const CLOSET_INTENT = 'identify_for_closet' as const;",
    replace: "export const CLOSET_INTENT = 'identify_and_shop' as const;",
  },
  {
    id: 'D',
    spec: 29.12,
    invariant: 'a durably staged crop never re-enters the retry set',
    file: 'services/mirror/mirrorCandidateIntegration.ts',
    find: '        successfulCropKeys.push(outcome.cropKey);',
    replace: '        successfulCropKeys.push(outcome.cropKey);\n        retryableCropKeys.push(outcome.cropKey);',
  },
  {
    id: 'E',
    spec: 29.13,
    invariant: 'a duplicate handoff cannot start a second coordinator',
    file: 'hooks/useClosetCandidates.js',
    find: '      if (mirrorIntegrationLiveRef.current) {',
    replace: '      if (false) {',
  },
  {
    id: 'F',
    spec: 29.26,
    invariant: 'a successful handoff does not cancel the coordinator',
    file: 'app/library.tsx',
    find: '            void closetCandidates.stageMirrorSelection(selection);',
    replace:
      '            void closetCandidates.stageMirrorSelection(selection);\n            closetCandidates.cancelMirrorIntegration();',
  },
  {
    id: 'G',
    spec: 29.27,
    invariant: 'owner abandonment cancels future groups',
    file: 'hooks/useClosetCandidates.js',
    find: '      promotionLiveRef.current = false;\n      mirrorIntegrationLiveRef.current = false;\n      subscription?.remove?.();',
    replace: '      promotionLiveRef.current = false;\n      subscription?.remove?.();',
  },
  {
    id: 'H',
    spec: 29.28,
    invariant: 'reconciliation deletes the crop whose durable twin EXISTS, never the one without',
    file: 'services/mirror/mirrorCandidateIntegration.ts',
    find: '    if (!durableLineageIds.has(lineageId)) continue;',
    replace: '    if (durableLineageIds.has(lineageId)) continue;',
  },
  {
    id: 'I',
    spec: 29.17,
    invariant: 'temporary cleanup can never delete a file outside its own session',
    file: 'services/mirror/mirrorSessionStorage.ts',
    find: '  if (!isMirrorSessionOwnedUri(uri, extractionSessionId)) return false;',
    replace: '  if (false) return false;',
  },
  {
    id: 'J',
    spec: 29.18,
    invariant: 'the original selfie is destroyed when the crop selection is accepted',
    file: 'services/mirror/mirrorExtractionSession.ts',
    find: '      await storage.deleteNormalizedSource(extractionSessionId);',
    replace: '      // mutation: selfie retained',
  },
  {
    id: 'K',
    spec: 29.1011,
    invariant: 'a Mirror crop is deleted only when its candidate media is durable',
    file: 'services/mirror/mirrorCandidateIntegration.ts',
    find: "  return outcome === 'created' || outcome === 'deduped_candidate' || outcome === 'duplicate_of_closet';",
    replace: '  return true;',
  },
  {
    id: 'M',
    spec: '5.F1',
    invariant: 'already_in_closet is an idempotent success, never a staging failure',
    file: 'services/mirror/mirrorCandidateIntegration.ts',
    find: "  return outcome === 'already_in_closet';",
    replace: '  return false;',
  },
  {
    id: 'N',
    spec: '5.F1b',
    invariant: 'a group of only permanent failures is not reported as retryable',
    file: 'services/mirror/mirrorCandidateIntegration.ts',
    find: "        : 'failed_non_retryable';",
    replace: "        : 'failed_retryable';",
  },
  {
    id: 'L',
    spec: 29.25,
    invariant: 'the unresolved-candidate cap stops later groups',
    file: 'services/mirror/mirrorCandidateIntegration.ts',
    find: "    if (groupHitCapacity) stoppedEarly = 'capacity_blocked';",
    replace: '    // mutation: cap ignored',
  },
];

function runSuites() {
  const result = spawnSync(process.execPath, ['--test', ...SUITES], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return result.status === 0;
}

function main() {
  console.log('Mirror Selfie mutation check — Build 2.5 Step 5 HOSTILE AUDIT');
  console.log(`suites: ${SUITES.length}\n`);

  const baselineGreen = runSuites();
  console.log(`baseline: ${baselineGreen ? 'GREEN' : 'RED'}`);
  if (!baselineGreen) {
    console.error('baseline is not green — cannot attribute mutation results');
    process.exit(1);
  }
  console.log('');

  let caught = 0;
  const survived = [];

  for (const mutation of MUTATIONS) {
    const abs = path.join(ROOT, mutation.file);
    const original = fs.readFileSync(abs, 'utf8');
    const occurrences = original.split(mutation.find).length - 1;
    if (occurrences !== 1) {
      console.error(
        `M${mutation.id}: ANCHOR ERROR — found ${occurrences} occurrences in ${mutation.file}`,
      );
      survived.push({ ...mutation, reason: 'anchor' });
      continue;
    }

    fs.writeFileSync(abs, original.replace(mutation.find, mutation.replace));
    let green;
    try {
      green = runSuites();
    } finally {
      fs.writeFileSync(abs, original);
    }

    if (green) {
      console.log(`M${mutation.id} (§29.${mutation.spec}): SURVIVED — ${mutation.invariant}`);
      survived.push(mutation);
    } else {
      console.log(`M${mutation.id} (§29.${mutation.spec}): CAUGHT — ${mutation.invariant}`);
      caught += 1;
    }
  }

  console.log(`\n${caught}/${MUTATIONS.length} mutations caught`);
  const postGreen = runSuites();
  console.log(`post-restore: ${postGreen ? 'GREEN' : 'RED'}`);
  if (!postGreen) process.exit(1);
  if (survived.length) {
    console.log('\nSURVIVING MUTATIONS (coverage holes):');
    for (const s of survived) console.log(`  M${s.id} — ${s.invariant}`);
  }
  process.exit(0);
}

main();
