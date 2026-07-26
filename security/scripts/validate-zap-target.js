#!/usr/bin/env node
'use strict';

/**
 * Validates ZAP_STAGING_URL against ZAP_ALLOWED_HOST.
 * Node built-ins only. Prints safe metadata. Exits nonzero on invalid config.
 *
 * Usage:
 *   node security/scripts/validate-zap-target.js <stagingUrl> <allowedHost>
 */

const { isIP } = require('node:net');

function fail(message) {
  console.error(`ZAP target validation failed: ${message}`);
  process.exit(1);
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

  // IPv4 private / link-local / loopback
  const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) {
    // Non-loopback IPv6 literals are rejected in Phase 1 for safety.
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

function main() {
  const stagingUrl = process.argv[2];
  const allowedHost = process.argv[3];

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
        fail(`staging URL must not include sensitive query parameter names`);
      }
    }
    // Phase 1: reject all query parameters unless explicitly needed later.
    fail('staging URL must not include query parameters in Phase 1');
  }

  const hostname = parsed.hostname.toLowerCase();
  const expected = allowedHost.toLowerCase();

  if (hostname !== expected) {
    fail('staging URL hostname does not exactly match ZAP_ALLOWED_HOST');
  }

  if (isPrivateOrBlockedHostname(hostname)) {
    fail('staging URL hostname is a blocked local, private, or metadata target');
  }

  // Safe metadata only — never print query strings or credentials.
  const safe = {
    ok: true,
    protocol: parsed.protocol,
    hostname,
    port: parsed.port || '443',
    pathname: parsed.pathname || '/',
    allowedHost: expected,
  };

  console.log(JSON.stringify(safe));
}

main();
