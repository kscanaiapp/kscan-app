#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');

const { scanBuffer, ping } = require('../../security/ingestion-gate/clamdClient');

// The real EICAR antivirus test string (https://www.eicar.org/) -- a
// harmless, industry-standard byte pattern every AV engine is designed to
// flag. Used ONLY here, against a fake local INSTREAM server that never
// leaves this test process; never written to disk, never sent to any real
// network endpoint, never a fixture file in the repo (per Phase 11
// instructions: "must never enter production or legitimate staging content").
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

// Minimal fake clamd INSTREAM server: reads the "zINSTREAM\0" command,
// consumes length-prefixed chunks until a zero-length terminator, then
// replies with either "stream: OK" or "stream: <name> FOUND" depending on
// whether the reassembled payload matches the EICAR pattern.
function startFakeClamd(behavior = 'normal') {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      if (behavior === 'silent') return; // never responds -- exercises SCAN_TIMEOUT
      if (behavior === 'garbage') {
        socket.end('not a real clamd response\n');
        return;
      }
      let buffered = Buffer.alloc(0);
      let sawCommand = false;
      socket.on('data', (chunk) => {
        buffered = Buffer.concat([buffered, chunk]);
        if (!sawCommand && buffered.includes('zINSTREAM\0')) {
          sawCommand = true;
          buffered = buffered.subarray(buffered.indexOf('zINSTREAM\0') + 'zINSTREAM\0'.length);
        }
        // Walk length-prefixed chunks looking for the zero-length terminator.
        let offset = 0;
        let payload = Buffer.alloc(0);
        while (offset + 4 <= buffered.length) {
          const len = buffered.readUInt32BE(offset);
          if (len === 0) {
            const found = payload.includes(EICAR) ? 'stream: Eicar-Signature FOUND' : 'stream: OK';
            socket.end(`${found}\0`);
            return;
          }
          if (offset + 4 + len > buffered.length) break; // wait for more data
          payload = Buffer.concat([payload, buffered.subarray(offset + 4, offset + 4 + len)]);
          offset += 4 + len;
        }
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function portOf(server) {
  return server.address().port;
}

test('scanBuffer: a clean buffer returns CLEAN', async (t) => {
  const server = await startFakeClamd('normal');
  t.after(() => server.close());
  const result = await scanBuffer(Buffer.from('just a normal image payload'), { host: '127.0.0.1', port: portOf(server) });
  assert.equal(result.verdict, 'CLEAN');
});

test('scanBuffer: the EICAR test pattern is detected as REJECTED_MALWARE', async (t) => {
  const server = await startFakeClamd('normal');
  t.after(() => server.close());
  const result = await scanBuffer(Buffer.from(EICAR), { host: '127.0.0.1', port: portOf(server) });
  assert.equal(result.verdict, 'REJECTED_MALWARE');
  // signatureName is captured for ops/internal use but this test only
  // asserts the verdict -- server.js/gate.js are separately verified to
  // never forward it into any user-facing message (verdict.test.js).
});

test('scanBuffer: an unresponsive scanner times out -> SCAN_TIMEOUT (fails closed)', async (t) => {
  const server = await startFakeClamd('silent');
  t.after(() => server.close());
  const result = await scanBuffer(Buffer.from('anything'), { host: '127.0.0.1', port: portOf(server), timeoutMs: 200 });
  assert.equal(result.verdict, 'SCAN_TIMEOUT');
});

test('scanBuffer: connection refused (no scanner running) -> SCANNER_UNAVAILABLE (fails closed)', async () => {
  // Port 1 is reserved and virtually guaranteed to refuse the connection.
  const result = await scanBuffer(Buffer.from('anything'), { host: '127.0.0.1', port: 1, timeoutMs: 2000 });
  assert.equal(result.verdict, 'SCANNER_UNAVAILABLE');
});

test('scanBuffer: an unrecognized response from something-not-clamd -> SCANNER_UNAVAILABLE (fails closed)', async (t) => {
  const server = await startFakeClamd('garbage');
  t.after(() => server.close());
  const result = await scanBuffer(Buffer.from('anything'), { host: '127.0.0.1', port: portOf(server) });
  assert.equal(result.verdict, 'SCANNER_UNAVAILABLE');
});

test('ping: reports healthy when clamd responds to zVERSION', async (t) => {
  const server = net.createServer((socket) => {
    socket.end('ClamAV 1.3.0/27000/Sun Aug  3 00:00:00 2026\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const result = await ping({ host: '127.0.0.1', port: portOf(server) });
  assert.equal(result.healthy, true);
  assert.match(result.versionString, /ClamAV/);
});

test('ping: reports unhealthy when nothing is listening', async () => {
  const result = await ping({ host: '127.0.0.1', port: 1, timeoutMs: 1000 });
  assert.equal(result.healthy, false);
});
