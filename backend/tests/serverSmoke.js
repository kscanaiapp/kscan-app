const http = require('http');
const express = require('express');

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

async function main() {
  const port = 3999;

  // Test 1: disabled by default
  {
    delete process.env.KSCAN_GLASSES_ANALYZE_ENABLED;
    delete process.env.KSCAN_GLASSES_ANALYZE_DEBUG_TOKEN;
    const app = buildApp();
    const server = app.listen(port);
    await new Promise((r) => setTimeout(r, 200));

    const res = await new Promise((resolve, reject) => {
      const data = JSON.stringify({ image: 'data:image/jpeg;base64,abc' });
      const req = http.request({
        hostname: '127.0.0.1', port, path: '/api/glasses/analyze-debug',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      }, (res) => {
        let chunks = '';
        res.on('data', (d) => { chunks += d; });
        res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(chunks) }); } catch { resolve({ status: res.statusCode, body: chunks }); } });
      });
      req.on('error', reject);
      req.write(data);
      req.end();
    });

    console.log('Test 1 - disabled by default:', res.body?.error?.code === 'CONFIG_DISABLED' ? 'PASS' : 'FAIL', res);
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

    const res = await new Promise((resolve, reject) => {
      const data = JSON.stringify({ image: 'data:image/jpeg;base64,abc' });
      const req = http.request({
        hostname: '127.0.0.1', port, path: '/api/glasses/analyze-debug',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      }, (res) => {
        let chunks = '';
        res.on('data', (d) => { chunks += d; });
        res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(chunks) }); } catch { resolve({ status: res.statusCode, body: chunks }); } });
      });
      req.on('error', reject);
      req.write(data);
      req.end();
    });

    console.log('Test 2 - enabled without token:', res.body?.error?.code === 'CONFIG_DISABLED' ? 'PASS' : 'FAIL', res);
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

    const res = await new Promise((resolve, reject) => {
      const data = JSON.stringify({});
      const req = http.request({
        hostname: '127.0.0.1', port, path: '/api/glasses/analyze-debug',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'Authorization': 'Bearer test-token' },
      }, (res) => {
        let chunks = '';
        res.on('data', (d) => { chunks += d; });
        res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(chunks) }); } catch { resolve({ status: res.statusCode, body: chunks }); } });
      });
      req.on('error', reject);
      req.write(data);
      req.end();
    });

    console.log('Test 3 - missing image:', res.body?.error?.code === 'MISSING_IMAGE' ? 'PASS' : 'FAIL', res);
    server.close();
    await new Promise((r) => setTimeout(r, 200));
  }

  // Test 4: invalid prefix
  {
    process.env.KSCAN_GLASSES_ANALYZE_ENABLED = 'true';
    process.env.KSCAN_GLASSES_ANALYZE_DEBUG_TOKEN = 'test-token';
    const app = buildApp();
    const server = app.listen(port);
    await new Promise((r) => setTimeout(r, 200));

    const res = await new Promise((resolve, reject) => {
      const data = JSON.stringify({ image: 'data:image/png;base64,abc' });
      const req = http.request({
        hostname: '127.0.0.1', port, path: '/api/glasses/analyze-debug',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'Authorization': 'Bearer test-token' },
      }, (res) => {
        let chunks = '';
        res.on('data', (d) => { chunks += d; });
        res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(chunks) }); } catch { resolve({ status: res.statusCode, body: chunks }); } });
      });
      req.on('error', reject);
      req.write(data);
      req.end();
    });

    console.log('Test 4 - invalid prefix:', res.body?.error?.code === 'INVALID_IMAGE' ? 'PASS' : 'FAIL', res);
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

    const res = await new Promise((resolve, reject) => {
      const data = JSON.stringify({ image: 'data:image/jpeg;base64,abc' });
      const req = http.request({
        hostname: '127.0.0.1', port, path: '/api/glasses/analyze-debug',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'Authorization': 'Bearer wrong' },
      }, (res) => {
        let chunks = '';
        res.on('data', (d) => { chunks += d; });
        res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(chunks) }); } catch { resolve({ status: res.statusCode, body: chunks }); } });
      });
      req.on('error', reject);
      req.write(data);
      req.end();
    });

    console.log('Test 5 - bad token:', res.body?.error?.code === 'UNAUTHORIZED' ? 'PASS' : 'FAIL', res);
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

    const res = await new Promise((resolve, reject) => {
      const data = JSON.stringify({ image: 'data:image/jpeg;base64,abc', requestId: 'smoke-1', client: 'google-glasses-alpha' });
      const req = http.request({
        hostname: '127.0.0.1', port, path: '/api/glasses/analyze-debug',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'Authorization': 'Bearer test-token' },
      }, (res) => {
        let chunks = '';
        res.on('data', (d) => { chunks += d; });
        res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(chunks) }); } catch { resolve({ status: res.statusCode, body: chunks }); } });
      });
      req.on('error', reject);
      req.write(data);
      req.end();
    });

    const ok = res.body?.ok === true && res.body?.result?.safeForHud === true && res.body?.meta?.model === 'mock-debug';
    console.log('Test 6 - valid mock request:', ok ? 'PASS' : 'FAIL', res);
    server.close();
    await new Promise((r) => setTimeout(r, 200));
  }

  // Test 7: no payload leakage
  {
    process.env.KSCAN_GLASSES_ANALYZE_ENABLED = 'true';
    process.env.KSCAN_GLASSES_ANALYZE_DEBUG_TOKEN = 'test-token';
    process.env.KSCAN_GLASSES_ANALYZE_MODEL = 'mock-debug';
    const app = buildApp();
    const server = app.listen(port);
    await new Promise((r) => setTimeout(r, 200));

    const res = await new Promise((resolve, reject) => {
      const data = JSON.stringify({ image: 'data:image/jpeg;base64,abc' });
      const req = http.request({
        hostname: '127.0.0.1', port, path: '/api/glasses/analyze-debug',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'Authorization': 'Bearer test-token' },
      }, (res) => {
        let chunks = '';
        res.on('data', (d) => { chunks += d; });
        res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(chunks) }); } catch { resolve({ status: res.statusCode, body: chunks }); } });
      });
      req.on('error', reject);
      req.write(data);
      req.end();
    });

    const json = JSON.stringify(res.body);
    const ok = res.body?.ok === true && !json.includes('base64') && !json.includes('data:image');
    console.log('Test 7 - no payload leakage:', ok ? 'PASS' : 'FAIL', res);
    server.close();
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log('\n=== Local Server Smoke Tests Complete ===');
}

main().catch((err) => {
  console.error('Smoke test error:', err.message);
  process.exit(1);
});
