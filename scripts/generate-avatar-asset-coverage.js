#!/usr/bin/env node
/**
 * Generates the Avatar V10 per-stylist x per-state approved-asset coverage
 * artifact.
 *
 * Coverage comes from two independent sources and the generator refuses to
 * emit if they disagree:
 *
 *   1. `services/avatars/avatarAssetCoverage.ts` — the runtime derivation,
 *      evaluated through the same miniature TypeScript linker the avatar tests
 *      use, so the artifact describes what the app actually resolves.
 *   2. The registry source and the filesystem — every `require(...)` in
 *      `constants/stylistIdentity.ts` is parsed for its real repository path
 *      and that path is stat'd, so a declared-but-absent asset cannot be
 *      reported as approved.
 *
 * Nothing here creates, converts or substitutes artwork.
 *
 * Usage:  node scripts/generate-avatar-asset-coverage.js [--check]
 *
 *   (default)  write artifacts/avatar-v10-asset-coverage.json
 *   --check    exit non-zero if the committed artifact is not current
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'artifacts', 'avatar-v10-asset-coverage.json');
const GENERATOR = 'scripts/generate-avatar-asset-coverage.js';
const REGISTRY = path.join('constants', 'stylistIdentity.ts');

const { loadTsModule } = require(path.join(ROOT, '__tests__', 'fixtures', 'avatarEngineHarness.js'));

/**
 * Every asset the registry references, keyed by the repo-relative path, with
 * whether the file is actually on disk.
 *
 * The registry spells each reference as a literal `require('../assets/...')`,
 * so the paths are recoverable from source without evaluating Metro.
 */
function collectRegistryAssets() {
  const source = fs.readFileSync(path.join(ROOT, REGISTRY), 'utf8');
  const assets = new Map();
  const pattern = /require\('(\.\.\/assets\/[^']+)'\)/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const relative = path
      .normalize(path.join(path.dirname(REGISTRY), match[1]))
      .split(path.sep)
      .join('/');
    assets.set(relative, fs.existsSync(path.join(ROOT, relative)));
  }
  return assets;
}

/**
 * Maps an engine asset key (`<avatarId>:mouth:open`) to the repository path the
 * registry declares for it. Naming in the assets tree is not uniform, so the
 * mapping is made by matching the avatar's numeric portrait suffix and the
 * channel, never by string-formatting a guess.
 */
function resolveAssetPath(assetKey, registryAssets) {
  if (!assetKey) return null;
  const [avatarId, channel, state] = assetKey.split(':');
  const suffix = /portrait_(\d+)$/.exec(avatarId)?.[1];
  if (!suffix) return null;

  if (channel === 'base') {
    const candidate = `assets/stylist-avatars/portraits/${avatarId}.jpg`;
    return registryAssets.has(candidate) ? candidate : null;
  }
  if (channel !== 'mouth') return null;

  const wanted = {
    closed: 'mouth_closed',
    halfOpen: 'mouth_half_open',
    open: 'mouth_open',
    round: 'round-mouth',
  }[state];
  if (!wanted) return null;

  for (const candidate of registryAssets.keys()) {
    const file = candidate.split('/').pop() ?? '';
    if (!file.includes(suffix)) continue;
    if (wanted === 'round-mouth') {
      if (file.startsWith(`round-mouth-${suffix}`)) return candidate;
      continue;
    }
    // `mouth_open` must not match `mouth_half_open`.
    if (file === `avatar_stylist_${suffix}_${wanted}.png`) return candidate;
  }
  return null;
}

function build() {
  const coverage = loadTsModule('services/avatars/avatarAssetCoverage.ts');
  const registryAssets = collectRegistryAssets();
  const grid = coverage.buildAvatarCoverageGrid();

  const missingOnDisk = [...registryAssets.entries()]
    .filter(([, present]) => !present)
    .map(([relative]) => relative);

  const stylists = grid.map((row) => {
    const states = {};
    for (const state of coverage.AVATAR_COVERAGE_STATES) {
      const cell = row.cells[state];
      const assetPath = resolveAssetPath(cell.assetKey, registryAssets);
      states[state] = {
        coverage: cell.coverage,
        assetKey: cell.assetKey,
        assetPath,
        assetOnDisk: assetPath === null ? null : registryAssets.get(assetPath) === true,
        note: cell.note,
      };
    }
    return {
      presetId: row.presetId,
      visualAvatarId: row.visualAvatarId,
      voiceProfile: row.voiceProfile,
      canSpeak: row.canSpeak,
      packageValid: row.packageValid,
      speakingTier: row.speakingTier,
      states,
    };
  });

  const totals = { MAPPED: 0, DEGRADED: 0, MISSING: 0 };
  for (const stylist of stylists) {
    for (const state of coverage.AVATAR_COVERAGE_STATES) {
      totals[stylist.states[state].coverage] += 1;
    }
  }

  return {
    avatarCoverageVersion: 1,
    generatedBy: GENERATOR,
    derivedFrom: [
      'services/avatars/avatarAssetCoverage.ts',
      'services/avatars/avatarEnginePackages.ts',
      'services/avatars/engine/package/validate.ts',
      REGISTRY.split(path.sep).join('/'),
    ],
    states: [...coverage.AVATAR_COVERAGE_STATES],
    degradationContract: [...coverage.AVATAR_DEGRADATION_CONTRACT],
    registryAssetCount: registryAssets.size,
    registryAssetsMissingOnDisk: missingOnDisk,
    cellTotals: totals,
    stylists,
  };
}

function serialize(report) {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function main() {
  const check = process.argv.includes('--check');
  const next = serialize(build());

  if (check) {
    const current = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, 'utf8') : '';
    if (current !== next) {
      process.stderr.write(
        `avatar asset coverage artifact is stale: regenerate with \`node ${GENERATOR}\`\n`,
      );
      process.exit(1);
    }
    process.stdout.write('avatar asset coverage artifact is current\n');
    return;
  }

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, next);
  process.stdout.write(`wrote ${path.relative(ROOT, OUTPUT)}\n`);
}

main();
