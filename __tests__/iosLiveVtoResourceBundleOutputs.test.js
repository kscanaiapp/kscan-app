// Build fix — kscan-live-vto-native's CocoaPods resource bundle must never
// declare two inputs that Xcode copies to the same output path.
//
// WHY THIS EXISTS: EAS build 45dafd1d-2440-4f29-8654-9ea3b94ec34d failed the
// iOS Release archive with duplicate `alpha.png`, `texture.png` and
// `manifest.json` outputs inside KScanLiveVtoNativeAssets.bundle. The
// podspec's `resource_bundles` used `Assets/**/*`, which CocoaPods expands
// (include_dirs) to every nested directory AND every nested file. Directories
// become folder references (copied with their subdirectory intact) but each
// matched file is copied flat to the bundle root, so the three garment
// directories' identically named files collide.
//
// This test simulates CocoaPods' resource_bundles glob resolution and Xcode's
// copy destinations, relative to the podspec's directory, so a future glob
// edit or new same-named asset fails locally, on Windows, without Ruby,
// CocoaPods, Xcode or a paid EAS build. It also proves every path the Swift
// runtime looks up (subdirectory-qualified) is still produced, with bytes
// matching the governed integrity tables.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MODULE_DIR = path.join(ROOT, 'modules', 'kscan-live-vto-native', 'ios');
const PODSPEC_PATH = path.join(MODULE_DIR, 'KScanLiveVtoNative.podspec');
const podspec = fs.readFileSync(PODSPEC_PATH, 'utf8');
const BUNDLE_NAME = 'KScanLiveVtoNativeAssets';

function readSwift(rel) {
  return fs.readFileSync(path.join(MODULE_DIR, rel), 'utf8');
}

function parseResourceBundles(source) {
  const block = source.match(/s\.resource_bundles\s*=\s*\{([\s\S]*?)\n\s*\}/);
  if (!block) return null;
  const bundles = {};
  const entry = /'([^']+)'\s*=>\s*\[([^\]]*)\]/g;
  let m;
  while ((m = entry.exec(block[1]))) {
    bundles[m[1]] = [...m[2].matchAll(/'([^']+)'/g)].map((p) => p[1]);
  }
  return bundles;
}

function walk(dirAbs, relBase = '') {
  const out = { files: [], dirs: [] };
  for (const ent of fs.readdirSync(dirAbs, { withFileTypes: true })) {
    const rel = relBase ? `${relBase}/${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      out.dirs.push(rel);
      const sub = walk(path.join(dirAbs, ent.name), rel);
      out.files.push(...sub.files);
      out.dirs.push(...sub.dirs);
    } else {
      out.files.push(rel);
    }
  }
  return out;
}

// File.fnmatch(p, path, FNM_PATHNAME | FNM_CASEFOLD) plus CocoaPods'
// dir_glob_equivalent_patterns (`**/` may also match zero directories).
function globToRegExp(pattern) {
  if (/[{}[\]]/.test(pattern)) {
    throw new Error(`unsupported glob syntax in resource pattern: ${pattern}`);
  }
  let re = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*' && pattern[i + 2] === '/') {
      re += '(?:[^/]+/)*';
      i += 2;
    } else if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^$()|\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`, 'i');
}

// Returns Map<outputPathInBundle, sourceRelPath[]> for one bundle's patterns.
function resolveBundleOutputs(patterns, tree = walk(MODULE_DIR)) {
  const dirSet = new Set(tree.dirs);
  const fullList = [...tree.files, ...tree.dirs];
  const matched = new Set();
  for (const pattern of patterns) {
    if (fullList.includes(pattern)) {
      matched.add(pattern);
      continue;
    }
    const re = globToRegExp(pattern);
    for (const p of fullList) if (re.test(p)) matched.add(p);
  }
  const outputs = new Map();
  const add = (dest, src) => {
    const key = dest.toLowerCase(); // APFS default volumes are case-insensitive
    if (!outputs.has(key)) outputs.set(key, []);
    outputs.get(key).push(src);
  };
  for (const p of matched) {
    if (dirSet.has(p)) {
      // Folder reference: Xcode copies the directory recursively under its
      // own name at the bundle root.
      const base = path.posix.basename(p);
      for (const f of tree.files) {
        if (f.startsWith(`${p}/`)) add(`${base}/${f.slice(p.length + 1)}`, f);
      }
    } else {
      // Plain file reference: copied flat to the bundle root.
      add(path.posix.basename(p), p);
    }
  }
  return outputs;
}

