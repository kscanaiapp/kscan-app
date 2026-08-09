#!/usr/bin/env node
'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const MASTER = 'origin/master';
const STAGING = 'origin/staging/production-parity';
const OUTPUT = 'security/release/master-staging-provenance-map.json';

const BUILD25_COMMITS = new Set([
  '08015e7', '5ddd05e', 'f38e470', 'a6d0b55', '662effd', 'f69f709', '507cec9',
  '66e2757', '8ed440c', '2aedd79', 'a6cb2a4', '061f546', 'a242450', '969afbc',
  '9618537', '3aadd57', '1ee759c', 'e2531ea', '4a0b349', '43aabaa', 'd5ccc29', '1f9b452',
]);
const MASTER_BUILD25_LAUNCHER = new Set([
  '19688e1', '915e7dc', '969d44a', '2efee7c', '813309d', '39946ea',
]);
const QUARANTINE_PATH = /(?:privacy-controls|public-sale-share-opt-out|product-match|provenance-exceptions|staging-state-manifest)/i;
const CONTROL_PLANE_PATH = /^(?:\.github\/|docs\/|security\/|__tests__\/|scripts\/(?:qa-|check-|verify-|run-)|AGENTS\.md)/;
const RUNTIME_PATH = /^(?:app\/|components\/|contexts\/|hooks\/|lib\/|modules\/|services\/|server\/|supabase\/(?:functions|migrations)\/|types\/|constants\/|assets\/|android\/|ios\/|server\.js$|app\.json$|app\.config\.|package(?:-lock)?\.json$|eas\.json$|render\.yaml$|\.env\.example$)/;

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function lines(value) {
  return value ? value.split(/\r?\n/).filter(Boolean) : [];
}

function treeBlobs(ref) {
  return new Map(lines(git(['ls-tree', '-r', ref])).map((line) => {
    const match = line.match(/^\d+\s+blob\s+([0-9a-f]+)\t(.+)$/);
    return match ? [match[2], match[1]] : [line, null];
  }));
}

const HEAD_BLOBS = { master: null, staging: null };

function allEquivalent(files) {
  return files.length > 0 && files.every((file) => {
    const a = HEAD_BLOBS.master.get(file);
    const b = HEAD_BLOBS.staging.get(file);
    return Boolean(a && a === b);
  });
}

function masterDisposition(short, files, subject) {
  if (MASTER_BUILD25_LAUNCHER.has(short) || (files.includes('.github/workflows/ios-maestro-local.yml') && /maestro/i.test(subject))) return {
    disposition: 'BUILD25_EXCLUDE', purpose: 'Build 2.5-only iOS Maestro launcher maintenance',
    reason: 'The workflow checks out test/ios-build25-maestro-runtime and runs ios-build25 flows.', confidence: 'HIGH',
  };
  if (allEquivalent(files)) return {
    disposition: 'ALREADY_EQUIVALENT', purpose: subject,
    reason: 'Every changed path has identical blob identity at the current master and staging heads.', confidence: 'HIGH',
  };
  if (['3a345a9', 'ad42e6e'].includes(short)) return {
    disposition: 'DUPLICATE_IMPLEMENTATION', purpose: 'Disable demo catalog products by default',
    reason: 'Current staging independently contains INCLUDE_DEMO_CATALOG=false-by-default behavior in its newer server implementation.', confidence: 'HIGH',
  };
  if (['fc7fa00','2376dad','d07adea','2891215','7aff81d','18b0d78','51aef6f'].includes(short)) return {
    disposition: 'REQUIRES_OWNER_DECISION', purpose: 'Legacy scan-identify gateway contract and boundary clarifications',
    reason: 'Staging has a substantially newer scan-identify implementation; contract equivalence is not proven and a blind port could regress current commerce/security behavior.', confidence: 'HIGH',
  };
  if (['260219c'].includes(short)) return {
    disposition: 'REQUIRES_OWNER_DECISION', purpose: 'Retire the legacy Render /api/analyze route',
    reason: 'Current staging clients and server still implement /api/analyze; removal is a product/runtime decision, not safe release automation reconciliation.', confidence: 'HIGH',
  };
  if (['22cf6d8','5846dfb','9bb0b57'].includes(short)) return {
    disposition: 'REQUIRES_OWNER_DECISION', purpose: 'Render transactional email and account-restoration delivery',
    reason: 'The feature is absent from staging and touches external email/hosting behavior; its authoritative deployment lineage cannot be proven in this pass.', confidence: 'HIGH',
  };
  if (short === '3cc31ed') return {
    disposition: 'CONTROL_PLANE_ONLY', purpose: 'Master promotion governance bootstrap',
    reason: 'Shared promotion files are already content-equivalent; master-required-checks remains intentional master-only governance.', confidence: 'HIGH',
  };
  if (['749a59d','e3cf869','cda5eaf'].includes(short)) return {
    disposition: allEquivalent(files) ? 'ALREADY_EQUIVALENT' : 'CONTROL_PLANE_ONLY', purpose: subject,
    reason: 'Release-governance maintenance; shared files are retained on both branches and master-only checks remain branch-specific.', confidence: 'HIGH',
  };
  return {
    disposition: files.every((file) => CONTROL_PLANE_PATH.test(file)) ? 'CONTROL_PLANE_ONLY' : 'REQUIRES_OWNER_DECISION',
    purpose: subject,
    reason: 'No automatic runtime port is authorized without cluster-specific provenance proof.', confidence: 'MEDIUM',
  };
}

