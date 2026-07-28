// Phase 2B.4 — cross-platform parity of the governed shared identification core.
//
// WHAT THIS GATES: every file that both platform lines must run byte-for-byte,
// because it implements the shared V2 core, one of the two consumer intents, or
// the governed downstream contract. A governed file edited on the Android line
// and not on the iOS line (or the reverse) is a silent fork of the "one
// identification core" guarantee, and Phase 2B.3 had no gate that would notice.
//
// HOW: `config/cross-path-parity-manifest.json` is committed IDENTICALLY on both
// branches. This suite fails when the working tree drifts from its own manifest,
// and it names the exact file. Because the manifest itself is byte-identical
// across branches, two trees that each pass are provably running the same bytes.
//
// The same shape as the existing Edge Function parity gate, deliberately: one
// governance mechanism, not two.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(ROOT, 'config', 'cross-path-parity-manifest.json');

function readManifest() {
  assert.ok(fs.existsSync(MANIFEST_PATH), 'config/cross-path-parity-manifest.json is missing');
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
}

function sha256(absolute) {
  return crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
}

function allEntries(manifest) {
  return Object.entries(manifest.groups).flatMap(([group, entries]) =>
    entries.map((entry) => ({ ...entry, group })));
}

test('parity: the manifest declares the expected governance groups', () => {
  const manifest = readManifest();
  assert.equal(manifest.manifestVersion, 'cross-path-parity-manifest-v1');
  assert.deepEqual(
    Object.keys(manifest.groups).sort(),
    ['backend', 'contract', 'eliseIntent', 'scannerIntent', 'sharedCore'],
  );
});

test('parity: every governed file exists and matches its recorded hash', () => {
  const manifest = readManifest();
  const drifted = [];
  for (const entry of allEntries(manifest)) {
    const absolute = path.join(ROOT, entry.path);
    if (!fs.existsSync(absolute)) {
      drifted.push(`${entry.path}  MISSING`);
      continue;
    }
    const actual = sha256(absolute);
    if (actual !== entry.sha256) {
      drifted.push(`${entry.path}\n      manifest     ${entry.sha256}\n      working tree ${actual}`);
    }
  }
  assert.equal(
    drifted.length,
    0,
    drifted.length
      ? `governed shared source drifted from the cross-platform parity manifest:\n  ${drifted.join('\n  ')}`
      : undefined,
  );
});

