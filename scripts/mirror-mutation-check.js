#!/usr/bin/env node
/**
 * Mirror Selfie mutation harness (Build 2.5 Step 3).
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
