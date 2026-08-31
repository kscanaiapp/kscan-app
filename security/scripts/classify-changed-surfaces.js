#!/usr/bin/env node
'use strict';

/**
 * Classifies changed files into staging-impact surfaces for PR gating.
 * Node built-ins only.
 *
 * Usage:
 *   node security/scripts/classify-changed-surfaces.js [baseRef]
 *
 * Outputs JSON to stdout with classifications and stagingImpact boolean.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

const CLASSIFIERS = [
  // Known client surfaces. Listed explicitly so UNKNOWN keeps meaning
  // "the classifier does not recognise this path" rather than becoming the
  // catch-all for ordinary app code.
  { tag: 'MOBILE', patterns: [/^app\//, /^components\//, /^hooks\//, /^contexts\//, /^android\//, /^ios\//, /^assets\//, /^services\//, /^stores\//, /^constants\//, /^types\//, /^utils\//, /^src\//, /^modules\//, /^__tests__\//, /^__mocks__\//] },
  { tag: 'WEB', patterns: [/^app\//, /^components\//, /^public\//, /\.html$/, /^index\.web\./] },
  { tag: 'API', patterns: [/^server\.js$/, /^server\//, /^routes\//, /^api\//] },
  { tag: 'SUPABASE FUNCTION', patterns: [/^supabase\/functions\//] },
  { tag: 'DATABASE MIGRATION', patterns: [/^supabase\/migrations\//] },
  { tag: 'AUTH', patterns: [/auth/i, /login/i, /oauth/i, /session/i, /deletion/i, /privacy/i] },
  { tag: 'STORAGE', patterns: [/storage/i, /upload/i, /bucket/i] },
  { tag: 'BUILD/CI', patterns: [/\.github\//, /^scripts\//, /^package\.json$/, /^package-lock\.json$/, /^eas\.json$/, /^app\.config\./] },
  // SECURITY/GOVERNANCE. Before this existed, security/** matched no pattern at
  // all and fell through to the MOBILE default -- so a change to the promotion
  // gate, the classifier itself, a baseline or a perimeter manifest was
  // classified as ordinary mobile UI. Governance changes are the LAST thing that
  // should inherit a permissive default.
  { tag: 'SECURITY/GOVERNANCE', patterns: [/^security\//, /^config\/backend-authority\.json$/, /^config\/edge-function-manifest\.json$/, /^supabase\/config\.toml$/] },
  { tag: 'DOCUMENTATION ONLY', patterns: [/^docs\//, /^README/i, /\.md$/] },
];

/**
 * Tags that must never be silently downgraded to DOCUMENTATION ONLY, and whose
 * presence means the diff is governance-sensitive even though it deploys
 * nothing. Kept separate from STAGING_IMPACT_TAGS: these do not require a
 * staging write, they require that checks are not waived.
 */
const GOVERNANCE_SENSITIVE_TAGS = new Set(['BUILD/CI', 'SECURITY/GOVERNANCE', 'UNKNOWN']);

const STAGING_IMPACT_TAGS = new Set([
  'WEB',
  'API',
  'SUPABASE FUNCTION',
  'DATABASE MIGRATION',
  'AUTH',
  'STORAGE',
]);

/**
 * Raised when the diff cannot be established. Callers must FAIL CLOSED on this:
 * an unresolvable base is not an empty diff, and an empty diff would waive every
 * check.
 */
class ClassificationAuthorityError extends Error {}

/**
 * True when `ref` names a real commit in this checkout.
 *
 * execFileSync, NOT execSync: this runs through no shell, so the `^{commit}`
 * peel survives verbatim. Through cmd.exe on Windows `^` is the escape
 * character and the suffix silently became `{commit}`, so every ref failed to
 * resolve -- a portability trap worth not re-introducing.
 */
