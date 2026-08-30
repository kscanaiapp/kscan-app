#!/usr/bin/env node
'use strict';

/**
 * Validates ZAP_STAGING_URL against ZAP_ALLOWED_HOST.
 * Node built-ins only. Prints safe metadata. Exits nonzero on invalid config.
 *
 * Usage:
 *   node security/scripts/validate-zap-target.js <stagingUrl> <allowedHost>
 *   node security/scripts/validate-zap-target.js --self-test
 */

const { isIP } = require('node:net');

const PRODUCTION_PROJECT_REF = 'wyyuqfdxucjksghsmhry';
const STAGING_PROJECT_REF = 'yzqjvdfgefveprobvvyw';

function fail(message) {
  const err = new Error(message);
  err.name = 'ZapTargetValidationError';
  throw err;
}

function isPrivateOrBlockedHostname(hostname) {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0') {
    return true;
  }

  if (host === 'metadata.google.internal' || host === 'metadata' || host.endsWith('.internal')) {
    return true;
  }

  if (!isIP(host)) {
    return false;
  }

  if (host === '::1' || host === '169.254.169.254') {
    return true;
  }

  const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) {
    return true;
  }

  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

function isProductionHost(hostname) {
  const host = hostname.toLowerCase();
  if (host === `${PRODUCTION_PROJECT_REF}.supabase.co`) return true;
  if (host.includes(PRODUCTION_PROJECT_REF)) return true;
  return false;
}

function validateTarget(stagingUrl, allowedHost) {
  if (!stagingUrl || !allowedHost) {
    fail('both staging URL and allowed host are required');
  }

  if (/\s/.test(stagingUrl) || /\s/.test(allowedHost)) {
    fail('URL and allowed host must not contain whitespace');
  }

  let parsed;
  try {
    parsed = new URL(stagingUrl);
  } catch {
    fail('staging URL is not a valid absolute URL');
  }

  if (parsed.protocol !== 'https:') {
    fail('staging URL must use https');
  }

  if (!parsed.hostname) {
    fail('staging URL hostname is empty');
  }

  if (parsed.username || parsed.password) {
    fail('staging URL must not include embedded credentials');
  }

  if (parsed.hash) {
    fail('staging URL must not include a fragment');
  }

  if (parsed.search) {
    const params = parsed.searchParams;
    const blocked = ['access_token', 'refresh_token', 'authorization', 'session_token', 'companion_token', 'pairing_secret', 'token', 'key', 'secret'];
    for (const name of blocked) {
      if (params.has(name)) {
        fail('staging URL must not include sensitive query parameter names');
      }
    }
    fail('staging URL must not include query parameters');
  }

  const hostname = parsed.hostname.toLowerCase();
  const expected = allowedHost.toLowerCase();

  if (hostname !== expected) {
    fail('staging URL hostname does not exactly match ZAP_ALLOWED_HOST');
  }

  if (isProductionHost(hostname)) {
    fail('staging URL must not target the production Supabase project host');
  }

  if (isPrivateOrBlockedHostname(hostname)) {
    fail('staging URL hostname is a blocked local, private, or metadata target');
  }

  return {
    ok: true,
    protocol: parsed.protocol,
    hostname,
    port: parsed.port || '443',
    pathname: parsed.pathname || '/',
    allowedHost: expected,
    stagingProjectRef: hostname.endsWith('.supabase.co')
      ? hostname.replace('.supabase.co', '')
      : null,
  };
}

function deriveHealthCheckUrl(stagingUrl) {
  const meta = validateTarget(stagingUrl, new URL(stagingUrl).hostname);
  const base = stagingUrl.replace(/\/+$/, '');
  if (meta.pathname === '/' || meta.pathname === '') {
    return `${base}/auth/v1/health`;
  }
  return stagingUrl;
}

function isAcceptableHealthStatus(statusCode) {
  const code = Number(statusCode);
  if (Number.isNaN(code)) return false;
  // Keep codes narrow: 404/405 must not be treated as healthy globally.
  if (code >= 200 && code < 400) return true;
  if (code === 401 || code === 403) return true;
  return false;
}

function runSelfTest() {
  const cases = [
    {
      name: 'valid staging target',
      url: `https://${STAGING_PROJECT_REF}.supabase.co`,
      host: `${STAGING_PROJECT_REF}.supabase.co`,
      ok: true,
    },
    {
      name: 'production host rejection',
      url: `https://${PRODUCTION_PROJECT_REF}.supabase.co`,
      host: `${PRODUCTION_PROJECT_REF}.supabase.co`,
      ok: false,
    },
    {
      name: 'localhost rejection',
      url: 'https://localhost/',
      host: 'localhost',
      ok: false,
    },
    {
      name: 'private IP rejection',
      url: 'https://10.0.0.5/',
      host: '10.0.0.5',
      ok: false,
    },
    {
      name: 'hostname mismatch',
      url: `https://${STAGING_PROJECT_REF}.supabase.co`,
      host: 'other.example.com',
      ok: false,
    },
    {
      name: 'non-HTTPS rejection',
      url: `http://${STAGING_PROJECT_REF}.supabase.co`,
      host: `${STAGING_PROJECT_REF}.supabase.co`,
      ok: false,
    },
    {
      name: 'malformed URL rejection',
      url: 'not-a-url',
      host: `${STAGING_PROJECT_REF}.supabase.co`,
      ok: false,
    },
  ];

  let failed = 0;
  for (const testCase of cases) {
    try {
      validateTarget(testCase.url, testCase.host);
      if (!testCase.ok) {
        console.error(`FAIL ${testCase.name}: expected rejection`);
        failed += 1;
      } else {
        console.log(`PASS ${testCase.name}`);
      }
    } catch (err) {
      if (testCase.ok) {
        console.error(`FAIL ${testCase.name}: ${err.message}`);
        failed += 1;
      } else {
        console.log(`PASS ${testCase.name}`);
      }
    }
  }

  const healthCases = [200, 301, 401, 403, 404, 405, 500, 502];
  for (const code of healthCases) {
    const ok = isAcceptableHealthStatus(code);
    const expected = [200, 301, 401, 403].includes(code);
    if (ok !== expected) {
      console.error(`FAIL health status ${code}: expected ${expected}, got ${ok}`);
      failed += 1;
    } else {
      console.log(`PASS health status ${code}`);
    }
  }

  const derived = deriveHealthCheckUrl(`https://${STAGING_PROJECT_REF}.supabase.co`);
  if (derived !== `https://${STAGING_PROJECT_REF}.supabase.co/auth/v1/health`) {
    console.error(`FAIL derive health URL: ${derived}`);
    failed += 1;
  } else {
    console.log('PASS derive /auth/v1/health for Supabase root');
  }

  process.exit(failed > 0 ? 1 : 0);
}

function main() {
  if (process.argv[2] === '--self-test') {
    runSelfTest();
    return;
  }

  try {
    const result = validateTarget(process.argv[2], process.argv[3]);
    console.log(JSON.stringify(result));
  } catch (err) {
    console.error(`ZAP target validation failed: ${err.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  validateTarget,
  deriveHealthCheckUrl,
  isAcceptableHealthStatus,
  isProductionHost,
  isPrivateOrBlockedHostname,
  PRODUCTION_PROJECT_REF,
  STAGING_PROJECT_REF,
};