function duplicates(outputs) {
  return [...outputs.entries()].filter(([, srcs]) => srcs.length > 1);
}

function sha256(rel) {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(MODULE_DIR, rel))).digest('hex');
}

const bundles = parseResourceBundles(podspec);

test('podspec declares exactly one resource bundle, and no flat s.resources', () => {
  assert.ok(bundles, 's.resource_bundles block not found in podspec');
  assert.deepEqual(Object.keys(bundles), [BUNDLE_NAME]);
  assert.ok(bundles[BUNDLE_NAME].length > 0);
  assert.doesNotMatch(podspec, /^\s*s\.resources?\s*=/m);
  // Swift resolves the bundle by this exact name.
  assert.match(readSwift('LiveVtoAssetBundle.swift'), new RegExp(`bundleName = "${BUNDLE_NAME}"`));
});

test('no two resource inputs produce the same output path inside the bundle', () => {
  const dupes = duplicates(resolveBundleOutputs(bundles[BUNDLE_NAME]));
  assert.deepEqual(
    dupes.map(([dest, srcs]) => `${dest} <= ${srcs.join(', ')}`),
    [],
    'duplicate CocoaPods resource output destinations ("Multiple commands produce") break the Xcode archive'
  );
});

test('the duplicate-output guard rejects the recursive glob that broke EAS build 45dafd1d', () => {
  const dupes = duplicates(resolveBundleOutputs(['Assets/**/*']));
  const names = dupes.map(([dest]) => dest).sort();
  assert.deepEqual(names, ['alpha.png', 'manifest.json', 'texture.png']);
});

test('every runtime lookup path is produced under its subdirectory with governed bytes', () => {
  const outputs = resolveBundleOutputs(bundles[BUNDLE_NAME]);
  const produced = (dest) => {
    const srcs = outputs.get(dest.toLowerCase());
    assert.ok(srcs && srcs.length === 1, `bundle must contain exactly one ${dest}`);
    return srcs[0];
  };

  // LiveVtoMediaPipePoseProvider: inDirectory "models", fail-closed checksum.
  const provider = readSwift('Perception/LiveVtoMediaPipePoseProvider.swift');
  const modelSha = provider.match(/approvedModelSha256 = "([0-9a-f]{64})"/)[1];
  assert.equal(sha256(produced('models/pose_landmarker_lite.task')), modelSha);

  // LiveVtoRenderView perception self-test frame: subdirectory "perception".
  assert.match(readSwift('LiveVtoRenderView.swift'), /"synthetic-test-frame", withExtension: "png", subdirectory: "perception"/);
  produced('perception/synthetic-test-frame.png');

  // Garments: every supported asset key, loaded via subdirectory: <key>, and
  // validated against LiveVtoBundledAssetIntegrity's hash table.
  const integrity = readSwift('Rendering/LiveVtoBundledAssetIntegrity.swift');
  const hashes = Object.fromEntries(
    [...integrity.matchAll(/"([^"]+\/[^"]+)": "([0-9a-f]{64})"/g)].map((m) => [m[1], m[2]])
  );
  const keys = readSwift('Core/LiveVtoSessionState.swift')
    .match(/supportedAssetKeys: Set<String> = \[([^\]]+)\]/)[1]
    .match(/"([^"]+)"/g)
    .map((s) => s.slice(1, -1));
  assert.ok(keys.length >= 3);
  for (const key of keys) {
    for (const file of ['manifest.json', 'texture.png', 'alpha.png']) {
      const dest = `${key}/${file}`;
      assert.ok(hashes[dest], `integrity table missing ${dest}`);
      assert.equal(sha256(produced(dest)), hashes[dest], `${dest} bytes drifted from integrity table`);
    }
  }
});
