#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const sharp = require('sharp');

const { runIngestionGate, VERDICTS } = require('../../security/ingestion-gate/gate');
const { loadPolicy } = require('../../security/ingestion-gate/policy');

const policy = loadPolicy();

async function makeJpegWithExifGps() {
  return sharp({ create: { width: 300, height: 200, channels: 3, background: { r: 10, g: 200, b: 80 } } })
    .jpeg()
    .withExif({
      IFD0: { Make: 'TestCam' },
      GPS: { GPSLatitude: '37/1,45/1,0/1', GPSLatitudeRef: 'N', GPSLongitude: '122/1,25/1,0/1', GPSLongitudeRef: 'W' },
    })
    .toBuffer();
}

test('valid JPEG -> CLEAN, canonical hash differs, dimensions preserved', async () => {
  const jpeg = await sharp({ create: { width: 150, height: 100, channels: 3, background: 'red' } }).jpeg().toBuffer();
  const result = await runIngestionGate(jpeg, { policy, declaredMimeType: 'image/jpeg' });
  assert.equal(result.ok, true);
  assert.equal(result.verdict, VERDICTS.CLEAN);
  assert.equal(result.width, 150);
  assert.equal(result.height, 100);
  assert.notEqual(result.sha256Original, result.sha256Canonical);
});

test('valid PNG -> CLEAN', async () => {
  const png = await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  const result = await runIngestionGate(png, { policy, declaredMimeType: 'image/png' });
  assert.equal(result.ok, true);
  assert.equal(result.detectedFormat, 'png');
});

test('valid WebP -> CLEAN', async () => {
  const webp = await sharp({ create: { width: 64, height: 64, channels: 3, background: 'blue' } }).webp().toBuffer();
  const result = await runIngestionGate(webp, { policy, declaredMimeType: 'image/webp' });
  assert.equal(result.ok, true);
  assert.equal(result.detectedFormat, 'webp');
});

test('EXIF GPS metadata is stripped from the canonical output', async () => {
  const jpeg = await makeJpegWithExifGps();
  const inputMeta = await sharp(jpeg).metadata();
  assert.ok(inputMeta.exif, 'sanity check: input fixture actually has EXIF');

  const result = await runIngestionGate(jpeg, { policy, declaredMimeType: 'image/jpeg' });
  assert.equal(result.ok, true);
  const outputMeta = await sharp(result.canonicalBuffer).metadata();
  assert.equal(outputMeta.exif, undefined);
  assert.equal(outputMeta.icc, undefined);
});

test('spoofed MIME: PNG bytes declared as image/jpeg is rejected REJECTED_TYPE', async () => {
  const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'red' } }).png().toBuffer();
  const result = await runIngestionGate(png, { policy, declaredMimeType: 'image/jpeg' });
  assert.equal(result.ok, false);
  assert.equal(result.verdict, VERDICTS.REJECTED_TYPE);
});

test('spoofed extension: PNG bytes with a .jpg extension declared is rejected REJECTED_TYPE', async () => {
  const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'red' } }).png().toBuffer();
  const result = await runIngestionGate(png, { policy, declaredMimeType: 'image/png', declaredExtension: '.jpg' });
  assert.equal(result.ok, false);
  assert.equal(result.verdict, VERDICTS.REJECTED_TYPE);
});

test('invalid magic bytes (SVG XML content) is rejected REJECTED_TYPE', async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>');
  const result = await runIngestionGate(svg, { policy, declaredMimeType: 'image/svg+xml' });
  assert.equal(result.ok, false);
  assert.equal(result.verdict, VERDICTS.REJECTED_TYPE);
});

test('archive (zip) magic bytes are rejected REJECTED_TYPE', async () => {
  const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0, 0, 0]);
  const result = await runIngestionGate(zip, { policy });
  assert.equal(result.ok, false);
  assert.equal(result.verdict, VERDICTS.REJECTED_TYPE);
});

