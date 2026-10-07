const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadTsModule(relativePath, requireMap = {}) {
  const filename = path.join(ROOT, relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(output, {
    exports: mod.exports,
    module: mod,
    console,
    require: (id) => {
      if (id in requireMap) return requireMap[id];
      throw new Error(`Unexpected require: ${id}`);
    },
    Math,
    Number,
    Object,
    Array,
    Set,
    Error,
  }, { filename });
  return mod.exports;
}

const multi = loadTsModule('services/multiImageScan.ts');

function garment(index, overrides = {}) {
  return {
    candidateId: `garment-${index}`,
    order: index,
    label: `Garment ${index}`,
    category: 'jacket',
    subtype: `jacket-${index}`,
    bounds: { x: 0.1 * index, y: 0.1, width: 0.25, height: 0.5 },
    attributes: { category: 'jacket', itemType: `jacket-${index}` },
    identification: { item_type: 'jacket', subtype: `jacket-${index}` },
    ...overrides,
  };
}

function completed(detectedGarments) {
  return {
    status: 'completed',
    attributes: { category: 'jacket', itemType: 'jacket' },
    identification: { item_type: 'jacket' },
    recommendedProducts: [],
    detectedGarments,
  };
}

function batch(image, response = completed([garment(0)])) {
  return { image, response, preparedImage: `base64-${image.id}` };
}

test('normalizes one, two, and five selected images in stable order', () => {
  for (const count of [1, 2, 5]) {
    const assets = Array.from({ length: count }, (_, index) => ({ uri: `file://image-${index}.jpg` }));
    const images = multi.normalizeImageSelections(assets, 'upload');
    assert.equal(images.length, count);
    assert.deepEqual(Array.from(images, (image) => image.uri), assets.map((asset) => asset.uri));
    assert.deepEqual(Array.from(images, (image) => image.originalIndex), assets.map((_, index) => index));
  }
});

test('rejects a sixth image without truncating silently', () => {
  const assets = Array.from({ length: 6 }, (_, index) => ({ uri: `file://image-${index}.jpg` }));
  assert.throws(() => multi.normalizeImageSelections(assets, 'upload'), /TOO_MANY_IMAGES/);
});

test('rejects empty and malformed image selections', () => {
  assert.throws(() => multi.normalizeImageSelections([], 'upload'), /EMPTY_IMAGE_SELECTION/);
  assert.throws(() => multi.normalizeImageSelections([{ uri: '' }], 'upload'), /MALFORMED_IMAGE/);
  assert.throws(() => multi.normalizeImageSelections([{ uri: 'file://ok.jpg' }, { uri: null }], 'upload'), /MALFORMED_IMAGE/);
});

test('suppresses duplicate images and keeps first-seen ordering', () => {
  const images = multi.normalizeImageSelections([
    { uri: 'file://a.jpg' },
    { uri: 'file://a.jpg' },
    { uri: 'file://b.jpg' },
  ], 'upload');
  assert.deepEqual(Array.from(images, (image) => image.uri), ['file://a.jpg', 'file://b.jpg']);
});

test('removal before submission reindexes without mutating input', () => {
  const images = multi.normalizeImageSelections([
    { uri: 'file://a.jpg' },
    { uri: 'file://b.jpg' },
    { uri: 'file://c.jpg' },
  ], 'upload');
  const removed = multi.removeImageSelection(images, images[1].id);
  assert.deepEqual(Array.from(removed, (image) => image.uri), ['file://a.jpg', 'file://c.jpg']);
  assert.deepEqual(Array.from(removed, (image) => image.originalIndex), [0, 1]);
  assert.equal(images.length, 3);
});

test('maps one image with multiple genuine garments', () => {
  const [image] = multi.normalizeImageSelections([{ uri: 'file://a.jpg' }], 'upload');
  const candidates = multi.buildMultiScanCandidates([
    batch(image, completed([garment(0), garment(1)])),
  ]);
  assert.equal(candidates.length, 2);
  assert.ok(candidates.every((candidate) => candidate.sourceImageId === image.id));
});

test('maps multiple images with one or multiple garments and stable association', () => {
  const images = multi.normalizeImageSelections([
    { uri: 'file://a.jpg' },
    { uri: 'file://b.jpg' },
  ], 'upload');
  const candidates = multi.buildMultiScanCandidates([
    batch(images[0], completed([garment(0)])),
    batch(images[1], completed([garment(0), garment(1)])),
  ]);
  assert.equal(candidates.length, 3);
  assert.deepEqual(Array.from(candidates, (candidate) => candidate.sourceImageIndex), [0, 1, 1]);
  assert.deepEqual(Array.from(candidates, (candidate) => candidate.sourceImageUri), [
    'file://a.jpg',
    'file://b.jpg',
    'file://b.jpg',
  ]);
});

test('partial success keeps valid images and does not fabricate empty-image items', () => {
  const images = multi.normalizeImageSelections([
    { uri: 'file://empty.jpg' },
    { uri: 'file://valid.jpg' },
  ], 'upload');
  const candidates = multi.buildMultiScanCandidates([
    batch(images[0], { status: 'non_fashion', recommendedProducts: [], detectedGarments: [] }),
    batch(images[1], completed([garment(0)])),
  ]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].sourceImageId, images[1].id);
});

test('empty and malformed garment arrays produce no fabricated candidates', () => {
  const [image] = multi.normalizeImageSelections([{ uri: 'file://a.jpg' }], 'upload');
  assert.equal(multi.buildMultiScanCandidates([batch(image, { status: 'failed', recommendedProducts: [] })]).length, 0);
  assert.equal(multi.buildMultiScanCandidates([batch(image, { status: 'completed', recommendedProducts: [], detectedGarments: 'bad' })]).length, 0);
  assert.equal(multi.buildMultiScanCandidates([batch(image, completed([]))]).length, 0);
});

test('legacy completed single-item responses remain compatible', () => {
  const [image] = multi.normalizeImageSelections([{ uri: 'file://a.jpg' }], 'upload');
  const response = completed(undefined);
  const candidates = multi.buildMultiScanCandidates([batch(image, response)]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].garment, null);
  assert.equal(candidates[0].detectionResponse, response);
});

test('duplicate garments are suppressed per source image', () => {
  const [image] = multi.normalizeImageSelections([{ uri: 'file://a.jpg' }], 'upload');
  const duplicate = garment(1, {
    candidateId: 'different-id',
    subtype: 'jacket-0',
    bounds: garment(0).bounds,
  });
  const candidates = multi.buildMultiScanCandidates([
    batch(image, completed([garment(0), duplicate])),
  ]);
  assert.equal(candidates.length, 1);
});

test('global result count is bounded to five without fabricating', () => {
  const images = multi.normalizeImageSelections([
    { uri: 'file://a.jpg' },
    { uri: 'file://b.jpg' },
  ], 'upload');
  const candidates = multi.buildMultiScanCandidates([
    batch(images[0], completed([garment(0), garment(1), garment(2)])),
    batch(images[1], completed([garment(0), garment(1), garment(2)])),
  ]);
  assert.equal(candidates.length, 5);
  assert.ok(candidates.every((candidate) => candidate.garment));
});
