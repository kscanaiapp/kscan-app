const test = require('node:test');
const assert = require('node:assert/strict');

const { DatTransportAdapter } = require('../services/bridge/DatTransportAdapter.ts');
const { BluetoothTransportAdapter } = require('../services/bridge/BluetoothTransportAdapter.ts');
const { MockLoopbackTransport } = require('../services/bridge/MockLoopbackTransport.ts');
const { WifiDevTransport } = require('../services/bridge/WifiDevTransport.ts');
const { isBridgeDebugEnabled } = require('../services/bridge/bridgeDebugGate.ts');
const { getBridgePermissionStatus } = require('../services/bridge/BridgePermissionStatus.ts');
const { isBridgeMessage } = require('../services/bridge/bridgeTypes.ts');

test('DAT adapter reports blocked status and DAT_NOT_CONFIGURED', async () => {
  const adapter = new DatTransportAdapter();
  assert.equal(adapter.kind, 'dat');
  assert.equal(adapter.blockedCode, 'DAT_NOT_CONFIGURED');
  assert.equal(adapter.getStatus().connectionState, 'blocked');
  await assert.rejects(adapter.connect(), /DAT_NOT_CONFIGURED/);
  await assert.rejects(
    adapter.send({ type: 'capture.request', requestId: 'x', source: 'glasses-web', createdAt: '' }),
    /DAT_NOT_CONFIGURED/
  );
});

test('Bluetooth adapter reports blocked status and BLUETOOTH_NOT_CONFIGURED', async () => {
  const adapter = new BluetoothTransportAdapter();
  assert.equal(adapter.kind, 'bluetooth');
  assert.equal(adapter.blockedCode, 'BLUETOOTH_NOT_CONFIGURED');
  assert.equal(adapter.getStatus().connectionState, 'blocked');
  await assert.rejects(adapter.connect(), /BLUETOOTH_NOT_CONFIGURED/);
});

test('mock loopback transport sends and receives messages', async () => {
  const transport = new MockLoopbackTransport();
  await transport.connect();

  const received = [];
  const unsubscribe = transport.onMessage((message) => received.push(message));

  const outbound = {
    type: 'capture.error',
    requestId: 'req-1',
    code: 'CAPTURE_CANCELLED',
    message: 'test',
    createdAt: new Date().toISOString(),
  };
  await transport.send(outbound);
  assert.deepEqual(transport.sentMessages, [outbound]);

  const inbound = {
    type: 'capture.request',
    requestId: 'req-2',
    source: 'glasses-web',
    createdAt: new Date().toISOString(),
  };
  transport.emitIncoming(inbound);
  assert.deepEqual(received, [inbound]);

  unsubscribe();
  transport.emitIncoming(inbound);
  assert.equal(received.length, 1);

  await transport.disconnect();
  await assert.rejects(transport.send(outbound), /not connected/);
});

test('wifi dev transport parses valid JSON frames and drops invalid ones', async () => {
  let fakeSocket;
  const factory = () => {
    fakeSocket = {
      readyState: 0,
      sent: [],
      send(data) {
        this.sent.push(data);
      },
      close() {},
      onopen: null,
      onclose: null,
      onerror: null,
      onmessage: null,
    };
    // Open asynchronously like a real socket.
    setTimeout(() => fakeSocket.onopen && fakeSocket.onopen({}), 0);
    return fakeSocket;
  };

  const transport = new WifiDevTransport({ webSocketFactory: factory });
  await transport.connect();
  assert.equal(transport.getStatus().connectionState, 'connected');

  const received = [];
  transport.onMessage((message) => received.push(message));

  fakeSocket.onmessage({ data: 'not json at all {' });
  fakeSocket.onmessage({ data: JSON.stringify({ type: 'unrelated', requestId: 'x' }) });
  fakeSocket.onmessage({
    data: JSON.stringify({
      type: 'capture.request',
      requestId: 'req-9',
      source: 'glasses-web',
      createdAt: new Date().toISOString(),
    }),
  });

  assert.equal(received.length, 1);
  assert.equal(received[0].requestId, 'req-9');
  assert.ok(isBridgeMessage(received[0]));

  await transport.send({
    type: 'capture.error',
    requestId: 'req-9',
    code: 'CAPTURE_CANCELLED',
    message: 'test',
    createdAt: new Date().toISOString(),
  });
  assert.equal(fakeSocket.sent.length, 1);

  await transport.disconnect();
  assert.equal(transport.getStatus().connectionState, 'disconnected');
});

test('debug gate is closed for production builds without the env flag', () => {
  assert.equal(isBridgeDebugEnabled({ isDev: false, envFlag: undefined }), false);
  assert.equal(isBridgeDebugEnabled({ isDev: false, envFlag: 'false' }), false);
  assert.equal(isBridgeDebugEnabled({ isDev: false, envFlag: '1' }), false);
});

test('debug gate opens for dev builds or the explicit env flag', () => {
  assert.equal(isBridgeDebugEnabled({ isDev: true, envFlag: undefined }), true);
  assert.equal(isBridgeDebugEnabled({ isDev: false, envFlag: 'true' }), true);
});

test('permission status is query-only and conservative', async () => {
  const android = await getBridgePermissionStatus('android');
  assert.equal(android.datPermission, 'not-configured');
  assert.equal(android.bluetoothPermission, 'not-configured');
  assert.equal(android.localNetworkPermission, 'not-required');
  assert.equal(android.microphonePermission, 'not-required');

  const ios = await getBridgePermissionStatus('ios');
  assert.equal(ios.localNetworkPermission, 'unknown');

  const unknownPlatform = await getBridgePermissionStatus();
  assert.equal(unknownPlatform.localNetworkPermission, 'unknown');
});
