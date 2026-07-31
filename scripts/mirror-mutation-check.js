#!/usr/bin/env node
/**
 * Mirror Selfie mutation harness (Build 2.5 Steps 3 and 4).
 *
 * A green suite proves nothing unless it can go red. This applies one hostile
 * edit at a time to the REAL production source, runs the Mirror suites, and
 * asserts they FAIL — then restores the file byte-for-byte before the next one.
 *
 * A mutation that leaves the suite green is a hole in the tests, and is
 * reported as such rather than quietly passing.
 *
 * Usage:  node scripts/mirror-mutation-check.js
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const SUITES = [
  '__tests__/mirrorExtractionGeometry.test.js',
  '__tests__/mirrorExtractionSession.test.js',
  '__tests__/mirrorExtractionContainment.test.js',
  '__tests__/mirrorCandidateIntegration.test.js',
];

/**
 * Each mutation names the invariant it attacks. `find` must appear EXACTLY once
 * in the file — a mutation that silently matched nothing would look like a test
 * failure to detect it.
 */
const MUTATIONS = [
  {
    id: 1,
    invariant: 'Mirror UI is unreachable while the feature flag is false',
    file: 'services/mirror/mirrorExtractionSession.ts',
    find: '      if (resolveActive() !== true) {\n        fail(\'mirror_extraction_unsupported\');\n        return;\n      }',
    replace: '      if (false) {\n        fail(\'mirror_extraction_unsupported\');\n        return;\n      }',
  },
  {
    id: 2,
    invariant: 'the original selfie is never emitted as a garment crop',
    file: 'services/mirror/mirrorCropGeneration.ts',
    find: '  const coversWholeFrame = bounds.width >= 0.985 && bounds.height >= 0.985;\n  return !coversWholeFrame;',
    replace: '  return true;',
  },
  {
    id: 3,
    invariant: 'extraction issues no network request',
    file: 'services/mirror/mirrorExtractionSession.ts',
    find: '    async choosePerson(index) {',
    replace: '    async __leak() {\n      await fetch(\'https://example.invalid/telemetry\');\n    },\n\n    async choosePerson(index) {',
  },
  {
    id: 4,
    invariant: 'several people are never merged into one garment set',
    file: 'services/mirror/mirrorPersonResolution.ts',
    find: '  return { kind: \'ambiguous\', candidates: ordered, personCount: ordered.length };\n}',
    replace: '  return { kind: \'resolved\', person: ordered[0], personCount: ordered.length };\n}',
  },
  {
    id: 5,
    invariant: 'overlapping detections are deduplicated',
    file: 'services/mirror/mirrorGarmentRegions.ts',
    find: '    const duplicate = kept.some(\n      (existing) => intersectionOverUnion(existing.bounds, region.bounds) >= MIRROR_REGION_IOU_THRESHOLD,\n    );',
    replace: '    const duplicate = false;',
  },
  {
    id: 6,
    invariant: 'region order is deterministic',
    file: 'services/mirror/mirrorGarmentRegions.ts',
    find: '    const classDelta =\n      MIRROR_REGION_CLASS_ORDER.indexOf(a.regionClass) -\n      MIRROR_REGION_CLASS_ORDER.indexOf(b.regionClass);\n    if (classDelta !== 0) return classDelta;',
    replace: '    return b.bounds.y - a.bounds.y;',
  },
  {
    id: 7,
    invariant: 'a ninth crop is never silently discarded',
    file: 'services/mirror/mirrorExtractionSession.ts',
    find: '      const selected = crops.filter((crop) => crop.selected);',
    replace: '      const selected = crops.filter((crop) => crop.selected).slice(0, 8);',
  },
  {
    id: 8,
    invariant: 'cancellation deletes every generated crop',
    file: 'services/mirror/mirrorExtractionSession.ts',
    find: '      crops = [];\n      prepared = null;\n      personCandidates = null;\n      await storage.deleteSession(extractionSessionId);\n      status = \'cancelled\';',
    replace: '      crops = [];\n      prepared = null;\n      personCandidates = null;\n      status = \'cancelled\';',
  },
  {
    id: 9,
    invariant: 'retry leaves no obsolete crop behind',
    file: 'services/mirror/mirrorExtractionSession.ts',
    find: '      await purgeCrops();\n      publish();\n      await runPipeline(token, null);',
    replace: '      crops = [];\n      publish();\n      await runPipeline(token, null);',
  },
  {
    id: 10,
    invariant: 'telemetry never carries a URI',
    file: 'services/mirror/mirrorTelemetry.ts',
    find: "export function emitMirrorSourceSelected(input: {\n  sourceType: MirrorSourceType;\n  sourceCount: number;\n}): void {\n  emitClosetCandidateEvent('mirror_selfie_source_selected', {\n    sourceType: input.sourceType,",
    replace: "export function emitMirrorSourceSelected(input: {\n  sourceType: MirrorSourceType;\n  sourceCount: number;\n}): void {\n  emitClosetCandidateEvent('mirror_selfie_source_selected', {\n    sourceType: 'file:///picker/IMG_4821.jpg' as MirrorSourceType,",
  },
  {
    id: 11,
    invariant: 'an actor change cancels the extraction',
    file: 'services/mirror/mirrorExtractionSession.ts',
    find: '      if (actorRequest && !isActorCurrent(actorRequest)) {\n        await this.cancel();\n        return null;\n      }',
    replace: '      if (false) {\n        await this.cancel();\n        return null;\n      }',
  },
  {
    id: 12,
    invariant: 'a Step 3 crop is never persisted as a Closet item',
    file: 'services/mirror/mirrorExtractionSession.ts',
    find: "import { prepareMirrorSource } from './mirrorSourcePreparation';",
    replace:
      "import { prepareMirrorSource } from './mirrorSourcePreparation';\nimport { deriveCandidateMedia } from '../closetCandidateMedia';\nexport const __leak = () => deriveCandidateMedia('x');",
  },
  {
    id: 13,
    invariant: 'no commerce or Recent Scan symbol becomes reachable',
    file: 'services/mirror/mirrorCropGeneration.ts',
    find: "import { verifyJpegIsMetadataFree } from './mirrorSourcePreparation';",
    replace:
      "import { verifyJpegIsMetadataFree } from './mirrorSourcePreparation';\nimport { ProductShelf } from '../../components/ProductShelf';\nexport const __shelf = ProductShelf;",
  },

  // ── Build 2.5 Step 4 — mirrorCandidateIntegration.ts ────────────────────────

  {
    id: 14,
    invariant: 'the partition size matches the existing 8-item staging limit',
    file: 'services/mirror/mirrorCandidateIntegration.ts',
    find: 'export function partitionMirrorCrops(\n  crops: MirrorGarmentCropInput[],\n  maxGroupSize: number = CLOSET_CANDIDATE_BATCH_MAX_ITEMS,\n): MirrorStagingGroupState[] {',
    replace: 'export function partitionMirrorCrops(\n  crops: MirrorGarmentCropInput[],\n  maxGroupSize: number = CLOSET_CANDIDATE_BATCH_MAX_ITEMS + 1,\n): MirrorStagingGroupState[] {',
  },
  {
    id: 15,
    invariant: 'a ninth crop is never silently discarded by partitioning',
    file: 'services/mirror/mirrorCandidateIntegration.ts',
    find: '  for (let start = 0; start < crops.length; start += size) {\n    groups.push({\n      groupIndex: groups.length,\n      cropKeys: crops.slice(start, start + size).map((c) => c.cropKey),\n      status: \'pending\',\n    });\n  }',
    replace: '  for (let start = 0; start < crops.length; start += size) {\n    groups.push({\n      groupIndex: groups.length,\n      cropKeys: crops.slice(start, start + size - 1).map((c) => c.cropKey),\n      status: \'pending\',\n    });\n  }',
  },
  {
    id: 16,
    invariant: 'crop order is preserved, never reversed, by partitioning',
    file: 'services/mirror/mirrorCandidateIntegration.ts',
    find: '  for (let start = 0; start < crops.length; start += size) {\n    groups.push({\n      groupIndex: groups.length,\n      cropKeys: crops.slice(start, start + size).map((c) => c.cropKey),',
    replace: '  for (let start = 0; start < crops.length; start += size) {\n    groups.push({\n      groupIndex: groups.length,\n      cropKeys: crops.slice(start, start + size).map((c) => c.cropKey).reverse(),',
  },
  {
    id: 17,
    invariant: 'groups are dispatched serially, never concurrently',
    file: 'services/mirror/mirrorCandidateIntegration.ts',
    find: '  for (const group of groups) {',
    replace: '  await Promise.all(groups.map(async (group) => {',
  },
  {
    id: 18,
    invariant: 'the actor is re-checked between groups',
    file: 'services/mirror/mirrorCandidateIntegration.ts',
    find: '    if (!actorStillValid()) {\n      stoppedEarly = \'actor_changed\';',
    replace: '    if (false) {\n      stoppedEarly = \'actor_changed\';',
  },
  {
    id: 19,
    invariant: 'classification is triggered only when something was durably created',
    file: 'services/mirror/mirrorCandidateIntegration.ts',
    find: '  if (anyCreated && actorStillValid()) {\n    await requeueClassification(actorRequest).catch(() => null);\n  }',
    replace: '  {\n    await requeueClassification(actorRequest).catch(() => null);\n  }',
  },
  {
    id: 20,
    invariant: 'classification is never triggered under a stale actor',
    file: 'services/mirror/mirrorCandidateIntegration.ts',
    find: '  if (anyCreated && actorStillValid()) {',
    replace: '  if (anyCreated) {',
  },
  {
    id: 21,
    invariant: 'a Mirror crop is cleaned only AFTER its outcome is known, never before',
    file: 'services/mirror/mirrorCandidateIntegration.ts',
    find: "    let groupHitCapacity = false;\n    for (const outcome of result.outcomes) {\n      if (isDurableOutcome(outcome.outcome)) {\n        successfulCropKeys.push(outcome.cropKey);\n        anyCreated = anyCreated || outcome.outcome === 'created' || outcome.outcome === 'duplicate_of_closet';\n        await cleanupCrop(outcome.cropKey);",
    replace: "    let groupHitCapacity = false;\n    for (const outcome of result.outcomes) {\n      await cleanupCrop(outcome.cropKey);\n      if (isDurableOutcome(outcome.outcome)) {\n        successfulCropKeys.push(outcome.cropKey);\n        anyCreated = anyCreated || outcome.outcome === 'created' || outcome.outcome === 'duplicate_of_closet';",
  },
  {
    id: 22,
    invariant: 'a capacity-blocked crop is retained, not discarded as non-retryable',
    file: 'services/mirror/mirrorCandidateIntegration.ts',
    find: "  if (errorCode === 'candidate_limit_reached') return true;",
    replace: "  if (errorCode === 'candidate_limit_reached') return false;",
  },
  {
    id: 24,
    invariant: 'a late/stale actor request cannot be masked by minting a fresh one',
    file: 'services/mirror/mirrorCandidateIntegration.ts',
    find: '  const startedUnder = deps.actorRequest\n    ? { actorId: deps.actorRequest.actorId, epoch: deps.actorRequest.epoch }\n    : getActorContext();\n  const actorRequest = deps.actorRequest ?? createActorRequest();',
    replace: '  const startedUnder = getActorContext();\n  const actorRequest = createActorRequest();',
  },
  {
    id: 25,
    invariant: 'the production hook captures its actor snapshot before calling the coordinator',
    file: 'hooks/useClosetCandidates.js',
    find: '      const actorRequest = createActorRequest();\n      const generation = ++mirrorIntegrationGenerationRef.current;',
    replace: '      const generation = ++mirrorIntegrationGenerationRef.current;',
  },
];

