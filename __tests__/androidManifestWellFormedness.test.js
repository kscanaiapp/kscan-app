// Android native XML well-formedness (K SCAN AI Build 34 Android final hostile
// audit, B34-AND-MAN-001).
//
// THE DEFECT
//
// XML 1.0 forbids the two-character sequence "--" anywhere inside a comment
// body, and forbids a body that ends in "-" (production [15]:
// Comment ::= '<!--' ((Char - '-') | ('-' (Char - '-')))* '-->').
//
// From aec2a631 onwards the governed manifests used "--" as a prose dash inside
// their explanatory comments: src/main (18 occurrences), src/certification (9),
// src/push (4) and src/voicePush (3). The Android Gradle Plugin's manifest
// merger reads every manifest with the JDK's strict XML parser and aborts:
//
//   > Task :app:processReleaseMainManifest FAILED
//   org.xml.sax.SAXParseException; lineNumber: 14; columnNumber: 73;
//   The string "--" is not permitted within comments.
//
// src/main takes part in EVERY variant, so no Android artifact -- debug,
// release, or any EAS profile -- could be built from the release line.
//
// WHY NOTHING CAUGHT IT
//
// Every other manifest test, and scripts/check-native-config-parity.js, reads
// manifests with regular expressions after stripping comments: lenient by
// construction. No CI workflow runs Gradle. This file is the missing strict
// parse, with two independent oracles:
//
//   1. the XML comment production itself, dependency-free;
//   2. a strict parse with the xml2js instance @expo/config-plugins uses to read
//      AndroidManifest.xml (sax, strict mode). It agrees with the JDK parser on
//      this defect: both reject the four pre-repair manifests, and both accept
//      src/release and 1be396f6's main manifest, the last well-formed one.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const MAIN_MANIFEST = 'android/app/src/main/AndroidManifest.xml';
const GOVERNED_MANIFESTS = [
  MAIN_MANIFEST,
  'android/app/src/release/AndroidManifest.xml',
  'android/app/src/certification/AndroidManifest.xml',
  'android/app/src/push/AndroidManifest.xml',
  'android/app/src/voicePush/AndroidManifest.xml',
];

const SKIP_DIRS = new Set(['build', '.cxx', '.gradle', 'node_modules']);

function listXml(relDir) {
  const abs = path.join(ROOT, relDir);
  if (!fs.existsSync(abs)) return [];
  const found = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.posix.join(relDir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) found.push(...listXml(rel));
    } else if (entry.name.endsWith('.xml')) {
      found.push(rel);
    }
  }
  return found;
}

// Every first-party XML file the Android build parses: the app module, plus the
// android/ tree of each local Expo module the app depends on through `file:`.
function androidBuildXmlFiles() {
  const pkg = JSON.parse(read('package.json'));
  const localModules = Object.values(pkg.dependencies ?? {})
    .filter((spec) => typeof spec === 'string' && spec.startsWith('file:'))
    .map((spec) => path.posix.join(spec.slice('file:'.length).replace(/^\.\//, ''), 'android'));
  return ['android/app/src', ...localModules].flatMap(listXml).sort();
}

function commentViolations(xml) {
  const violations = [];
  for (const match of xml.matchAll(/<!--([\s\S]*?)-->/g)) {
    const line = xml.slice(0, match.index).split('\n').length;
    if (match[1].includes('--')) violations.push(`comment at line ${line} contains "--"`);
    if (match[1].endsWith('-')) violations.push(`comment at line ${line} ends with "-"`);
  }
  return violations;
}

function expoXmlParser() {
  const pluginsPkg = require.resolve('@expo/config-plugins/package.json', { paths: [ROOT] });
  return require(require.resolve('xml2js', { paths: [path.dirname(pluginsPkg)] }));
}

// Resolution happens OUTSIDE the try: a missing parser must fail loudly, never
// read as "the file was rejected" -- that would let every negative control pass.
async function strictParseError(xml) {
  const parser = expoXmlParser();
  try {
    await parser.parseStringPromise(xml);
    return null;
  } catch (error) {
    return String(error.message).split('\n')[0];
  }
}

const MANIFEST_WITH = (comment) =>
  `<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n` +
  `  <!--${comment}-->\n` +
  `  <uses-permission android:name="android.permission.CAMERA"/>\n` +
  `</manifest>\n`;

test('inventory: every governed manifest and the local Voice module are covered', () => {
  const files = androidBuildXmlFiles();
  for (const manifest of GOVERNED_MANIFESTS) {
    assert.ok(files.includes(manifest), `${manifest} must be in the well-formedness inventory`);
  }
  assert.ok(
    files.includes('modules/kscan-voice-native/android/src/main/AndroidManifest.xml'),
    'the local Voice module manifest must be in the inventory',
  );
  assert.ok(files.length > GOVERNED_MANIFESTS.length, 'resource XML must be covered too, not only manifests');
});

test('every Android build XML file obeys the XML comment rule', () => {
  const failures = androidBuildXmlFiles().flatMap((rel) =>
    commentViolations(read(rel)).map((violation) => `${rel}: ${violation}`),
  );
  assert.deepEqual(failures, [], 'the Android manifest merger and aapt2 reject these files outright');
});

test('every Android build XML file parses under a strict XML parser', async () => {
  const failures = [];
  for (const rel of androidBuildXmlFiles()) {
    const error = await strictParseError(read(rel));
    if (error) failures.push(`${rel}: ${error}`);
  }
  assert.deepEqual(failures, [], 'a file that does not parse strictly cannot be merged into an artifact');
});

test('POSITIVE CONTROL: a well-formed manifest passes both oracles', async () => {
  const xml = MANIFEST_WITH(' a prose dash - is fine ');
  assert.deepEqual(commentViolations(xml), []);
  assert.equal(await strictParseError(xml), null);
});

test('NEGATIVE CONTROL: a prose "--" inside a comment fails both oracles', async () => {
  const xml = MANIFEST_WITH(' removed by default -- see build.gradle ');
  assert.equal(commentViolations(xml).length, 1);
  assert.notEqual(await strictParseError(xml), null);
});

test('NEGATIVE CONTROL: a comment body ending in "-" fails both oracles', async () => {
  const xml = MANIFEST_WITH(' trailing dash -');
  assert.equal(commentViolations(xml).length, 1);
  assert.notEqual(await strictParseError(xml), null);
});

test('NEGATIVE CONTROL: re-introducing the defect into the real main manifest is caught', async () => {
  const real = read(MAIN_MANIFEST);
  const mutated = real.replace('<!--', '<!-- regression probe -- ');
  assert.notEqual(mutated, real, 'the mutation must change the real manifest (self-check)');
  assert.ok(commentViolations(mutated).length > 0, 'the comment oracle must catch the mutant');
  assert.notEqual(await strictParseError(mutated), null, 'the strict parser must catch the mutant');
});
