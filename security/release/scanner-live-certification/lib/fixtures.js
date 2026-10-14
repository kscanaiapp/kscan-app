'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const FIXTURE_DIR = path.join(REPO_ROOT, 'assets', 'qa_fixtures');
const CORPUS_PATH = path.join(__dirname, '..', 'corpus.json');

// The app prepares every image at <= 896 px wide, JPEG q0.65 (services/imageUtils.js).
const SCANNER_IMAGE_MAX_WIDTH = 896;
const SCANNER_IMAGE_JPEG_QUALITY = 65;

class FixtureError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'FixtureError';
    this.code = code;
  }
}

function loadCorpus() {
  return JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8'));
}

/**
 * The ONLY door through which image bytes enter the harness. A file must be listed
 * in the corpus, must resolve inside the approved fixture directory, and must not
 * be on the excluded list. Anything else is refused before it is read.
 */
function resolveApprovedFixture(corpus, file) {
  const base = path.basename(String(file));
  if (base !== file) throw new FixtureError('fixture name must be a bare file name', 'FIXTURE_PATH');
  if ((corpus.excluded ?? []).some((entry) => entry.file === base)) {
    throw new FixtureError('fixture is on the excluded list and is never read', 'FIXTURE_EXCLUDED');
  }
  if (!(corpus.images ?? []).some((image) => image.file === base)) {
    throw new FixtureError('fixture is not part of the approved corpus', 'FIXTURE_NOT_APPROVED');
  }
  const full = path.join(FIXTURE_DIR, base);
  if (!full.startsWith(FIXTURE_DIR + path.sep)) throw new FixtureError('fixture path escaped its directory', 'FIXTURE_PATH');
  if (!fs.existsSync(full)) throw new FixtureError(`approved fixture is missing: ${base}`, 'FIXTURE_MISSING');
  return full;
}

function resizeWithImageMagick(fullPath) {
  // `convert` is ImageMagick only off Windows; on Windows it is the system's disk
  // format utility and must never be invoked.
  const candidates = process.platform === 'win32' ? ['magick'] : ['magick', 'convert'];
  for (const bin of candidates) {
    const args = [fullPath, '-auto-orient', '-strip', '-resize', `${SCANNER_IMAGE_MAX_WIDTH}x>`, '-quality', String(SCANNER_IMAGE_JPEG_QUALITY), 'jpg:-'];
    const run = spawnSync(bin, args, { maxBuffer: 16 * 1024 * 1024 });
    if (run.status === 0 && run.stdout && run.stdout.length > 1000) return { bytes: run.stdout, how: `imagemagick:${bin}` };
  }
  return null;
}

/** Returns { uri, dataUri, how, bytes } for one approved fixture, prepared like the app does. */
function prepareFixture(corpus, image) {
  const full = resolveApprovedFixture(corpus, image.file);
  const resized = resizeWithImageMagick(full);
  const bytes = resized ? resized.bytes : fs.readFileSync(full);
  return {
    id: image.id,
    uri: `file:///fixtures/${image.file}`,
    dataUri: `data:image/jpeg;base64,${bytes.toString('base64')}`,
    how: resized ? resized.how : 'raw-bytes (all approved fixtures are already <= 960 px wide)',
    bytes: bytes.length,
  };
}

function prepareAll(corpus, ids = null) {
  const prepared = new Map();
  const info = {};
  for (const image of corpus.images) {
    if (ids && !ids.includes(image.id)) continue;
    const p = prepareFixture(corpus, image);
    prepared.set(p.uri, p.dataUri);
    info[image.id] = { uri: p.uri, how: p.how, bytes: p.bytes };
  }
  return { prepared, info };
}

module.exports = {
  FIXTURE_DIR,
  FixtureError,
  SCANNER_IMAGE_JPEG_QUALITY,
  SCANNER_IMAGE_MAX_WIDTH,
  loadCorpus,
  prepareAll,
  prepareFixture,
  resolveApprovedFixture,
};