function runSuites() {
  const result = spawnSync(process.execPath, ['--test', ...SUITES], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
  });
  return result.status === 0;
}

console.log('Mirror Selfie mutation check — Build 2.5 Step 3\n');

if (!runSuites()) {
  console.error('BASELINE IS RED. Fix the suite before running mutations.');
  process.exit(1);
}
console.log('baseline: GREEN\n');

let undetected = 0;

for (const mutation of MUTATIONS) {
  const abs = path.join(ROOT, mutation.file);
  const original = fs.readFileSync(abs, 'utf8');

  const occurrences = original.split(mutation.find).length - 1;
  if (occurrences !== 1) {
    console.error(
      `M${mutation.id}: ANCHOR NOT UNIQUE (${occurrences} matches in ${mutation.file}) — mutation not applied`,
    );
    undetected += 1;
    continue;
  }

  fs.writeFileSync(abs, original.replace(mutation.find, mutation.replace), 'utf8');
  let caught;
  try {
    caught = !runSuites();
  } finally {
    // Restored byte-for-byte, whatever happened above.
    fs.writeFileSync(abs, original, 'utf8');
  }

  if (caught) {
    console.log(`M${mutation.id}: CAUGHT — ${mutation.invariant}`);
  } else {
    console.error(`M${mutation.id}: SURVIVED — ${mutation.invariant}  <-- TEST GAP`);
    undetected += 1;
  }
}

console.log(`\n${MUTATIONS.length - undetected}/${MUTATIONS.length} mutations caught`);

if (!runSuites()) {
  console.error('POST-RESTORE SUITE IS RED — a mutation was not restored cleanly.');
  process.exit(1);
}
console.log('post-restore: GREEN');

process.exit(undetected === 0 ? 0 : 1);
