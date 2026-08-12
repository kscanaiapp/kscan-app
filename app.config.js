const { execFileSync } = require('node:child_process');

const SHA_RE = /^[a-f0-9]{40}$/i;
const RELEASE_ID_RE = /^[A-Za-z0-9._-]{1,120}$/;
const BUILD_IDENTITY_RE = /^[A-Za-z0-9._-]{1,160}$/;
const ENVIRONMENTS = new Set(['development', 'staging', 'production']);

function firstValidSha(...values) {
  for (const value of values) {
    const normalized = String(value || '').trim().toLowerCase();
    if (SHA_RE.test(normalized)) return normalized;
  }
  return null;
}

function localSourceSha() {
  try {
    return firstValidSha(execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }));
  } catch {
    return null;
  }
}

/**
 * The build identifier a monitoring provider files artifacts under.
 *
 * MUST use the same precedence as `validateObservabilityBuildEnvironment` in
 * `scripts/verify-observability-build-env.mjs`, because that is what the
 * source-map upload passes as `--dist`. Sentry matches an event to its source
 * maps on the (release, dist) pair: if the runtime reports a different dist
 * from the one the artifacts were filed under, nothing ever symbolicates.
 */
function resolveBuildIdentifier() {
  const candidate = String(
    process.env.KSCAN_BUILD_IDENTIFIER || process.env.EAS_BUILD_ID || process.env.GITHUB_RUN_ID || '',
  ).trim();
  return BUILD_IDENTITY_RE.test(candidate) ? candidate : null;
}

function resolveEnvironment() {
  const explicit = String(process.env.KSCAN_OBSERVABILITY_ENVIRONMENT || '').trim().toLowerCase();
  if (ENVIRONMENTS.has(explicit)) return explicit;

  const profile = String(process.env.EAS_BUILD_PROFILE || '').trim().toLowerCase();
  if (profile === 'production') return 'production';
  if (profile === 'staging' || profile === 'preview') return 'staging';
  return 'development';
}

module.exports = ({ config }) => {
  const sourceSha = firstValidSha(
    process.env.KSCAN_SOURCE_SHA,
    process.env.EAS_BUILD_GIT_COMMIT_HASH,
    process.env.GITHUB_SHA,
  ) || localSourceSha();
  const releaseIdCandidate = String(process.env.KSCAN_RELEASE_ID || '').trim();
  const releaseId = RELEASE_ID_RE.test(releaseIdCandidate) ? releaseIdCandidate : null;
  const environment = resolveEnvironment();
  const existingExtra = config.extra && typeof config.extra === 'object' ? config.extra : {};

  return {
    ...config,
    extra: {
      ...existingExtra,
      observability: {
        contractVersion: 'build29-observability-v1',
        environment,
        releaseId,
        sourceSha,
        buildIdentifier: resolveBuildIdentifier(),
        sourceAttributionState: sourceSha && releaseId ? 'VERIFIABLE' : 'NOT_VERIFIABLE',
        replayEnabled: false,
      },
    },
  };
};
