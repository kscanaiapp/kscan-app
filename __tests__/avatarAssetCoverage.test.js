// Avatar V10 -> Elise: approved-asset coverage and the degradation contract.
//
// The coverage grid is the answer to "what can this avatar actually draw?", and
// it must be derived from the validated engine package rather than asserted by
// hand. These tests execute the derivation, then check the committed artifact
// against it, so a registry change that adds or loses artwork cannot leave a
// stale grid behind.
//
// The load-bearing product rule under test: missing artwork DEGRADES, it never
// substitutes. No generated frame, no placeholder, no other portrait's face.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { loadTsModule, executableSource, ROOT } = require('./fixtures/avatarEngineHarness');

const coverage = loadTsModule('services/avatars/avatarAssetCoverage.ts');
const ARTIFACT = path.join(ROOT, 'artifacts', 'avatar-v10-asset-coverage.json');
const GENERATOR = path.join('scripts', 'generate-avatar-asset-coverage.js');

const grid = coverage.buildAvatarCoverageGrid();
const byId = new Map(grid.map((row) => [row.presetId, row]));

// -- The grid describes every shipped preset and every state ------------------

test('every selectable preset has a cell for every presentation state', () => {
  assert.ok(grid.length >= 16, `expected the full registry, saw ${grid.length}`);
  for (const row of grid) {
    for (const state of coverage.AVATAR_COVERAGE_STATES) {
      const cell = row.cells[state];
      assert.ok(cell, `${row.presetId} is missing ${state}`);
      assert.ok(
        ['MAPPED', 'DEGRADED', 'MISSING'].includes(cell.coverage),
        `${row.presetId}/${state} = ${cell.coverage}`,
      );
      assert.equal(typeof cell.note, 'string');
      assert.ok(cell.note.length > 0, `${row.presetId}/${state} has no note`);
    }
  }
});

test('the eight dispatched states are exactly the states mapped', () => {
  assert.deepEqual([...coverage.AVATAR_COVERAGE_STATES], [
    'IDLE',
    'LISTENING',
    'THINKING',
    'SPEAKING_CLOSED',
    'SPEAKING_HALF',
    'SPEAKING_OPEN',
    'INTERRUPTED',
    'ERROR',
  ]);
});

// -- Coverage matches the artwork that actually exists ------------------------

test("Elise's canonical portrait is BASIC: closed and open, no approved half-open", () => {
  // The half-open file on disk is a different subject and is deliberately not
  // registered (see constants/stylistIdentity.ts). Consonants degrade.
  const row = byId.get('stylist_portrait_01');
  assert.equal(row.speakingTier, 'basic');
  assert.equal(row.cells.SPEAKING_CLOSED.coverage, 'MAPPED');
  assert.equal(row.cells.SPEAKING_OPEN.coverage, 'MAPPED');
  assert.equal(row.cells.SPEAKING_HALF.coverage, 'DEGRADED');
  assert.match(row.cells.SPEAKING_HALF.note, /degrades to closed/);
  assert.equal(row.cells.SPEAKING_HALF.assetKey, 'stylist_portrait_01:mouth:closed');
});

test('the system Elise alias resolves to the same coverage as the portrait it draws', () => {
  const alias = byId.get('elise_default');
  const portrait = byId.get('stylist_portrait_01');
  assert.equal(alias.visualAvatarId, 'stylist_portrait_01');
  assert.equal(alias.speakingTier, portrait.speakingTier);
  assert.deepEqual(alias.cells, portrait.cells);
});

test('the three FULL portraits are the only ones with an approved half-open frame', () => {
  const full = grid.filter((row) => row.speakingTier === 'full').map((row) => row.presetId);
  assert.deepEqual(full.sort(), ['stylist_portrait_02', 'stylist_portrait_05', 'stylist_portrait_08']);
});

