#!/usr/bin/env node
'use strict';

/**
 * Migration risk classification for the backend release control plane.
 *
 * Two independent layers, deliberately kept separate:
 *
 *   1. STATIC RISK DETECTION (detectRiskPatterns) - deterministic textual
 *      scanning for dangerous SQL shapes. This is ADVISORY. Regex analysis
 *      cannot prove semantic safety: it cannot tell a DROP of a table
 *      created three lines earlier from a DROP of a populated production
 *      table, and it cannot see through dynamic SQL. It therefore reports
 *      DETECTED_RISK / REQUIRES_CLASSIFICATION / REQUIRES_REVIEW rather
 *      than emitting a risk class of its own.
 *
 *   2. AUTHORITATIVE CLASSIFICATION (classifyMigration) - the human/agent
 *      decision recorded in security/release/migration-risk-classifications.json.
 *      This is what release gating consumes. A detector finding never
 *      silently overrides it, and never silently downgrades a migration to
 *      a safer class.
 *
 * The gap between the two is intentional and is where review happens: if
 * the detector flags a destructive pattern and the registry says
 * EXPANSION_SAFE, that is surfaced as a mismatch requiring review, not
 * resolved automatically in either direction.
 *
 * Node built-ins only.
 */

const fs = require('node:fs');
const path = require('node:path');

const RISK_CLASSES = Object.freeze([
  'EXPANSION_SAFE',
  'REVERSIBLE',
  'DATA_TRANSFORMING',
  'FORWARD_FIX_ONLY',
  'DESTRUCTIVE',
]);
const RISK_CLASS_SET = new Set(RISK_CLASSES);

const CLASSIFICATION_STATUS = Object.freeze({
  CLASSIFIED: 'CLASSIFIED',
  UNCLASSIFIED_HISTORICAL: 'UNCLASSIFIED_HISTORICAL',
  UNCLASSIFIED_NEW: 'UNCLASSIFIED_NEW',
});

const DETECTOR_VERDICT = Object.freeze({
  NO_PATTERN_DETECTED: 'NO_PATTERN_DETECTED',
  DETECTED_RISK: 'DETECTED_RISK',
  REQUIRES_CLASSIFICATION: 'REQUIRES_CLASSIFICATION',
  REQUIRES_REVIEW: 'REQUIRES_REVIEW',
});

/**
 * Deterministic SQL risk patterns.
 *
 * `severity` drives the detector verdict only:
 *   DESTRUCTIVE_SHAPE  -> DETECTED_RISK
 *   TRANSFORM_SHAPE    -> REQUIRES_CLASSIFICATION
 *   REVIEW_SHAPE       -> REQUIRES_REVIEW
 *
 * `scope` selects what the pattern is tested against:
 *   'document'  (default) - the whole comment-stripped file
 *   'statement'           - each semicolon-delimited statement individually,
 *                           so a qualifying clause on a later line still
 *                           counts as part of the same statement
 *   'routine'             - only text inside $$-quoted routine bodies
 *
 * A 'statement'-scoped pattern fires only when `re` matches a statement and
 * `unless` (if present) does not match that same statement.
 */
