const test = require('node:test');
const assert = require('node:assert/strict');

const { BridgeService } = require('../services/bridge/BridgeService.ts');
const { MockLoopbackTransport } = require('../services/bridge/MockLoopbackTransport.ts');
const { bridgeFixtures } = require('../services/bridge/bridgeFixtures.ts');
const { DEV_CAPTURE_FIXTURE_DATA_URL } = require('../services/bridge/devCaptureProvider.ts');

function createService(overrides = {}) {
  const transport = new MockLoopbackTransport();
  const service = new BridgeService({ transport, ...overrides });
  return { service, transport };
}

test('startDevBridge moves idle -> ready and stopBridge -> stopped', async () => {
  const { service } = createService();
  assert.equal(service.getStatus().bridgeState, 'idle');
  await service.startDevBridge();
  assert.equal(service.getStatus().bridgeState, 'ready');
  await service.stopBridge();
  assert.equal(service.getStatus().bridgeState, 'stopped');
});

test('simulateGlassesCaptureRequest returns a safe capture.success', async () => {
  const { service } = createService();
  await service.startDevBridge();
  const response = await service.simulateGlassesCaptureRequest();
  assert.equal(response.type, 'capture.success');
  assert.equal(response.mime, 'image/jpeg');
  assert.equal(response.encoding, 'data-url');
  assert.equal(response.image, DEV_CAPTURE_FIXTURE_DATA_URL);
  assert.equal(service.getStatus().bridgeState, 'ready');
  await service.stopBridge();
});

test('status never includes the image payload', async () => {
  const { service } = createService();
  await service.startDevBridge();
  await service.simulateGlassesCaptureRequest();
  const serialized = JSON.stringify(service.getStatus());
  assert.ok(!serialized.includes('base64'));
  assert.ok(!serialized.includes(DEV_CAPTURE_FIXTURE_DATA_URL.slice(-24)));
  await service.stopBridge();
});

test('invalid dev provider payload yields capture.error INVALID_CAPTURE_RESPONSE', async () => {
  const badProvider = {
    name: 'bad-provider',
    capture: async () => bridgeFixtures.rawBase64WithoutPrefix,
  };
  const { service } = createService({ captureProvider: badProvider });
  await service.startDevBridge();
  const response = await service.simulateGlassesCaptureRequest();
  assert.equal(response.type, 'capture.error');
  assert.equal(response.code, 'INVALID_CAPTURE_RESPONSE');
  assert.equal(service.getStatus().lastErrorCode, 'INVALID_CAPTURE_RESPONSE');
  await service.stopBridge();
});

test('incoming capture.request over the transport gets a capture.success reply', async () => {
  const { service, transport } = createService();
  await service.startDevBridge();

  transport.emitIncoming({
    type: 'capture.request',
    requestId: 'glasses-req-1',
    source: 'glasses-web',
    createdAt: new Date().toISOString(),
  });

  // The capture provider resolves on a microtask; give it a tick.
  await new Promise((resolve) => setTimeout(resolve, 20));

  const reply = transport.sentMessages.find((m) => m.requestId === 'glasses-req-1');
  assert.ok(reply, 'expected a reply on the transport');
  assert.equal(reply.type, 'capture.success');
  assert.equal(reply.image, DEV_CAPTURE_FIXTURE_DATA_URL);
  await service.stopBridge();
});

test('subscribe receives status updates and unsubscribe stops them', async () => {
  const { service } = createService();
  const seenStates = [];
  const unsubscribe = service.subscribe((status) => seenStates.push(status.bridgeState));
  await service.startDevBridge();
  assert.ok(seenStates.includes('starting'));
  assert.ok(seenStates.includes('ready'));
  unsubscribe();
  const countAfterUnsubscribe = seenStates.length;
  await service.stopBridge();
  assert.equal(seenStates.length, countAfterUnsubscribe);
});

test('status reports DAT and Bluetooth as blocked', () => {
  const { service } = createService();
  const status = service.getStatus();
  assert.equal(status.datStatus.connectionState, 'blocked');
  assert.equal(status.bluetoothStatus.connectionState, 'blocked');
});

test('refreshPermissions uses the injected query-only provider', async () => {
  const permissions = {
    datPermission: 'not-configured',
    bluetoothPermission: 'not-configured',
    localNetworkPermission: 'not-required',
    microphonePermission: 'not-required',
    checkedAt: new Date().toISOString(),
  };
  const { service } = createService({ getPermissionStatus: async () => permissions });
  assert.equal(service.getStatus().permissionStatus, null);
  await service.refreshPermissions();
  assert.deepEqual(service.getStatus().permissionStatus, permissions);
});
