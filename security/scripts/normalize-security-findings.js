#!/usr/bin/env node
'use strict';

/**
 * Normalizes scanner reports into stable finding records for baseline comparison.
 * Node built-ins only.
 *
 * Usage:
 *   node security/scripts/normalize-security-findings.js <reportsDir> [outputFile]
 *
 * Expects optional report files in reportsDir:
 *   gitleaks-results.json, semgrep-results.json, osv-results.json,
 *   trivy-results.json, npm-audit.json, zap-baseline-report.json, zap-api-report.json
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const RUNTIME_CLASSIFICATIONS = new Set([
  'MOBILE RUNTIME',
  'BACKEND RUNTIME',
  'BUILD/CI',
  'DEVELOPMENT ONLY',
  'TEST ONLY',
  'FALSE POSITIVE',
  'UNVERIFIED',
]);

function readJson(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function normalizePath(filePath) {
  if (!filePath) return '';
  return String(filePath).replace(/\\/g, '/').replace(/^\.\//, '');
}

function fingerprint(parts) {
  const payload = parts.filter(Boolean).join('|');
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

function classifySemgrepRuntime(result) {
  const checkId = result.check_id || '';
  const filePath = normalizePath(result.path);
  if (filePath.includes('supabase/functions') || filePath === 'server.js') {
    return 'BACKEND RUNTIME';
  }
  if (filePath.startsWith('app/') || filePath.startsWith('components/') || filePath.startsWith('services/')) {
    return 'MOBILE RUNTIME';
  }
  if (checkId.includes('cors') || checkId.includes('dangerous-dynamic')) {
    return 'BACKEND RUNTIME';
  }
  if (filePath.includes('.github/workflows')) {
    return 'BUILD/CI';
  }
  return 'UNVERIFIED';
}

function mapSemgrepSeverity(severity) {
  const s = String(severity || 'UNKNOWN').toUpperCase();
  if (s === 'ERROR') return 'HIGH';
  if (s === 'WARNING') return 'MEDIUM';
  if (s === 'INFO') return 'LOW';
  return s;
}

function normalizeGitleaks(data, reportsDir) {
  if (!Array.isArray(data)) {
    throw new Error('gitleaks-results.json must be a JSON array');
  }
  return data.map((item) => {
    const ruleId = item.RuleID || item.rule || 'gitleaks-unknown';
    const filePath = normalizePath(item.File || item.file || '');
    const severity = 'CRITICAL';
    const runtime = 'BACKEND RUNTIME';
    return {
      scanner: 'Gitleaks',
      ruleId,
      fileOrPackage: filePath,
      normalizedPath: filePath,
      installedVersion: '',
      severity,
      runtimeClassification: runtime,
      fingerprint: fingerprint(['Gitleaks', ruleId, filePath, String(item.StartLine || ''), String(item.EndLine || '')]),
      sourceReport: path.join(reportsDir, 'gitleaks-results.json'),
    };
  });
}

function normalizeSemgrep(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.results)) {
    throw new Error('semgrep-results.json must contain a results array');
  }
  return data.results.map((result) => {
    const extra = result.extra || {};
    const ruleId = result.check_id || extra.metadata?.kscan_boundary || 'semgrep-unknown';
    const filePath = normalizePath(result.path || '');
    const severity = mapSemgrepSeverity(extra.severity || result.severity);
    const runtime = classifySemgrepRuntime(result);
    const start = result.start?.line || '';
    return {
      scanner: 'Semgrep',
      ruleId,
      fileOrPackage: filePath,
      normalizedPath: filePath,
      installedVersion: '',
      severity,
      runtimeClassification: runtime,
      fingerprint: fingerprint(['Semgrep', ruleId, filePath, String(start)]),
      sourceReport: 'semgrep-results.json',
    };
  });
}

function normalizeOsv(data) {
  if (!data || typeof data !== 'object') {
    throw new Error('osv-results.json must be a JSON object');
  }
  const findings = [];
  for (const result of data.results || []) {
    const sourceFile = normalizePath(result.source?.path || 'package-lock.json');
    for (const pkg of result.packages || []) {
      const pkgName = pkg.package?.name || pkg.package?.ecosystem || 'unknown-package';
      const version = pkg.package?.version || '';
      for (const vuln of pkg.vulnerabilities || []) {
        const ruleId = vuln.id || vuln.aliases?.[0] || 'osv-unknown';
        const severity = String(vuln.severity?.[0]?.score || vuln.database_specific?.severity || 'UNVERIFIED').toUpperCase();
        findings.push({
          scanner: 'OSV-Scanner',
          ruleId,
          fileOrPackage: pkgName,
          normalizedPath: sourceFile,
          installedVersion: version,
          severity: severity.includes('CRITICAL') ? 'CRITICAL' : severity.includes('HIGH') ? 'HIGH' : severity.includes('MEDIUM') ? 'MEDIUM' : 'LOW',
          runtimeClassification: 'UNVERIFIED',
          fingerprint: fingerprint(['OSV-Scanner', ruleId, pkgName, version, sourceFile]),
          sourceReport: 'osv-results.json',
        });
      }
    }
  }
  return findings;
}

function normalizeTrivy(data) {
  if (!data || typeof data !== 'object') {
    throw new Error('trivy-results.json must be a JSON object');
  }
  const findings = [];
  for (const result of data.Results || []) {
    const target = normalizePath(result.Target || '');
    for (const key of ['Vulnerabilities', 'Misconfigurations', 'Secrets']) {
      for (const item of result[key] || []) {
        const ruleId = item.VulnerabilityID || item.ID || item.AVDID || item.Title || `trivy-${key}`;
        const severity = String(item.Severity || 'UNKNOWN').toUpperCase();
        findings.push({
          scanner: 'Trivy',
          ruleId,
          fileOrPackage: item.PkgName || target || 'filesystem',
          normalizedPath: target,
          installedVersion: item.InstalledVersion || '',
          severity,
          runtimeClassification: key === 'Secrets' ? 'BACKEND RUNTIME' : 'UNVERIFIED',
          fingerprint: fingerprint(['Trivy', ruleId, target, item.PkgName || '', item.InstalledVersion || '']),
          sourceReport: 'trivy-results.json',
        });
      }
    }
  }
  return findings;
}

function normalizeNpmAudit(data) {
  if (!data || typeof data !== 'object') {
    throw new Error('npm-audit.json must be a JSON object');
  }
  const findings = [];
  const advisories = data.vulnerabilities || data.advisories || {};
  const entries = Array.isArray(advisories) ? advisories : Object.values(advisories);
  for (const adv of entries) {
    if (!adv || typeof adv !== 'object') continue;
    const ruleId = adv.url || adv.name || adv.id || 'npm-advisory';
    const severity = String(adv.severity || 'UNKNOWN').toUpperCase();
    const pkgName = adv.name || 'unknown-package';
    findings.push({
      scanner: 'npm audit',
      ruleId,
      fileOrPackage: pkgName,
      normalizedPath: 'package-lock.json',
      installedVersion: adv.range || adv.version || '',
      severity: severity === 'MODERATE' ? 'MEDIUM' : severity,
      runtimeClassification: 'UNVERIFIED',
      fingerprint: fingerprint(['npm audit', ruleId, pkgName, adv.range || '']),
      sourceReport: 'npm-audit.json',
    });
  }
  return findings;
}

function normalizeZap(data, scannerName, sourceReport) {
  if (!data || typeof data !== 'object') {
    throw new Error(`${sourceReport} must be a JSON object`);
  }
  const findings = [];
  const sites = data.site || [];
  for (const site of sites) {
    for (const alert of site.alerts || []) {
      const ruleId = alert.pluginid || alert.alertRef || alert.name || 'zap-unknown';
      const risk = String(alert.riskdesc || alert.riskcode || 'UNKNOWN');
      let severity = 'LOW';
      if (/high/i.test(risk)) severity = 'HIGH';
      else if (/medium/i.test(risk)) severity = 'MEDIUM';
      else if (/informational/i.test(risk)) severity = 'LOW';
      else if (/critical/i.test(risk)) severity = 'CRITICAL';
      findings.push({
        scanner: scannerName,
        ruleId: String(ruleId),
        fileOrPackage: alert.url || site['@name'] || 'staging-target',
        normalizedPath: alert.url || site['@name'] || '',
        installedVersion: '',
        severity,
        runtimeClassification: 'BACKEND RUNTIME',
        fingerprint: fingerprint([scannerName, String(ruleId), alert.url || '', alert.name || '']),
        sourceReport,
        zapRisk: risk,
      });
    }
  }
  return findings;
}

function main() {
  const reportsDir = process.argv[2] || '.';
  const outputFile = process.argv[3] || path.join(reportsDir, 'normalized-findings.json');

  const scanners = [];
  const findings = [];
  const errors = [];

  const specs = [
    { file: 'gitleaks-results.json', scanner: 'Gitleaks', normalize: (d) => normalizeGitleaks(d, reportsDir) },
    { file: 'semgrep-results.json', scanner: 'Semgrep', normalize: normalizeSemgrep },
    { file: 'osv-results.json', scanner: 'OSV-Scanner', normalize: normalizeOsv },
    { file: 'trivy-results.json', scanner: 'Trivy', normalize: normalizeTrivy },
    { file: 'npm-audit.json', scanner: 'npm audit', normalize: normalizeNpmAudit },
    { file: 'zap-baseline-report.json', scanner: 'OWASP ZAP Baseline', normalize: (d) => normalizeZap(d, 'OWASP ZAP Baseline', 'zap-baseline-report.json') },
    { file: 'zap-api-report.json', scanner: 'OWASP ZAP API', normalize: (d) => normalizeZap(d, 'OWASP ZAP API', 'zap-api-report.json') },
  ];

  for (const spec of specs) {
    const filePath = path.join(reportsDir, spec.file);
    if (!fs.existsSync(filePath)) {
      continue;
    }
    try {
      const data = readJson(filePath);
      const normalized = spec.normalize(data);
      findings.push(...normalized);
      scanners.push({ scanner: spec.scanner, report: spec.file, status: 'ok', count: normalized.length });
    } catch (err) {
      errors.push({ scanner: spec.scanner, report: spec.file, status: 'malformed', error: err.message });
    }
  }

  const output = {
    generatedAt: new Date().toISOString(),
    reportsDir: path.resolve(reportsDir),
    scanners,
    errors,
    findings,
    findingCount: findings.length,
  };

  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ outputFile, findingCount: findings.length, scanners: scanners.length, errors: errors.length }));

  if (errors.length > 0) {
    process.exit(2);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  normalizeGitleaks,
  normalizeSemgrep,
  normalizeOsv,
  normalizeTrivy,
  normalizeNpmAudit,
  normalizeZap,
  fingerprint,
  RUNTIME_CLASSIFICATIONS,
};
