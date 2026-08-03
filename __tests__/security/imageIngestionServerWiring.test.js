#!/usr/bin/env node
'use strict';

// End-to-end wiring test for the Secure Image Ingestion Gate inside
// server.js's /api/analyze route -- uses a real HTTP server (no supertest
// dependency, matching this repo's existing no-supertest convention) so the
// gate's rejection path is exercised through the actual Express route, not
// just the gate module in isolation.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const sharp = require('sharp');

process.env.KSCAN_DEBUG = 'false';
process.env.ALLOW_DEV_FALLBACK = 'false';
process.env.GEMINI_API_KEY = 'fake-key-for-test';
process.env.USE_OPENROUTER = 'false';

const { app } = require('../../server.js');

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function postAnalyze(server, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port: server.address().port, path: '/api/analyze', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

test('a spoofed-format image is rejected by the ingestion gate before any provider call', async (t) => {
  let fetchCalled = false;
  const originalFetch = global.fetch;
  global.fetch = () => { fetchCalled = true; throw new Error('provider must not be called for a rejected image'); };
  t.after(() => { global.fetch = originalFetch; });

  const server = await startServer();
  t.after(() => server.close());

  const pngBytes = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'red' } }).png().toBuffer();
  const dataUri = `data:image/jpeg;base64,${pngBytes.toString('base64')}`; // PNG bytes mislabeled as JPEG

  const { status, body } = await postAnalyze(server, { image: dataUri });

  assert.equal(fetchCalled, false, 'the provider must never be called for an ingestion-gate rejection');
  assert.equal(status, 400);
  assert.equal(body.result, 'This image format is not supported.');
  assert.deepEqual(body.products, []);
});

test('a non-image payload with a spoofed data-uri prefix is rejected, not silently forwarded', async (t) => {
  let fetchCalled = false;
  const originalFetch = global.fetch;
  global.fetch = () => { fetchCalled = true; throw new Error('provider must not be called'); };
  t.after(() => { global.fetch = originalFetch; });

  const server = await startServer();
  t.after(() => server.close());

  const garbage = Buffer.from('this is not an image at all, just plain text bytes');
  const dataUri = `data:image/jpeg;base64,${garbage.toString('base64')}`;

  const { status } = await postAnalyze(server, { image: dataUri });
  assert.equal(fetchCalled, false);
  assert.equal(status, 400);
});

test('an oversized image (over the effective policy cap) is rejected REJECTED_SIZE before any provider call', async (t) => {
  let fetchCalled = false;
  const originalFetch = global.fetch;
  global.fetch = () => { fetchCalled = true; throw new Error('provider must not be called'); };
  t.after(() => { global.fetch = originalFetch; });

  const server = await startServer();
  t.after(() => server.close());

  const jpeg = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'red' } }).jpeg().toBuffer();
  const oversized = Buffer.concat([jpeg, Buffer.alloc(11 * 1024 * 1024)]);
  const dataUri = `data:image/jpeg;base64,${oversized.toString('base64')}`;

  const { status, body } = await postAnalyze(server, { image: dataUri });
  assert.equal(fetchCalled, false);
  assert.equal(status, 400);
  assert.equal(body.result, 'This image is too large.');
});

test('a valid image reaches the provider call with re-encoded (canonical) bytes, not the original upload', async (t) => {
  const originalFetch = global.fetch;
  let capturedBody = null;
  global.fetch = (url, opts) => {
    capturedBody = opts && opts.body ? JSON.parse(opts.body) : null;
    return Promise.resolve(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'Category: Footwear\nColor: Black\nSilhouette: Low-top' }] } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  };
  t.after(() => { global.fetch = originalFetch; });

  const server = await startServer();
  t.after(() => server.close());

  const jpegWithExif = await sharp({ create: { width: 50, height: 50, channels: 3, background: 'blue' } })
    .jpeg()
    .withExif({ IFD0: { Make: 'TestCam' } })
    .toBuffer();
  const dataUri = `data:image/jpeg;base64,${jpegWithExif.toString('base64')}`;

  await postAnalyze(server, { image: dataUri });
  assert.ok(capturedBody, 'expected the provider to have been called for a valid image');

  // The bytes actually sent to the provider (Gemini's inline_data.data field,
  // per server.js's request body) must differ from the original upload
  // (re-encoded/metadata-stripped), and must themselves be a valid JPEG.
  const inlineDataPart = capturedBody.contents[0].parts.find((p) => p.inline_data);
  assert.ok(inlineDataPart, 'expected an inline_data part in the Gemini request body');
  const sentBase64 = inlineDataPart.inline_data.data;
  assert.notEqual(sentBase64, jpegWithExif.toString('base64'));
  const sentBuffer = Buffer.from(sentBase64, 'base64');
  assert.equal(sentBuffer.subarray(0, 3).toString('hex'), 'ffd8ff');

  const sentMeta = await sharp(sentBuffer).metadata();
  assert.equal(sentMeta.exif, undefined, 'the EXIF the client sent must have been stripped before reaching the provider');
});
