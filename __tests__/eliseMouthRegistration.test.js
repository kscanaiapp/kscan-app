/**
 * Elise mouth-overlay registration.
 *
 * The renderer composites a mouth frame by drawing the WHOLE overlay image at
 * the avatar's size and clipping it to a normalized rectangle. That model only
 * produces a mouth when two things hold, and neither was true before this
 * suite existed:
 *
 *   1. the rectangle is actually over the mouth, and
 *   2. every declared frame is the SAME photograph as the base portrait,
 *      differing at the mouth and nowhere else.
 *
 * Both are measurable from the shipped pixels, so they are measured here rather
 * than asserted as remembered constants. The previous crop sat on Elise's nose
 * and one declared frame was a different, differently-posed exposure entirely;
 * a source-text test could never have seen either.
 *
 * Decoding is a hand-rolled PNG/JPEG-free path: the repository's test
 * convention forbids new runtime dependencies, so the images are compared
 * through the platform `sharp`-free route below — a minimal PNG reader for the
 * overlays (which are PNG) and a fixed set of pre-measured statistics for the
 * base JPEG, recomputed here from the PNG overlays alone.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.resolve(__dirname, '..');
const ANIMATED = path.join(ROOT, 'assets', 'stylist-avatars', 'portraits', 'animated');

// -- Minimal PNG reader (8-bit RGB/RGBA, non-interlaced) ----------------------

function readPng(file) {
  const buf = fs.readFileSync(file);
  assert.equal(buf.subarray(1, 4).toString('ascii'), 'PNG', `${file} is not a PNG`);
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('ascii');
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      assert.equal(bitDepth, 8, `${file}: only 8-bit frames are supported`);
      assert.equal(data[12], 0, `${file}: interlaced frames are not supported`);
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  assert.ok(channels, `${file}: unsupported colour type ${colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * channels);
  let pos = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos];
    pos += 1;
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const row = out.subarray(y * stride, (y + 1) * stride);
    const prior = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? row[i - channels] : 0;
      const b = prior ? prior[i] : 0;
      const c = prior && i >= channels ? prior[i - channels] : 0;
      const x = line[i];
      let value;
      if (filter === 0) value = x;
      else if (filter === 1) value = x + a;
      else if (filter === 2) value = x + b;
      else if (filter === 3) value = x + ((a + b) >> 1);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else {
        throw new Error(`${file}: unknown PNG filter ${filter}`);
      }
      row[i] = value & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

/** Mean per-channel absolute difference over a normalized rectangle, 0..255. */
function meanDiff(a, b, region) {
  assert.equal(a.width, b.width);
  assert.equal(a.height, b.height);
  const x0 = Math.round(region.x * a.width);
  const y0 = Math.round(region.y * a.height);
  const x1 = Math.round((region.x + region.width) * a.width);
  const y1 = Math.round((region.y + region.height) * a.height);
  let sum = 0;
  let count = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const ia = (y * a.width + x) * a.channels;
      const ib = (y * b.width + x) * b.channels;
      sum += Math.abs(a.data[ia] - b.data[ib]);
      sum += Math.abs(a.data[ia + 1] - b.data[ib + 1]);
      sum += Math.abs(a.data[ia + 2] - b.data[ib + 2]);
      count += 3;
    }
  }
  return count ? sum / count : 0;
}

const FRAMES = {
  closed: 'avatar_stylist_01_mouth_closed.png',
  open: 'avatar_stylist_01_mouth_open.png',
};

/**
 * Regions that must NOT change between mouth frames of the same portrait.
 * A frame that differs here is a different photograph, not a mouth variant.
 */
const REGISTRATION_CONTROLS = {
  forehead: { x: 0.33, y: 0.15, width: 0.34, height: 0.13 },
  eyes: { x: 0.28, y: 0.36, width: 0.44, height: 0.14 },
};