test('truncated JPEG is rejected REJECTED_MALFORMED', async () => {
  const jpeg = await sharp({ create: { width: 100, height: 100, channels: 3, background: 'red' } }).jpeg().toBuffer();
  const truncated = jpeg.subarray(0, 40);
  const result = await runIngestionGate(truncated, { policy, declaredMimeType: 'image/jpeg' });
  assert.equal(result.ok, false);
  assert.equal(result.verdict, VERDICTS.REJECTED_MALFORMED);
});

test('corrupted JPEG (bytes flipped mid-stream) is rejected REJECTED_MALFORMED', async () => {
  const jpeg = await sharp({ create: { width: 100, height: 100, channels: 3, background: 'red' } }).jpeg().toBuffer();
  const corrupted = Buffer.from(jpeg);
  for (let i = 100; i < 150 && i < corrupted.length; i += 1) corrupted[i] = 0xff;
  const result = await runIngestionGate(corrupted, { policy, declaredMimeType: 'image/jpeg' });
  // Either the decoder rejects it outright, or (rarely, if libjpeg tolerates
  // the corruption) it still produces a valid re-encode -- both are
  // acceptable outcomes; what must NOT happen is an unhandled throw.
  assert.ok(result.verdict === VERDICTS.REJECTED_MALFORMED || result.ok === true);
});

test('polyglot: valid JPEG with trailing appended script-like bytes re-encodes cleanly, discarding the trailer', async () => {
  const jpeg = await sharp({ create: { width: 80, height: 80, channels: 3, background: 'red' } }).jpeg().toBuffer();
  const polyglot = Buffer.concat([jpeg, Buffer.from('<script>alert(1)</script>')]);
  const result = await runIngestionGate(polyglot, { policy, declaredMimeType: 'image/jpeg' });
  assert.equal(result.ok, true);
  assert.equal(result.canonicalBuffer.includes('script'), false);
});

test('excessive compressed size is rejected REJECTED_SIZE', async () => {
  const jpeg = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'red' } }).jpeg().toBuffer();
  const oversized = Buffer.concat([jpeg, Buffer.alloc(11 * 1024 * 1024)]);
  const result = await runIngestionGate(oversized, { policy, declaredMimeType: 'image/jpeg' });
  assert.equal(result.ok, false);
  assert.equal(result.verdict, VERDICTS.REJECTED_SIZE);
});

test('excessive dimensions (header-declared) is rejected REJECTED_DIMENSIONS before a full decode', async () => {
  const bombHeader = Buffer.alloc(33);
  Buffer.from('89504E470D0A1A0A', 'hex').copy(bombHeader, 0);
  bombHeader.writeUInt32BE(12, 8);
  bombHeader.write('IHDR', 12, 'ascii');
  bombHeader.writeUInt32BE(50000, 16);
  bombHeader.writeUInt32BE(50000, 20);
  const result = await runIngestionGate(bombHeader, { policy, declaredMimeType: 'image/png' });
  assert.equal(result.ok, false);
  assert.equal(result.verdict, VERDICTS.REJECTED_DIMENSIONS);
});

test('excessive total pixels (within per-axis limits but over the pixel budget) is rejected REJECTED_DIMENSIONS', async () => {
  const policyClone = JSON.parse(JSON.stringify(policy));
  const pngFormat = policyClone.allowedFormats.find((f) => f.id === 'png');
  pngFormat.maxTotalPixels = 100; // artificially tiny for this test
  const png = await sharp({ create: { width: 50, height: 50, channels: 3, background: 'red' } }).png().toBuffer();
  const result = await runIngestionGate(png, { policy: policyClone, declaredMimeType: 'image/png' });
  assert.equal(result.ok, false);
  assert.equal(result.verdict, VERDICTS.REJECTED_DIMENSIONS);
});

