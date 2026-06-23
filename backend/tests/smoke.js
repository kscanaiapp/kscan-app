const http = require('http');
const express = require('express');

// Build the app inline so we can start/stop it cleanly in tests
function buildApp() {
  const app = express();
  app.use(express.json({ limit: '8.5mb' }));

  const glassesRoute = require('../routes/glasses-analyze-debug');
  app.use(glassesRoute);

  app.get('/api/glasses/health', (_req, res) => {
    res.json({ ok: true, service: 'kscan-glasses-debug-backend' });
  });

  app.use((err, _req, res, _next) => {
    const { mapGlassesAnalyzeError } = require('../utils/mapGlassesAnalyzeError');
    const safe = mapGlassesAnalyzeError(err);
    res.status(safe.status).json(safe.body);
  });

  return app;
}

function request(port, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/api/glasses/analyze-debug',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...headers,
      },
    }, (res) => {
      let chunks = '';
      res.on('data', (d) => { chunks += d; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(chunks) });
        } catch {
          resolve({ status: res.statusCode, body: chunks });
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  const results = [];
  const port = 3005;

  // Test 1: disabled by default
  {
    delete process.env.KSCAN_GLASSES_ANALYZE_ENABLED;
    delete process.env.KSCAN_GLASSES_ANALYZE_DEBUG_TOKEN;
    const app = buildApp();
    const server = app.listen(port);
    await new Promise((r) => setTimeout(r, 200));
    const res = await request(port, { image: 'data:image/jpeg;base64,abc' });
    results.push({ name: 'disabled by default', status: res.body?.error?.code === 'CONFIG_DISABLED' ? 'PASS' : 'FAIL', res });
    server.close();
    await new Promise((r) => setTimeout(r, 200));
  }

  // Test 2: enabled without token
  {
    process.env.KSCAN_GLASSES_ANALYZE_ENABLED = 'true';
    delete process.env.KSCAN_GLASSES_ANALYZE_DEBUG_TOKEN;
    const app = buildApp();
    const server = app.listen(port);
    await new Promise((r) => setTimeout(r, 200));
    const res = await request(port, { image: 'data:image/jpeg;base64,abc' });
    results.push({ name: 'enabled without token', status: res.body?.error?.code === 'CONFIG_DISABLED' ? 'PASS' : 'FAIL', res });
    server.close();
    await new Promise((r) => setTimeout(r, 200));
  }

  // Test 3: missing image
  {
    process.env.KSCAN_GLASSES_ANALYZE_ENABLED = 'true';
    process.env.KSCAN_GLASSES_ANALYZE_DEBUG_TOKEN = 'test-token';
    const app = buildApp();
    const server = app.listen(port);
    await new Promise((r) => setTimeout(r, 200));
    const res = await request(port, {}, { Authorization: 'Bearer test-token' });
    results.push({ name: 'missing image', status: res.body?.error?.code === 'MISSING_IMAGE' ? 'PASS' : 'FAIL', res });
    server.close();
    await new Promise((r) => setTimeout(r, 200));
  }

  // Test 4: invalid image prefix
  {
    process.env.KSCAN_GLASSES_ANALYZE_ENABLED = 'true';
    process.env.KSCAN_GLASSES_ANALYZE_DEBUG_TOKEN = 'test-token';
    const app = buildApp();
    const server = app.listen(port);
    await new Promise((r) => setTimeout(r, 200));
    const res = await request(port, { image: 'data:image/png;base64,abc' }, { Authorization: 'Bearer test-token' });
    results.push({ name: 'invalid image prefix', status: res.body?.error?.code === 'INVALID_IMAGE' ? 'PASS' : 'FAIL', res });
    server.close();
    await new Promise((r) => setTimeout(r, 200));
  }

  // Test 5: bad token
  {
    process.env.KSCAN_GLASSES_ANALYZE_ENABLED = 'true';
    process.env.KSCAN_GLASSES_ANALYZE_DEBUG_TOKEN = 'test-token';
    const app = buildApp();
    const server = app.listen(port);
    await new Promise((r) => setTimeout(r, 200));
    const res = await request(port, { image: 'data:image/jpeg;base64,abc' }, { Authorization: 'Bearer wrong' });
    results.push({ name: 'bad token', status: res.body?.error?.code === 'UNAUTHORIZED' ? 'PASS' : 'FAIL', res });
    server.close();
    await new Promise((r) => setTimeout(r, 200));
  }

  // Test 6: valid mock request
  {
    process.env.KSCAN_GLASSES_ANALYZE_ENABLED = 'true';
    process.env.KSCAN_GLASSES_ANALYZE_DEBUG_TOKEN = 'test-token';
    process.env.KSCAN_GLASSES_ANALYZE_MODEL = 'mock-debug';
    const app = buildApp();
    const server = app.listen(port);
    await new Promise((r) => setTimeout(r, 200));
    const res = await request(port, { image: 'data:image/jpeg;base64,abc', requestId: 'smoke-1', client: 'google-glasses-alpha' }, { Authorization: 'Bearer test-token' });
    const ok = res.body?.ok === true && res.body?.result?.safeForHud === true && res.body?.meta?.model === 'mock-debug';
    results.push({ name: 'valid mock request', status: ok ? 'PASS' : 'FAIL', res });
    server.close();
    await new Promise((r) => setTimeout(r, 200));
  }

  // Test 7: response never contains base64 or data:image
  {
    process.env.KSCAN_GLASSES_ANALYZE_ENABLED = 'true';
    process.env.KSCAN_GLASSES_ANALYZE_DEBUG_TOKEN = 'test-token';
    process.env.KSCAN_GLASSES_ANALYZE_MODEL = 'mock-debug';
    const app = buildApp();
    const server = app.listen(port);
    await new Promise((r) => setTimeout(r, 200));
    const res = await request(port, { image: 'data:image/jpeg;base64,abc' }, { Authorization: 'Bearer test-token' });
    const json = JSON.stringify(res.body);
    const ok = res.body?.ok === true && !json.includes('base64') && !json.includes('data:image');
    results.push({ name: 'no payload leakage', status: ok ? 'PASS' : 'FAIL', res });
    server.close();
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log('\n=== Smoke Test Results ===');
  for (const r of results) {
    console.log(`${r.status}: ${r.name}`);
  }
  const allPass = results.every((r) => r.status === 'PASS');
  console.log(allPass ? '\nAll smoke tests passed.' : '\nSome smoke tests failed.');
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error('Smoke test error:', err.message);
  process.exit(1);
});
