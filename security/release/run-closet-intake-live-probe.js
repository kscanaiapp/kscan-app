#!/usr/bin/env node
'use strict';

/**
 * Governed Build 29 Closet intake live probe.
 *
 * This script is deliberately narrow: it proves that the deployed staging
 * scan-identify function accepts the three authoritative Closet V2 entry paths
 * (camera, gallery, mirror), preserves request/evidence correlation, skips
 * commerce, and rejects a mirror near-miss. It never runs against production,
 * never reads an unapproved fixture, and emits only bounded contract facts.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { assertExpectedEnvironment } = require('../scripts/lib/environment-authority');
const { assertNotProductionUrl, signInSyntheticUser, maskLine } = require('../scripts/synthetic-auth');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE_DIR = path.join(REPO_ROOT, 'assets', 'qa_fixtures');
const FIXTURE_NAME = 'outerwear.jpg';
const SCAN_IDENTIFY_PATH = '/functions/v1/scan-identify';
const CONTRACT_VERSION = 'fashion-identification-v2';
const ENTRY_PATHS = Object.freeze(['closet_camera', 'closet_gallery', 'closet_mirror']);

const REQUIRED_ENV_VARS = Object.freeze([
  'SUPABASE_STAGING_PROJECT_REF',
  'SUPABASE_STAGING_URL',
  'SUPABASE_STAGING_PUBLISHABLE_KEY',
  'STAGING_SYNTHETIC_ACTIVE_EMAIL',
  'STAGING_SYNTHETIC_ACTIVE_PASSWORD',
]);

const FORBIDDEN_EVIDENCE_PATTERNS = Object.freeze([
  /^data:image\//i,
  /^ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}$/,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
  /^sbp_[a-f0-9]{40}$/,
]);

class ClosetIntakeProbeError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ClosetIntakeProbeError';
    this.code = code;
  }
}

function findMissingEnvVars(env) {
  return REQUIRED_ENV_VARS.filter((name) => !env[name]);
}

function loadApprovedFixture() {
  const fullPath = path.join(FIXTURE_DIR, FIXTURE_NAME);
  if (!fullPath.startsWith(FIXTURE_DIR + path.sep)) {
    throw new ClosetIntakeProbeError('approved fixture path escaped its directory', 'FIXTURE_PATH_ESCAPE');
  }
  if (!fs.existsSync(fullPath)) {
    throw new ClosetIntakeProbeError(`approved fixture is missing: ${FIXTURE_NAME}`, 'NO_SAFE_TEST_IMAGE');
  }
  return fs.readFileSync(fullPath).toString('base64');
}

function buildClosetRequest(entryPath, imageBase64, ids = {}) {
  if (!ENTRY_PATHS.includes(entryPath)) {
    throw new ClosetIntakeProbeError(`entry path is not probe-approved: ${entryPath}`, 'ENTRY_PATH_NOT_ALLOWED');
  }
  const requestId = ids.requestId || `req_closet_probe_${crypto.randomUUID()}`;
  const evidenceId = ids.evidenceId || crypto.randomUUID();
  return {
    contractVersion: CONTRACT_VERSION,
    requestId,
    intent: 'identify_for_closet',
    mode: 'detect_items',
    source: { entryPath, platform: 'ci' },
    evidence: [
      {
        evidenceId,
        sequenceIndex: 0,
        transport: { type: 'jpeg_base64', imageBase64 },
        metadata: { schemaVersion: 'image-metadata-v1', mimeType: 'image/jpeg' },
      },
    ],
    privacy: {
      localFaceMaskApplied: false,
      localPlateMaskApplied: false,
      rawExifTransmitted: false,
    },
  };
}

function buildScanIdentifyUrl(supabaseUrl) {
  return `${String(supabaseUrl).replace(/\/+$/, '')}${SCAN_IDENTIFY_PATH}`;
}

function countArray(value) {
  return Array.isArray(value) ? value.length : 0;
}

function inspectPositiveResponse(httpStatus, body, expected) {
  const v2 = body && typeof body === 'object' ? body.identificationV2 : null;
  const evidenceIds = Array.isArray(v2?.evidenceIds) ? v2.evidenceIds : [];
  const facts = {
    httpStatus,
    logicalStatus: typeof body?.status === 'string' ? body.status : null,
    contractVersion: typeof body?.contractVersion === 'string' ? body.contractVersion : null,
    v2Status: typeof v2?.status === 'string' ? v2.status : null,
    v2Outcome: typeof v2?.outcome === 'string' ? v2.outcome : null,
    requestCorrelated: v2?.requestId === expected.requestId,
    evidenceCorrelated: evidenceIds.length === 1 && evidenceIds[0] === expected.evidenceId,
    recommendedProductCount: countArray(body?.recommendedProducts),
    productCount: countArray(body?.products),
    purchaseOptionCount: countArray(body?.purchaseOptions),
    similarityMatchCount: countArray(body?.similarityMatches),
  };
  facts.accepted =
    facts.httpStatus === 200 &&
    facts.logicalStatus === 'completed' &&
    facts.contractVersion === CONTRACT_VERSION &&
    facts.v2Status === 'completed' &&
    ['classified', 'multiple_items_need_selection'].includes(facts.v2Outcome) &&
    facts.requestCorrelated &&
    facts.evidenceCorrelated &&
    facts.recommendedProductCount === 0 &&
    facts.productCount === 0 &&
    facts.purchaseOptionCount === 0 &&
    facts.similarityMatchCount === 0;
  return facts;
}

function inspectNegativeResponse(httpStatus, body) {
  const code = typeof body?.code === 'string' ? body.code : null;
  return {
    httpStatus,
    code,
    rejected: httpStatus === 400 && code === 'invalid_source',
  };
}

function assertEvidencePrivacy(value) {
  if (typeof value === 'string') {
    for (const pattern of FORBIDDEN_EVIDENCE_PATTERNS) {
      if (pattern.test(value)) {
        throw new ClosetIntakeProbeError('sanitized evidence matched a forbidden secret/PII shape', 'EVIDENCE_PRIVACY');
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(assertEvidencePrivacy);
    return;
  }
  if (value && typeof value === 'object') Object.values(value).forEach(assertEvidencePrivacy);
}

async function invoke(url, publishableKey, accessToken, body, fetchImpl) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      apikey: publishableKey,
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* response contract check handles this */ }
  return { httpStatus: res.status, body: json };
}

