/**
 * Rasterizes a frozen GeometrySnapshot's mesh to a PNG, for human visual
 * review (amendments D2 / D23).
 *
 * WHAT THIS IS: a rendering of exactly the mesh vertex array that
 * `Canvas.drawBitmapMesh` consumes on device, produced from the committed
 * `native-meshes.jsonl` the JVM conformance test writes. It answers the one
 * question numbers cannot: does the supposedly-correct geometry actually
 * look like a garment?
 *
 * WHAT THIS IS NOT: a device screenshot. It does not exercise Android's
 * rasterizer, its own bilinear sampling, or any device-specific behaviour,
 * and it must never be presented as physical-device evidence. The mandatory
 * physical-device screenshot is a separate, still-outstanding requirement.
 *
 * Usage:
 *   node tools/render-snapshot.mjs [--out <dir>] [--fixture <name>] [--case <id>]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync, deflateSync, crc32 } from 'node:zlib';

const MODULE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFORMANCE_DIR = join(MODULE_ROOT, 'build', 'conformance');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const outDir = resolve(arg('out', join(CONFORMANCE_DIR, 'renders')));
const onlyFixture = arg('fixture', null);
const onlyCase = arg('case', null);

// ── Minimal PNG read/write (RGBA8, no interlace) ────────────────────────────

function readPng(path) {
  const d = readFileSync(path);
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = 6;
  const idat = [];
  while (pos < d.length) {
    const len = d.readUInt32BE(pos);
    const type = d.toString('ascii', pos + 4, pos + 8);
    const data = d.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const channels = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * channels);
  let prev = Buffer.alloc(stride);
  let i = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[i++];
    const line = Buffer.from(raw.subarray(i, i + stride));
    i += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      if (filter === 1) line[x] = (line[x] + a) & 255;
      else if (filter === 2) line[x] = (line[x] + b) & 255;
      else if (filter === 3) line[x] = (line[x] + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        line[x] = (line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
    }
    line.copy(out, y * stride);
    prev = line;
  }
  return { width, height, channels, pixels: out };
}

function writePng(path, width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const chunk = (type, data) => {
    const out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'ascii');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])) >>> 0, data.length + 8);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  writeFileSync(
    path,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw, { level: 9 })),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

// ── Mesh rasterization ──────────────────────────────────────────────────────

/**
 * Forward-scatters the garment texture through the mesh, matching
 * drawBitmapMesh's own model: the mesh is a (w+1)x(h+1) grid of destination
 * vertices, and each grid cell maps a rectangular texture patch onto a
 * (generally non-rectangular) destination quad by bilinear interpolation.
 *
 * Supersampled so the scatter leaves no gaps. This is a review render, not
 * a performance-sensitive path.
 */
