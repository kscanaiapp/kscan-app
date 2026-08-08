#!/usr/bin/env node
'use strict';

// Candidate-only secret exposure scan. It reports fingerprints and redacted
// context; secret material is never copied to stdout or an artifact.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SKIP = new Set(['.git', 'node_modules', 'Pods', '.gradle', 'build', 'dist']);
const RULES = [
  ['PRIVATE_KEY', /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/],
  ['SUPABASE_SERVICE_KEY', /sb_secret_[A-Za-z0-9_-]{10,}/],
  ['SUPABASE_ACCESS_TOKEN', /sbp_[a-f0-9]{40}/],
  ['OPENAI_API_KEY', /sk-[A-Za-z0-9]{20,}/],
  ['GITHUB_TOKEN', /(?:ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{20,})/],
  ['AWS_ACCESS_KEY', /AKIA[0-9A-Z]{16}/],
  ['DATABASE_URL_WITH_PASSWORD', /postgres(?:ql)?:\/\/[^:\s@/]+:[^@\s]{4,}@/i],
];

function walk(target, files = []) {
  if (!fs.existsSync(target)) return files;
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    if (SKIP.has(path.basename(target))) return files;
    for (const entry of fs.readdirSync(target)) walk(path.join(target, entry), files);
  } else if (stat.isFile() && stat.size <= 25 * 1024 * 1024) files.push(target);
  return files;
}

function fingerprint(rule, text) {
  return crypto.createHash('sha256').update(`${rule}:${text}`).digest('hex').slice(0, 16);
}

function scanFile(file) {
  const data = fs.readFileSync(file);
  if (data.includes(0)) return [];
  const findings = [];
  data.toString('utf8').split(/\r?\n/).forEach((line, index) => {
    for (const [rule, regex] of RULES) {
      const match = line.match(regex);
      if (match) findings.push({ rule, file: file.replace(/\\/g, '/'), line: index + 1, fingerprint: fingerprint(rule, match[0]), severity: 'BLOCKER' });
    }
  });
  return findings;
}

function scan(targets) {
  const files = targets.flatMap((target) => walk(target));
  const findings = files.flatMap(scanFile);
  return { scanned_files: files.length, findings, verdict: findings.length ? 'BLOCKED' : 'PASS' };
}

function main() {
  const args = process.argv.slice(2);
  const outputIndex = args.indexOf('--output');
  const candidateIndex = args.indexOf('--candidate-sha');
  const output = outputIndex === -1 ? null : args[outputIndex + 1];
  const candidateSha = candidateIndex === -1 ? null : args[candidateIndex + 1];
  const targets = args.filter((arg, index) => arg !== '--output' && index !== outputIndex + 1 && arg !== '--candidate-sha' && index !== candidateIndex + 1);
  const report = scan(targets.length ? targets : ['app.json', 'app.config.js', 'eas.json', 'supabase', '.github']);
  report.candidate_sha = candidateSha;
  if (output) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify({ scanned_files: report.scanned_files, finding_count: report.findings.length, verdict: report.verdict })}\n`);
  process.exit(report.verdict === 'PASS' ? 0 : 1);
}

if (require.main === module) main();
module.exports = { scan, scanFile, RULES };
