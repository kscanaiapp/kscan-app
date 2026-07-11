// Migration-order and destructive-operation review for the Elise UX polish build.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');

const migrations = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();

const auditFile = migrations.find((f) => f.endsWith('_audit_hardening_ai_stylist_stylechat.sql'));
const savedScanMediaFile = '20260712000001_saved_scan_media_backing.sql';
const auditMigration = auditFile ? fs.readFileSync(path.join(MIGRATIONS_DIR, auditFile), 'utf8') : '';
const savedScanMediaMigration = fs.readFileSync(path.join(MIGRATIONS_DIR, savedScanMediaFile), 'utf8');

const dangerousPatterns = [
  /\bdrop table\b/i,
  /\bdrop column\b/i,
  /\balter\s+\S+\s+drop\b/i,
  /\bdelete\s+from\b/i,
  /\btruncate\s+/i,
];

// ── Order and dependency ─────────────────────────────────────────────────────

test('all migrations are enumerated in filename order', () => {
  assert.ok(migrations.length > 0);
  assert.ok(migrations.includes(savedScanMediaFile));
  assert.ok(auditFile, 'audit hardening migration missing');
});

test('audit-hardening migration sorts after saved-scan media migration', () => {
  assert.ok(auditFile, 'audit hardening migration missing');
  const auditIndex = migrations.indexOf(auditFile);
  const mediaIndex = migrations.indexOf(savedScanMediaFile);
  assert.ok(auditIndex > mediaIndex, `audit migration ${auditFile} does not sort after ${savedScanMediaFile}`);
});

test('audit-hardening migration references saved_scans media columns created by Phase 2 media migration', () => {
  assert.match(auditMigration, /alter table public\.saved_scans[\s\S]*?storage_bucket/);
  assert.match(auditMigration, /alter table public\.saved_scans[\s\S]*?storage_path/);
});

test('saved-scan media migration creates the referenced columns', () => {
  assert.match(savedScanMediaMigration, /add column if not exists storage_bucket/);
  assert.match(savedScanMediaMigration, /add column if not exists storage_path/);
});

test('audit-hardening migration does not reference inspiration_items styling metadata from media migration', () => {
  // The audit migration only references inspiration_items ownership/identity columns,
  // not the additive category/color/pattern/material/silhouette/garment_role columns.
  assert.doesNotMatch(auditMigration, /inspiration_items\.category\b/);
  assert.doesNotMatch(auditMigration, /inspiration_items\.color\b/);
  assert.doesNotMatch(auditMigration, /inspiration_items\.pattern\b/);
  assert.doesNotMatch(auditMigration, /inspiration_items\.material\b/);
  assert.doesNotMatch(auditMigration, /inspiration_items\.silhouette\b/);
  assert.doesNotMatch(auditMigration, /inspiration_items\.garment_role\b/);
});

test('only one audit-hardening migration exists', () => {
  const auditFiles = migrations.filter((f) => f.endsWith('_audit_hardening_ai_stylist_stylechat.sql'));
  assert.strictEqual(auditFiles.length, 1);
});

// ── Destructive operation review ─────────────────────────────────────────────

test('audit-hardening migration contains only safe replacement drops', () => {
  const statements = auditMigration.split(/;\s*\n/).filter((s) => s.trim().length > 0);
  for (const stmt of statements) {
    for (const pattern of dangerousPatterns) {
      if (pattern.test(stmt)) {
        // DROP FUNCTION/TRIGGER/POLICY/INDEX/CONSTRAINT IF EXISTS followed by a
        // compatible replacement is the only permitted destructive pattern.
        const isSafeReplacement =
          /^\s*drop\s+(function|trigger|policy|index|constraint)\s+if\s+exists/i.test(stmt) &&
          (/create\s+or\s+replace\s+function/i.test(auditMigration) ||
           /create\s+trigger/i.test(auditMigration) ||
           /create\s+policy/i.test(auditMigration) ||
           /add\s+constraint/i.test(auditMigration));
        assert.ok(
          isSafeReplacement,
          `Potentially dangerous statement in audit migration: ${stmt.slice(0, 200)}`,
        );
      }
    }
  }
});

test('audit-hardening migration does not drop required Phase 1 or Phase 2 tables', () => {
  const requiredTables = [
    'saved_scans',
    'inspiration_items',
    'looks',
    'look_items',
    'dressing_rooms',
    'dressing_room_items',
    'outfit_decision_groups',
    'outfit_decision_options',
    'outfit_decision_option_items',
    'outfit_decision_votes',
  ];
  for (const table of requiredTables) {
    assert.doesNotMatch(
      auditMigration,
      new RegExp(`drop\\s+table\\s+if\\s+exists\\s+public\\.${table}\\b`, 'i'),
      `audit migration drops required table ${table}`,
    );
    assert.doesNotMatch(
      auditMigration,
      new RegExp(`drop\\s+table\\s+public\\.${table}\\b`, 'i'),
      `audit migration drops required table ${table}`,
    );
  }
});

test('Phase 1 and Phase 2 migrations remain present', () => {
  assert.ok(migrations.includes('20260711000001_ai_stylist_looks_extension.sql'));
  assert.ok(migrations.includes('20260711000002_outfit_decision_rooms.sql'));
  assert.ok(migrations.includes('20260711000003_style_outfit_usage.sql'));
  assert.ok(migrations.includes(savedScanMediaFile));
});
