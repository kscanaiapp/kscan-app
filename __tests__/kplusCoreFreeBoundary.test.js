/**
 * Build 34 K+ entitlement audit — KPLUS-NC-011 … NC-014.
 *
 * THE CORE/FREE BOUNDARY, PINNED AS AN INVENTORY.
 *
 * K+ gating is correct today: eight gate sites across four sources, none of
 * them on a core surface. Nothing pinned that. `scannerObjectivityFirewall`
 * guards exactly one screen (Scan Results); every other core surface —
 * Scanner entry, Text Scan, base Elise, Dressing Rooms, Library/Saved,
 * privacy/account — had no control at all. Proven by mutation during the K+
 * entitlement audit: putting `if (!kPlusEntitlement.isActive) return null;`
 * at the top of the Elise conversation screen left the K+ suites at
 * 37 pass / 0 fail.
 *
 * A per-screen test would only ever cover the screens someone remembered to
 * name, and a K+ gate can be added to a screen nobody enumerated. So the
 * control is the INVENTORY: every K+ gate site in the shipped app, and every
 * module that reads the entitlement at all. Adding a gate anywhere — core
 * surface or not — changes the inventory and fails here, which forces the
 * question "is this surface allowed to be K+?" to be answered deliberately
 * rather than by omission.
 *
 * Updating these tables is a legitimate part of shipping a new K+ surface.
 * Updating them to admit a gate on a CORE feature is the thing the Build 34
 * product contract forbids (audit sections 4, 46-49, 100).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SCANNED_ROOTS = ['app', 'components'];

/**
 * Every `<KPlusGate source="…">` in the shipped app, as `relative/path -> source`.
 *
 * A K+ FEATURE may appear here. A CORE feature may not:
 *   - Scanner entry / identification / results (except the Watch affordance)
 *   - Text Scan's own query + submit path (the Voice Scan accessory IS K+)
 *   - the Elise conversation itself
 *   - Dressing Rooms
 *   - Library / Saved / Recent Scans
 *   - privacy, security, account, deletion, accessibility
 */
const EXPECTED_GATE_SITES = [
  'app/packing/index.tsx -> packing',
  'app/watchlist/[watchId].tsx -> watchlist',
  'components/ProductShelf.tsx -> watchlist',
  'components/home/HomeLuxuryTechV1.tsx -> watchlist',
  'components/home/HomeVoiceScanPill.tsx -> voice_scan',
  'components/scan-results/PurchaseOptionsPanel.tsx -> watchlist',
  'components/text-scan/TextScanFeatureRow.tsx -> voice_scan',
  'components/text-scan/VoiceScanButton.tsx -> voice_scan',
  'components/vto/TryItOnEntry.tsx -> vto',
];

/**
 * Every module that reads K+ state directly, and why.
 *
 * Reading the entitlement is not the same as gating on it — `privacy.tsx`
 * renders a status row and the Elise screen chooses wait copy — but an
 * unlisted reader is an ungoverned decision point, so the set is closed.
 */
const EXPECTED_ENTITLEMENT_READERS = [
  'app/privacy.tsx',                  // Account screen K+ status row (display only)
  'app/style-chat/[sessionId].tsx',   // chooses Concierge vs base wait copy
  'components/kplus/KPlusEarlyAccessSheet.tsx',
  'components/kplus/KPlusGate.tsx',   // the shared gate itself
];

/** Core surfaces that must contain no K+ gate and make no K+ render decision. */
const CORE_SURFACES = [
  'app/index.tsx',
  'app/library.tsx',
  'app/text-scan/index.tsx',
  'app/dressing-rooms/index.tsx',
  'app/dressing-rooms/[id].tsx',
];

/**
 * Core surfaces that legitimately READ K+ but must never GATE on it, and the
 * exact number of times each one touches the hook result.
 *
 * The inventory tests above cannot protect these two: they are already on the
 * approved reader list, so an added `if (!kPlusEntitlement.isActive) return
 * null;` changes nothing they assert. That mutation is exactly NC-013 —
 * putting base Elise behind K+ — and it survived until this test existed.
 *
 * Counting the touches is what makes the difference: a gate has to read the
 * entitlement somewhere, so any new decision point moves the count. The count
 * includes the `const … = useKPlusEntitlement()` binding itself.
 */