test('a portrait with no approved speaking frames degrades, and is not reported MAPPED', () => {
  for (const id of [
    'stylist_portrait_03',
    'stylist_portrait_04',
    'stylist_portrait_06',
    'stylist_portrait_07',
    'stylist_portrait_09',
    'stylist_portrait_10',
  ]) {
    const row = byId.get(id);
    assert.equal(row.speakingTier, 'none', id);
    for (const state of ['SPEAKING_CLOSED', 'SPEAKING_HALF', 'SPEAKING_OPEN']) {
      assert.equal(row.cells[state].coverage, 'DEGRADED', `${id}/${state}`);
      assert.equal(row.cells[state].assetKey, `${row.visualAvatarId}:base`, `${id}/${state}`);
      assert.match(row.cells[state].note, /status channel/);
    }
  }
});

test('a silent preset can never reach a speaking state', () => {
  for (const row of grid) {
    if (row.canSpeak) continue;
    for (const state of ['SPEAKING_CLOSED', 'SPEAKING_HALF', 'SPEAKING_OPEN']) {
      assert.equal(row.cells[state].coverage, 'MISSING', `${row.presetId}/${state}`);
      assert.equal(row.cells[state].assetKey, null);
    }
  }
});

test('LISTENING and INTERRUPTED are DEGRADED everywhere: no approved pose exists', () => {
  for (const row of grid) {
    assert.equal(row.cells.LISTENING.coverage, 'DEGRADED', row.presetId);
    assert.equal(row.cells.INTERRUPTED.coverage, 'DEGRADED', row.presetId);
    assert.equal(row.cells.LISTENING.assetKey, `${row.visualAvatarId}:base`, row.presetId);
  }
});

test('ERROR always resolves to a safe static approved base', () => {
  for (const row of grid) {
    assert.equal(row.cells.ERROR.coverage, 'MAPPED', row.presetId);
    assert.equal(row.cells.ERROR.assetKey, `${row.visualAvatarId}:base`, row.presetId);
  }
});

// -- The render path reads the same coverage ----------------------------------

test('the render path gets mouth capability from the validated package', () => {
  assert.equal(coverage.resolveAvatarSpeakingCoverage('stylist_portrait_02').mouthCapable, true);
  assert.equal(coverage.resolveAvatarSpeakingCoverage('stylist_portrait_01').mouthCapable, true);
  assert.equal(coverage.resolveAvatarSpeakingCoverage('stylist_portrait_03').mouthCapable, false);
  assert.equal(coverage.resolveAvatarSpeakingCoverage('editorial_plum').mouthCapable, false);
});

test('an unknown avatar id is not shipped, so the projection can fail closed', () => {
  for (const id of [null, undefined, '', 'not_a_preset', '../../etc/passwd']) {
    const resolved = coverage.resolveAvatarSpeakingCoverage(id);
    assert.equal(resolved.assetsAvailable, false, String(id));
    assert.equal(resolved.mouthCapable, false, String(id));
  }
  assert.equal(coverage.resolveAvatarSpeakingCoverage('stylist_portrait_01').assetsAvailable, true);
});

// -- No substitution ----------------------------------------------------------

test('ASSET AUTHORITY: MAPPED requires an approved descriptor in the engine package', () => {
  const packages = loadTsModule('services/avatars/avatarEnginePackages.ts');
  const channelForState = {
    SPEAKING_CLOSED: 'closed',
    SPEAKING_HALF: 'halfOpen',
    SPEAKING_OPEN: 'open',
  };

  for (const row of grid) {
    const pkg = packages.resolveAvatarPackage(row.presetId).package;
    for (const [state, channel] of Object.entries(channelForState)) {
      const approved = pkg?.mouth?.[channel]?.approval === 'approved';
      const claimed = row.cells[state].coverage === 'MAPPED';
      assert.equal(
        claimed,
        approved,
        `${row.presetId}/${state}: claimed MAPPED=${claimed} but package approval=${approved}`,
      );
      // A MAPPED cell names that channel's own asset, never another channel's
      // and never another portrait's.
      if (claimed) {
        assert.equal(row.cells[state].assetKey, `${row.visualAvatarId}:mouth:${channel}`);
      }
    }
  }
});

