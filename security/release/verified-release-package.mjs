#!/usr/bin/env node
// @ts-check
'use strict';

/**
 * Verified staging release package — durable persistence and retrieval.
 *
 * Closes VERIFIED_BASELINE_PERSISTENCE_GAP: a minted baseline is useless to a
 * future change-scoped release unless that release can actually retrieve the
 * baseline AND the release evidence it was minted from.
 *
 * WHY A GITHUB RELEASE, NOT A COMMIT: committing evidence onto
 * staging/production-parity would move the source tree after the release was
 * verified, so the verified candidate SHA would no longer be branch HEAD and
 * the next freeze would describe a different tree. The package is therefore
 * anchored to the exact verified commit by tag, and the source branch is never
 * touched.
 *
 * ─── WHAT THIS IS AND IS NOT ────────────────────────────────────────────────
 *
 * GitHub release assets are DURABLE OPERATIONAL EVIDENCE. They are not
 * cryptographically immutable, not signed, not WORM storage, and this module
 * claims none of those things. A repository admin can delete or replace an
 * asset. What retrieval does guarantee is that a package which has been
 * tampered with cannot silently authorize carry-forward: digests are
 * recomputed, the tag must point at the expected commit, and baseline and
 * evidence must corroborate each other under the Phase 2B.2 rules.
 *
 * Signing/attestation (OIDC, artifact attestations, HMAC envelopes, append-only
 * external storage) is deliberately left to Phase 3.
 *
 * Node built-ins only. The GitHub adapter is injected, so unit tests never
 * touch the network.
 */

import crypto from 'node:crypto';

import baselineModule from './verified-baseline.js';
import evidenceModule from './build-release-evidence.js';

const { validateVerifiedBaseline } = baselineModule;
const { verifyEvidenceIntegrity } = evidenceModule;

export const PACKAGE_SCHEMA_VERSION = 1;

/** Asset names inside a staging verified release. Stable: retrieval looks them up by name. */
export const ASSET_NAMES = Object.freeze({
  baseline: 'verified-baseline.json',
  evidence: 'release-evidence.json',
  receipt: 'deployment-receipt.json',
  manifest: 'frozen-manifest.json',
});

/**
 * Staging tag convention. Deliberately prefixed so it can never collide with
 * mobile/app version tags (v1.0.1, android-v27, ios-readiness-baseline, ...).
 */
export const STAGING_TAG_PREFIX = 'staging-verified-';

