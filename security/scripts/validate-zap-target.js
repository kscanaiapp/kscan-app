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
const fs = require('node:fs');
const path = require('node:path');

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

  // The baseline scanner must use the URL validated by the same-host health
  // preflight, not the Supabase project root (HTTP 404). This regression
  // control keeps the passive scanner operational without relaxing findings.
  const baselineWorkflow = fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/zap-baseline-staging.yml'), 'utf8');
  const correctScanTarget =
    baselineWorkflow.includes('ZAP_SCAN_URL: \u0024{{ steps.validate_target.outputs.health_url }}') &&
    baselineWorkflow.includes('-t "\u0024{ZAP_SCAN_URL}"') &&
    !baselineWorkflow.includes('-t "\u0024{ZAP_STAGING_URL}"');
  if (correctScanTarget) {
    console.log('PASS ZAP baseline scans the validated staging health endpoint');
  } else {
    console.error('FAIL ZAP baseline must scan the validated staging health endpoint');
    failed += 1;
  }

  const retryViolations = zapRetryContractViolations(baselineWorkflow);
  if (retryViolations.length === 0) {
    console.log('PASS ZAP baseline retries only an operational (no-report) failure, once, and still fails closed');
  } else {
    for (const violation of retryViolations) console.error(`FAIL ZAP retry contract: ${violation}`);
    failed += 1;
  }

  process.exit(failed > 0 ? 1 : 0);
}

/**
 * The scanner container occasionally dies before writing any report. The workflow therefore tries a
 * fresh container ONCE, and only when no JSON report exists. This contract keeps that retry from ever
 * becoming a way to shop for a passing scan or to hide a missing report:
 *   - exactly one bounded retry (MAX_ATTEMPTS=2) and exactly one `docker run`;
 *   - the loop leaves on "a report exists OR attempts are exhausted" -- never on exit status;
 *   - stale reports are removed before every attempt, so an old file cannot satisfy the check;
 *   - a missing report after the last attempt still prints the operational failure and exits 2;
 *   - the report is still parsed as JSON, and nothing swallows a failure (`|| true`, continue-on-error).
 * Returns a list of violations (empty = compliant).
 */
function zapRetryContractViolations(workflowText) {
  const violations = [];
  const text = String(workflowText);
  const count = (needle) => text.split(needle).length - 1;
  if (count('MAX_ATTEMPTS=2') !== 1) violations.push('MAX_ATTEMPTS must be set exactly once, to 2 (one bounded retry)');
  if (count('docker run') !== 1) violations.push('there must be exactly one docker run (inside the bounded loop)');
  const leave = 'if [ -f zap-out/zap-baseline-report.json ] || [ "$' + '{ATTEMPT}" -ge "$' + '{MAX_ATTEMPTS}" ]; then';
  if (count(leave) !== 1) violations.push('the loop must leave only when a report exists or attempts are exhausted');
  const removeAt = text.indexOf('rm -f zap-out/zap-baseline-report.json');
  const dockerAt = text.indexOf('docker run');
  if (removeAt < 0 || dockerAt < 0 || removeAt > dockerAt) violations.push('stale reports must be removed before every docker run');
  if (!/Operational failure: zap-baseline-report\.json missing"\s*\n\s*exit 2/.test(text)) violations.push('a missing report after the last attempt must still fail closed with exit 2');
  // Bound to the scan step: the parse must sit immediately before its "valid JSON" confirmation, so the
  // later summary step's separate json.load cannot satisfy this check.
  if (!/json\.load\(open\("zap-out\/zap-baseline-report\.json"[^\n]*\)\n\s*print\("zap-baseline-report\.json: valid JSON"\)/.test(text)) {
    violations.push('the report must still be parsed as JSON before it is accepted');
  }
  if (text.includes('|| true') || /continue-on-error:\s*true/.test(text)) violations.push('nothing may swallow a failure');
  return violations;
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
  zapRetryContractViolations,
  validateTarget,
  deriveHealthCheckUrl,
  isAcceptableHealthStatus,
  isProductionHost,
  isPrivateOrBlockedHostname,
  PRODUCTION_PROJECT_REF,
  STAGING_PROJECT_REF,
};
