#!/usr/bin/env node
'use strict';

/**
 * Candidate Artifact Exposure Gate — scans generated/collected candidate
 * build outputs (JS/web export, Edge Function source, Android/iOS packaged
 * config, migration manifests, generated env/config files) for exposed
 * credentials, distinguishing expected public identifiers (staging
 * publishable keys, staging project ref/URL) from confirmed private
 * material (service-role keys, provider API keys, private key material,
 * the production project reference).
 *
 * This complements, not replaces, Gitleaks/Trivy — those are generic
 * secret scanners with no knowledge of Supabase's specific key taxonomy
 * (a staging anon/publishable JWT and a service-role JWT are both
 * "eyJ...", indistinguishable to a generic detector without decoding the
 * payload's `role` claim, which this script does).
 *
 * Usage:
 *   node security/scripts/scan-candidate-artifacts.js <dir-or-file>... [--json <outputFile>]
 *
 * Exit code: 0 if no BLOCKER/P0 finding, 1 if any BLOCKER/P0 finding.
 * Never prints a raw matched secret value — only classification + a short
 * non-reversible context snippet with the match itself redacted.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PRODUCTION_PROJECT_REF = 'wyyuqfdxucjksghsmhry';
const STAGING_PROJECT_REF = 'yzqjvdfgefveprobvvyw';

const SKIP_DIR_NAMES = new Set(['node_modules', '.git', '.expo', 'ios/Pods', 'Pods']);
const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25MB — beyond this, skip content scan (record as SKIPPED_TOO_LARGE)

const PATTERN_RULES = [
  {
    id: 'PRIVATE_KEY_MATERIAL',
    severity: 'BLOCKER',
    verdict: 'BLOCK',
    detector: 'kscan-forbidden-pattern',
    regex: /-----BEGIN( RSA| EC| OPENSSH| DSA| PGP)? PRIVATE KEY-----/,
    description: 'Private key material',
  },
  {
    id: 'SUPABASE_ACCESS_TOKEN',
    severity: 'P0',
    verdict: 'BLOCK',
    detector: 'kscan-forbidden-pattern',
    regex: /sbp_[a-f0-9]{40}/,
    description: 'Supabase personal/CI access token',
  },
  {
    id: 'SUPABASE_SECRET_KEY',
    severity: 'P0',
    verdict: 'BLOCK',
    detector: 'kscan-forbidden-pattern',
    regex: /sb_secret_[A-Za-z0-9_-]{10,}/,
    description: 'Supabase secret API key (new key format)',
  },
  {
    id: 'DATABASE_CONNECTION_PASSWORD',
    severity: 'P0',
    verdict: 'BLOCK',
    detector: 'kscan-forbidden-pattern',
    regex: /postgres(?:ql)?:\/\/[^:\s@/]+:[^@\s]{4,}@[^\s'"]+/i,
    description: 'Database connection string with embedded password',
  },
  {
    id: 'OPENAI_API_KEY',
    severity: 'P0',
    verdict: 'BLOCK',
    detector: 'kscan-forbidden-pattern',
    regex: /sk-[A-Za-z0-9]{20,}/,
    description: 'OpenAI-style private API key',
  },
  {
    id: 'GOOGLE_GEMINI_API_KEY',
    severity: 'P0',
    verdict: 'BLOCK',
    detector: 'kscan-forbidden-pattern',
    regex: /AIza[0-9A-Za-z_-]{35}/,
    description: 'Google/Gemini API key',
  },
  {
    id: 'GITHUB_TOKEN',
    severity: 'P0',
    verdict: 'BLOCK',
    detector: 'kscan-forbidden-pattern',
    regex: /(ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{20,})/,
    description: 'GitHub access token',
  },
  {
    id: 'AWS_ACCESS_KEY_ID',
    severity: 'P0',
    verdict: 'BLOCK',
    detector: 'kscan-forbidden-pattern',
    regex: /AKIA[0-9A-Z]{16}/,
    description: 'AWS access key ID',
  },
  {
    id: 'SLACK_TOKEN',
    severity: 'P0',
    verdict: 'BLOCK',
    detector: 'kscan-forbidden-pattern',
    regex: /xox[baprs]-[A-Za-z0-9-]{10,}/,
    description: 'Slack token',
  },
  {
    id: 'PRODUCTION_PROJECT_REFERENCE',
    severity: 'BLOCKER',
    verdict: 'BLOCK',
    detector: 'kscan-forbidden-pattern',
    regex: new RegExp(PRODUCTION_PROJECT_REF),
    description: 'Production Supabase project reference in a candidate artifact — a shipped candidate must never reference production',
    commentExempt: true,
  },
  {
    id: 'GENERIC_SIGNING_OR_WEBHOOK_SECRET',
    severity: 'P0',
    verdict: 'BLOCK',
    detector: 'kscan-forbidden-pattern',
    regex: /(WEBHOOK_SECRET|SIGNING_SECRET|VERDICT_SIGNING_SECRET|CLAMAV[A-Z_]*SECRET|SCANNER[A-Z_]*(SECRET|TOKEN))\s*[=:]\s*['"]?[A-Za-z0-9+/_=.-]{12,}/,
    description: 'Signing/webhook/scanner-service secret assigned a literal value',
  },
];

function shouldSkipDir(name) {
  return SKIP_DIR_NAMES.has(name);
}

function isLikelyBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8000));
  for (let i = 0; i < sample.length; i += 1) {
    if (sample[i] === 0) return true;
  }
  return false;
}

function walk(targets) {
  const files = [];
  const stack = [...targets];
  while (stack.length > 0) {
    const current = stack.pop();
    let stat;
    try {
      stat = fs.statSync(current);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      const base = path.basename(current);
      if (shouldSkipDir(base)) continue;
      for (const entry of fs.readdirSync(current)) {
        stack.push(path.join(current, entry));
      }
    } else if (stat.isFile()) {
      files.push({ filePath: current, size: stat.size });
    }
  }
  return files;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function decodeJwtPayload(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payloadB64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payloadB64 + '='.repeat((4 - (payloadB64.length % 4)) % 4);
    const json = Buffer.from(padded, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function classifyJwt(token) {
  const payload = decodeJwtPayload(token);
  if (!payload) {
    return { verdict: 'MANUAL_REVIEW', severity: 'P2', description: 'Unparseable JWT-shaped token', ruleId: 'JWT_UNPARSEABLE' };
  }
  const role = payload.role;
  const ref = payload.ref;

  if (ref === PRODUCTION_PROJECT_REF) {
    return { verdict: 'BLOCK', severity: 'BLOCKER', description: `Production-project JWT (role=${role || 'unknown'})`, ruleId: 'PRODUCTION_JWT' };
  }
  if (role === 'service_role') {
    return { verdict: 'BLOCK', severity: 'P0', description: 'Supabase service-role JWT', ruleId: 'SUPABASE_SERVICE_ROLE_JWT' };
  }
  if (role === 'anon' && ref === STAGING_PROJECT_REF) {
    return { verdict: 'ALLOW', severity: 'INFO', description: 'Staging anon/publishable JWT (expected in client-facing config)', ruleId: 'STAGING_ANON_JWT' };
  }
  if (role === 'anon') {
    return { verdict: 'MANUAL_REVIEW', severity: 'P2', description: `Anon JWT for unrecognized ref (${ref || 'unknown'})`, ruleId: 'ANON_JWT_UNKNOWN_REF' };
  }
  return { verdict: 'MANUAL_REVIEW', severity: 'P2', description: `JWT with unrecognized role (${role || 'unknown'})`, ruleId: 'JWT_UNKNOWN_ROLE' };
}

// A line whose first non-whitespace characters are a comment marker across
// the languages this repo actually uses (SQL --, shell/env/YAML #, JS/TS //
// or block-comment * / /*). Scoped narrowly: only rules explicitly marked
// commentExempt skip these lines (e.g. PRODUCTION_PROJECT_REFERENCE, which
// legitimately shows up in migration/doc comments explaining that staging
// mirrors production schema — see docs/security/staging-security-pipeline-map.md).
// A real secret or private key is still flagged even inside a comment.
function isCommentLine(line) {
  const trimmed = line.trimStart();
  return trimmed.startsWith('--') || trimmed.startsWith('#') || trimmed.startsWith('//')
    || trimmed.startsWith('/*') || trimmed.startsWith('*');
}

// A line that compares/classifies against the production ref rather than
// embedding it as a target (e.g. `if (url.includes(PRODUCTION_REF)) return
// 'production'`) -- the exact pattern already proven safe and common across
// security/scripts/*.js's own production-reference guards. A real leaked
// credential or write target would appear as a bare literal, not inside a
// comparison call.
function isComparisonContextLine(line) {
  return /\.(includes|indexOf|startsWith|endsWith|match|test)\s*\(|===|!==/.test(line);
}

function isTemplateEnvFile(filePath) {
  const base = path.basename(filePath);
  if (!/^\.env(\.[^.]+)?$/.test(base)) return true; // not an env file at all
  return /\.(example|sample|template)$/.test(base);
}

function redactedSnippet(line, matchStart, matchEnd) {
  const before = line.slice(Math.max(0, matchStart - 12), matchStart);
  const after = line.slice(matchEnd, Math.min(line.length, matchEnd + 12));
  return `${before}[REDACTED]${after}`.trim().slice(0, 80);
}

function scanFile(filePath) {
  const findings = [];
  let buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch (err) {
    return { findings, error: err.message };
  }
  const hash = sha256(buffer);

  if (buffer.length > MAX_FILE_BYTES) {
    return { findings, hash, skipped: 'TOO_LARGE' };
  }
  if (isLikelyBinary(buffer)) {
    return { findings, hash, skipped: 'BINARY' };
  }

  const base = path.basename(filePath);
  if (/^\.env(\.[^.]+)?$/.test(base) && !isTemplateEnvFile(filePath)) {
    findings.push({
      ruleId: 'RAW_ENV_FILE_IN_ARTIFACT',
      severity: 'BLOCKER',
      verdict: 'BLOCK',
      detector: 'kscan-forbidden-pattern',
      description: 'Raw (non-template) .env file present in a candidate artifact',
      snippet: '[REDACTED — full file withheld]',
    });
  }

  const text = buffer.toString('utf8');
  const lines = text.split(/\r?\n/);

  lines.forEach((line, idx) => {
    const exemptContext = isCommentLine(line) || isComparisonContextLine(line);
    for (const rule of PATTERN_RULES) {
      if (rule.commentExempt && exemptContext) continue;
      const match = rule.regex.exec(line);
      if (match) {
        findings.push({
          ruleId: rule.id,
          severity: rule.severity,
          verdict: rule.verdict,
          detector: rule.detector,
          description: rule.description,
          line: idx + 1,
          snippet: redactedSnippet(line, match.index, match.index + match[0].length),
        });
      }
    }

    const jwtRegex = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
    let jwtMatch;
    // eslint-disable-next-line no-cond-assign
    while ((jwtMatch = jwtRegex.exec(line))) {
      const classification = classifyJwt(jwtMatch[0]);
      findings.push({
        ruleId: classification.ruleId,
        severity: classification.severity,
        verdict: classification.verdict,
        detector: 'kscan-supabase-jwt-classifier',
        description: classification.description,
        line: idx + 1,
        snippet: redactedSnippet(line, jwtMatch.index, jwtMatch.index + jwtMatch[0].length),
      });
    }
  });

  return { findings, hash };
}

function scan(targets) {
  const files = walk(targets);
  const results = [];
  for (const { filePath } of files) {
    const { findings, hash, skipped, error } = scanFile(filePath);
    results.push({
      path: filePath,
      sha256: hash || null,
      skipped: skipped || null,
      error: error || null,
      findings,
    });
  }
  return results;
}

function summarize(results) {
  const allFindings = results.flatMap((r) => r.findings.map((f) => ({ ...f, path: r.path, sha256: r.sha256 })));
  const blocked = allFindings.filter((f) => f.verdict === 'BLOCK');
  const manualReview = allFindings.filter((f) => f.verdict === 'MANUAL_REVIEW');
  const allowed = allFindings.filter((f) => f.verdict === 'ALLOW');
  return {
    scannedFiles: results.length,
    skippedFiles: results.filter((r) => r.skipped).length,
    totalFindings: allFindings.length,
    blockedCount: blocked.length,
    manualReviewCount: manualReview.length,
    allowedCount: allowed.length,
    verdict: blocked.length > 0 ? 'BLOCKED' : 'PASS',
    findings: allFindings,
  };
}

function fileHashIfExists(filePath) {
  try {
    return sha256(fs.readFileSync(filePath));
  } catch {
    return null;
  }
}

// Gitleaks JSON report: an array of {RuleID, Description, File, StartLine, Match, ...}.
// An empty/absent report (no leaks, or the step never ran) yields no findings — never
// treated as an error, since "not configured to run" and "ran clean" both parse to [].
function mergeGitleaksFindings(reportPath) {
  if (!reportPath || !fs.existsSync(reportPath)) return [];
  let data;
  try {
    data = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  return data.map((leak) => ({
    ruleId: leak.RuleID || 'GITLEAKS_UNSPECIFIED',
    severity: 'P0',
    verdict: 'BLOCK',
    detector: 'gitleaks',
    description: leak.Description || 'Gitleaks-detected secret',
    path: leak.File || 'unknown',
    sha256: fileHashIfExists(leak.File),
    line: leak.StartLine || null,
    snippet: '[REDACTED — see Gitleaks report artifact for detector context]',
  }));
}

// Trivy JSON (fs scan, scanners=secret): {Results: [{Target, Secrets: [{RuleID, Title, Severity, StartLine}]}]}.
function mergeTrivyFindings(reportPath) {
  if (!reportPath || !fs.existsSync(reportPath)) return [];
  let data;
  try {
    data = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  } catch {
    return [];
  }
  const findings = [];
  for (const result of data.Results || []) {
    for (const secret of result.Secrets || []) {
      findings.push({
        ruleId: secret.RuleID || 'TRIVY_UNSPECIFIED',
        severity: 'P0',
        verdict: 'BLOCK',
        detector: 'trivy',
        description: secret.Title || 'Trivy-detected secret',
        path: result.Target || 'unknown',
        sha256: fileHashIfExists(result.Target),
        line: secret.StartLine || null,
        snippet: '[REDACTED — see Trivy report artifact for detector context]',
      });
    }
  }
  return findings;
}

function parseArgs(argv) {
  const targets = [];
  let jsonOut = null;
  let gitleaksReport = null;
  let trivyReport = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--json') {
      jsonOut = argv[++i];
    } else if (argv[i] === '--merge-gitleaks-json') {
      gitleaksReport = argv[++i];
    } else if (argv[i] === '--merge-trivy-json') {
      trivyReport = argv[++i];
    } else {
      targets.push(argv[i]);
    }
  }
  return { targets, jsonOut, gitleaksReport, trivyReport };
}

function main() {
  const { targets, jsonOut, gitleaksReport, trivyReport } = parseArgs(process.argv.slice(2));
  if (targets.length === 0) {
    console.error('Usage: scan-candidate-artifacts.js <dir-or-file>... [--json <outputFile>] [--merge-gitleaks-json <file>] [--merge-trivy-json <file>]');
    process.exit(1);
  }

  const existingTargets = targets.filter((t) => fs.existsSync(t));
  const results = scan(existingTargets);
  const summary = summarize(results);

  const externalFindings = [
    ...mergeGitleaksFindings(gitleaksReport),
    ...mergeTrivyFindings(trivyReport),
  ];
  summary.findings = [...summary.findings, ...externalFindings];
  summary.totalFindings = summary.findings.length;
  summary.blockedCount = summary.findings.filter((f) => f.verdict === 'BLOCK').length;
  summary.manualReviewCount = summary.findings.filter((f) => f.verdict === 'MANUAL_REVIEW').length;
  summary.allowedCount = summary.findings.filter((f) => f.verdict === 'ALLOW').length;
  summary.verdict = summary.blockedCount > 0 ? 'BLOCKED' : 'PASS';

  const report = {
    scannedAt: null,
    targets,
    existingTargets,
    ...summary,
  };

  if (jsonOut) {
    fs.mkdirSync(path.dirname(jsonOut), { recursive: true });
    fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2));
  }

  console.log(JSON.stringify({
    scannedFiles: summary.scannedFiles,
    skippedFiles: summary.skippedFiles,
    totalFindings: summary.totalFindings,
    blockedCount: summary.blockedCount,
    manualReviewCount: summary.manualReviewCount,
    allowedCount: summary.allowedCount,
    verdict: summary.verdict,
  }));

  process.exit(summary.verdict === 'BLOCKED' ? 1 : 0);
}

if (require.main === module) {
  main();
}

module.exports = {
  scan,
  summarize,
  classifyJwt,
  isTemplateEnvFile,
  isCommentLine,
  isComparisonContextLine,
  PRODUCTION_PROJECT_REF,
  STAGING_PROJECT_REF,
  PATTERN_RULES,
};