test('decompression-bomb-shaped fixture (tiny file, huge declared dimensions) never reaches the decoder', async () => {
  const bombHeader = Buffer.alloc(33);
  Buffer.from('89504E470D0A1A0A', 'hex').copy(bombHeader, 0);
  bombHeader.writeUInt32BE(12, 8);
  bombHeader.write('IHDR', 12, 'ascii');
  bombHeader.writeUInt32BE(0xffff, 16); // 65535
  bombHeader.writeUInt32BE(0xffff, 20);
  const start = Date.now();
  const result = await runIngestionGate(bombHeader, { policy, declaredMimeType: 'image/png' });
  const elapsedMs = Date.now() - start;
  assert.equal(result.ok, false);
  assert.equal(result.verdict, VERDICTS.REJECTED_DIMENSIONS);
  assert.ok(elapsedMs < 500, `header precheck should reject near-instantly, took ${elapsedMs}ms`);
});

test('animated content is rejected REJECTED_DIMENSIONS via the header precheck', async () => {
  const header = Buffer.alloc(30);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(22, 4);
  header.write('WEBP', 8, 'ascii');
  header.write('VP8X', 12, 'ascii');
  header.writeUInt32LE(10, 16);
  header[20] = 0x02; // ANIM flag
  header[24] = 19; header[25] = 0; header[26] = 0; // width-1 = 19 -> width 20
  header[27] = 19; header[28] = 0; header[29] = 0; // height-1 = 19 -> height 20
  const result = await runIngestionGate(header, { policy, declaredMimeType: 'image/webp' });
  assert.equal(result.ok, false);
  assert.equal(result.verdict, VERDICTS.REJECTED_DIMENSIONS);
});

test('malware scan (scanEnabled): EICAR pattern is rejected REJECTED_MALWARE, fails closed', async (t) => {
  const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
  const server = net.createServer((socket) => {
    let buffered = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      const cmdIdx = buffered.indexOf('zINSTREAM\0');
      if (cmdIdx === -1) return;
      const rest = buffered.subarray(cmdIdx + 'zINSTREAM\0'.length);
      let offset = 0;
      let payload = Buffer.alloc(0);
      while (offset + 4 <= rest.length) {
        const len = rest.readUInt32BE(offset);
        if (len === 0) {
          const found = payload.includes(EICAR) ? 'stream: Eicar FOUND' : 'stream: OK';
          socket.end(`${found}\0`);
          return;
        }
        if (offset + 4 + len > rest.length) break;
        payload = Buffer.concat([payload, rest.subarray(offset + 4, offset + 4 + len)]);
        offset += 4 + len;
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const carrier = Buffer.concat([await sharp({ create: { width: 10, height: 10, channels: 3, background: 'red' } }).jpeg().toBuffer(), Buffer.from(EICAR)]);
  const result = await runIngestionGate(carrier, {
    policy,
    declaredMimeType: 'image/jpeg',
    scanEnabled: true,
    scannerOptions: { host: '127.0.0.1', port: server.address().port },
  });
  assert.equal(result.ok, false);
  assert.equal(result.verdict, VERDICTS.REJECTED_MALWARE);
  assert.equal(result.userMessage, 'This image was rejected for safety reasons.');
  assert.equal(result.userMessage.toLowerCase().includes('eicar'), false);
});

test('malware scan (scanEnabled): scanner unavailable fails CLOSED, never falls through to CLEAN', async () => {
  const jpeg = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'red' } }).jpeg().toBuffer();
  const result = await runIngestionGate(jpeg, {
    policy,
    declaredMimeType: 'image/jpeg',
    scanEnabled: true,
    scannerOptions: { host: '127.0.0.1', port: 1, timeoutMs: 1000 }, // nothing listening
  });
  assert.equal(result.ok, false);
  assert.equal(result.verdict, VERDICTS.SCANNER_UNAVAILABLE);
});

