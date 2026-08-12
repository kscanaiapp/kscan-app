#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateObservabilityBuildEnvironment } from './verify-observability-build-env.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.join(repoRoot, 'dist', 'observability-source-maps');
const SECRET_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bsbp_[A-Za-z0-9]{20,}/,
  /\bsb_secret_[A-Za-z0-9_-]{10,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];

function walkFiles(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(absolute));
    else files.push(absolute);
  }
  return files;
}

export function buildSourceMapManifest(root, identity) {
  const files = walkFiles(root)
    .filter((file) => /\.(?:map|hbc|jsbundle|js)$/.test(file))
    .map((file) => {
      const bytes = fs.readFileSync(file);
      if (file.endsWith('.map')) {
        const text = bytes.toString('utf8');
        if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) {
          throw new Error(`SOURCE_MAP_SECRET_SHAPE_DETECTED:${path.relative(root, file)}`);
        }
      }
      return {
        path: path.relative(root, file).replace(/\\/g, '/'),
        bytes: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));

  return {
    contractVersion: 'build29-source-map-manifest-v1',
    releaseId: identity.releaseId,
    sourceSha: identity.sourceSha,
    environment: identity.environment,
    generatedAt: new Date().toISOString(),
    provider: null,
    uploadState: 'BLOCKED_NEW_PROVIDER_CONFIGURATION',
    files,
  };
}

function main() {
  const validation = validateObservabilityBuildEnvironment(process.env);
  if (!validation.ok) {
    throw new Error(`OBSERVABILITY_BUILD_ENV_INVALID:${validation.errors.join('|')}`);
  }
  fs.rmSync(outputRoot, { recursive: true, force: true });
  const result = spawnSync(
    process.execPath,
    [path.join(repoRoot, 'node_modules', 'expo', 'bin', 'cli'), 'export', '--source-maps', '--platform', 'all', '--output-dir', outputRoot],
    { cwd: repoRoot, env: process.env, stdio: 'inherit' },
  );
  if (result.status !== 0) {
    throw new Error(`EXPO_SOURCE_MAP_EXPORT_FAILED:${result.status ?? result.error?.code ?? 'spawn_error'}`);
  }
  const manifest = buildSourceMapManifest(outputRoot, validation.identity);
  fs.writeFileSync(path.join(outputRoot, 'observability-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({
    status: 'SOURCE_MAP_PIPELINE_CONFIGURED',
    outputRoot,
    files: manifest.files.length,
    uploadState: manifest.uploadState,
  }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
