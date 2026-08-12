#!/usr/bin/env node
// @ts-check
'use strict';

/**
 * Real runtime adapters for staging activation (DEF-REL-014).
 *
 * The orchestrator's adapters defaulted to null, and the CLI supplied none —
 * so a real EXECUTE would deterministically have produced
 * `health = OPERATIONAL_FAILURE`, absent certification and no persistence,
 * making STAGING_VERIFIED unreachable no matter how well the deployments went.
 * Dependency injection that only exists in tests proves nothing about the path
 * that actually runs.
 *
 * These are the implementations the CLI wires automatically.
 *
 * Node built-ins only (global fetch). No secret is ever logged or returned.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const STATUS = Object.freeze({
  PASS: 'PASS',
  BLOCKED: 'BLOCKED',
  NOT_APPLICABLE: 'NOT_APPLICABLE',
  OPERATIONAL_FAILURE: 'OPERATIONAL_FAILURE',
});

const DEFAULT_TIMEOUT_MS = 15_000;

/** Bounded fetch. A hang must surface as OPERATIONAL_FAILURE, never a stall. */
async function getJson(url, { headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { headers, signal: controller.signal });
    const text = await response.text();
    let body = null;
    let parseError = null;
    try {
      body = JSON.parse(text);
    } catch (error) {
      parseError = error.message;
    }
    return { ok: response.ok, status: response.status, body, parseError };
  } catch (error) {
    return { ok: false, status: 0, body: null, networkError: error.name === 'AbortError' ? 'timeout' : error.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Real health-contract-v1 probe.
 *
 * Nothing here is optimistic: a timeout, DNS failure, malformed JSON, non-2xx
 * readiness, or a `/version` body reporting NOT_VERIFIABLE all resolve to
 * OPERATIONAL_FAILURE. The parsed `/version` body is returned verbatim as
 * `versionBody` so `verifyExactCandidate` compares against what the deployment
 * actually said, not a summary of it.
 */
export function createHealthProbe({ stagingUrl, anonKey, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return async function probeHealth() {
    if (!stagingUrl) {
      const detail = 'SUPABASE_STAGING_URL is not configured';
      return {
        live: { status: STATUS.OPERATIONAL_FAILURE, detail },
        ready: { status: STATUS.OPERATIONAL_FAILURE, detail },
        version: { status: STATUS.OPERATIONAL_FAILURE, detail },
        versionBody: null,
      };
    }

    const base = `${String(stagingUrl).replace(/\/$/, '')}/functions/v1/staging-health`;
    const headers = anonKey ? { apikey: anonKey, Authorization: `Bearer ${anonKey}` } : {};

    const [live, ready, version] = await Promise.all([
      getJson(`${base}/health/live`, { headers, timeoutMs, fetchImpl }),
      getJson(`${base}/health/ready`, { headers, timeoutMs, fetchImpl }),
      getJson(`${base}/version`, { headers, timeoutMs, fetchImpl }),
    ]);

    const classify = (result, predicate, label) => {
      if (result.networkError) return { status: STATUS.OPERATIONAL_FAILURE, detail: `${label}: ${result.networkError}` };
      if (result.parseError) return { status: STATUS.OPERATIONAL_FAILURE, detail: `${label}: malformed JSON (${result.parseError})` };
      if (!result.body || typeof result.body !== 'object') {
        return { status: STATUS.OPERATIONAL_FAILURE, detail: `${label}: no JSON object body` };
      }
      if (!result.ok) return { status: STATUS.OPERATIONAL_FAILURE, detail: `${label}: HTTP ${result.status}` };
      return predicate(result.body)
        ? { status: STATUS.PASS }
        : { status: STATUS.OPERATIONAL_FAILURE, detail: `${label}: unexpected body shape` };
    };

    return {
      live: classify(live, (b) => b.status === 'alive' && b.environment === 'staging', 'live'),
      ready: classify(ready, (b) => b.status === 'ready' && b.environment === 'staging', 'ready'),
      version: classify(
        version,
        (b) => b.environment === 'staging' && b.releaseIdentityState === 'VERIFIABLE',
        'version',
      ),
      // Verbatim, including a NOT_VERIFIABLE body — the exact verifier must see
      // the real response and decide, rather than being handed a substitute.
      versionBody: version.body,
    };
  };
}

/**
 * Real staging-certification adapter.
 *
 * Consumes the repository's EXISTING canonical certification artifact rather
 * than recreating certification logic inside activation — a second
 * certification authority is precisely the drift DEF-REL-006 removed.
 *
 * Returns `{ ok, certification, detail }`. A missing, unreadable or malformed
 * report is an OPERATIONAL_FAILURE, never a silent null.
 */
export function createCertificationLoader({ reportPath, repoRoot, exec = spawnSync, generate = false } = {}) {
  return function loadCertification() {
    const target = reportPath || path.join(repoRoot, 'security', 'reports', 'staging-certification.json');

    if (generate && !fs.existsSync(target)) {
      const result = exec('node', [path.join('security', 'scripts', 'build-staging-certification.js')], {
        cwd: repoRoot, encoding: 'utf8',
      });
      if (result.status !== 0) {
        return { ok: false, certification: null, detail: `certification build exited ${result.status}` };
      }
    }

    if (!fs.existsSync(target)) {
      return { ok: false, certification: null, detail: `no staging certification report at ${target}` };
    }

    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    } catch (error) {
      return { ok: false, certification: null, detail: `certification report is not valid JSON: ${error.message}` };
    }

    // Shape check: the normalizer reads these, and a silently-wrong shape would
    // otherwise look like "no findings".
    const required = ['final_verdict', 'blocking_findings', 'operational_failures'];
    const missing = required.filter((k) => !(k in parsed));
    if (missing.length > 0) {
      return { ok: false, certification: null, detail: `certification report is missing: ${missing.join(', ')}` };
    }
    for (const key of ['blocking_findings', 'operational_failures']) {
      if (!Array.isArray(parsed[key])) {
        return { ok: false, certification: null, detail: `certification.${key} must be an array` };
      }
    }

    return { ok: true, certification: parsed, detail: null };
  };
}

/**
 * Real GitHub adapter for the verified release package, built on the `gh` CLI
 * so it inherits the workflow's GITHUB_TOKEN rather than needing a PAT.
 *
 * `readOnly` omits every mutating operation, so the same adapter can safely
 * back prior-baseline discovery during PLAN_ONLY.
 */
export function createGithubAdapter({ repo, exec = spawnSync, readOnly = false, env = process.env } = {}) {
  const gh = (args, input) => {
    const result = exec('gh', args, { encoding: 'utf8', env, input });
    if (result.status !== 0) {
      throw new Error(`gh ${args[0]} ${args[1] || ''} failed (${result.status}): ${String(result.stderr || '').slice(0, 400)}`);
    }
    return String(result.stdout || '');
  };

  const mutating = (name) => () => {
    throw new Error(`${name} is unavailable: this adapter is read-only`);
  };

  return {
    listTags: async ({ prefix }) => {
      const out = gh(['api', `repos/${repo}/git/matching-refs/tags/${prefix}`, '--jq', '.[].ref']);
      return out.split(/\r?\n/).filter(Boolean)
        .map((ref) => ({ tag: ref.replace('refs/tags/', '') }))
        .reverse(); // most recent last from the API; callers want newest first
    },
    resolveTagCommit: async ({ tag }) => gh(['api', `repos/${repo}/git/ref/tags/${tag}`, '--jq', '.object.sha']).trim(),
    getAsset: async ({ tag, name }) => gh(['release', 'download', tag, '--repo', repo, '--pattern', name, '--output', '-']),
    createTag: readOnly ? mutating('createTag') : async () => { /* created implicitly by `gh release create --target` */ },
    createRelease: readOnly ? mutating('createRelease') : async ({ tag, name, prerelease, body, target }) => {
      const args = ['release', 'create', tag, '--repo', repo, '--title', name, '--notes', body];
      if (prerelease) args.push('--prerelease');
      if (target) args.push('--target', target);
      gh(args);
    },
    uploadAsset: readOnly ? mutating('uploadAsset') : async ({ tag, name, body }) => {
      const tmp = path.join(env.RUNNER_TEMP || process.cwd(), name);
      fs.writeFileSync(tmp, body);
      try {
        gh(['release', 'upload', tag, tmp, '--repo', repo, '--clobber']);
      } finally {
        try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
      }
    },
  };
}

export default { STATUS, createHealthProbe, createCertificationLoader, createGithubAdapter };
