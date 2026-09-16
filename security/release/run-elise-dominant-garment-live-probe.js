#!/usr/bin/env node
'use strict';

/**
 * Governed live probe for the P1 Elise photo-upload dominant-garment repair.
 *
 * WHAT IT PROVES, AND WHY A PROBE IS THE ONLY WAY TO PROVE IT.
 *
 * The repair narrows the detection candidate set to one garment, server-side,
 * when one garment unambiguously dominates the frame. Unit tests pin the rule,
 * and the deployed-byte tests pin the projection, but neither can establish the
 * one thing the fix actually depends on in production: that the configured
 * identification provider returns MORE THAN ONE CANDIDATE, WITH USABLE BOUNDS,
 * for an ordinary worn-garment photo. If real detection returned no bounds, or
 * only ever one candidate, the rule would be correct and inert.
 *
 * So this sends each image class through both paths:
 *
 *   `elise_gallery`  -- the repaired item path, post-narrowing
 *   `scanner_camera` -- the untouched control, which reveals what detection
 *                       actually found before any narrowing
 *
 * Provider output is nondeterministic across calls, so the probe does not infer
 * the repair from a difference between those two responses. It reads the
 * function's sanitized, same-request resolution diagnostic from staging logs.
 * The control independently proves Scanner remains healthy on the same fixture.
 *
 * For the classes that resolve to a single candidate it then runs the real
 * second stage (`identify_selected_item`) with the server-issued correlation
 * carried forward verbatim, so "the user's photo proceeds" is an observed
 * outcome rather than an inference from the candidate count.
 *
 * SCOPE AND SAFETY
 * - Staging only. Refuses a production ref or URL before any network call.
 * - Reads only the repository's own approved `assets/qa_fixtures` images.
 * - At most fourteen bounded, sequential provider calls. Geometry-sensitive
 *   classes get at most three attempts because provider detection can vary.
 * - Emits contract facts only: counts, enum-ish strings, and normalized
 *   bounding-box AREA. Never image bytes, tokens, email, user id, provider
 *   prose, or raw provider payload. `assertEvidencePrivacy` re-checks the
 *   finished report against forbidden secret/PII shapes before it is written.
 * - Creates nothing and deletes nothing. It signs in an existing synthetic
 *   account; it never provisions one.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { assertNotProductionUrl, signInSyntheticUser, maskLine } = require('../scripts/synthetic-auth');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE_DIR = path.join(REPO_ROOT, 'assets', 'qa_fixtures');
const SCAN_IDENTIFY_PATH = '/functions/v1/scan-identify';
const CONTRACT_VERSION = 'fashion-identification-v2';
const REPORT_FILE = 'elise-dominant-garment-live-probe-report.json';
const RESOLUTION_MARKER = 'elise_item_candidate_resolution';
const GEOMETRY_ATTEMPT_LIMIT = 3;

const STAGING_PROJECT_REF = 'yzqjvdfgefveprobvvyw';
const PRODUCTION_PROJECT_REF = 'wyyuqfdxucjksghsmhry';

/** The repaired item path, and the untouched control it is compared against. */
const ELISE_ENTRY_PATH = 'elise_gallery';
const CONTROL_ENTRY_PATH = 'scanner_camera';

const REQUIRED_ENV_VARS = Object.freeze([
  'SUPABASE_STAGING_PROJECT_REF',
  'SUPABASE_STAGING_URL',
  'SUPABASE_STAGING_PUBLISHABLE_KEY',
  'SUPABASE_ACCESS_TOKEN',
  'STAGING_SYNTHETIC_ACTIVE_EMAIL',
  'STAGING_SYNTHETIC_ACTIVE_PASSWORD',
]);

const FORBIDDEN_EVIDENCE_PATTERNS = Object.freeze([
  /^data:image\//i,
  /^ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}$/,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
  /^sbp_[a-f0-9]{40}$/,
]);