export class VerifiedPackageError extends Error {
  constructor(message, code, detail) {
    super(message);
    this.name = 'VerifiedPackageError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

/** `staging-verified-<shortsha>-<sanitized release id>` */
export function buildStagingTag({ candidateSha, releaseId }) {
  if (!/^[a-f0-9]{40}$/.test(String(candidateSha || ''))) {
    throw new VerifiedPackageError(`candidateSha must be a 40-hex SHA, got ${candidateSha}`, 'INVALID_CANDIDATE_SHA');
  }
  const suffix = String(releaseId || '').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80);
  if (!suffix) throw new VerifiedPackageError('releaseId is required to build a tag', 'INVALID_RELEASE_ID');
  return `${STAGING_TAG_PREFIX}${candidateSha.slice(0, 12)}-${suffix}`;
}

export function isStagingVerifiedTag(tag) {
  return typeof tag === 'string' && tag.startsWith(STAGING_TAG_PREFIX);
}

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * Assembles the package payload. Pure — no I/O — so its contents are testable.
 */
export function buildPackage({ baseline, evidence, receipt, manifest, candidateSha, releaseId }) {
  if (!baseline || !evidence || !receipt || !manifest) {
    throw new VerifiedPackageError('baseline, evidence, receipt and manifest are all required', 'INCOMPLETE_PACKAGE');
  }
  const assets = {
    [ASSET_NAMES.baseline]: JSON.stringify(baseline, null, 2),
    [ASSET_NAMES.evidence]: JSON.stringify(evidence, null, 2),
    [ASSET_NAMES.receipt]: JSON.stringify(receipt, null, 2),
    [ASSET_NAMES.manifest]: JSON.stringify(manifest, null, 2),
  };
  return {
    schemaVersion: PACKAGE_SCHEMA_VERSION,
    tag: buildStagingTag({ candidateSha, releaseId }),
    candidateSha,
    releaseId,
    assets,
    assetDigests: Object.fromEntries(Object.entries(assets).map(([name, body]) => [name, sha256(body)])),
  };
}

/**
 * Publishes the package, in the order the brief requires: nothing durable is
 * created until verification has already succeeded, and the result is only
 * PASS after the uploaded assets are read back and their digests re-checked.
 *
 * @param {object} opts
 * @param {object} opts.pkg      - from buildPackage()
 * @param {object} opts.github   - injected adapter { createTag, createRelease, uploadAsset, getAsset }
 * @param {boolean} [opts.planOnly]
 */
export async function publishPackage({ pkg, github, planOnly = false }) {
  if (planOnly) {
    return {
      ok: true, planOnly: true, persisted: false,
      plan: { tag: pkg.tag, candidateSha: pkg.candidateSha, assets: Object.keys(pkg.assets), prerelease: true },
    };
  }

  const failures = [];
  try {
    await github.createTag({ tag: pkg.tag, sha: pkg.candidateSha });
    await github.createRelease({
      tag: pkg.tag,
      name: `Staging verified — ${pkg.releaseId}`,
      prerelease: true, // never the repository's "latest" release
      body: [
        `Staging verified release package for candidate \`${pkg.candidateSha}\`.`,
        '',
        'Durable operational evidence for backend release carry-forward.',
        'NOT cryptographically signed and NOT immutable storage — see',
        'docs/release/STAGING_RELEASE_VERIFICATION.md.',
      ].join('\n'),
    });
    for (const [name, body] of Object.entries(pkg.assets)) {
      await github.uploadAsset({ tag: pkg.tag, name, body });
    }
  } catch (error) {
    failures.push({ code: 'PUBLISH_FAILED', detail: error.message });
    return { ok: false, persisted: false, code: 'VERIFIED_BASELINE_PERSISTENCE_GAP', failures };
  }

  // Read back and re-verify: an upload that "succeeded" but stored something
  // else is exactly the case this catches.
  for (const [name, expectedDigest] of Object.entries(pkg.assetDigests)) {
    let body;
    try {
      body = await github.getAsset({ tag: pkg.tag, name });
    } catch (error) {
      failures.push({ code: 'READBACK_FAILED', detail: `${name}: ${error.message}` });
      continue;
    }
    if (sha256(body) !== expectedDigest) {
      failures.push({ code: 'READBACK_DIGEST_MISMATCH', detail: name });
    }
  }

  if (failures.length > 0) {
    return { ok: false, persisted: false, code: 'VERIFIED_BASELINE_PERSISTENCE_GAP', failures };
  }
  return { ok: true, persisted: true, tag: pkg.tag, assetDigests: pkg.assetDigests };
}

/**
 * Retrieves and fully validates the prior verified staging package.
 *
 * Naming is never trusted: the tag must resolve to the commit the baseline
 * claims, both artifacts must pass their own integrity checks, and the pair
 * must corroborate under the Phase 2B.2 rules before anything is returned.
 *
 * @returns {Promise<{ok: boolean, errors: string[], bundle: object|null}>}
 */
export async function loadPriorVerifiedRelease({ github, tag = null, manifest = null }) {
  const errors = [];

  let resolvedTag = tag;
  try {
    if (!resolvedTag) {
      const tags = await github.listTags({ prefix: STAGING_TAG_PREFIX });
      const candidates = (tags || []).filter((t) => isStagingVerifiedTag(t.tag || t));
      if (candidates.length === 0) {
        return { ok: false, errors: ['no staging verified release found'], bundle: null };
      }
      // Most recent first, as provided by the adapter.
      resolvedTag = candidates[0].tag || candidates[0];
    }
  } catch (error) {
    return { ok: false, errors: [`tag discovery failed: ${error.message}`], bundle: null };
  }

  if (!isStagingVerifiedTag(resolvedTag)) {
    return { ok: false, errors: [`tag ${resolvedTag} is not a staging verified tag`], bundle: null };
  }

  /** @type {any} */
  let baseline = null;
  /** @type {any} */
  let evidence = null;
  let tagSha = null;

  try {
    tagSha = await github.resolveTagCommit({ tag: resolvedTag });
    baseline = JSON.parse(await github.getAsset({ tag: resolvedTag, name: ASSET_NAMES.baseline }));
    evidence = JSON.parse(await github.getAsset({ tag: resolvedTag, name: ASSET_NAMES.evidence }));
  } catch (error) {
    return { ok: false, errors: [`retrieval failed: ${error.message}`], bundle: null };
  }

  if (!baseline) errors.push('baseline asset missing');
  if (!evidence) errors.push('evidence asset missing');
  if (errors.length > 0) return { ok: false, errors, bundle: null };

  // The tag must anchor the exact commit the baseline claims.
  if (tagSha !== baseline.sourceSha) {
    errors.push(`tag ${resolvedTag} points at ${tagSha} but the baseline claims ${baseline.sourceSha}`);
  }

  const evidenceIntegrity = verifyEvidenceIntegrity(evidence);
  if (!evidenceIntegrity.valid) errors.push(`evidence integrity: ${evidenceIntegrity.reason}`);

  // The decisive check — corroboration, not naming and not a lone checksum.
  const validation = validateVerifiedBaseline(baseline, { manifest, priorReleaseEvidence: evidence });
  if (!validation.valid) errors.push(...validation.errors);

  if (errors.length > 0) return { ok: false, errors, bundle: null };

  return {
    ok: true,
    errors: [],
    bundle: { tag: resolvedTag, sourceSha: tagSha, baseline, evidence },
  };
}

export default {
  PACKAGE_SCHEMA_VERSION,
  ASSET_NAMES,
  STAGING_TAG_PREFIX,
  VerifiedPackageError,
  buildStagingTag,
  isStagingVerifiedTag,
  buildPackage,
  publishPackage,
  loadPriorVerifiedRelease,
};
