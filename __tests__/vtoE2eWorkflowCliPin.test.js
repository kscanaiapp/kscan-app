const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKFLOW = fs.readFileSync(
  path.join(__dirname, '..', '.github', 'workflows', 'vto-e2e.yml'), 'utf8',
);

test('vto-e2e pins the Supabase CLI in every setup step instead of resolving "latest"', () => {
  // "latest" resolves through the GitHub releases API and can fail on a rate
  // limit before any step runs (seen 2026-10-16). Same pin as the other
  // governed workflows.
  const setups = [...WORKFLOW.matchAll(/uses:\s*supabase\/setup-cli@v1\s+with:\s+version:\s*(\S+)/g)];
  assert.equal(setups.length, 3, 'every Supabase CLI setup step is covered');
  for (const [, version] of setups) assert.equal(version, '2.109.1');
  assert.doesNotMatch(WORKFLOW, /version:\s*latest/);
});