test('ASSET AUTHORITY: coverage derives capability and never loads an asset itself', () => {
  const source = executableSource('services/avatars/avatarAssetCoverage.ts');
  assert.match(source, /resolveAvatarPackage/);
  assert.equal(/require\(/.test(source), false, 'coverage must not load an asset itself');
  assert.equal(/stylist_portrait_0/.test(source), false, 'no hard-coded avatar may be special');
  // The only mention of substitution is the contract forbidding it.
  const substitutionMentions = source.match(/substitut\w*/gi) ?? [];
  assert.deepEqual(substitutionMentions, ['substituted']);
  assert.match(coverage.AVATAR_DEGRADATION_CONTRACT.join('\n'), /never substituted/);
});

test('the renderer degrades along the approved chain and never invents a frame', () => {
  const renderer = executableSource('components/stylist/AnimatedStylistAvatar.tsx');
  // round -> open -> halfOpen -> closed, and halfOpen -> closed.
  assert.match(renderer, /sources\.round \?\? sources\.open \?\? sources\.halfOpen \?\? sources\.closed/);
  assert.match(renderer, /sources\.halfOpen \?\? sources\.closed/);
  // A mouth layer is drawn only from a resolved approved source.
  assert.match(renderer, /mouthSource != null \?/);
});

// -- The degradation contract is recorded, not implied ------------------------

test('the degradation contract is committed as text and covers every rule', () => {
  const rules = coverage.AVATAR_DEGRADATION_CONTRACT.join('\n');
  assert.match(rules, /MAPPED requires an approved asset/);
  assert.match(rules, /never substituted/);
  assert.match(rules, /status channel/);
  assert.match(rules, /LISTENING and INTERRUPTED/);
  assert.match(rules, /Reduce Motion/);
});

// -- The committed artifact is current ---------------------------------------

test('the committed coverage artifact matches the live derivation', () => {
  assert.ok(fs.existsSync(ARTIFACT), 'artifacts/avatar-v10-asset-coverage.json must be committed');
  const artifact = JSON.parse(fs.readFileSync(ARTIFACT, 'utf8'));

  assert.equal(artifact.generatedBy, 'scripts/generate-avatar-asset-coverage.js');
  assert.deepEqual(artifact.states, [...coverage.AVATAR_COVERAGE_STATES]);
  assert.deepEqual(artifact.degradationContract, [...coverage.AVATAR_DEGRADATION_CONTRACT]);
  assert.equal(artifact.stylists.length, grid.length);

  for (const row of grid) {
    const recorded = artifact.stylists.find((entry) => entry.presetId === row.presetId);
    assert.ok(recorded, `${row.presetId} missing from the artifact`);
    assert.equal(recorded.visualAvatarId, row.visualAvatarId);
    assert.equal(recorded.speakingTier, row.speakingTier);
    for (const state of coverage.AVATAR_COVERAGE_STATES) {
      assert.equal(
        recorded.states[state].coverage,
        row.cells[state].coverage,
        `${row.presetId}/${state}`,
      );
      assert.equal(recorded.states[state].assetKey, row.cells[state].assetKey);
    }
  }
});

test('every asset path the artifact names exists on disk', () => {
  const artifact = JSON.parse(fs.readFileSync(ARTIFACT, 'utf8'));
  assert.deepEqual(
    artifact.registryAssetsMissingOnDisk,
    [],
    'the registry declares an asset that is not in the repository',
  );
  let checked = 0;
  for (const stylist of artifact.stylists) {
    for (const state of artifact.states) {
      const { assetPath, assetOnDisk } = stylist.states[state];
      if (assetPath === null) continue;
      checked += 1;
      assert.equal(assetOnDisk, true, `${stylist.presetId}/${state} ${assetPath}`);
      assert.ok(
        fs.existsSync(path.join(ROOT, assetPath)),
        `${assetPath} is named by the artifact but absent`,
      );
    }
  }
  assert.ok(checked > 40, `expected the grid to name real files, checked ${checked}`);
});

test('the generator reports the committed artifact as current', () => {
  const output = execFileSync(process.execPath, [GENERATOR, '--check'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.match(output, /current/);
});
