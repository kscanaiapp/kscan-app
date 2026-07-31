'use strict';

/**
 * Freeze and seal digests must reproduce from a fresh clone.
 *
 * Repository policy is `eol=lf`, but a Windows working copy can hold CRLF while
 * Git stores LF. Hashing working-copy bytes yields a digest that verifies on the
 * authoring workstation and fails everywhere else, so the freeze record and the
 * holdout seal would silently become workstation-local. That is exactly what
 * happened to `labelingGuideSha256` in the first v0.3.1 seal.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const {
  ROOT,
  sha256OfTextFile,
  sha256OfSealedTextFile,
  reconstructSealedTextBytes,
} = require('../lib/governedStorage');

const FREEZE = path.join(ROOT, 'evals/scanner-accuracy/tier-a-freeze.v0.3.1.json');
const SEAL = path.join(ROOT, 'evals/scanner-accuracy/review/holdout-seal.v0.3.1.json');
const GUIDE = path.join(ROOT, 'docs/scanner-accuracy/labeling-guide.md');

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const sha256Hex = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const lfHash = (file) => sha256OfTextFile(file).slice('sha256:'.length);
/** The reconstructed sealed (as-reviewed, CRLF) digest. Checkout-portable. */
const sealedHash = (file) => sha256OfSealedTextFile(file).slice('sha256:'.length);

/** Write `content` with a specific line ending, for portability fixtures. */
function writeWithEol(file, lfContent, eol) {
  fs.writeFileSync(file, eol === 'crlf' ? lfContent.replace(/\n/g, '\r\n') : lfContent);
}