test('parity: the generator agrees the committed manifest is current', () => {
  // Runs the real script rather than re-implementing its hashing, so the gate
  // and the generator cannot drift from one another.
  const result = spawnSync(
    process.execPath,
    [path.join(ROOT, 'scripts', 'generate-cross-path-parity-manifest.js'), '--check'],
    { cwd: ROOT, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, `manifest --check failed:\n${result.stdout}\n${result.stderr}`);
});

test('parity: the identification core, both intents and the backend are all governed', () => {
  const manifest = readManifest();
  const paths = allEntries(manifest).map((entry) => entry.path);

  // The shared core: one validator, one evidence gateway, one snapshot module.
  for (const required of [
    'services/fashionIdentificationV2Core.ts',
    'services/fashionEvidenceGateway.ts',
    'types/fashionIdentificationV2.ts',
    'contracts/fashion-identification-v2.schema.json',
  ]) {
    assert.ok(paths.includes(required), `${required} must be governed`);
  }
  // Both consumer intents.
  assert.ok(paths.includes('services/scannerIdentificationV2.ts'));
  assert.ok(paths.includes('services/style-chat/eliseIdentificationV2.ts'));
  // Both orchestrators — the only two modules that build a V2 request body.
  assert.ok(paths.includes('services/scannerScanRequest.ts'));
  assert.ok(paths.includes('services/style-chat/eliseIdentifyForStyle.ts'));
  // The projection and the reuse router.
  assert.ok(paths.includes('services/style-chat/eliseFashionContextV2.ts'));
  assert.ok(paths.includes('services/style-chat/eliseAttachmentRouting.ts'));
  // Both governed Edge Functions and the shared backend contract.
  assert.ok(paths.includes('supabase/functions/scan-identify/index.ts'));
  assert.ok(paths.includes('supabase/functions/stylechat-generate/index.ts'));
  assert.ok(paths.includes('supabase/functions/_shared/fashionIdentificationV2.ts'));
});

test('parity: no governed file is listed twice', () => {
  const paths = allEntries(readManifest()).map((entry) => entry.path);
  assert.equal(new Set(paths).size, paths.length, 'a governed file is listed more than once');
});

test('parity: fileCount matches the number of governed entries', () => {
  const manifest = readManifest();
  assert.equal(manifest.fileCount, allEntries(manifest).length);
});

/**
 * The ONE authorized platform divergence in the Elise intake surface.
 *
 * Android's Elise attachment surface is a single-photo modal; the iOS surface is
 * the header gallery, and on iOS the same modal is a DORMANT legacy route. Both
 * are real platform surfaces, so the two screens and the two modal files
 * legitimately differ — but the divergence is only acceptable while each side
 * still converges on the shared identification contract, and while the dormant
 * side stays failed closed.
 *
 * Asserted here rather than left to prose so that a future edit which quietly
 * turns the iOS dormant route back on, or unhooks the Android intake from the
 * shared orchestrator, fails a named test.
 */
test('parity: the platform intake divergence stays governed on whichever line this is', () => {
  const intake = path.join(ROOT, 'components', 'style-chat', 'StyleChatPhotoIntake.tsx');
  assert.ok(fs.existsSync(intake), 'the Elise photo intake component is missing');
  const intakeSource = fs.readFileSync(intake, 'utf8');
  const flags = fs.readFileSync(path.join(ROOT, 'constants', 'featureFlags.ts'), 'utf8');
  const hasDormantOptIn = flags.includes('ELISE_LEGACY_PHOTO_INTAKE_ENABLED');

  if (hasDormantOptIn) {
    // iOS line: the modal is the dormant legacy route and must be failed closed
    // behind an exact-string opt-in that no governed profile sets.
    assert.match(
      flags,
      /ELISE_LEGACY_PHOTO_INTAKE_ENABLED =\s*\n?\s*process\.env\.EXPO_PUBLIC_ELISE_LEGACY_PHOTO_INTAKE_ENABLED === 'true';/,
      'the dormant opt-in must require the exact string "true"',
    );
    const screen = fs.readFileSync(path.join(ROOT, 'app', 'style-chat', '[sessionId].tsx'), 'utf8');
    assert.match(
      screen,
      /legacyPhotoIntakeEnabled =\s*\n?\s*attachmentsEnabled && !visualAttachmentsEnabled && ELISE_LEGACY_PHOTO_INTAKE_ENABLED/,
      'the dormant route must require the explicit opt-in',
    );
    assert.equal(
      screen.includes('onUploadPhoto={legacyPhotoIntakeEnabled ?'),
      true,
      'the dormant entry point must honour the same gate',
    );
  } else {
    // Android line: the modal is the LIVE single-photo intake, and it must reach
    // the shared V2 orchestrator rather than carrying its own identification.
    assert.match(
      intakeSource,
      /identifyDirectImageForStyle/,
      'the live intake must route through the shared identify-for-style path',
    );
    assert.match(intakeSource, /beginEliseV2Session/, 'the live intake must latch the V2 session flag');
    const direct = fs.readFileSync(
      path.join(ROOT, 'services', 'style-chat', 'eliseDirectImageIdentification.ts'),
      'utf8',
    );
    assert.match(
      direct,
      /identifyPreparedImageForStyle/,
      'the direct-image path must converge on the shared orchestrator',
    );
    assert.match(
      direct,
      /if \(!sessionFlag\.enabled\) return \{ kind: 'legacy_fallback' \}/,
      'flag-off must fall back to the unchanged legacy path, not to a new one',
    );
  }
});

test('parity: the shared direct-image module is governed on both lines', () => {
  const paths = allEntries(readManifest()).map((entry) => entry.path);
  assert.ok(paths.includes('services/style-chat/eliseDirectImageIdentification.ts'));
  assert.ok(paths.includes('services/style-chat/eliseSendContext.ts'));
});

test('parity: the manifest carries no per-branch provenance', () => {
  // A Git SHA or a timestamp would differ between the Android and iOS branches
  // and make two correctly synchronized trees report as drifted forever.
  const raw = fs.readFileSync(MANIFEST_PATH, 'utf8');
  assert.equal(/generatedAtUtc|generatedFromGitSha|"provenance"/.test(raw), false);
});