function stagingDisposition(short, files, subject) {
  if (BUILD25_COMMITS.has(short)) return {
    disposition: 'BUILD25_EXCLUDE', purpose: subject,
    reason: 'Direct contribution of the certified Build 2.5 merge or its global EAS activation; branch separation is mandatory.', confidence: 'HIGH',
  };
  if (files.some((file) => QUARANTINE_PATH.test(file))) return {
    disposition: 'QUARANTINE_EXCLUDE', purpose: subject,
    reason: 'Touches Issue #46 or Issue #72 quarantine records; preserve the control but do not use this history to restore quarantined runtime source.', confidence: 'HIGH',
  };
  if (files.length && files.every((file) => CONTROL_PLANE_PATH.test(file))) return {
    disposition: 'CONTROL_PLANE_ONLY', purpose: subject,
    reason: 'Staging release/security/test/documentation control; keep on staging unless separately proven appropriate for master.', confidence: 'HIGH',
  };
  return {
    disposition: 'KEEP_FROM_STAGING', purpose: subject,
    reason: files.some((file) => RUNTIME_PATH.test(file))
      ? 'Part of the current staging runtime line; it must be certified as a whole rather than bulk cherry-picked by history.'
      : 'Staging-only content with no proven master replacement; preserve pending release-tree certification.',
    confidence: 'MEDIUM',
  };
}

function history(range) {
  const output = execFileSync('git', [
    'log', '--reverse', '--diff-merges=first-parent', '--format=@@%H%x1f%P%x1f%s', '--name-only', range,
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const records = [];
  let current = null;
  for (const raw of output.split(/\r?\n/)) {
    if (raw.startsWith('@@')) {
      const [sha, parentText, ...subjectParts] = raw.slice(2).split('\x1f');
      current = { sha, parents: parentText ? parentText.split(' ') : [], subject: subjectParts.join('\x1f'), files: [] };
      records.push(current);
    } else if (raw && current) {
      current.files.push(raw);
    }
  }
  return records;
}

function commits(range, branchOrigin) {
  return history(range).map(({ sha, parents, subject, files }) => {
    const short = sha.slice(0, 7);
    const classification = branchOrigin === 'master'
      ? masterDisposition(short, files, subject)
      : stagingDisposition(short, files, subject);
    return {
      commit_sha: sha,
      branch_origin: branchOrigin,
      subject,
      merge_commit: parents.length > 1,
      files_changed: files,
      functional_purpose: classification.purpose,
      surface: files.some((file) => RUNTIME_PATH.test(file)) ? 'RUNTIME_OR_RUNTIME_CONFIG' : 'CONTROL_PLANE_OR_NON_RUNTIME',
      content_equivalent_at_heads: allEquivalent(files),
      build25_relationship: classification.disposition === 'BUILD25_EXCLUDE' ? 'DIRECT_OR_PINNED_DEPENDENCY' : 'NONE_PROVEN',
      quarantine_relationship: files.some((file) => QUARANTINE_PATH.test(file)) ? 'DIRECT_CONTROL_OR_RECORD' : 'NONE_PROVEN',
      security_relevance: files.some((file) => /(?:security|auth|privacy|supabase|server|\.github)/i.test(file)) ? 'YES' : 'NO_DIRECT_SIGNAL',
      recommended_disposition: classification.disposition,
      rationale: classification.reason,
      confidence: classification.confidence,
      evidence: [`git show --stat ${sha}`, `first-parent changed paths (${files.length})`, 'current-head blob comparison'],
    };
  });
}

function countBy(entries, key) {
  return entries.reduce((acc, item) => {
    const value = item[key];
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

function main() {
  const masterSha = git(['rev-parse', MASTER]);
  const stagingSha = git(['rev-parse', STAGING]);
  const mergeBase = git(['merge-base', MASTER, STAGING]);
  HEAD_BLOBS.master = treeBlobs(MASTER);
  HEAD_BLOBS.staging = treeBlobs(STAGING);
  const entries = [
    ...commits(`${STAGING}..${MASTER}`, 'master'),
    ...commits(`${MASTER}..${STAGING}`, 'staging'),
  ];
  const report = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    repository: 'kscanaiapp/kscan-app',
    refs: { master: MASTER, master_sha: masterSha, staging: STAGING, staging_sha: stagingSha, merge_base_sha: mergeBase },
    classification_policy: {
      allowed_dispositions: ['KEEP_FROM_MASTER','KEEP_FROM_STAGING','ALREADY_EQUIVALENT','CONTROL_PLANE_ONLY','RUNTIME_REQUIRED','BUILD25_EXCLUDE','QUARANTINE_EXCLUDE','OBSOLETE','DUPLICATE_IMPLEMENTATION','REQUIRES_OWNER_DECISION'],
      note: 'Entries are grouped analytically in docs/release/master-staging-provenance-map.md; this companion preserves per-commit traceability.',
    },
    counts: { total: entries.length, by_origin: countBy(entries, 'branch_origin'), by_disposition: countBy(entries, 'recommended_disposition') },
    explicit_excluded_remote_lines: {
      product_match: ['origin/product-match/foundation-v1', 'origin/product-match/foundation-v1-ios'],
      note: 'These commits are not ancestors of current master or staging and are excluded under Issue #72.',
    },
    commits: entries,
  };
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report.counts)}\n`);
}

if (require.main === module) main();
module.exports = { masterDisposition, stagingDisposition, allEquivalent, BUILD25_COMMITS };
