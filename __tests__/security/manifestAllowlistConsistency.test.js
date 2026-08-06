#!/usr/bin/env node
'use strict';

/**
 * Cross-checks security/perimeter/public-ingress-manifest.json against
 * security/scripts/anon-grant-guard.js's ANON_EXECUTE_ALLOWLIST so the two
 * can never silently drift apart -- a new RPC marked PUBLIC_WITH_ABUSE_CONTROLS
 * or INTENTIONALLY_PUBLIC in the manifest without a matching allowlist entry
 * would mean the drift guard blocks a legitimate future public RPC; an
 * allowlist entry with no manifest classification would mean a publicly
 * callable function exists with no recorded audit trail.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { ANON_EXECUTE_ALLOWLIST } = require('../../security/scripts/anon-grant-guard');

const manifestPath = path.join(__dirname, '..', '..', 'security', 'perimeter', 'public-ingress-manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

const publicRpcSurfaces = manifest.surfaces.filter(
  (s) => s.type === 'supabase_rpc' && ['INTENTIONALLY_PUBLIC', 'PUBLIC_WITH_ABUSE_CONTROLS'].includes(s.riskClassification),
);

test('every manifest RPC classified as publicly callable has a matching anon-allowlist entry', () => {
  for (const surface of publicRpcSurfaces) {
    assert.ok(
      ANON_EXECUTE_ALLOWLIST.includes(surface.name),
      `${surface.name} is classified ${surface.riskClassification} in the manifest but is not in ANON_EXECUTE_ALLOWLIST`,
    );
  }
});

test('every anon-allowlist entry has a corresponding manifest RPC surface', () => {
  const manifestRpcNames = new Set(manifest.surfaces.filter((s) => s.type === 'supabase_rpc').map((s) => s.name));
  for (const fnName of ANON_EXECUTE_ALLOWLIST) {
    assert.ok(manifestRpcNames.has(fnName), `${fnName} is anon-allowlisted but has no manifest entry at all`);
  }
});

test('the manifest RPC surfaces are exactly the three reviewed public RPCs (no untracked public RPC exists yet)', () => {
  const names = manifest.surfaces.filter((s) => s.type === 'supabase_rpc').map((s) => s.name).sort();
  assert.deepEqual(names, ['get_item_reaction_counts', 'get_public_room_decision_preview', 'get_public_room_preview']);
});

test('manifest and allowlist stay in exact 1:1 correspondence (same length, same names)', () => {
  const manifestNames = publicRpcSurfaces.map((s) => s.name).sort();
  const allowlistNames = [...ANON_EXECUTE_ALLOWLIST].sort();
  assert.deepEqual(manifestNames, allowlistNames);
});