function refResolves(ref) {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the base to diff against, trying only spellings of the SAME ref.
 *
 * actions/checkout does not always create a remote-tracking branch for a PR's
 * base, so `origin/<base>` can be unresolvable even at fetch-depth 0. Previously
 * that hit a silent `HEAD~1 HEAD` fallback which answered a DIFFERENT question;
 * that fallback is gone.
 *
 * The merge-commit case here is not a guess. On a pull_request event
 * actions/checkout checks out the MERGE commit, whose FIRST parent is by
 * definition the base tip -- so `HEAD^1` is exactly the base, not an
 * approximation of it. It is used only when HEAD really is a merge commit.
 *
 * Returns null when nothing resolves, and the caller fails closed.
 */
function resolveBaseRef(requested) {
  const candidates = [];
  if (requested) {
    candidates.push(requested);
    if (requested.startsWith('origin/')) candidates.push(requested.slice('origin/'.length));
    else candidates.push(`origin/${requested}`);
    candidates.push(`refs/remotes/${requested}`);
  }
  for (const candidate of candidates) {
    if (refResolves(candidate)) return candidate;
  }
  // Merge commit -> first parent IS the base.
  try {
    const parents = execFileSync('git', ['rev-list', '--parents', '-n', '1', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim().split(/\s+/);
    if (parents.length >= 3) return parents[1];
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Resolve the changed-file set.
 *
 * --no-renames is deliberate. With rename detection on, `git diff --name-only`
 * reports only the DESTINATION path, so a migration renamed OUT of
 * supabase/migrations/ (or an Edge function moved out of supabase/functions/)
 * would stop classifying as a migration/function change -- exactly the surface
 * whose validation must not become skippable. With renames off a rename is a
 * delete plus an add, so BOTH paths are classified and applicability stays
 * conservative. Deletions already report their own path.
 *
 * The previous silent fallback to `HEAD~1 HEAD` is REMOVED: it answered a
 * DIFFERENT question than the caller asked. If the base was unresolvable it
 * classified the last commit instead of the branch, which on a multi-commit
 * branch can report no migrations for a PR that contains one. resolveBaseRef
 * only ever tries other spellings of the SAME ref, or the merge commit's first
 * parent -- which IS the base by definition, not an approximation.
 */
function gitDiffFiles(baseRef) {
  const resolved = resolveBaseRef(baseRef);
  if (!resolved) {
    throw new ClassificationAuthorityError(
      `cannot resolve a base to diff against (requested "${baseRef}"). ` +
      'Refusing to classify: an unresolvable base is not an empty diff, and an ' +
      'empty diff would waive every check.',
    );
  }
  let out;
  try {
    out = execFileSync('git', ['diff', '--no-renames', '--name-only', `${resolved}...HEAD`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const detail = error && error.message ? String(error.message).split('\n')[0] : 'unknown';
    throw new ClassificationAuthorityError(
      `cannot diff against resolved base "${resolved}": ${detail}`,
    );
  }
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

function classifyFile(filePath) {
  const tags = new Set();
  for (const classifier of CLASSIFIERS) {
    if (classifier.patterns.some((p) => p.test(filePath))) {
      tags.add(classifier.tag);
    }
  }
  // FAIL CONSERVATIVE, not convenient. An unrecognised path used to default to
  // MOBILE -- a benign, low-enforcement category -- which meant any file the
  // pattern table did not anticipate could quietly lower the bar. UNKNOWN is
  // deliberately not benign: it is governance-sensitive, so a check is never
  // waived because the classifier did not recognise a path.
  if (tags.size === 0) {
    tags.add('UNKNOWN');
  }
  // The BUILD/CI -> DOCUMENTATION ONLY collapse is REMOVED. It meant a change to
  // a workflow, a build script, package.json or eas.json was reported as
  // documentation, which is what let CI/governance edits inherit the
  // documentation-only exemptions. Documentation-only must mean exactly that.
  return [...tags];
}

function main() {
  const baseRef = process.argv[2] || process.env.GITHUB_BASE_REF || 'origin/ios/full-submission-readiness-v2';
  const files = process.env.CHANGED_FILES
    ? process.env.CHANGED_FILES.split(',').map((f) => f.trim()).filter(Boolean)
    : gitDiffFiles(baseRef);

  const fileClassifications = files.map((file) => ({
    file,
    classifications: classifyFile(file),
  }));

  const allTags = new Set();
  for (const entry of fileClassifications) {
    for (const tag of entry.classifications) {
      allTags.add(tag);
    }
  }

  const onlyDocs = files.length > 0 && [...allTags].every((t) => t === 'DOCUMENTATION ONLY');
  // mobileOnly must not absorb governance-sensitive tags. BUILD/CI used to
  // count as "mobile only", so a workflow or build-script change inherited the
  // mobile-only relaxations.
  const onlyMobile = files.length > 0
    && [...allTags].every((t) => t === 'MOBILE' || t === 'WEB' || t === 'DOCUMENTATION ONLY')
    && ![...allTags].some((t) => GOVERNANCE_SENSITIVE_TAGS.has(t));
  const stagingImpact = !onlyDocs && [...allTags].some((t) => STAGING_IMPACT_TAGS.has(t));

  // Orthogonal change-applicability fields, added alongside (never replacing)
  // stagingImpact above, which every existing consumer keeps reading unchanged
  // (security-staging-gate.yml's classify-changes job, and this script's own
  // classifyFile/STAGING_IMPACT_TAGS assertions). stagingImpact answers "is
  // this release content worth running staging validation for at all" -- a
  // deliberately blunt question, true for a mobile-only diff.
  //
  // These fields answer a narrower one: "does this diff actually require
  // backend/edge/migration deployment authority" -- which a mobile-only PR
  // does not. They are computed the same way deploy-changed-functions.js and
  // apply-candidate-migrations.js actually select their targets: exclusively
  // supabase/functions/** and supabase/migrations/** respectively. Neither
  // script ever acts on server.js/services/** (the separate Render backend),
  // so backendDeploymentRequired intentionally excludes them.
  //
  // Because both source tags are already members of STAGING_IMPACT_TAGS,
  // backendDeploymentRequired is a strict subset of stagingImpact: swapping a
  // deploy gate from the latter to the former can only ever narrow what
  // reaches a real staging write, never widen it.
  const edgeDeploymentRequired = allTags.has('SUPABASE FUNCTION');
  const migrationValidationRequired = allTags.has('DATABASE MIGRATION');
  const backendDeploymentRequired = edgeDeploymentRequired || migrationValidationRequired;
  const mobileRuntimeImpact = allTags.has('MOBILE');

  // ── Canonical check-applicability contract (CI-APPLICABILITY-001) ─────────
  //
  // ONE authority for "does this check apply to this diff". The staging
  // workflow's job-level `if:` conditions and the Promotion Gate's required-set
  // must not answer this question independently, or they drift -- and when they
  // drift, the gate reads a legitimately-absent check as a missing one (or, far
  // worse, waives a check that should have run).
  //
  // Each entry mirrors the governing condition in
  // .github/workflows/security-staging-gate.yml EXACTLY.
  // __tests__/security/checkApplicability.test.js asserts that correspondence,
  // so changing one without the other fails.
  //
  // Absent from this map == unconditionally applicable. That is the safe
  // default: a check is required unless something here proves otherwise.
  const documentationOnly = onlyDocs;
  const checkApplicability = {
    // if: contains(classifications, 'DATABASE MIGRATION')
    'Migration validation': migrationValidationRequired,
    // if: backend_deployment_required == 'true' && deploy-staging success
    'Staging health checks': backendDeploymentRequired,
    // if: ... && deploy-staging success && staging-health success|skipped
    'Synthetic auth tests': backendDeploymentRequired,
    // if: enforcement_level != 'NORMAL_PR' || classifications != 'DOCUMENTATION ONLY'
    // Enforcement level is resolved separately and can only WIDEN applicability,
    // so documentation-only is the sole condition that can make this
    // non-applicable. A CI/governance diff is NOT documentation-only, which is
    // what makes this repair self-applying.
    'Contract tests': !documentationOnly,
  };

  const result = {
    baseRef,
    changedFileCount: files.length,
    classifications: [...allTags].sort(),
    documentationOnly,
    governanceSensitive: [...allTags].some((t) => GOVERNANCE_SENSITIVE_TAGS.has(t)),
    checkApplicability,
    stagingImpact,
    mobileOnly: onlyMobile && !stagingImpact,
    backendDeploymentRequired,
    edgeDeploymentRequired,
    migrationValidationRequired,
    mobileRuntimeImpact,
    fileClassifications,
  };

  const outputPath = process.env.CLASSIFICATION_OUTPUT;
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (outputPath) {
    fs.writeFileSync(outputPath, json, 'utf8');
  }
  process.stdout.write(json);
}

if (require.main === module) {
  main();
}

module.exports = {
  classifyFile,
  resolveBaseRef,
  gitDiffFiles,
  STAGING_IMPACT_TAGS,
  GOVERNANCE_SENSITIVE_TAGS,
  ClassificationAuthorityError,
};
