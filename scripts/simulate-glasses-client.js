#!/usr/bin/env node
/**
 * K Scan mock glasses client (Phase 16 alpha). NODE-ONLY DEV TOOLING.
 *
 * Connects to the bridge dev server (default ws://localhost:8787), sends a
 * `capture.request`, and waits for the matching `capture.success` or
 * `capture.error`. Uses Node's built-in WebSocket global (Node >= 22) —
 * no `ws` import needed on the client side.
 *
 * Logging policy: message type, requestId, status, and error codes only.
 * Never logs image payload data (full or partial base64, byte length,
 * dimensions, EXIF, or other image-derived metadata).
 */

const URL = process.env.BRIDGE_DEV_URL || 'ws://localhost:8787';
const TIMEOUT_MS = Number(process.env.BRIDGE_CLIENT_TIMEOUT_MS || 10000);
const JPEG_PREFIX = 'data:image/jpeg;base64,';

if (typeof WebSocket !== 'function') {
  console.error('[glasses-client] this script requires Node >= 22 (built-in WebSocket)');
  process.exit(1);
}

const requestId = `glasses-sim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const socket = new WebSocket(URL);

const timer = setTimeout(() => {
  console.error(`[glasses-client] timeout waiting for response requestId=${requestId}`);
  socket.close();
  process.exit(1);
}, TIMEOUT_MS);

socket.onopen = () => {
  const request = {
    type: 'capture.request',
    requestId,
    source: 'glasses-web',
    createdAt: new Date().toISOString(),
  };
  console.log(`[glasses-client] connected to ${URL}`);
  console.log(`[glasses-client] send type=capture.request requestId=${requestId}`);
  socket.send(JSON.stringify(request));
};

socket.onmessage = (event) => {
  let message;
  try {
    message = JSON.parse(String(event.data));
  } catch {
    console.log('[glasses-client] dropped invalid JSON frame');
    return;
  }

  const type = typeof message?.type === 'string' ? message.type : 'unknown';
  if (type !== 'capture.success' && type !== 'capture.error') {
    console.log(`[glasses-client] ignored type=${type}`);
    return;
  }

  if (message.requestId !== requestId) {
    console.log(`[glasses-client] ignored mismatched requestId=${message.requestId}`);
    return;
  }

  clearTimeout(timer);

  if (type === 'capture.error') {
    console.log(`[glasses-client] recv type=capture.error requestId=${requestId} code=${message.code}`);
    console.log('[glasses-client] result=error');
    socket.close();
    process.exit(0);
  }

  // capture.success — validate prefix only; never log the payload itself.
  const validPrefix =
    typeof message.image === 'string' &&
    message.image.startsWith(JPEG_PREFIX) &&
    message.image.length > JPEG_PREFIX.length;

  console.log(`[glasses-client] recv type=capture.success requestId=${requestId}`);
  console.log(`[glasses-client] payloadPrefixValid=${validPrefix}`);
  console.log(`[glasses-client] result=${validPrefix ? 'success' : 'invalid-payload'}`);
  socket.close();
  process.exit(validPrefix ? 0 : 1);
};

socket.onerror = () => {
  clearTimeout(timer);
  console.error(`[glasses-client] connection error (is the dev server running? npm run bridge:server)`);
  process.exit(1);
};
