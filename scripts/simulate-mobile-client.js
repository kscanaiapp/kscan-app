#!/usr/bin/env node
/**
 * K Scan simulate-mobile-client (Phase 17). NODE-ONLY DEV TOOLING.
 *
 * Acts as the MOBILE peer in relay-mode end-to-end dev testing. Connects to
 * the bridge dev server (default ws://localhost:8787, run with
 * BRIDGE_DEV_MODE=relay), waits for `capture.request` messages relayed from
 * the glasses web app, and replies with `capture.success` carrying the SAME
 * safe dev JPEG fixture used by the mobile bridge alpha (no new fixture is
 * created here). Uses Node's built-in WebSocket global (Node >= 22).
 *
 * Logging policy: message type, requestId, status, and error code only.
 * Never logs image payload (full or partial base64), byte length,
 * dimensions, EXIF, or any image-derived metadata.
 *
 * This is dev tooling. It is never bundled into the mobile app and never
 * uploads, persists, or writes image data to disk.
 */

const URL = process.env.BRIDGE_DEV_URL || 'ws://localhost:8787';

// SAME deterministic 1x1 JPEG fixture as services/bridge/devCaptureProvider.ts
// and scripts/bridge-dev-server.js. Not a new image — the existing dev fixture.
const TINY_JPEG_DATA_URL =
  'data:image/jpeg;base64,' +
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof' +
  'Hh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAAB' +
  'AAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAAEAAD8AVN//2Q==';

if (typeof WebSocket !== 'function') {
  console.error('[mobile-client] this script requires Node >= 22 (built-in WebSocket)');
  process.exit(1);
}

const socket = new WebSocket(URL);

socket.onopen = () => {
  console.log(`[mobile-client] connected to ${URL}; waiting for capture.request`);
};

socket.onmessage = (event) => {
  let message;
  try {
    message = JSON.parse(String(event.data));
  } catch {
    console.log('[mobile-client] dropped invalid JSON frame');
    return;
  }

  const type = typeof message?.type === 'string' ? message.type : 'unknown';
  const requestId = typeof message?.requestId === 'string' ? message.requestId : 'unknown';

  if (type !== 'capture.request') {
    console.log(`[mobile-client] ignored type=${type} requestId=${requestId}`);
    return;
  }

  console.log(`[mobile-client] recv type=capture.request requestId=${requestId}`);

  const response = {
    type: 'capture.success',
    requestId,
    image: TINY_JPEG_DATA_URL,
    mime: 'image/jpeg',
    encoding: 'data-url',
    createdAt: new Date().toISOString(),
  };
  socket.send(JSON.stringify(response));
  console.log(`[mobile-client] sent type=capture.success requestId=${requestId} status=ok`);
};

socket.onerror = () => {
  console.error('[mobile-client] connection error (is the relay server running? BRIDGE_DEV_MODE=relay npm run bridge:server)');
  process.exitCode = 1;
};

socket.onclose = () => {
  console.log('[mobile-client] disconnected');
};