test('sha256OfTextFile is line-ending independent', () => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'kscan-eol-'));
  const lf = path.join(dir, 'lf.md');
  const crlf = path.join(dir, 'crlf.md');
  fs.writeFileSync(lf, 'alpha\nbeta\ngamma\n');
  fs.writeFileSync(crlf, 'alpha\r\nbeta\r\ngamma\r\n');
  try {
    assert.notStrictEqual(
      sha256Hex(fs.readFileSync(lf)),
      sha256Hex(fs.readFileSync(crlf)),
      'raw byte hashing must differ, otherwise this test proves nothing'
    );
    assert.strictEqual(sha256OfTextFile(lf), sha256OfTextFile(crlf));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('every governed freeze input is recorded as its LF-normalised digest', () => {
  const freeze = readJson(FREEZE);
  for (const [relative, recorded] of Object.entries(freeze.files)) {
    const absolute = path.join(ROOT, relative);
    assert.ok(fs.existsSync(absolute), `${relative} is missing`);
    assert.strictEqual(
      recorded,
      lfHash(absolute),
      `${relative} is recorded as a working-copy digest and will not verify from a fresh clone`
    );
  }
});

test('the freeze aggregate is derived from the LF-normalised file digests', () => {
  const freeze = readJson(FREEZE);
  const input = Object.keys(freeze.files)
    .sort()
    .map((relative) => `${relative}:${lfHash(path.join(ROOT, relative))}\n`)
    .join('');
  assert.strictEqual(sha256Hex(Buffer.from(input, 'utf8')), freeze.aggregateSha256);
});

test('the holdout seal publishes a fresh-clone-reproducible guide digest', () => {
  const seal = readJson(SEAL);
  const freeze = readJson(FREEZE);

  assert.strictEqual(seal.labelingGuideSha256, lfHash(GUIDE));
  assert.strictEqual(seal.datasetAggregateSha256, freeze.aggregateSha256);

  // The as-reviewed digest is the chain-of-custody record of the bytes the
  // reviewers actually read — a CRLF working copy on the authoring workstation.
  // It is retained, and must not be mistaken for the portable digest.
  //
  // It is verified by RECONSTRUCTING that sealed byte stream from whatever line
  // endings this checkout holds, never by hashing the working-copy bytes
  // directly. Hashing directly is what made this test workstation-local: an LF
  // checkout (a fresh clone, CI, any worktree honouring `*.md text eol=lf`)
  // produced LF bytes and could never reproduce a CRLF-sealed digest, so the
  // test passed only where the stale CRLF copy happened to survive.
  assert.strictEqual(
    seal.labelingGuideSha256AsReviewed,
    sealedHash(GUIDE),
    'the reconstructed sealed byte stream must reproduce the as-reviewed digest'
  );
});

test('sealed reconstruction is identical from LF, CRLF and mixed checkouts', () => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'kscan-sealed-'));
  const content = 'alpha\nbeta\ngamma\n';
  const lf = path.join(dir, 'lf.md');
  const crlf = path.join(dir, 'crlf.md');
  const mixed = path.join(dir, 'mixed.md');

  try {
    writeWithEol(lf, content, 'lf');
    writeWithEol(crlf, content, 'crlf');
    // A real hazard, not a hypothetical: a partially-converted working copy.
    fs.writeFileSync(mixed, 'alpha\r\nbeta\ngamma\r\n');

    // The premise: raw bytes genuinely differ, so this proves something.
    assert.notStrictEqual(sha256Hex(fs.readFileSync(lf)), sha256Hex(fs.readFileSync(crlf)));

    const expected = sha256Hex(Buffer.from('alpha\r\nbeta\r\ngamma\r\n', 'utf8'));
    for (const [name, file] of [['lf', lf], ['crlf', crlf], ['mixed', mixed]]) {
      assert.strictEqual(sealedHash(file), expected, `${name} checkout must reconstruct one sealed representation`);
      assert.deepStrictEqual(
        reconstructSealedTextBytes(file),
        Buffer.from('alpha\r\nbeta\r\ngamma\r\n', 'utf8'),
        `${name} checkout must reconstruct identical sealed BYTES, not merely an equal hash`
      );
    }

    // Reconstruction is idempotent: reconstructing an already-CRLF file must not
    // double-expand \r\n into \r\r\n.
    const roundTrip = path.join(dir, 'roundtrip.md');
    fs.writeFileSync(roundTrip, reconstructSealedTextBytes(crlf));
    assert.strictEqual(sealedHash(roundTrip), expected, 'reconstruction must be idempotent');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sealed reconstruction still fails on any real content change', () => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'kscan-sealed-neg-'));
  const baseline = 'alpha\nbeta\ngamma\n';
  const original = path.join(dir, 'original.md');

  try {
    writeWithEol(original, baseline, 'lf');
    const sealed = sealedHash(original);

    // Each mutation is a DIFFERENT class of change, because a normalisation bug
    // could plausibly mask one class while leaving the others detectable.
    const mutations = {
      'a changed word': 'alpha\nBETA\ngamma\n',
      'a changed character': 'alpha\nbetb\ngamma\n',
      'reordered lines': 'beta\nalpha\ngamma\n',
      'an added line': 'alpha\nbeta\ngamma\ndelta\n',
      'a removed line': 'alpha\ngamma\n',
      'added trailing whitespace': 'alpha\nbeta \ngamma\n',
      'a removed trailing newline': 'alpha\nbeta\ngamma',
    };

    for (const [description, mutated] of Object.entries(mutations)) {
      // Written in BOTH encodings: a mutation must be detected regardless of the
      // checkout it arrives in, otherwise the repair would only hold on Windows.
      for (const eol of ['lf', 'crlf']) {
        const file = path.join(dir, `mutated-${eol}.md`);
        writeWithEol(file, mutated, eol);
        assert.notStrictEqual(sealedHash(file), sealed, `${description} (${eol}) must still fail verification`);
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the repair changed no sealed artifact and no guide content', () => {
  const seal = readJson(SEAL);

  // The sealed digests are exactly the values recorded at lock time. The repair
  // changed how they are VERIFIED, never what they are.
  assert.strictEqual(
    seal.labelingGuideSha256,
    'ac87fdd66bf6657f85bbac7ca8eb9feb2d179752cc78f8abbad27fdc2b78636a'
  );
  assert.strictEqual(
    seal.labelingGuideSha256AsReviewed,
    '89963c451295696205e708a27a69912a6c52983f286bb178a75b168fadebbde7'
  );
  assert.strictEqual(seal.labelingGuideVersion, '1.1.0');

  // Both digests describe ONE guide content. If that stopped being true, the
  // seal would be describing two different documents.
  const lfBytes = Buffer.from(fs.readFileSync(GUIDE, 'utf8').replace(/\r\n/g, '\n'), 'utf8');
  assert.strictEqual(sha256Hex(lfBytes), seal.labelingGuideSha256);
  assert.strictEqual(
    sha256Hex(reconstructSealedTextBytes(GUIDE)),
    seal.labelingGuideSha256AsReviewed
  );
  assert.strictEqual(
    reconstructSealedTextBytes(GUIDE).toString('utf8').replace(/\r\n/g, '\n'),
    lfBytes.toString('utf8'),
    'the sealed and portable representations must differ only in line endings'
  );

  // The holdout decisions are untouched.
  assert.strictEqual(seal.adjudication.unresolvedCount, 0);
  assert.strictEqual(seal.holdoutCaseCount, 7);
  assert.strictEqual(seal.scannerOutputSeenBeforeLock, false);
});

test('the seal still binds the unchanged v0.3.1 ground truth', () => {
  const seal = readJson(SEAL);
  const manifest = readJson(path.join(ROOT, 'evals/scanner-accuracy/tier-a-manifest.v0.3.1.json'));

  assert.strictEqual(seal.datasetVersion, manifest.datasetVersion);
  assert.strictEqual(seal.finalGroundTruthSha256, manifest.finalGroundTruthSha256);
  assert.deepStrictEqual([...seal.holdoutCaseIds].sort(), [...manifest.split.holdout].sort());
  assert.strictEqual(seal.adjudication.unresolvedCount, 0);
  assert.strictEqual(seal.scannerOutputSeenBeforeLock, false);
});
