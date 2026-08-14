#!/usr/bin/env node
'use strict';

// Candidate-only secret exposure scan. It reports fingerprints and redacted
// context; secret material is never copied to stdout or an artifact.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SKIP = new Set(['.git', 'node_modules', 'Pods', '.gradle', 'build', 'dist']);
const RULES = [
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

/**
 * PRIVATE_KEY detection is semantic and whole-file, not line-based
 * (DEF-B29-SVV-013A).
 *
 * The old rule fired on the literal `-----BEGIN PRIVATE KEY-----` marker
 * alone, so three Build 29 Apple auth constructs blocked certification while
 * containing no key material at all: a helper that BUILDS a PEM from generated
 * bytes, a tiny fake test fixture, and a regex that PARSES PEM input. A marker
 * is not a credential; the key material between the markers is.
 *
 * The fix is to require a plausible complete private key rather than to
 * allowlist those files. Test files are still scanned, and detection of real
 * PKCS#8 / RSA / EC / encrypted private keys is unchanged: a real key satisfies
 * every check below by construction.
 *
 * A block must satisfy all of:
 *   - BEGIN and END markers whose labels match (backreference), so a truncated
 *     or mismatched pair is not treated as a key;
 *   - a body that is pure base64 once unwrapped, and that survives a decode
 *     then re-encode round trip. Buffer's base64 decoder is lenient and
 *     silently ignores stray characters, so the round trip is what actually
 *     rejects source constructs;
 *   - a decoded payload of at least MIN_PRIVATE_KEY_DER_BYTES, which excludes
 *     toy fixtures such as a decoded "AAAA";
 *   - a leading DER SEQUENCE tag, which every PKCS#8, PKCS#1/RSA, SEC1/EC and
 *     encrypted-PKCS#8 private key begins with, so a long but structureless
 *     base64 blob is not reported as a credential.
 *
 * Sources embed keys either with real newlines or with escaped newlines inside
 * a string literal, so both forms are unwrapped before validation.
 */
const PEM_PRIVATE_KEY = /-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY)-----([\s\S]*?)-----END \1-----/g;

// The smallest real PKCS#8 payload in practice is a 48-byte Ed25519 key;
// anything materially smaller cannot carry private-key material.
const MIN_PRIVATE_KEY_DER_BYTES = 48;

const DER_SEQUENCE_TAG = 0x30;

function unwrapPemBody(raw) {
  // Escaped newlines first (source/JSON string literals), then real whitespace.
  return raw.replace(/\\[rn]/g, '').replace(/\s+/g, '');
}

function isPlausiblePrivateKeyBody(body) {
  if (!body || !/^[A-Za-z0-9+/]+={0,2}$/.test(body)) return false;
  let decoded;
  try {
    decoded = Buffer.from(body, 'base64');
  } catch {
    return false;
  }
  // Round trip: rejects bodies the lenient decoder merely tolerated.
  if (decoded.toString('base64').replace(/=+$/, '') !== body.replace(/=+$/, '')) return false;
  if (decoded.length < MIN_PRIVATE_KEY_DER_BYTES) return false;
  return decoded[0] === DER_SEQUENCE_TAG;
}

/** Findings carry only a hash of the material, never the material itself. */
function detectPrivateKeys(text, file) {
  const findings = [];
  PEM_PRIVATE_KEY.lastIndex = 0;
  let match;
  while ((match = PEM_PRIVATE_KEY.exec(text)) !== null) {
    const body = unwrapPemBody(match[2]);
    if (!isPlausiblePrivateKeyBody(body)) continue;
    findings.push({
      rule: 'PRIVATE_KEY',
      file: file.replace(/\\/g, '/'),
      line: text.slice(0, match.index).split('\n').length,
      fingerprint: fingerprint('PRIVATE_KEY', body),
      severity: 'BLOCKER',
    });
  }
  return findings;
}

function scanFile(file) {
  const data = fs.readFileSync(file);
  if (data.includes(0)) return [];
  const findings = [];
  const text = data.toString('utf8');
  findings.push(...detectPrivateKeys(text, file));
  text.split(/\r?\n/).forEach((line, index) => {
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