/**
 * The four classes the incident is about, each mapped to an image the
 * repository already owns and has cleared for use. The ambiguity fixture is a
 * deterministic equal-scale, side-by-side duplicate of the approved `top.jpg`
 * fixture, so it gives the live provider two equally prominent garments. It
 * contains no customer photograph.
 */
const CLASSES = Object.freeze([
  {
    id: 'SINGLE_ITEM',
    fixture: 'dress.jpg',
    // One gown filling the frame.
    expect: 'proceeds',
  },
  {
    id: 'DOMINANT_PLUS_INCIDENTAL',
    fixture: 'top.jpg',
    // A white hoodie occupying most of the frame with a sliver of the trousers
    // below it: structurally the reported photo, from an approved fixture.
    expect: 'proceeds',
  },
  {
    id: 'GENUINE_AMBIGUITY',
    fixture: 'ambiguous_two_garments.jpg',
    // Two equal-scale copies of the approved hoodie fixture. Live provider
    // evidence on 2026-09-16 measured both leading garment boxes at 0.189 area
    // (ratio 1.0), which is the comparable-prominence case the rule must keep.
    expect: 'asks',
  },
  {
    id: 'NO_ITEM',
    fixture: 'non_fashion.jpg',
    // A ceramic mug.
    expect: 'safe_fallback',
  },
]);

class EliseDominantProbeError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'EliseDominantProbeError';
    this.code = code;
  }
}

function findMissingEnvVars(env) {
  return REQUIRED_ENV_VARS.filter((name) => !env[name]);
}

/**
 * Staging-only, asserted two ways before anything is sent: the declared project
 * ref must BE the staging ref, and must not be the production one. Checking
 * only "not production" would let a typo reach some third project.
 */
function assertStagingOnly(projectRef, supabaseUrl) {
  if (projectRef === PRODUCTION_PROJECT_REF) {
    throw new EliseDominantProbeError('refusing to run against production', 'PRODUCTION_REF');
  }
  if (projectRef !== STAGING_PROJECT_REF) {
    throw new EliseDominantProbeError(`project ref is not the staging project: ${projectRef}`, 'UNEXPECTED_REF');
  }
  if (String(supabaseUrl).includes(PRODUCTION_PROJECT_REF)) {
    throw new EliseDominantProbeError('refusing to run against a production URL', 'PRODUCTION_URL');
  }
  assertNotProductionUrl(supabaseUrl);
}

function loadApprovedFixture(fixtureName) {
  const fullPath = path.join(FIXTURE_DIR, fixtureName);
  if (!fullPath.startsWith(FIXTURE_DIR + path.sep)) {
    throw new EliseDominantProbeError('approved fixture path escaped its directory', 'FIXTURE_PATH_ESCAPE');
  }
  if (!fs.existsSync(fullPath)) {
    throw new EliseDominantProbeError(`approved fixture is missing: ${fixtureName}`, 'NO_SAFE_TEST_IMAGE');
  }
  return fs.readFileSync(fullPath).toString('base64');
}