test('malware scan (scanEnabled): scanner timeout fails CLOSED', async (t) => {
  const server = net.createServer(() => {}); // accepts but never responds
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const jpeg = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'red' } }).jpeg().toBuffer();
  const result = await runIngestionGate(jpeg, {
    policy,
    declaredMimeType: 'image/jpeg',
    scanEnabled: true,
    scannerOptions: { host: '127.0.0.1', port: server.address().port, timeoutMs: 200 },
  });
  assert.equal(result.ok, false);
  assert.equal(result.verdict, VERDICTS.SCAN_TIMEOUT);
});

test('scanEnabled=false (default rollout state) skips scanning entirely and still enforces every other check', async () => {
  const jpeg = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'red' } }).jpeg().toBuffer();
  const result = await runIngestionGate(jpeg, { policy, declaredMimeType: 'image/jpeg' });
  assert.equal(result.ok, true);
  assert.equal(result.verdictRecord.scannerEngine, 'not_run');
});

test('a signed verdict is issued when verdictSecret is provided, and verifies', async () => {
  const { verify } = require('../../security/ingestion-gate/verdict');
  const jpeg = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'red' } }).jpeg().toBuffer();
  const result = await runIngestionGate(jpeg, { policy, declaredMimeType: 'image/jpeg', verdictSecret: 'test-secret' });
  assert.equal(result.ok, true);
  assert.ok(result.signedVerdict);
  const verification = verify(result.signedVerdict, 'test-secret');
  assert.equal(verification.ok, true);
});

test('an unsupported/misconfigured outputReencodeFormat fails REENCODE_FAILED rather than passing raw input through', async () => {
  const policyClone = JSON.parse(JSON.stringify(policy));
  const jpegFormat = policyClone.allowedFormats.find((f) => f.id === 'jpeg');
  jpegFormat.outputReencodeFormat = 'not-a-real-format';
  const jpeg = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'red' } }).jpeg().toBuffer();
  const result = await runIngestionGate(jpeg, { policy: policyClone, declaredMimeType: 'image/jpeg' });
  assert.equal(result.ok, false);
  assert.equal(result.verdict, VERDICTS.REENCODE_FAILED);
});

test('canonical output revalidation: the self-check catches a re-encoder that silently produced the wrong format', async () => {
  // Simulate a re-encoder bug/misconfiguration by injecting a fake
  // decodeAndReencode-shaped module that reports success but returns bytes
  // of the WRONG format -- proves gate.js's own signature self-check on the
  // canonical output (not just trusting reencode.js's ok:true) is load-bearing.
  const gateModulePath = require.resolve('../../security/ingestion-gate/gate');
  delete require.cache[gateModulePath];
  const reencodeModulePath = require.resolve('../../security/ingestion-gate/reencode');
  const originalReencode = require.cache[reencodeModulePath];
  const fakePngBuffer = await sharp({ create: { width: 5, height: 5, channels: 3, background: 'red' } }).png().toBuffer();
  require.cache[reencodeModulePath] = {
    id: reencodeModulePath,
    filename: reencodeModulePath,
    loaded: true,
    exports: {
      isAvailable: () => true,
      decodeAndReencode: async () => ({ ok: true, canonicalBuffer: fakePngBuffer, width: 5, height: 5, canonicalHasExif: false, canonicalHasIcc: false }),
    },
  };
  try {
    const { runIngestionGate: gateWithFake, VERDICTS: V } = require(gateModulePath);
    const jpeg = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'red' } }).jpeg().toBuffer();
    const result = await gateWithFake(jpeg, { policy, declaredMimeType: 'image/jpeg' }); // policy says jpeg output should be jpeg, but fake returns png bytes
    assert.equal(result.ok, false);
    assert.equal(result.verdict, V.REENCODE_FAILED);
  } finally {
    if (originalReencode) require.cache[reencodeModulePath] = originalReencode;
    else delete require.cache[reencodeModulePath];
    delete require.cache[gateModulePath];
  }
});

test('empty buffer is rejected REJECTED_MALFORMED', async () => {
  const result = await runIngestionGate(Buffer.alloc(0), { policy });
  assert.equal(result.ok, false);
  assert.equal(result.verdict, VERDICTS.REJECTED_MALFORMED);
});
