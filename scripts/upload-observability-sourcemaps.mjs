#!/usr/bin/env node
/**
 * Build 29 source-map provider handoff.
 *
 * The local pipeline (`export-observability-sourcemaps.mjs`) remains the
 * identity authority: it exports the maps, checksums every artifact, and binds
 * them to release_id / source_sha / environment / distribution / build. This
 * script is the FINAL TRANSPORT STEP only. It re-proves that binding before a
 * single byte reaches Sentry, and refuses to run without a credential supplied
 * by the environment.
 *
 * Requires (from a secret store, never from a tracked file):
 *   SENTRY_AUTH_TOKEN  - minimum scope `org:ci` (release + source-map write)
 *   SENTRY_ORG
 *   SENTRY_PROJECT
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateObservabilityBuildEnvironment } from './verify-observability-build-env.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.join(repoRoot, 'dist', 'observability-source-maps');
const manifestPath = path.join(outputRoot, 'observability-manifest.json');

/**
 * A manifest may only be uploaded under the identity it was generated for.
 * Anything else would attach one release's maps to another release's events.
 */
export function assertManifestIdentityMatches(manifest, identity) {
  const mismatches = [];
  const fields = [
    ['releaseId', 'releaseId'],
    ['sourceSha', 'sourceSha'],
    ['environment', 'environment'],
    ['distribution', 'distribution'],
    ['buildIdentifier', 'buildIdentifier'],
  ];
  for (const [manifestKey, identityKey] of fields) {
    if (manifest?.[manifestKey] !== identity?.[identityKey]) {
      mismatches.push(
        `${manifestKey}: manifest=${JSON.stringify(manifest?.[manifestKey])} build=${JSON.stringify(identity?.[identityKey])}`,
      );
    }
  }
  if (manifest?.contractVersion !== 'build29-source-map-manifest-v1') {
    mismatches.push(`contractVersion: ${JSON.stringify(manifest?.contractVersion)}`);
  }
  return { ok: mismatches.length === 0, mismatches };
}

/**
 * Re-verify every recorded SHA-256 against the artifact on disk. The local
 * checksum contract survives the provider handoff rather than being replaced
 * by it.
 */
export function verifyManifestChecksums(root, manifest) {
  const failures = [];
  const files = Array.isArray(manifest?.files) ? manifest.files : [];
  if (files.length === 0) failures.push('manifest lists no artifacts');
  for (const entry of files) {
    const absolute = path.join(root, entry.path);
    if (!fs.existsSync(absolute)) {
      failures.push(`missing artifact: ${entry.path}`);
      continue;
    }
    const bytes = fs.readFileSync(absolute);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== entry.sha256) failures.push(`checksum mismatch: ${entry.path}`);
    if (bytes.length !== entry.bytes) failures.push(`size mismatch: ${entry.path}`);
  }
  return { ok: failures.length === 0, failures };
}

/**
 * The credential gate. Upload is impossible without an environment-supplied
 * token; the token value itself is never returned, logged, or placed on a
 * command line.
 */
export function resolveUploadCredential(env = process.env) {
  const missing = [];
  if (!String(env.SENTRY_AUTH_TOKEN || '').trim()) missing.push('SENTRY_AUTH_TOKEN');
  if (!String(env.SENTRY_ORG || '').trim()) missing.push('SENTRY_ORG');
  if (!String(env.SENTRY_PROJECT || '').trim()) missing.push('SENTRY_PROJECT');
  return {
    ok: missing.length === 0,
    missing,
    org: String(env.SENTRY_ORG || '').trim() || null,
    project: String(env.SENTRY_PROJECT || '').trim() || null,
  };
}

function main() {
  const validation = validateObservabilityBuildEnvironment(process.env);
  if (!validation.ok) {
    throw new Error(`OBSERVABILITY_BUILD_ENV_INVALID:${validation.errors.join('|')}`);
  }

  const credential = resolveUploadCredential(process.env);
  if (!credential.ok) {
    throw new Error(`SOURCE_MAP_UPLOAD_CREDENTIAL_MISSING:${credential.missing.join(',')}`);
  }

  if (!fs.existsSync(manifestPath)) {
    throw new Error('SOURCE_MAP_MANIFEST_MISSING:run observability:export-sourcemaps first');
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  const identity = assertManifestIdentityMatches(manifest, validation.identity);
  if (!identity.ok) {
    throw new Error(`SOURCE_MAP_IDENTITY_MISMATCH:${identity.mismatches.join('|')}`);
  }

  const checksums = verifyManifestChecksums(outputRoot, manifest);
  if (!checksums.ok) {
    throw new Error(`SOURCE_MAP_CHECKSUM_VERIFICATION_FAILED:${checksums.failures.join('|')}`);
  }

  // The release Sentry files these maps under IS the K Scan release id, and the
  // dist IS the K Scan build identifier. No provider-generated release exists.
  const cli = path.join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'sentry-cli.cmd' : 'sentry-cli');
  const args = [
    'sourcemaps', 'upload',
    '--org', credential.org,
    '--project', credential.project,
    '--release', validation.identity.releaseId,
    '--dist', validation.identity.buildIdentifier,
    outputRoot,
  ];
  const result = spawnSync(cli, args, {
    cwd: repoRoot,
    // SENTRY_AUTH_TOKEN is inherited through the environment only.
    env: process.env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    throw new Error(`SOURCE_MAP_UPLOAD_FAILED:${result.status ?? result.error?.code ?? 'spawn_error'}`);
  }

  console.log(JSON.stringify({
    status: 'SOURCE_MAP_UPLOADED',
    provider: 'sentry',
    releaseId: validation.identity.releaseId,
    sourceSha: validation.identity.sourceSha,
    environment: validation.identity.environment,
    distribution: validation.identity.distribution,
    buildIdentifier: validation.identity.buildIdentifier,
    files: manifest.files.length,
  }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