async function run(env = process.env, fetchImpl = fetch) {
  assertExpectedEnvironment('staging', env.SUPABASE_STAGING_PROJECT_REF);
  assertNotProductionUrl(env.SUPABASE_STAGING_URL);
  const missing = findMissingEnvVars(env);
  if (missing.length > 0) {
    throw new ClosetIntakeProbeError(`missing required staging environment: ${missing.join(', ')}`, 'MISSING_ENV');
  }

  const signIn = await signInSyntheticUser(
    env.SUPABASE_STAGING_URL,
    env.SUPABASE_STAGING_PUBLISHABLE_KEY,
    env.STAGING_SYNTHETIC_ACTIVE_EMAIL,
    env.STAGING_SYNTHETIC_ACTIVE_PASSWORD,
    fetchImpl,
  );
  if (!signIn.ok) {
    throw new ClosetIntakeProbeError(`synthetic sign-in failed with status ${signIn.status}`, 'SYNTHETIC_AUTH_FAILED');
  }
  process.stderr.write(`${maskLine(signIn.accessToken)}\n`);

  const imageBase64 = loadApprovedFixture();
  const url = buildScanIdentifyUrl(env.SUPABASE_STAGING_URL);
  const entryPathResults = [];
  for (const entryPath of ENTRY_PATHS) {
    const request = buildClosetRequest(entryPath, imageBase64);
    // Calls are sequential so staging quota/provider pressure is bounded.
    // eslint-disable-next-line no-await-in-loop
    const response = await invoke(url, env.SUPABASE_STAGING_PUBLISHABLE_KEY, signIn.accessToken, request, fetchImpl);
    const facts = inspectPositiveResponse(response.httpStatus, response.body, {
      requestId: request.requestId,
      evidenceId: request.evidence[0].evidenceId,
    });
    entryPathResults.push({ entryPath, ...facts });
  }

  const hostileRequest = buildClosetRequest('closet_mirror', imageBase64);
  hostileRequest.source.entryPath = 'closet_mirror_v2';
  const hostileResponse = await invoke(
    url,
    env.SUPABASE_STAGING_PUBLISHABLE_KEY,
    signIn.accessToken,
    hostileRequest,
    fetchImpl,
  );
  const hostileNearMiss = inspectNegativeResponse(hostileResponse.httpStatus, hostileResponse.body);

  const report = {
    verdict: entryPathResults.every((result) => result.accepted) && hostileNearMiss.rejected ? 'PASS' : 'FAIL',
    environment: 'staging',
    contractVersion: CONTRACT_VERSION,
    fixture: FIXTURE_NAME,
    entryPathResults,
    hostileNearMiss,
  };
  assertEvidencePrivacy(report);
  fs.writeFileSync('closet-intake-live-probe-report.json', `${JSON.stringify(report, null, 2)}\n`);
  if (report.verdict !== 'PASS') {
    throw new ClosetIntakeProbeError('one or more live Closet intake assertions failed', 'LIVE_ASSERTION_FAILED');
  }
  return report;
}

if (require.main === module) {
  run()
    .then((report) => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`))
    .catch((error) => {
      const report = {
        verdict: 'OPERATIONAL_FAILURE',
        environment: 'staging',
        code: error?.code || 'UNEXPECTED',
        message: String(error?.message || error).slice(0, 300),
      };
      assertEvidencePrivacy(report);
      fs.writeFileSync('closet-intake-live-probe-report.json', `${JSON.stringify(report, null, 2)}\n`);
      process.stderr.write(`${JSON.stringify(report)}\n`);
      process.exitCode = 1;
    });
}

module.exports = {
  CONTRACT_VERSION,
  ENTRY_PATHS,
  REQUIRED_ENV_VARS,
  ClosetIntakeProbeError,
  findMissingEnvVars,
  buildClosetRequest,
  buildScanIdentifyUrl,
  inspectPositiveResponse,
  inspectNegativeResponse,
  assertEvidencePrivacy,
  run,
};