const RISK_PATTERNS = Object.freeze([
  { id: 'DROP_TABLE', severity: 'DESTRUCTIVE_SHAPE', re: /\bdrop\s+table\b/i, note: 'drops a table' },
  { id: 'DROP_COLUMN', severity: 'DESTRUCTIVE_SHAPE', re: /\balter\s+table\b[\s\S]{0,200}?\bdrop\s+column\b/i, note: 'drops a column' },
  {
    id: 'TRUNCATE',
    severity: 'DESTRUCTIVE_SHAPE',
    scope: 'statement',
    // Statement-initial only: TRUNCATE is also a privilege NAME, and this repo
    // revokes it routinely (`revoke truncate, references, trigger ... on ...`),
    // which is privilege tightening, the opposite of destructive.
    re: /^\s*truncate\b/i,
    note: 'truncates a table',
  },
  { id: 'DROP_SCHEMA', severity: 'DESTRUCTIVE_SHAPE', re: /\bdrop\s+schema\b/i, note: 'drops a schema' },
  { id: 'ENUM_VALUE_REMOVAL', severity: 'DESTRUCTIVE_SHAPE', re: /\balter\s+type\b[\s\S]{0,200}?\bdrop\s+(?:value|attribute)\b/i, note: 'removes an enum value or composite attribute' },

  {
    id: 'UNBOUNDED_DELETE',
    severity: 'TRANSFORM_SHAPE',
    scope: 'statement',
    re: /\bdelete\s+from\s+[\w".]+/i,
    unless: /\bwhere\b/i,
    note: 'DELETE with no WHERE clause',
  },
  {
    id: 'UNBOUNDED_UPDATE',
    severity: 'TRANSFORM_SHAPE',
    scope: 'statement',
    re: /\bupdate\s+[\w".]+\s+set\b/i,
    unless: /\bwhere\b/i,
    note: 'UPDATE ... SET with no WHERE clause',
  },
  {
    id: 'DELETE_INSIDE_ROUTINE_BODY',
    severity: 'REVIEW_SHAPE',
    scope: 'routine',
    re: /\bdelete\s+from\b/i,
    note: 'DELETE inside a routine body - verify it is row/user-scoped and not a table-wide sweep on a client-triggered request path (see 20260808121216_privacy_request_rate_limits.sql)',
  },
  { id: 'ALTER_TYPE_CONVERSION', severity: 'TRANSFORM_SHAPE', re: /\balter\s+(?:table|column)\b[\s\S]{0,200}?\b(?:set\s+data\s+)?type\b/i, note: 'column type conversion; verify in-place compatibility' },
  { id: 'NOT_NULL_TIGHTENING', severity: 'TRANSFORM_SHAPE', re: /\balter\s+column\b[\s\S]{0,120}?\bset\s+not\s+null\b/i, note: 'tightens an existing column to NOT NULL' },

  { id: 'DROP_POLICY', severity: 'REVIEW_SHAPE', re: /\bdrop\s+policy\b/i, note: 'removes/replaces an RLS policy; verify the target table is not already populated' },
  { id: 'GRANT_OR_REVOKE', severity: 'REVIEW_SHAPE', re: /\b(?:grant|revoke)\b/i, note: 'changes effective privileges' },
  { id: 'SECURITY_DEFINER_REPLACE', severity: 'REVIEW_SHAPE', re: /\bcreate\s+or\s+replace\s+function\b/i, note: 'redefines a function body under an unchanged signature - the dominant real-world risk shape in this repo; a signature-only diff would miss it' },
  { id: 'DROP_FUNCTION', severity: 'REVIEW_SHAPE', re: /\bdrop\s+function\b/i, note: 'removes a function; verify no RPC signature the client depends on is lost' },
  { id: 'DROP_TRIGGER', severity: 'REVIEW_SHAPE', re: /\bdrop\s+trigger\b/i, note: 'removes a trigger' },
]);

/** Strips SQL line and block comments so commented-out DDL never trips the detector. */
function stripSqlComments(sql) {
  return String(sql)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ');
}

/**
 * Splits comment-stripped SQL into statements. Dollar-quoted routine bodies
 * are masked first so semicolons inside a function body do not split it into
 * fragments (which is how a WHERE clause could get separated from its DELETE).
 */
function splitStatements(body) {
  const bodies = [];
  const masked = body.replace(/\$([\w]*)\$[\s\S]*?\$\1\$/g, (match) => {
    bodies.push(match);
    return `$$ROUTINE_BODY_${bodies.length - 1}$$`;
  });
  return masked
    .split(';')
    .map((s) => s.replace(/\$\$ROUTINE_BODY_(\d+)\$\$/g, (_, i) => bodies[Number(i)]))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Returns the text of every $$-quoted routine body in the SQL. */
function extractRoutineBodies(body) {
  const matches = body.match(/\$([\w]*)\$[\s\S]*?\$\1\$/g);
  return matches || [];
}

/**
 * Scans migration SQL for dangerous shapes. Advisory only - see module header.
 * @returns {{verdict: string, findings: Array<{id, severity, note}>}}
 */
function detectRiskPatterns(sql) {
  const body = stripSqlComments(sql);
  const statements = splitStatements(body);
  const routineBodies = extractRoutineBodies(body);
  const findings = [];

  for (const pattern of RISK_PATTERNS) {
    let hit = false;
    if (pattern.scope === 'statement') {
      hit = statements.some((stmt) => pattern.re.test(stmt) && !(pattern.unless && pattern.unless.test(stmt)));
    } else if (pattern.scope === 'routine') {
      hit = routineBodies.some((routine) => pattern.re.test(routine));
    } else {
      hit = pattern.re.test(body);
    }
    if (hit) {
      findings.push({ id: pattern.id, severity: pattern.severity, note: pattern.note });
    }
  }

  let verdict = DETECTOR_VERDICT.NO_PATTERN_DETECTED;
  if (findings.some((f) => f.severity === 'DESTRUCTIVE_SHAPE')) {
    verdict = DETECTOR_VERDICT.DETECTED_RISK;
  } else if (findings.some((f) => f.severity === 'TRANSFORM_SHAPE')) {
    verdict = DETECTOR_VERDICT.REQUIRES_CLASSIFICATION;
  } else if (findings.length > 0) {
    verdict = DETECTOR_VERDICT.REQUIRES_REVIEW;
  }

  return { verdict, findings };
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function defaultRegistryPaths(repoRoot) {
  return {
    classifications: path.join(repoRoot, 'security', 'release', 'migration-risk-classifications.json'),
    baseline: path.join(repoRoot, 'security', 'release', 'migration-baseline.json'),
  };
}

/**
 * Resolves the authoritative classification for one migration name.
 *
 * @param {string} name - migration name (filename minus timestamp prefix and .sql)
 * @param {object} registries - { classifications, baseline } parsed JSON
 * @returns {{name, status, classification: string|null, rationale: string|null}}
 */
function classifyMigration(name, registries) {
  const { classifications, baseline } = registries;
  const entry = classifications?.classifications?.[name];
  if (entry) {
    if (!RISK_CLASS_SET.has(entry.classification)) {
      throw new Error(`migration "${name}" has an unknown risk class: ${entry.classification}`);
    }
    return {
      name,
      status: CLASSIFICATION_STATUS.CLASSIFIED,
      classification: entry.classification,
      rationale: entry.rationale || null,
      reviewFlag: entry.reviewFlag || null,
      riskDetectorMismatchExpected: Boolean(entry.riskDetectorMismatchExpected),
    };
  }

  const inBaseline = (baseline?.migrations || []).some((m) => m.name === name);
  return {
    name,
    status: inBaseline ? CLASSIFICATION_STATUS.UNCLASSIFIED_HISTORICAL : CLASSIFICATION_STATUS.UNCLASSIFIED_NEW,
    classification: null,
    rationale: null,
    reviewFlag: null,
    riskDetectorMismatchExpected: false,
  };
}

/**
 * Combines authoritative classification with the advisory detector for one
 * migration, surfacing (never auto-resolving) disagreement between them.
 */
function assessMigration({ name, sql, registries }) {
  const classification = classifyMigration(name, registries);
  const detection = detectRiskPatterns(sql == null ? '' : sql);

  // A detector DETECTED_RISK against a registry class that claims the
  // migration is purely additive is a real disagreement worth review. It is
  // reported, not resolved - and never downgrades the recorded class.
  const mismatch = Boolean(
    detection.verdict === DETECTOR_VERDICT.DETECTED_RISK
    && classification.status === CLASSIFICATION_STATUS.CLASSIFIED
    && ['EXPANSION_SAFE', 'REVERSIBLE'].includes(classification.classification)
    && !classification.riskDetectorMismatchExpected,
  );

  return {
    ...classification,
    detectorVerdict: detection.verdict,
    detectorFindings: detection.findings,
    detectorClassificationMismatch: mismatch,
  };
}

function loadRegistries(repoRoot) {
  const paths = defaultRegistryPaths(repoRoot);
  return {
    classifications: loadJson(paths.classifications),
    baseline: loadJson(paths.baseline),
  };
}

module.exports = {
  RISK_CLASSES,
  CLASSIFICATION_STATUS,
  DETECTOR_VERDICT,
  RISK_PATTERNS,
  stripSqlComments,
  splitStatements,
  extractRoutineBodies,
  detectRiskPatterns,
  classifyMigration,
  assessMigration,
  loadRegistries,
  defaultRegistryPaths,
};