function renderMesh(snapshot, texture, alpha, canvasWidth, canvasHeight) {
  const { meshWidth, meshHeight, meshVertices } = snapshot;
  const out = Buffer.alloc(canvasWidth * canvasHeight * 4);
  // Dark ground, so a garment drawn off-canvas is obvious rather than white-on-white.
  for (let i = 0; i < canvasWidth * canvasHeight; i++) {
    out[i * 4] = 24;
    out[i * 4 + 1] = 24;
    out[i * 4 + 2] = 28;
    out[i * 4 + 3] = 255;
  }

  const vertexAt = (col, row) => {
    const idx = (row * (meshWidth + 1) + col) * 2;
    return { x: meshVertices[idx], y: meshVertices[idx + 1] };
  };

  const SS = 3; // supersamples per texel per axis
  for (let row = 0; row < meshHeight; row++) {
    for (let col = 0; col < meshWidth; col++) {
      const p00 = vertexAt(col, row);
      const p10 = vertexAt(col + 1, row);
      const p01 = vertexAt(col, row + 1);
      const p11 = vertexAt(col + 1, row + 1);

      const u0 = (col / meshWidth) * texture.width;
      const u1 = ((col + 1) / meshWidth) * texture.width;
      const v0 = (row / meshHeight) * texture.height;
      const v1 = ((row + 1) / meshHeight) * texture.height;

      const steps = Math.max(2, Math.ceil(Math.max(u1 - u0, v1 - v0) * SS));
      for (let sy = 0; sy <= steps; sy++) {
        const ty = sy / steps;
        for (let sx = 0; sx <= steps; sx++) {
          const tx = sx / steps;
          // destination: bilinear across the quad
          const dx =
            p00.x * (1 - tx) * (1 - ty) + p10.x * tx * (1 - ty) + p01.x * (1 - tx) * ty + p11.x * tx * ty;
          const dy =
            p00.y * (1 - tx) * (1 - ty) + p10.y * tx * (1 - ty) + p01.y * (1 - tx) * ty + p11.y * tx * ty;
          const px = Math.round(dx);
          const py = Math.round(dy);
          if (px < 0 || py < 0 || px >= canvasWidth || py >= canvasHeight) continue;

          // source texel
          const su = Math.min(texture.width - 1, Math.round(u0 + (u1 - u0) * tx));
          const sv = Math.min(texture.height - 1, Math.round(v0 + (v1 - v0) * ty));
          const si = (sv * texture.width + su) * texture.channels;
          const ai = (sv * alpha.width + su) * alpha.channels;

          const alphaChannel = alpha.channels === 4 ? alpha.pixels[ai + 3] : 255;
          const luminance = (alpha.pixels[ai] * 3 + alpha.pixels[ai + 1] * 6 + alpha.pixels[ai + 2]) / 10;
          const coverage = Math.max(alphaChannel, luminance);
          if (coverage < 128) continue;

          const di = (py * canvasWidth + px) * 4;
          out[di] = texture.pixels[si];
          out[di + 1] = texture.pixels[si + 1];
          out[di + 2] = texture.pixels[si + 2];
          out[di + 3] = 255;
        }
      }
    }
  }

  // Control points, so the render is checkable against the delta table.
  const mark = (x, y, r, g, b) => {
    for (let oy = -3; oy <= 3; oy++) {
      for (let ox = -3; ox <= 3; ox++) {
        const px = Math.round(x) + ox;
        const py = Math.round(y) + oy;
        if (px < 0 || py < 0 || px >= canvasWidth || py >= canvasHeight) continue;
        const di = (py * canvasWidth + px) * 4;
        out[di] = r;
        out[di + 1] = g;
        out[di + 2] = b;
        out[di + 3] = 255;
      }
    }
  };
  for (const [id, [x, y]] of Object.entries(snapshot.controlPoints)) {
    // wearer's own LEFT green, RIGHT magenta -- a mirror is visible at a glance
    if (id.startsWith('left')) mark(x, y, 40, 230, 90);
    else if (id.startsWith('right')) mark(x, y, 240, 60, 200);
    else mark(x, y, 250, 220, 40);
  }
  return out;
}

// ── Main ────────────────────────────────────────────────────────────────────

const meshPath = join(CONFORMANCE_DIR, 'native-meshes.jsonl');
if (!existsSync(meshPath)) {
  console.error(
    'ERROR: native-meshes.jsonl not found.\n' +
      'Run  ./gradlew :kscan-live-vto-native:testDebugUnitTest  first.',
  );
  process.exit(2);
}

mkdirSync(outDir, { recursive: true });
const textures = new Map();

const rows = readFileSync(meshPath, 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

let written = 0;
for (const row of rows) {
  if (onlyFixture && row.fixture !== onlyFixture) continue;
  if (onlyCase && row.case !== onlyCase) continue;
  const snapshot = row.snapshot;
  if (!snapshot.meshVertices) {
    console.log(`skip ${row.fixture}/${row.case}: no mesh (${snapshot.failure ?? snapshot.gateFindings})`);
    continue;
  }
  if (!textures.has(row.fixture)) {
    const dir = join(MODULE_ROOT, 'android', 'src', 'main', 'assets', row.fixture);
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).ksgarment;
    textures.set(row.fixture, {
      texture: readPng(join(dir, manifest.texture)),
      alpha: readPng(join(dir, manifest.alphaMask)),
    });
  }
  const { texture, alpha } = textures.get(row.fixture);
  const w = Math.round(snapshot.canvasWidth);
  const h = Math.round(snapshot.canvasHeight);
  const rgba = renderMesh(snapshot, texture, alpha, w, h);
  const name = `${row.fixture}__${row.case}.png`;
  writePng(join(outDir, name), w, h, rgba);
  written++;
}

console.log(`wrote ${written} review renders to ${outDir}`);
console.log('NOTE: these are rasterizations of the frozen mesh, NOT device screenshots.');