const CORE_SURFACE_READERS = {
  // 1 binding + 1 read: chooses Concierge vs base wait copy. The Elise
  // conversation itself is core/free and renders for every actor.
  'app/style-chat/[sessionId].tsx': 2,
  // 1 binding + 11 reads: the Account screen's K+ status row — expiry label,
  // status text, tone, action label, and one telemetry property. Display only;
  // nothing on this screen is withheld from a non-K+ actor.
  'app/privacy.tsx': 12,
};

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(tsx|ts|js|jsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function shippedFiles() {
  const files = SCANNED_ROOTS.flatMap((rel) => walk(path.join(ROOT, rel)));
  // If the walk ever comes back empty the assertions below would all pass
  // vacuously, which is exactly how a firewall stops firewalling.
  assert.ok(files.length > 100, `expected to scan the shipped app, found ${files.length} files`);
  return files;
}

const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');

test('NC-011..NC-014: the K+ gate-site inventory is exactly the approved set', () => {
  const found = [];
  for (const abs of shippedFiles()) {
    const src = fs.readFileSync(abs, 'utf8');
    for (const m of src.matchAll(/<KPlusGate\s+source="([^"]*)"/g)) {
      found.push(`${rel(abs)} -> ${m[1]}`);
    }
  }
  assert.deepEqual(found.sort(), [...EXPECTED_GATE_SITES].sort(),
    'The set of K+ gate sites changed. A K+ feature may be added here deliberately; a CORE ' +
    'feature (Scanner, Text Scan, base Elise, Dressing Rooms, Library/Saved, privacy/account) ' +
    'may never be gated on K+ — see audit sections 4 and 46-49.');
});

test('NC-011..NC-014: every K+ gate names a source from the bounded taxonomy', () => {
  const src = fs.readFileSync(path.join(ROOT, 'types/kplusSource.ts'), 'utf8');
  const start = src.indexOf('export const KPLUS_SOURCES');
  assert.ok(start >= 0, 'KPLUS_SOURCES must exist in types/kplusSource.ts');
  const end = src.indexOf('] as const;', start);
  assert.ok(end > start, 'KPLUS_SOURCES must be a closed as-const array');
  const taxonomy = [...src.slice(start, end).matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(taxonomy.length >= 2, 'the K+ source taxonomy must have parsed, not come back empty');

  for (const site of EXPECTED_GATE_SITES) {
    const source = site.split(' -> ')[1];
    assert.ok(taxonomy.includes(source),
      `gate site "${site}" uses source "${source}", which is not in types/kplusSource.ts — an ` +
      'unbounded source escapes the telemetry allowlist and reads as "unknown"');
  }
});

test('NC-011..NC-014: the set of modules that read K+ state is closed', () => {
  const found = [];
  for (const abs of shippedFiles()) {
    const src = fs.readFileSync(abs, 'utf8');
    // The hook is how a component learns its own K+ state. KPlusGate consumers
    // are covered by the gate-site inventory above; this catches a component
    // that reaches past the shared gate and decides for itself.
    if (/\buseKPlusEntitlement\s*\(/.test(src)) found.push(rel(abs));
  }
  assert.deepEqual(found.sort(), [...EXPECTED_ENTITLEMENT_READERS].sort(),
    'A module started reading K+ entitlement directly. Every K+ capability should render ' +
    'through the shared KPlusGate; a direct read is a second, ungoverned gate unless it is ' +
    'display-only. Add it here with the reason, and confirm it does not gate a core feature.');
});

test('NC-011..NC-014: named core surfaces make no K+ decision at all', () => {
  for (const relPath of CORE_SURFACES) {
    const abs = path.join(ROOT, relPath);
    assert.ok(fs.existsSync(abs), `core surface ${relPath} is missing — update this list`);
    const src = fs.readFileSync(abs, 'utf8');
    assert.doesNotMatch(src, /<KPlusGate/,
      `${relPath} is a core/free surface and must never render a K+ gate`);
    assert.doesNotMatch(src, /\buseKPlusEntitlement\s*\(/,
      `${relPath} is a core/free surface and must not read K+ entitlement`);
  }
});

test('NC-013: a core surface that reads K+ never gains a new decision point', () => {
  for (const [relPath, expected] of Object.entries(CORE_SURFACE_READERS)) {
    const abs = path.join(ROOT, relPath);
    assert.ok(fs.existsSync(abs), `${relPath} is missing — update CORE_SURFACE_READERS`);
    const src = fs.readFileSync(abs, 'utf8');
    const binding = src.match(/const\s+([A-Za-z_$][\w$]*)\s*=\s*useKPlusEntitlement\s*\(/);
    assert.ok(binding, `${relPath} is listed as a K+ reader but does not bind the hook result`);
    const name = binding[1];
    const touches = [...src.matchAll(new RegExp(`\\b${name}\\b`, 'g'))].length;
    assert.equal(touches, expected,
      `${relPath} now touches the K+ entitlement ${touches} times, not ${expected}. This screen ` +
      'is CORE/FREE: it may read K+ to describe it, never to withhold the feature. If the new ' +
      'touch is display-only, update the count and say what it does; if it gates rendering, it ' +
      'is a core feature put behind K+ — see audit sections 4 and 46-49.');
  }
});
