'use strict';

const net = require('net');

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_CHUNK_SIZE = 64 * 1024;

// clamd INSTREAM protocol client. No third-party dependency -- INSTREAM is a
// simple length-prefixed TCP protocol clamd exposes for streaming scans:
//   1. send "zINSTREAM\0"
//   2. send repeated <4-byte BE chunk length><chunk bytes>
//   3. send a zero-length chunk (0x00000000) to signal EOF
//   4. read a single response line ("stream: OK", "stream: <sig> FOUND", or
//      an error string)
// Fails CLOSED on every error path (connection refused, timeout, malformed
// response) -- callers must treat anything other than { verdict: 'CLEAN' }
// as non-clean, per the "fail closed when the scanner cannot establish a
// clean result" requirement.
function scanBuffer(buffer, options = {}) {
  const host = options.host || process.env.CLAMD_HOST || '127.0.0.1';
  const port = options.port || Number(process.env.CLAMD_PORT || 3310);
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const chunkSize = options.chunkSize || DEFAULT_CHUNK_SIZE;

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    let responseData = Buffer.alloc(0);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ verdict: 'SCAN_TIMEOUT', reason: `clamd did not respond within ${timeoutMs}ms` });
    }, timeoutMs);

    socket.once('error', (err) => {
      finish({ verdict: 'SCANNER_UNAVAILABLE', reason: err.message });
    });

    socket.connect(port, host, () => {
      socket.write('zINSTREAM\0');
      let offset = 0;
      while (offset < buffer.length) {
        const chunk = buffer.subarray(offset, offset + chunkSize);
        const sizeHeader = Buffer.alloc(4);
        sizeHeader.writeUInt32BE(chunk.length, 0);
        socket.write(sizeHeader);
        socket.write(chunk);
        offset += chunk.length;
      }
      const zeroLengthTerminator = Buffer.alloc(4);
      socket.write(zeroLengthTerminator);
    });

    socket.on('data', (data) => {
      responseData = Buffer.concat([responseData, data]);
    });

    socket.on('close', () => {
      if (settled) return;
      // clamd's INSTREAM response is NUL-terminated ("stream: OK\0", etc.) --
      // strip trailing NUL bytes (and whitespace) before matching, otherwise
      // every real response would fall through as "unrecognized" and fail
      // closed even for a clean result.
      const text = responseData.toString('utf8').replace(/\0+$/, '').trim();
      if (!text) {
        finish({ verdict: 'SCANNER_UNAVAILABLE', reason: 'clamd closed the connection with no response' });
        return;
      }
      if (/OK$/.test(text)) {
        finish({ verdict: 'CLEAN', reason: text });
        return;
      }
      // Deliberately not surfaced to any user-facing message -- signatureName
      // is for operator/ops-review use only (e.g. security event logging),
      // per "do not expose malware family names" in required operational
      // behavior.
      const foundMatch = text.match(/:\s*(.+?)\s+FOUND$/);
      if (foundMatch) {
        finish({ verdict: 'REJECTED_MALWARE', reason: 'signature match', signatureName: foundMatch[1] });
        return;
      }
      finish({ verdict: 'SCANNER_UNAVAILABLE', reason: `unrecognized clamd response: ${text}` });
    });
  });
}

// Lightweight liveness/signature-age probe for the CI gate and ops health
// checks -- uses clamd's zVERSION/zPING-style single-command protocol
// (a bare command string, no INSTREAM framing).
function ping(options = {}) {
  const host = options.host || process.env.CLAMD_HOST || '127.0.0.1';
  const port = options.port || Number(process.env.CLAMD_PORT || 3310);
  const timeoutMs = options.timeoutMs || 5000;

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    let responseData = Buffer.alloc(0);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };

    const timer = setTimeout(() => finish({ healthy: false, reason: 'timeout' }), timeoutMs);

    socket.once('error', (err) => finish({ healthy: false, reason: err.message }));

    socket.connect(port, host, () => {
      socket.write('zVERSION\0');
    });

    socket.on('data', (data) => {
      responseData = Buffer.concat([responseData, data]);
    });

    socket.on('close', () => {
      if (settled) return;
      const text = responseData.toString('utf8').replace(/\0+$/, '').trim();
      finish({ healthy: text.length > 0, versionString: text || null });
    });
  });
}

module.exports = { scanBuffer, ping, DEFAULT_TIMEOUT_MS };
