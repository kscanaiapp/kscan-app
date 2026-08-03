'use strict';

const crypto = require('crypto');

const VERDICTS = Object.freeze({
  PENDING: 'PENDING',
  CLEAN: 'CLEAN',
  REJECTED_TYPE: 'REJECTED_TYPE',
  REJECTED_SIZE: 'REJECTED_SIZE',
  REJECTED_DIMENSIONS: 'REJECTED_DIMENSIONS',
  REJECTED_MALWARE: 'REJECTED_MALWARE',
  REJECTED_MALFORMED: 'REJECTED_MALFORMED',
  SCANNER_UNAVAILABLE: 'SCANNER_UNAVAILABLE',
  SCAN_TIMEOUT: 'SCAN_TIMEOUT',
  REENCODE_FAILED: 'REENCODE_FAILED',
});

// Required operational behavior: never expose malware family names, scanner
// implementation, signature details, internal bucket paths, provider names,
// security thresholds, or stack traces. Every verdict code maps to one of
// exactly five simple, generic user-facing strings.
const USER_FACING_MESSAGES = Object.freeze({
  REJECTED_TYPE: 'This image format is not supported.',
  REJECTED_SIZE: 'This image is too large.',
  REJECTED_DIMENSIONS: 'This image is too large.',
  REJECTED_MALWARE: 'This image was rejected for safety reasons.',
  REJECTED_MALFORMED: 'This image could not be processed.',
  SCANNER_UNAVAILABLE: 'The scanning service is temporarily unavailable. Please try again shortly.',
  SCAN_TIMEOUT: 'The scanning service is temporarily unavailable. Please try again shortly.',
  REENCODE_FAILED: 'This image could not be processed.',
});

function userFacingMessage(verdictCode) {
  return USER_FACING_MESSAGES[verdictCode] || 'This image could not be processed.';
}

// Non-forgeable, ephemeral verdict token for in-process (non-DB-backed) call
// sites -- e.g. server.js's /api/analyze, where the image is never persisted
// so there is no row to attach a verdict to. HMAC-signed with a server-only
// secret; base64url(JSON payload) + "." + hex HMAC. Any tampering with the
// payload invalidates the MAC. `verify()` also enforces expiry.
function sign(payload, secret) {
  if (!secret) throw new Error('verdict.sign requires a non-empty secret');
  const json = JSON.stringify(payload);
  const mac = crypto.createHmac('sha256', secret).update(json).digest('hex');
  return `${Buffer.from(json, 'utf8').toString('base64url')}.${mac}`;
}

function verify(token, secret) {
  if (!secret) return { ok: false, reason: 'no_secret_configured' };
  if (typeof token !== 'string' || !token.includes('.')) {
    return { ok: false, reason: 'malformed_token' };
  }
  const separatorIndex = token.lastIndexOf('.');
  const payloadB64 = token.slice(0, separatorIndex);
  const mac = token.slice(separatorIndex + 1);

  let json;
  try {
    json = Buffer.from(payloadB64, 'base64url').toString('utf8');
  } catch (err) {
    return { ok: false, reason: 'malformed_token' };
  }

  const expectedMac = crypto.createHmac('sha256', secret).update(json).digest('hex');
  const macBuf = Buffer.from(mac, 'hex');
  const expectedBuf = Buffer.from(expectedMac, 'hex');
  if (macBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(macBuf, expectedBuf)) {
    return { ok: false, reason: 'forged_or_tampered' };
  }

  let payload;
  try {
    payload = JSON.parse(json);
  } catch (err) {
    return { ok: false, reason: 'malformed_token' };
  }

  if (typeof payload.expiresAt === 'number' && Date.now() > payload.expiresAt) {
    return { ok: false, reason: 'expired' };
  }
  if (payload.verdict !== VERDICTS.CLEAN) {
    return { ok: false, reason: 'not_clean' };
  }
  return { ok: true, payload };
}

module.exports = { VERDICTS, userFacingMessage, sign, verify };
