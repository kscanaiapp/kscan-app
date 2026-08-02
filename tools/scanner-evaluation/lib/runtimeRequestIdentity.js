'use strict';

/**
 * Git-object-backed runtime snapshots and provider-request identity comparison.
 * Production worktrees are never imported or edited. Every executed source byte
 * is materialized from an explicit full commit SHA into a private temp root.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const certifiedSource = require('./certifiedSource');
const { assertOutsideGit } = require('./imagePreparation');

const CERTIFIED_SHA = 'f5f4ed2eda4984db0658c3209fece223acd33188';
const PROTECTED_ANDROID_SHA = '4d0ceb40655a7de7a2430bc4014ef0710aa8ca66';
const PROTECTED_IOS_SHA = '5c761ba7df2cfc7b22efa3d3326dca46850e02f0';
const SNAPSHOT_RECORD = 'runtime-source-snapshot.json';

const PROVIDER_PARSER_PATHS = Object.freeze([
  'supabase/functions/scan-identify/index.ts',
  'supabase/functions/_shared/scanHelpers.ts',
]);

const RESPONSE_CONTRACT_PATHS = Object.freeze([
  'supabase/functions/scan-identify/index.ts',
  'supabase/functions/_shared/fashionIdentificationV2.ts',
]);

const RUNTIME_SUPPORT_PATHS = Object.freeze([
  'package.json',
  'package-lock.json',
]);

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function assertFullCommitSha(ref) {
  if (!/^[0-9a-f]{40}$/.test(String(ref || ''))) {
    throw new Error('runtime source ref must be a full lowercase 40-character commit SHA');
  }
  execFileSync('git', ['cat-file', '-e', `${ref}^{commit}`], {
    cwd: certifiedSource.ROOT,
    stdio: 'pipe',
  });
}

function componentIdentity(ref, filePaths) {
  assertFullCommitSha(ref);
  const entries = filePaths.slice().sort().map((filePath) => ({
    path: filePath,
    sha256: sha256(certifiedSource.readBlob(ref, filePath)),
  }));
  return {
    files: entries,
    aggregateSha256: sha256(Buffer.from(entries.map((entry) => `${entry.path}:${entry.sha256}\n`).join(''))),
  };
}

function materializeReferenceClosure({ ref, destination }) {
  assertFullCommitSha(ref);
  if (!destination) throw new Error('runtime snapshot destination is required');
  const target = path.resolve(destination);
  assertOutsideGit(target);
  if (fs.existsSync(target)) {
    throw new Error(`runtime snapshot already exists and is immutable: ${target}`);
  }

  const record = certifiedSource.loadRecord();
  const files = record.files.filter((file) => file.bundle === true);
  const staged = [];
  const runtimeSupport = [];
  fs.mkdirSync(target, { recursive: true });
  try {
    for (const file of files) {
      const bytes = certifiedSource.readBlob(ref, file.path);
      const resolved = path.resolve(target, file.path);
      if (!resolved.startsWith(target + path.sep)) throw new Error(`snapshot path escapes root: ${file.path}`);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, bytes, { flag: 'wx' });
      staged.push({ path: file.path, sha256: sha256(bytes) });
    }
    // Deno's manual npm resolver requires the package metadata beside the
    // materialized source. These files are kept outside the certified Scanner
    // bundle identity and recorded separately; provider-source equivalence is
    // still computed exclusively from the certified bundle.
    for (const filePath of RUNTIME_SUPPORT_PATHS) {
      const bytes = certifiedSource.readBlob(ref, filePath);
      const resolved = path.resolve(target, filePath);
      fs.writeFileSync(resolved, bytes, { flag: 'wx' });
      runtimeSupport.push({ path: filePath, sha256: sha256(bytes) });
    }
    const snapshot = {
      snapshotVersion: '1.0.0',
      sourceCommit: ref,
      entry: record.entry,
      fileCount: staged.length,
      aggregateSha256: sha256(Buffer.from(staged.map((entry) => `${entry.path}:${entry.sha256}\n`).sort().join(''))),
      runtimeSupport,
      materializedFrom: 'git object store',
      immutable: true,
    };
    fs.writeFileSync(
      path.join(target, SNAPSHOT_RECORD),
      `${JSON.stringify(snapshot, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx' },
    );
    return { ...snapshot, root: target };
  } catch (error) {
    fs.rmSync(target, { recursive: true, force: true });
    throw error;
  }
}

function protectedMobileDispatchIdentity(ref) {
  assertFullCommitSha(ref);
  const eas = JSON.parse(certifiedSource.readBlob(ref, 'eas.json').toString('utf8'));
  const envBlocks = Object.values(eas.build || {})
    .map((profile) => profile && profile.env)
    .filter(Boolean);
  const v2Enabled = envBlocks.some((env) => env.EXPO_PUBLIC_SCANNER_IDENTIFICATION_V2_ENABLED === 'true');
  const backendEnabled = envBlocks.some((env) => env.EXPO_PUBLIC_SCAN_IDENTIFY_BACKEND_ENABLED === 'true');
  const multiImageEnabled = envBlocks.some((env) => env.EXPO_PUBLIC_MULTI_IMAGE_SCANNER_ENABLED === 'true');
  const featureFlags = certifiedSource.readBlob(ref, 'constants/featureFlags.ts').toString('utf8');
  const requestSource = certifiedSource.readBlob(ref, 'services/scannerScanRequest.ts').toString('utf8');
  const transportSource = certifiedSource.readBlob(ref, 'services/scanIdentification.ts').toString('utf8');
  return {
    v2Enabled,
    backendEnabled,
    multiImageEnabled,
    v2DefaultFailsClosed: /return value === 'true'/.test(featureFlags),
    selectedItemLegacyShapePresent:
      /multiItemDetection:\s*true/.test(requestSource)
      && /requestMode:\s*isSelected\s*\?\s*'selected_item'/.test(requestSource)
      && /selectedCandidate/.test(requestSource)
      && /clientTimestamp:\s*new Date\(\)\.toISOString\(\)/.test(transportSource)
      && /body:\s*requestBody/.test(transportSource),
    mobileOrchestratorSha256: sha256(Buffer.from(requestSource)),
    mobileTransportSha256: sha256(Buffer.from(transportSource)),
    selectedRuntimeContract: v2Enabled ? 'fashion-identification-v2' : 'legacy-selected-item',
  };
}

function compareRuntimeRequestIdentities(control, current) {
  const checks = {
    providerPayload: control.serializedRequestPayloadSha256 === current.serializedRequestPayloadSha256,
    prompt: control.promptSha256 === current.promptSha256,
    responseSchema: control.responseSchemaSha256 === current.responseSchemaSha256,
    samplingConfiguration: control.generationConfigSha256 === current.generationConfigSha256,
    model: control.model === current.model,
    providerParser: control.providerParserSha256 === current.providerParserSha256,
    requestContract: control.requestContract === current.requestContract,
    responseContract: control.responseContractSha256 === current.responseContractSha256,
  };
  return {
    comparisonVersion: '1.0.0',
    checks,
    reusable: Object.values(checks).every(Boolean),
    rule: 'Historical results are reusable only when every recorded request, model, schema, sampling, parser, and contract identity is byte-identical.',
  };
}

module.exports = {
  CERTIFIED_SHA,
  PROTECTED_ANDROID_SHA,
  PROTECTED_IOS_SHA,
  PROVIDER_PARSER_PATHS,
  RESPONSE_CONTRACT_PATHS,
  SNAPSHOT_RECORD,
  sha256,
  componentIdentity,
  materializeReferenceClosure,
  protectedMobileDispatchIdentity,
  compareRuntimeRequestIdentities,
};
