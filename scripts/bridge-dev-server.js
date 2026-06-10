#!/usr/bin/env node
/**
 * K Scan bridge dev server (Phase 16 alpha). NODE-ONLY DEV TOOLING.
 *
 * Starts a local WebSocket server on port 8787 that speaks the K Scan
 * app-level bridge contract (see services/bridge/bridgeTypes.ts). It lets
 * the mobile app's WifiDevTransport and the simulate-glasses-client script
 * exercise the bridge without glasses hardware.
 *
 * This file uses the `ws` devDependency and must NEVER be imported by
 * mobile app code (nothing under app/, components/, or services/ may
 * require it — Metro must not bundle `ws`).
 *
 * Modes (env var BRIDGE_DEV_MODE):
 *   success          -> reply to capture.request with capture.success
 *                       using the safe deterministic 1x1 JPEG fixture
 *   dat-blocked      -> reply with capture.error DAT_NOT_CONFIGURED
 *   invalid-payload  -> reply with a deliberately invalid payload so the
 *                       app's INVALID_CAPTURE_RESPONSE path can be tested
 *
 * Logging policy: message type, requestId, status, and error codes only.
 * Never logs base64 (full or partial), byte lengths, dimensions, EXIF, or
 * any image-derived metadata. No real photos, no backend upload, no disk
 * writes of image data.
 */

const { WebSocketServer } = require('ws');

const PORT = Number(process.env.BRIDGE_DEV_PORT || 8787);
const MODE = process.env.BRIDGE_DEV_MODE || 'success';
const VALID_MODES = ['success', 'dat-blocked', 'invalid-payload'];

// Same deterministic 1x1 JPEG fixture as services/bridge/devCaptureProvider.ts.
const TINY_JPEG_DATA_URL =
  'data:image/jpeg;base64,' +
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof' +
  'Hh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAAB' +
  'AAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAAEAAD8AVN//2Q==';

if (!VALID_MODES.includes(MODE)) {
  console.error(`[bridge-dev-server] invalid BRIDGE_DEV_MODE "${MODE}" (use: ${VALID_MODES.join(', ')})`);
  process.exit(1);
}

function buildResponse(requestId) {
  const createdAt = new Date().toISOString();
  if (MODE === 'dat-blocked') {
    return {
      type: 'capture.error',
      requestId,
      code: 'DAT_NOT_CONFIGURED',
      message: 'Dev server is simulating a blocked DAT capture path',
      createdAt,
    };
  }
  if (MODE === 'invalid-payload') {
    return {
      type: 'capture.success',
      requestId,
      image: 'not-a-data-url',
      mime: 'image/jpeg',
      encoding: 'data-url',
      createdAt,
    };
  }
  return {
    type: 'capture.success',
    requestId,
    image: TINY_JPEG_DATA_URL,
    mime: 'image/jpeg',
    encoding: 'data-url',
    createdAt,
  };
}

const server = new WebSocketServer({ port: PORT });

server.on('listening', () => {
  console.log(`[bridge-dev-server] listening on ws://localhost:${PORT} mode=${MODE}`);
});

server.on('connection', (socket) => {
  console.log('[bridge-dev-server] client connected');

  socket.on('message', (data) => {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      console.log('[bridge-dev-server] dropped invalid JSON frame');
      return;
    }

    const type = typeof message?.type === 'string' ? message.type : 'unknown';
    const requestId = typeof message?.requestId === 'string' ? message.requestId : 'unknown';
    console.log(`[bridge-dev-server] recv type=${type} requestId=${requestId}`);

    if (type === 'capture.request') {
      const response = buildResponse(requestId);
      socket.send(JSON.stringify(response));
      const codeNote = response.type === 'capture.error' ? ` code=${response.code}` : '';
      console.log(`[bridge-dev-server] sent type=${response.type} requestId=${requestId}${codeNote}`);
      return;
    }

    if (type === 'capture.success' || type === 'capture.error') {
      // App replied to a glasses-originated request; just acknowledge in logs.
      const codeNote = type === 'capture.error' ? ` code=${message.code}` : '';
      console.log(`[bridge-dev-server] noted app response type=${type} requestId=${requestId}${codeNote}`);
      return;
    }

    console.log(`[bridge-dev-server] ignored unsupported type=${type}`);
  });

  socket.on('close', () => {
    console.log('[bridge-dev-server] client disconnected');
  });
});

server.on('error', (error) => {
  console.error(`[bridge-dev-server] server error: ${error.message}`);
  process.exitCode = 1;
});
