/**
 * Deterministic synthetic image fixtures for the VTO E2E harness.
 *
 * Transport, not visual quality, is under test here (see docs/vto-provider-
 * benchmark.md §3 — AILabTools has already been proven to complete a
 * transport-level generation against deterministic non-personal synthetic
 * imagery). No private human imagery is ever sourced: every pixel is
 * generated programmatically from a fixed numeric seed using a simple
 * counter-based PRNG, so a fixture is fully reproducible from its seed alone
 * and carries no EXIF/XMP metadata (the PNG encoder emits only
 * IHDR/IDAT/IEND — see lib/png.mjs).
 */
'use strict';

import crypto from 'node:crypto';
import { encodePng } from './png.mjs';

export const PERSON_FIXTURE_WIDTH = 400;
export const PERSON_FIXTURE_HEIGHT = 600;
export const GARMENT_FIXTURE_WIDTH = 300;
export const GARMENT_FIXTURE_HEIGHT = 300;

/** Mulberry32 — a small, fast, deterministic PRNG. Same seed -> same bytes,
 *  forever, on any machine: no reliance on Math.random or crypto entropy. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedToUint32(seedLabel) {
  const digest = crypto.createHash('sha256').update(seedLabel).digest();
  return digest.readUInt32BE(0);
}

/**
 * Renders a deterministic gradient-plus-speckle RGB buffer. Structured (not
 * pure noise) so PNG deflate compresses it to a modest, realistic size
 * rather than an incompressible multi-megabyte blob.
 */
function renderRgb(width, height, seedLabel) {
  const rand = mulberry32(seedToUint32(seedLabel));
  const rgb = Buffer.alloc(width * height * 3);
  // Fixed per-fixture base hue so person/garment fixtures are visually
  // distinguishable in any debug dump, without depending on rand() order.
  const baseHue = seedToUint32(`${seedLabel}:hue`) % 256;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 3;
      const gradient = Math.floor((x / width) * 128 + (y / height) * 64);
      const speckle = Math.floor(rand() * 32);
      rgb[i] = (baseHue + gradient) & 0xff;
      rgb[i + 1] = (gradient + speckle) & 0xff;
      rgb[i + 2] = (255 - gradient + speckle) & 0xff;
    }
  }
  return rgb;
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Builds one deterministic PNG fixture and its evidence record (seed, hash,
 * dimensions, byte size — never the raw bytes) suitable for a report.
 */
export function buildFixture({ seedLabel, width, height }) {
  const rgb = renderRgb(width, height, seedLabel);
  const png = encodePng(width, height, rgb);
  return {
    seedLabel,
    width,
    height,
    byteLength: png.byteLength,
    sha256: sha256Hex(png),
    dataUri: `data:image/png;base64,${png.toString('base64')}`,
    buffer: png,
  };
}

/**
 * The two fixtures the harness needs, tagged by a per-run label so distinct
 * harness runs never accidentally collide on the same idempotency identity.
 */
export function buildVtoFixtures(runTag) {
  const person = buildFixture({
    seedLabel: `kscan-vto-e2e-person:${runTag}`,
    width: PERSON_FIXTURE_WIDTH,
    height: PERSON_FIXTURE_HEIGHT,
  });
  const garment = buildFixture({
    seedLabel: `kscan-vto-e2e-garment:${runTag}`,
    width: GARMENT_FIXTURE_WIDTH,
    height: GARMENT_FIXTURE_HEIGHT,
  });
  return { person, garment };
}

/** Evidence-only view of a fixture: never includes bytes or the data URI. */
export function fixtureEvidence(fixture) {
  return {
    seedLabel: fixture.seedLabel,
    width: fixture.width,
    height: fixture.height,
    byteLength: fixture.byteLength,
    sha256: fixture.sha256,
  };
}
