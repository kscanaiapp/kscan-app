import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { writePngFile } from '../src/codec';
import { generateSyntheticGarment } from '../src/syntheticGarment';

/**
 * Phase 4.2 closeout §5/§6/§D — the corpus cache CONTRACT.
 *
 * Two runners share one file: `catalogCharacterizationCli` writes it,
 * `addressableSliceCli` reads it. The closeout was blocked precisely because
 * that file did not exist when it was needed, so the contract between them
 * is now pinned by test rather than by assumption:
 *
 *   - the schema the writer produces is the schema the reader consumes;
 *   - the reader runs end-to-end off a cache with ZERO provider calls;
 *   - a page-keyed cache is resumable and never re-fetches a funded page.
 *
 * Everything here uses LOCAL fixture images, so this suite spends no
 * provider quota and needs no network.
 */

const WHITE: [number, number, number] = [248, 248, 248];
const BLUE: [number, number, number] = [176, 205, 234];

// Compiled tests live in dist/__tests__, so the package root is two levels up
// from the RUNNING file, not one. Resolving from the source layout would point
// at dist/ and silently fail to find the built runner.
const PKG_ROOT = resolve(__dirname, '..', '..');

function makeFixtureCache(dir: string, count: number): string {
  const products = [];
  for (let i = 0; i < count; i++) {
    const g = generateSyntheticGarment({ seed: 900 + i, backgroundColor: WHITE, garmentColor: BLUE });
    const imgPath = join(dir, 'fixture-' + i + '.png');
    writePngFile(imgPath, g.image);
    products.push({
      productRef: 'cat-' + String(i + 1).padStart(5, '0'),
      visual: 'plain',
      imageUrls: [imgPath],
    });
  }

  // Exactly the shape catalogCharacterizationCli's cache writer produces.
  const cache = {
    schema: 'vto-phase4-2-corpus-cache/2',
    updatedAt: new Date().toISOString(),
    pages: {
      'plain|fixture query|0': {
        visual: 'plain',
        query: 'fixture query',
        offset: 0,
        fetchedAt: new Date().toISOString(),
        products: products.map((p, i) => ({ product_id: 'fixture-' + i, product_photos: p.imageUrls })),
      },
    },
    queryLog: [{ stratum: 'plain', offset: 0, httpStatus: 200, returned: count, durationMs: 1 }],
    products,
    rawSeen: count,
    skippedNoPhotos: 0,
  };

  const cachePath = join(dir, 'corpus-cache.json');
  writeFileSync(cachePath, JSON.stringify(cache, null, 2));
  return cachePath;
}

test('§D: the slice runner consumes a v2 corpus cache end-to-end with ZERO provider calls', () => {
  const dir = mkdtempSync(join(tmpdir(), 'corpus-contract-'));
  try {
    const cachePath = makeFixtureCache(dir, 4);

    // The compiled runner is what actually ships; exercising the source via
    // ts-node would not prove the built artifact works.
    const script = join(PKG_ROOT, 'dist', 'src', 'addressableSliceCli.js');
    if (!existsSync(script)) {
      assert.fail('dist/src/addressableSliceCli.js missing — run `npm run build` first (npm test does).');
    }

    const output = execFileSync(process.execPath, [script], {
      cwd: PKG_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        CATALOG_CORPUS_CACHE: cachePath,
        SLICE_CONCURRENCY: '2',
        SLICE_EVIDENCE_ROOT: dir,
        // Deliberately absent: GATE_E_STAGING_ANON_KEY. The slice runner must
        // never need a provider credential — if it did, it would be querying.
        GATE_E_STAGING_ANON_KEY: '',
      },
    });

    assert.match(output, /running the full pipeline over 4 real products/);
    assert.match(output, /N-in\/N-out\s+: 4\/4/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('§D: the slice runner writes the closeout evidence the final report consumes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'corpus-contract-ev-'));
  try {
    const cachePath = makeFixtureCache(dir, 3);
    const script = join(PKG_ROOT, 'dist', 'src', 'addressableSliceCli.js');
    execFileSync(process.execPath, [script], {
      cwd: PKG_ROOT,
      encoding: 'utf8',
      // SLICE_EVIDENCE_ROOT keeps this SYNTHETIC run out of the committed
      // real-evidence directory, where it would be indistinguishable from a
      // genuine closeout measurement.
      env: { ...process.env, CATALOG_CORPUS_CACHE: cachePath, SLICE_CONCURRENCY: '2', SLICE_EVIDENCE_ROOT: dir },
    });

    const summaryPath = join(dir, 'addressable-slice-summary.json');
    assert.ok(existsSync(summaryPath), 'slice summary must be written where the report expects it');
    const summary = JSON.parse(readFileSync(summaryPath, 'utf-8'));

    // Every field the closeout report quotes must be present, so a missing
    // number fails here rather than silently becoming "not measured".
    for (const key of [
      'terminalAccounting',
      'addressableSlice',
      'beforeAfter',
      'pipelineDrivenRepair',
      'previouslyEligibleRegression',
      'originalEasyForensics',
      'extractionUnreliableBreakdown',
    ]) {
      assert.ok(key in summary, 'closeout summary must carry ' + key);
    }
    assert.equal(summary.pipelineDrivenRepair.target, 70);
    assert.equal(summary.originalEasyForensics.length, 4, 'all four mandatory EASY cases must be reported on, present or not');
    for (const f of summary.originalEasyForensics) {
      assert.ok('reIdentified' in f, 'each case must state whether it was re-identified');
      if (!f.reIdentified) {
        assert.ok(typeof f.note === 'string' && f.note.length > 0, 'a case that could not be re-identified must say so explicitly');
      }
    }
    assert.equal(summary.boundaries.productionMutation, false);
    assert.equal(summary.boundaries.stagingMutation, false);
    assert.equal(summary.boundaries.derivedAssetsWritten, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('§6: a page-keyed cache is resumable — a funded page is never re-fetched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'corpus-resume-'));
  try {
    const cachePath = makeFixtureCache(dir, 2);
    const before = JSON.parse(readFileSync(cachePath, 'utf-8'));

    assert.equal(before.schema, 'vto-phase4-2-corpus-cache/2');
    assert.ok(Object.keys(before.pages).length > 0, 'cache must be page-keyed, not a flat product list');

    // The key encodes stratum + offset, which is what makes "already fetched"
    // decidable without another provider call.
    const key = Object.keys(before.pages)[0];
    assert.match(key, /\|\d+$/, 'page key must end in the offset: ' + key);
    const page = before.pages[key];
    assert.equal(page.offset, 0);
    assert.ok(Array.isArray(page.products));
    assert.ok(page.products.every((p: { product_id: string }) => typeof p.product_id === 'string'), 'pages must carry stable provider identity for dedupe');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('§D: an unreadable or wrong-schema cache is refused, not silently treated as empty progress', () => {
  const dir = mkdtempSync(join(tmpdir(), 'corpus-bad-'));
  try {
    const badPath = join(dir, 'bad-cache.json');
    writeFileSync(badPath, JSON.stringify({ schema: 'something-else/1', products: [] }));

    const script = join(PKG_ROOT, 'dist', 'src', 'addressableSliceCli.js');
    let failed = false;
    try {
      execFileSync(process.execPath, [script], {
        cwd: PKG_ROOT,
        encoding: 'utf8',
        stdio: 'pipe',
        env: { ...process.env, CATALOG_CORPUS_CACHE: badPath },
      });
    } catch {
      failed = true;
    }
    assert.ok(failed, 'a cache with no usable products must fail rather than report an empty success');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