function buildDetectRequest(entryPath, imageBase64) {
  const isElise = entryPath === ELISE_ENTRY_PATH;
  return {
    contractVersion: CONTRACT_VERSION,
    requestId: `req_elise_dominant_probe_${crypto.randomUUID()}`,
    // The control deliberately carries Scanner's own intent: a Scanner request
    // that borrowed the styling intent would not be a Scanner control.
    intent: isElise ? 'identify_for_style' : 'identify_and_shop',
    mode: 'detect_items',
    // A real mobile client value; the backend refuses synthetic platform names.
    source: { entryPath, platform: 'ios' },
    evidence: [
      {
        evidenceId: crypto.randomUUID(),
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

function buildSelectedItemRequest(detectRequest, candidate, correlation) {
  return {
    ...detectRequest,
    requestId: `req_elise_dominant_probe_sel_${crypto.randomUUID()}`,
    mode: 'identify_selected_item',
    selectedCandidate: {
      candidateId: candidate.candidateId,
      evidenceId: detectRequest.evidence[0].evidenceId,
      category: candidate.category,
      ...(candidate.subtype ? { subtype: candidate.subtype } : {}),
      ...(candidate.boundsRaw ? { bounds: candidate.boundsRaw } : {}),
    },
    // Server-issued on the detection response and echoed back verbatim; the
    // deployed handler hard-fails a selected-item request that has lost them.
    ...(correlation.scanSessionId ? { scanSessionId: correlation.scanSessionId } : {}),
    ...(correlation.imageDigestPrefix ? { imageDigestPrefix: correlation.imageDigestPrefix } : {}),
  };
}

function buildScanIdentifyUrl(supabaseUrl) {
  return `${String(supabaseUrl).replace(/\/+$/, '')}${SCAN_IDENTIFY_PATH}`;
}

/**
 * Structural facts only.
 *
 * `area` is width x height of the normalized box. It describes how much of the
 * frame a garment occupies and nothing about the image contents, which is
 * exactly the evidence the dominance claim needs and the most that may leave
 * this probe.
 */
function summarizeCandidates(v2, evidenceId) {
  const raw = Array.isArray(v2?.candidates) ? v2.candidates : [];
  return raw
    .filter((c) => c && typeof c.candidateId === 'string' && c.evidenceId === evidenceId)
    .map((c) => {
      const b = c.bounds;
      const usable = b
        && ['x', 'y', 'width', 'height'].every((k) => typeof b[k] === 'number' && Number.isFinite(b[k]));
      return {
        candidateId: c.candidateId,
        category: typeof c.category === 'string' ? c.category : null,
        subtype: typeof c.subtype === 'string' ? c.subtype : null,
        boundsPresent: Boolean(usable),
        area: usable ? Number((b.width * b.height).toFixed(4)) : null,
        ...(usable ? { boundsRaw: { x: b.x, y: b.y, width: b.width, height: b.height } } : {}),
      };
    });
}

function readCorrelation(body) {
  return {
    scanSessionId: typeof body?.scanSessionId === 'string' ? body.scanSessionId : null,
    imageDigestPrefix: typeof body?.imageDigestPrefix === 'string' ? body.imageDigestPrefix : null,
  };
}

/**
 * The shipped client's terminal decision for `policy: 'item'`, restated.
 *
 * The client rule itself is pinned against the REAL shipped orchestrator by
 * __tests__/eliseDominantGarmentLiveConsumption.test.js; what this probe
 * contributes is the live wire input that feeds it.
 */
function clientOutcomeForItemPolicy(wireCandidateCount) {
  if (wireCandidateCount === 0) return 'safe_fallback';
  if (wireCandidateCount === 1) return 'proceeds';
  return 'asks';
}

function hashRequestId(requestId) {
  return crypto.createHash('sha256').update(requestId, 'utf8').digest('hex').slice(0, 12);
}

function parseResolutionDiagnostic(message) {
  if (typeof message !== 'string' || !message.includes(RESOLUTION_MARKER)) return null;
  const match = message.match(
    /requestHash=([a-f0-9]{12}) entryPath=([^\s]+) detected=(\d+) outcome=([^\s]+) reason=([^\s]+)/,
  );
  if (!match) return null;
  return {
    requestHash: match[1],
    entryPath: match[2],
    detected: Number(match[3]),
    outcome: match[4],
    reason: match[5],
  };
}

async function queryResolutionDiagnostics(projectRef, managementToken, startIso, expectedRequestHash, fetchImpl) {
  const sql = `select timestamp, event_message from logs where source = 'function_logs' and timestamp >= parseDateTimeBestEffort('${startIso}') and event_message like '%${RESOLUTION_MARKER} requestHash=${expectedRequestHash} %' order by timestamp desc limit 20`;
  const url = new URL(`https://api.supabase.com/v1/projects/${projectRef}/analytics/endpoints/logs`);
  url.searchParams.set('sql', sql);
  url.searchParams.set('iso_timestamp_start', startIso);
  url.searchParams.set('iso_timestamp_end', new Date().toISOString());
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${managementToken}` },
  });
  if (!response.ok) return [];
  const body = await response.json().catch(() => ({}));
  return (Array.isArray(body?.result) ? body.result : [])
    .map((row) => ({ timestamp: row.timestamp, ...parseResolutionDiagnostic(row.event_message) }))
    .filter((row) => row.requestHash === expectedRequestHash && row.entryPath === ELISE_ENTRY_PATH);
}

async function waitForResolutionDiagnostic(
  projectRef,
  managementToken,
  startIso,
  expectedRequestHash,
  fetchImpl,
) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    // Function console logs are delivered asynchronously to the analytics API.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const diagnostics = await queryResolutionDiagnostics(
      projectRef,
      managementToken,
      startIso,
      expectedRequestHash,
      fetchImpl,
    );
    if (diagnostics.length > 0) return diagnostics[0];
  }
  return null;
}

function assertEvidencePrivacy(value) {
  if (typeof value === 'string') {
    for (const pattern of FORBIDDEN_EVIDENCE_PATTERNS) {
      if (pattern.test(value)) {
        throw new EliseDominantProbeError('sanitized evidence matched a forbidden secret/PII shape', 'EVIDENCE_PRIVACY');
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
  try { json = await res.json(); } catch { /* the response contract check handles this */ }
  return { httpStatus: res.status, body: json };
}

async function detect(url, key, token, entryPath, imageBase64, fetchImpl) {
  const request = buildDetectRequest(entryPath, imageBase64);
  const { httpStatus, body } = await invoke(url, key, token, request, fetchImpl);
  const evidenceId = request.evidence[0].evidenceId;
  const v2 = body && typeof body === 'object' ? body.identificationV2 : null;
  return {
    request,
    httpStatus,
    authenticated: httpStatus !== 401,
    logicalStatus: typeof body?.status === 'string' ? body.status : null,
    v2Status: typeof v2?.status === 'string' ? v2.status : null,
    requestCorrelated: v2?.requestId === request.requestId,
    candidates: summarizeCandidates(v2, evidenceId),
    correlation: readCorrelation(body),
  };
}

async function run(env = process.env, fetchImpl = fetch) {
  assertStagingOnly(env.SUPABASE_STAGING_PROJECT_REF, env.SUPABASE_STAGING_URL);
  const missing = findMissingEnvVars(env);
  if (missing.length > 0) {
    throw new EliseDominantProbeError(`missing required staging environment: ${missing.join(', ')}`, 'MISSING_ENV');
  }

  const signIn = await signInSyntheticUser(
    env.SUPABASE_STAGING_URL,
    env.SUPABASE_STAGING_PUBLISHABLE_KEY,
    env.STAGING_SYNTHETIC_ACTIVE_EMAIL,
    env.STAGING_SYNTHETIC_ACTIVE_PASSWORD,
    fetchImpl,
  );
  if (!signIn.ok) {
    throw new EliseDominantProbeError(`synthetic sign-in failed with status ${signIn.status}`, 'SYNTHETIC_AUTH_FAILED');
  }
  // Masked on stderr the instant it exists, before it is used for anything.
  process.stderr.write(`${maskLine(signIn.accessToken)}\n`);

  const url = buildScanIdentifyUrl(env.SUPABASE_STAGING_URL);
  const key = env.SUPABASE_STAGING_PUBLISHABLE_KEY;
  const token = signIn.accessToken;
  const managementToken = env.SUPABASE_ACCESS_TOKEN;
  const results = [];

  for (const klass of CLASSES) {
    const imageBase64 = loadApprovedFixture(klass.fixture);
    const control = await detect(url, key, token, CONTROL_ENTRY_PATH, imageBase64, fetchImpl);
    const scannerControlHealthy = control.authenticated && control.httpStatus === 200;
    const geometrySensitive = ['DOMINANT_PLUS_INCIDENTAL', 'GENUINE_AMBIGUITY'].includes(klass.id);
    const attemptLimit = geometrySensitive ? GEOMETRY_ATTEMPT_LIMIT : 1;
    let chosen = null;

    // Sequential on purpose: staging quota and provider pressure stay bounded.
    /* eslint-disable no-await-in-loop */
    for (let attempt = 1; attempt <= attemptLimit; attempt += 1) {
      const startedAt = new Date(Date.now() - 1000).toISOString();
      const elise = await detect(url, key, token, ELISE_ENTRY_PATH, imageBase64, fetchImpl);
      const expectedRequestHash = hashRequestId(elise.request.requestId);
      const wireCount = elise.candidates.length;
      const clientOutcome = clientOutcomeForItemPolicy(wireCount);
      const diagnostic = geometrySensitive
        ? await waitForResolutionDiagnostic(
          env.SUPABASE_STAGING_PROJECT_REF,
          managementToken,
          startedAt,
          expectedRequestHash,
          fetchImpl,
        )
        : null;
      const sameRequestResolutionProven = klass.id === 'DOMINANT_PLUS_INCIDENTAL'
        ? diagnostic?.requestHash === expectedRequestHash
          && diagnostic?.detected > 1
          && diagnostic?.outcome === 'dominant'
          && diagnostic?.reason === 'area_dominance'
          && wireCount === 1
        : klass.id === 'GENUINE_AMBIGUITY'
          ? diagnostic?.requestHash === expectedRequestHash
            && diagnostic?.detected > 1
            && diagnostic?.outcome === 'ambiguous'
            && diagnostic?.reason === 'comparable_area'
            && wireCount > 1
          : true;
      const wireExpectationMet = clientOutcome === klass.expect;
      chosen = {
        attemptCount: attempt,
        elise,
        diagnostic,
        wireCount,
        clientOutcome,
        sameRequestResolutionProven,
        wireExpectationMet,
      };
      if (wireExpectationMet && sameRequestResolutionProven) break;
    }

    const { elise, diagnostic, wireCount, clientOutcome } = chosen;
    let selectedItem = null;
    if (wireCount === 1 && chosen.sameRequestResolutionProven) {
      const selectedRequest = buildSelectedItemRequest(
        elise.request,
        elise.candidates[0],
        elise.correlation,
      );
      const selectedResponse = await invoke(url, key, token, selectedRequest, fetchImpl);
      const sv2 = selectedResponse.body?.identificationV2 ?? null;
      selectedItem = {
        httpStatus: selectedResponse.httpStatus,
        logicalStatus: typeof selectedResponse.body?.status === 'string' ? selectedResponse.body.status : null,
        v2Status: typeof sv2?.status === 'string' ? sv2.status : null,
        // Category/subtype only: enough to show a usable identity came back,
        // far short of the provider's description of the garment.
        category: typeof sv2?.item?.category === 'string' ? sv2.item.category : null,
        subtype: typeof sv2?.item?.subtype === 'string' ? sv2.item.subtype : null,
      };
      selectedItem.usableIdentity = selectedItem.httpStatus === 200
        && ['completed', 'partial'].includes(selectedItem.v2Status)
        && Boolean(selectedItem.category || selectedItem.subtype);
    }
    /* eslint-enable no-await-in-loop */

    const expectationMet = chosen.wireExpectationMet
      && chosen.sameRequestResolutionProven
      && (klass.expect !== 'proceeds' || Boolean(selectedItem?.usableIdentity));

    results.push({
      class: klass.id,
      fixture: klass.fixture,
      expected: klass.expect,
      authenticated: control.authenticated && elise.authenticated,
      attemptCount: chosen.attemptCount,
      control: {
        entryPath: CONTROL_ENTRY_PATH,
        httpStatus: control.httpStatus,
        v2Status: control.v2Status,
        candidateCount: control.candidates.length,
        // Sorted descending so the dominance comparison is readable directly.
        areas: control.candidates.map((c) => c.area).sort((a, b) => (b ?? 0) - (a ?? 0)),
        categories: control.candidates.map((c) => c.category),
      },
      elise: {
        entryPath: ELISE_ENTRY_PATH,
        httpStatus: elise.httpStatus,
        v2Status: elise.v2Status,
        requestCorrelated: elise.requestCorrelated,
        candidateCount: wireCount,
        categories: elise.candidates.map((c) => c.category),
      },
      sameRequestDiagnostic: diagnostic,
      realProviderCandidateCount: diagnostic?.detected ?? null,
      realProviderBoundsPresent: ['area_dominance', 'comparable_area'].includes(diagnostic?.reason),
      dominanceResolution: diagnostic?.outcome ?? 'not_applicable',
      finalWireCandidateCount: wireCount,
      clientOutcome,
      selectedItem,
      expectationMet,
      scannerControlHealthy,
    });
  }

  const dominantCase = results.find((r) => r.class === 'DOMINANT_PLUS_INCIDENTAL');
  const ambiguousCase = results.find((r) => r.class === 'GENUINE_AMBIGUITY');

  const report = {
    verdict: results.every((r) => r.authenticated && r.expectationMet) ? 'PASS' : 'FAIL',
    environment: 'staging',
    projectRef: env.SUPABASE_STAGING_PROJECT_REF,
    contractVersion: CONTRACT_VERSION,
    liveAuthenticated: results.every((r) => r.authenticated),
    // The acceptance question the unit tests structurally cannot answer.
    realProviderReturnedSufficientBounds: Boolean(dominantCase?.realProviderBoundsPresent)
      && (dominantCase?.realProviderCandidateCount ?? 0) > 1,
    dominanceRuleExercisedLive: dominantCase?.dominanceResolution === 'dominant',
    ambiguityPreservedLive: ambiguousCase ? ambiguousCase.dominanceResolution !== 'dominant' : null,
    scannerRegressionLive: results.every((r) => r.scannerControlHealthy),
    results,
  };

  assertEvidencePrivacy(report);
  fs.writeFileSync(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`);
  if (report.verdict !== 'PASS') {
    throw new EliseDominantProbeError('one or more live Elise dominant-garment assertions failed', 'LIVE_ASSERTION_FAILED');
  }
  return report;
}

function buildTerminalFailureReport(error, existingReport = null) {
  if (existingReport && typeof existingReport === 'object' && existingReport.verdict === 'FAIL') {
    return { ...existingReport, executionCode: error?.code || 'UNEXPECTED' };
  }
  return {
    verdict: 'OPERATIONAL_FAILURE',
    environment: 'staging',
    code: error?.code || 'UNEXPECTED',
    message: String(error?.message || error).slice(0, 300),
  };
}

if (require.main === module) {
  run()
    .then((report) => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`))
    .catch((error) => {
      let existingReport = null;
      try {
        existingReport = JSON.parse(fs.readFileSync(REPORT_FILE, 'utf8'));
      } catch { /* no prior assertion report exists */ }
      const report = buildTerminalFailureReport(error, existingReport);
      assertEvidencePrivacy(report);
      fs.writeFileSync(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`);
      process.stderr.write(`${JSON.stringify(report)}\n`);
      process.exitCode = 1;
    });
}

module.exports = {
  CONTRACT_VERSION,
  CLASSES,
  ELISE_ENTRY_PATH,
  CONTROL_ENTRY_PATH,
  REQUIRED_ENV_VARS,
  EliseDominantProbeError,
  findMissingEnvVars,
  assertStagingOnly,
  buildDetectRequest,
  buildSelectedItemRequest,
  buildScanIdentifyUrl,
  summarizeCandidates,
  clientOutcomeForItemPolicy,
  hashRequestId,
  parseResolutionDiagnostic,
  assertEvidencePrivacy,
  buildTerminalFailureReport,
  run,
};
