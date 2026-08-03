#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');

const {
  matchesSignature,
  detectFormatId,
  readHeaderMetadata,
} = require('../../security/ingestion-gate/signatures');
const { loadPolicy, getFormatById } = require('../../security/ingestion-gate/policy');

const policy = loadPolicy();

test('detectFormatId: valid JPEG magic bytes are recognized', async () => {
  const buf = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'red' } }).jpeg().toBuffer();
  assert.equal(detectFormatId(buf, policy), 'jpeg');
});

test('detectFormatId: valid PNG magic bytes are recognized', async () => {
  const buf = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'red' } }).png().toBuffer();
  assert.equal(detectFormatId(buf, policy), 'png');
});

test('detectFormatId: valid WebP magic bytes are recognized', async () => {
  const buf = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'red' } }).webp().toBuffer();
  assert.equal(detectFormatId(buf, policy), 'webp');
});

test('detectFormatId: SVG (XML text) matches no allowed signature', () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>');
  assert.equal(detectFormatId(svg, policy), null);
});

test('detectFormatId: a ZIP/archive magic byte sequence matches no allowed signature', () => {
  const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00]); // "PK\x03\x04"
  assert.equal(detectFormatId(zip, policy), null);
});

test('detectFormatId: a PDF magic byte sequence matches no allowed signature', () => {
  const pdf = Buffer.from('%PDF-1.4\n%...');
  assert.equal(detectFormatId(pdf, policy), null);
});

test('detectFormatId: an empty buffer matches nothing', () => {
  assert.equal(detectFormatId(Buffer.alloc(0), policy), null);
});

test('matchesSignature: WebP requires BOTH the RIFF prefix and the WEBP tag at offset 8', () => {
  const webpFormat = getFormatById(policy, 'webp');
  const riffOnlyNotWebp = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.alloc(4), Buffer.from('AVI ', 'ascii')]);
  assert.equal(matchesSignature(riffOnlyNotWebp, webpFormat), false);
});

test('readHeaderMetadata: JPEG SOF0 dimensions are parsed correctly', async () => {
  const buf = await sharp({ create: { width: 321, height: 145, channels: 3, background: 'blue' } }).jpeg().toBuffer();
  const meta = readHeaderMetadata(buf, 'jpeg');
  assert.equal(meta.width, 321);
  assert.equal(meta.height, 145);
  assert.equal(meta.frames, 1);
});

test('readHeaderMetadata: PNG IHDR dimensions are parsed correctly', async () => {
  const buf = await sharp({ create: { width: 200, height: 88, channels: 3, background: 'green' } }).png().toBuffer();
  const meta = readHeaderMetadata(buf, 'png');
  assert.equal(meta.width, 200);
  assert.equal(meta.height, 88);
  assert.equal(meta.frames, 1);
});

test('readHeaderMetadata: forged PNG header declaring huge dimensions is read as-is (bomb detection is the caller\'s job)', () => {
  const bombHeader = Buffer.alloc(33);
  Buffer.from('89504E470D0A1A0A', 'hex').copy(bombHeader, 0);
  bombHeader.writeUInt32BE(50000, 16);
  bombHeader.writeUInt32BE(50000, 20);
  const meta = readHeaderMetadata(bombHeader, 'png');
  assert.equal(meta.width, 50000);
  assert.equal(meta.height, 50000);
});

test('readHeaderMetadata: animated WebP (VP8X with animation flag) reports frames > 1', () => {
  // Hand-built minimal VP8X container header -- this test exercises the
  // pure-JS header parser only (signatures.js), not a real decode, so a
  // synthetic but format-correct header is sufficient and avoids coupling
  // to a specific installed sharp version's animated-encode API.
  const header = Buffer.alloc(30);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(22, 4); // file size (not validated by our parser)
  header.write('WEBP', 8, 'ascii');
  header.write('VP8X', 12, 'ascii');
  header.writeUInt32LE(10, 16); // VP8X chunk length
  header[20] = 0x02; // flags byte: bit 1 (0x02) = ANIM
  // bytes 21-23 reserved, left zero
  const width = 20;
  const height = 20;
  header[24] = (width - 1) & 0xff;
  header[25] = ((width - 1) >> 8) & 0xff;
  header[26] = ((width - 1) >> 16) & 0xff;
  header[27] = (height - 1) & 0xff;
  header[28] = ((height - 1) >> 8) & 0xff;
  header[29] = ((height - 1) >> 16) & 0xff;

  const meta = readHeaderMetadata(header, 'webp');
  assert.equal(meta.width, 20);
  assert.equal(meta.height, 20);
  assert.ok(meta.frames > 1, `expected animated webp to report frames > 1, got ${meta.frames}`);
});

test('readHeaderMetadata: static single-frame WebP reports exactly 1 frame', async () => {
  const buf = await sharp({ create: { width: 20, height: 20, channels: 3, background: 'red' } }).webp().toBuffer();
  const meta = readHeaderMetadata(buf, 'webp');
  assert.equal(meta.frames, 1);
});

test('readHeaderMetadata: unrecognized format id returns null (defer to full decode)', () => {
  assert.equal(readHeaderMetadata(Buffer.from('anything'), 'gif'), null);
});