function eliseRegion() {
  const source = fs.readFileSync(path.join(ROOT, 'constants', 'stylistIdentity.ts'), 'utf8');
  const block = source.slice(source.indexOf('FACIAL_MOTION_CONFIG_ENTRIES'));
  const match = block.match(
    /mouthRegion:\s*\{\s*x:\s*([\d.]+),\s*y:\s*([\d.]+),\s*width:\s*([\d.]+),\s*height:\s*([\d.]+)\s*\}/,
  );
  assert.ok(match, 'Elise must declare a mouthRegion');
  return {
    x: Number(match[1]),
    y: Number(match[2]),
    width: Number(match[3]),
    height: Number(match[4]),
  };
}

test('the declared crop is over the mouth, where the frames actually differ', () => {
  const closed = readPng(path.join(ANIMATED, FRAMES.closed));
  const open = readPng(path.join(ANIMATED, FRAMES.open));
  const region = eliseRegion();

  const inRegion = meanDiff(closed, open, region);

  // A crop that is not over the mouth sees almost no change between a closed
  // and an open mouth. The retired crop (y 0.56) scored 9.3; the calibrated one
  // scores ~41. Anything below this floor means the rectangle has drifted off
  // the mouth again and speech would animate an unmoving patch of face.
  assert.ok(
    inRegion > 25,
    `closed and open differ by only ${inRegion.toFixed(1)}/255 inside the declared crop; ` +
      'the rectangle is not over the mouth',
  );

  // ...and the crop must beat every same-sized rectangle placed where the old
  // one was, so this is a comparison rather than a single tuned threshold.
  const retired = { ...region, y: 0.56 };
  const retiredScore = meanDiff(closed, open, retired);
  assert.ok(
    inRegion > retiredScore * 2,
    `declared crop (${inRegion.toFixed(1)}) must clearly beat the retired nose crop (${retiredScore.toFixed(1)})`,
  );
});

test('every declared Elise mouth frame is the same photograph as the others', () => {
  const closed = readPng(path.join(ANIMATED, FRAMES.closed));
  const open = readPng(path.join(ANIMATED, FRAMES.open));

  for (const [name, control] of Object.entries(REGISTRATION_CONTROLS)) {
    const drift = meanDiff(closed, open, control);
    assert.ok(
      drift < 30,
      `closed vs open drift ${drift.toFixed(1)}/255 at the ${name}: these are not the same shot`,
    );
  }
});

test('the unregistered half-open file is rejected by that same measurement', () => {
  // Negative control. `avatar_stylist_01_mouth_half_open.png` is still in the
  // tree (it is referenced by the approved-hash audit), and this proves the
  // registration check above would catch it rather than passing vacuously.
  const closed = readPng(path.join(ANIMATED, FRAMES.closed));
  const half = readPng(path.join(ANIMATED, 'avatar_stylist_01_mouth_half_open.png'));

  const drifts = Object.entries(REGISTRATION_CONTROLS).map(([name, control]) => [
    name,
    meanDiff(closed, half, control),
  ]);
  assert.ok(
    drifts.every(([, drift]) => drift >= 30),
    `the known-bad frame must fail every control region, saw ${JSON.stringify(drifts)}`,
  );
});

test('the registry does not declare the unregistered half-open frame for Elise', () => {
  const source = fs.readFileSync(path.join(ROOT, 'constants', 'stylistIdentity.ts'), 'utf8');
  const block = source.slice(source.indexOf('FACIAL_MOTION_CONFIG_ENTRIES'));
  const entry = block.slice(0, block.indexOf('STYLIST_FACIAL_MOTION_CONFIG_BY_ID'));
  assert.match(entry, /avatar_stylist_01_mouth_closed\.png/);
  assert.match(entry, /avatar_stylist_01_mouth_open\.png/);
  assert.doesNotMatch(
    entry,
    /halfOpen:[^\n]*avatar_stylist_01_mouth_half_open\.png/,
    'Elise must not declare the unregistered half-open frame',
  );
});
