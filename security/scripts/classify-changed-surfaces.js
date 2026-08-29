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
  { tag: 'MOBILE', patterns: [/^app\//, /^components\//, /^hooks\//, /^contexts\//, /^android\//, /^ios\//, /^assets\//] },
  { tag: 'WEB', patterns: [/^app\//, /^components\//, /^public\//, /\.html$/, /^index\.web\./] },
  { tag: 'API', patterns: [/^server\.js$/, /^server\//, /^routes\//, /^api\//] },
  { tag: 'SUPABASE FUNCTION', patterns: [/^supabase\/functions\//] },
  { tag: 'DATABASE MIGRATION', patterns: [/^supabase\/migrations\//] },
  { tag: 'AUTH', patterns: [/auth/i, /login/i, /oauth/i, /session/i, /deletion/i, /privacy/i] },
  { tag: 'STORAGE', patterns: [/storage/i, /upload/i, /bucket/i] },
  { tag: 'BUILD/CI', patterns: [/\.github\//, /^scripts\//, /^package\.json$/, /^package-lock\.json$/, /^eas\.json$/, /^app\.config\./] },
  { tag: 'CONTROL PLANE', patterns: [/^security\//, /^__tests__\//, /^qa\//, /^\.zap\//, /^\.semgrep\//] },
  { tag: 'DOCUMENTATION ONLY', patterns: [/^docs\//, /^README/i, /\.md$/] },
];

const STAGING_IMPACT_TAGS = new Set([
  'WEB',
  'API',
  'SUPABASE FUNCTION',
  'DATABASE MIGRATION',
  'AUTH',
  'STORAGE',
]);

const CONTROL_PLANE_PATTERNS = [
  /^\.github\//,
  /^__tests__\//,
  /^docs\//,
  /^security\//,
  /^qa\//,
  /^\.zap\//,
  /^\.semgrep\//,
  /^(?:AGENTS|README|SECURITY|CONTRIBUTING)(?:\.[^/]+)?$/i,
];

function gitDiffFiles(baseRef, headRef = 'HEAD') {
  try {
    const out = execFileSync('git', ['diff', '--name-only', `${baseRef}...${headRef}`], { encoding: 'utf8' });
    return out.split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    const out = execFileSync('git', ['diff', '--name-only', `${headRef}~1`, headRef], { encoding: 'utf8' });
    return out.split('\n').map((l) => l.trim()).filter(Boolean);
  }
}

function classifyFile(filePath) {
  const tags = new Set();
  for (const classifier of CLASSIFIERS) {
    if (classifier.patterns.some((p) => p.test(filePath))) {
      tags.add(classifier.tag);
    }
  }
  if (tags.size === 0) {
    tags.add('MOBILE');
  }
  if ([...tags].every((t) => t === 'DOCUMENTATION ONLY' || t === 'BUILD/CI')) {
    return tags.has('BUILD/CI') ? [...tags] : ['DOCUMENTATION ONLY'];
  }
  return [...tags];
}

function main() {
  const baseRef = process.argv[2] || process.env.GITHUB_BASE_REF || 'origin/ios/full-submission-readiness-v2';
  const headRef = process.argv[3] || process.env.GITHUB_HEAD_REF_SHA || 'HEAD';
  const files = process.env.CHANGED_FILES
    ? process.env.CHANGED_FILES.split(',').map((f) => f.trim()).filter(Boolean)
    : gitDiffFiles(baseRef, headRef);

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
  const onlyMobile = [...allTags].every((t) => t === 'MOBILE' || t === 'DOCUMENTATION ONLY' || t === 'BUILD/CI');
  const releaseClass = files.length > 0 && files.every((file) => CONTROL_PLANE_PATTERNS.some((pattern) => pattern.test(file)))
    ? 'CONTROL_PLANE_CHANGE'
    : 'RUNTIME_RELEASE';
  // Generic surface tags (for example "auth" in a workflow filename) must
  // never grant deployment authority. The strict path allow-list defines a
  // control-plane candidate first; only runtime candidates can have staging
  // impact and reach the staging write job.
  // Anything outside the strict control-plane allow-list is release content.
  // Runtime dependency/build/config files (for example package.json or
  // eas.json) must never skip deployment merely because their display tag is
  // BUILD/CI rather than API/MOBILE.
  const stagingImpact = releaseClass === 'RUNTIME_RELEASE';

  // Orthogonal change-applicability fields, added alongside (never replacing)
  // stagingImpact/releaseClass above, which existing consumers keep reading
  // unchanged (security-staging-gate.yml's classify-changes job,
  // staging-release-certification.yml's classify step, and
  // stagingCertification.test.js's classifyFile/CONTROL_PLANE_PATTERNS
  // assertions). stagingImpact/releaseClass answer "is this release content
  // worth running staging validation for at all" -- a deliberately blunt,
  // deny-list-shaped question (DEF-REL-005: any file outside the strict
  // control-plane allow-list is RUNTIME_RELEASE, on purpose, so a build/
  // dependency file can never accidentally skip staging deployment again).
  // These new fields answer a narrower, orthogonal question: "does this diff
  // actually require backend/edge/migration deployment authority" -- which a
  // mobile-only PR (correctly RUNTIME_RELEASE/stagingImpact=true) does not.
  // They are computed the same way deploy-changed-functions.js and
  // apply-candidate-migrations.js actually select their targets: exclusively
  // supabase/functions/** and supabase/migrations/** respectively. Neither
  // script ever acts on server.js/services/** (the separate Render backend),
  // so backendDeploymentRequired intentionally excludes them.
  const edgeDeploymentRequired = allTags.has('SUPABASE FUNCTION');
  const migrationValidationRequired = allTags.has('DATABASE MIGRATION');
  const backendDeploymentRequired = edgeDeploymentRequired || migrationValidationRequired;
  const mobileRuntimeImpact = allTags.has('MOBILE');

  const result = {
    baseRef,
    changedFileCount: files.length,
    classifications: [...allTags].sort(),
    stagingImpact,
    mobileOnly: onlyMobile && !stagingImpact,
    releaseClass,
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

module.exports = { classifyFile, gitDiffFiles, CONTROL_PLANE_PATTERNS, STAGING_IMPACT_TAGS };
