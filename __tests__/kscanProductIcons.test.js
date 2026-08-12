/**
 * Batch 5 — Product icon button integration.
 *
 * Scope contract (owner correction, Batch 5):
 *   Approved custom icons replace generic AI-star / sparkle glyphs ONLY where
 *   those glyphs are used as BUTTON icons on ACTIVE app surfaces, and only
 *   where a corresponding approved icon exists.
 *
 *   Decorative sparkles, illustrations, empty-state artwork, status indicators,
 *   section headers, badges and cover-fallback glyphs are intentionally
 *   PRESERVED. No substitute icon is invented for a surface that has no
 *   approved custom asset.
 *
 * These are source-contract tests (no renderer), consistent with the rest of
 * the suite.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ICON_DIR = path.join(ROOT, 'components', 'icons', 'kscan');

const read = (...segments) => fs.readFileSync(path.join(ROOT, ...segments), 'utf8');
const readIcon = (name) => fs.readFileSync(path.join(ICON_DIR, name), 'utf8');

const HOME = read('components', 'home', 'HomeLuxuryTechV1.tsx');
const LIVE_HOME = read('app', 'index.tsx');
const STYLIST_CARD = read('components', 'home', 'HomeStylistCard.tsx');
const SCAN_LANDING = read('components', 'scan-room', 'ScanLanding.tsx');
const LIVE_CAMERA = read('components', 'scan-room', 'LiveScanCamera.tsx');
const LUXURY_BUTTON = read('components', 'luxury', 'LuxuryButton.tsx');
const PACKAGE_JSON = JSON.parse(read('package.json'));

/** The six approved product icons. */
const APPROVED_ICON_NAMES = [
  'dressing-rooms',
  'textscan',
  'recent-scans',
  'visual-search',
  'save-organize',
  'style',
];

const ICON_FILES = [
  'DressingRoomsIcon.tsx',
  'TextScanIcon.tsx',
  'RecentScansIcon.tsx',
  'VisualSearchIcon.tsx',
  'SaveOrganizeIcon.tsx',
  'StyleIcon.tsx',
  'KScanIcon.tsx',
  'iconTypes.ts',
  'index.ts',
  'iconShared.tsx',
];

/* ------------------------------------------------------------------ *
 * 1. Icon package integrity
 * ------------------------------------------------------------------ */

test('icons: approved icon package files all exist', () => {
  for (const file of ICON_FILES) {
    assert.ok(fs.existsSync(path.join(ICON_DIR, file)), `missing ${file}`);
  }
});

test('icons: react-native-svg is a direct, exact dependency', () => {
  assert.equal(PACKAGE_JSON.dependencies['react-native-svg'], '15.12.1');
});

test('icons: registry lists all six approved names exactly once', () => {
  const registry = readIcon('KScanIcon.tsx');
  for (const name of APPROVED_ICON_NAMES) {
    const key = name.includes('-') ? `'${name}'` : name;
    const matches = registry.match(new RegExp(`${key.replace(/-/g, '\\-')}\\s*:`, 'g')) || [];
    assert.equal(matches.length, 1, `registry must contain ${name} exactly once`);
  }
  assert.match(registry, /as const satisfies Record<KScanIconName/);
});

test('icons: name union matches the registry keys', () => {
  const types = readIcon('iconTypes.ts');
  for (const name of APPROVED_ICON_NAMES) {
    assert.match(types, new RegExp(`'${name}'`), `union missing ${name}`);
  }
});

test('icons: every identifier resolves to a distinct glyph component', () => {
  const registry = readIcon('KScanIcon.tsx');
  const components = APPROVED_ICON_NAMES.map((name) => {
    const key = name.includes('-') ? `'${name}'` : name;
    const match = registry.match(
      new RegExp(`${key.replace(/-/g, '\\-')}\\s*:\\s*(\\w+)`),
    );
    assert.ok(match, `no component mapped for ${name}`);
    return match[1];
  });
  assert.equal(
    new Set(components).size,
    APPROVED_ICON_NAMES.length,
    'two icon names resolve to the same component',
  );
});

test('icons: unknown identifier uses a neutral fallback and never crashes', () => {
  const registry = readIcon('KScanIcon.tsx');
  // Guarded lookup, explicit neutral return — not an unrelated feature glyph.
  assert.match(registry, /if \(!isKScanIconName\(name\)\)/);
  assert.match(registry, /return null;/);
  assert.match(registry, /hasOwnProperty\.call\(KSCAN_ICON_REGISTRY, value\)/);
});

test('icons: package contains no raster assets and no avatar/portrait usage', () => {
  for (const file of ICON_FILES) {
    const source = readIcon(file);
    assert.doesNotMatch(
      source,
      /require\(['"`].*\.(png|jpe?g|webp)/i,
      `${file} must not import a raster asset`,
    );
    assert.doesNotMatch(
      source,
      /portrait|avatar/i,
      `${file} must not reference avatar/portrait assets`,
    );
  }
});

test('icons: product icons did not overwrite any avatar asset directory', () => {
  // The icon package is code-only; the approved avatar image set is untouched.
  assert.ok(fs.existsSync(ICON_DIR));
  const strays = fs
    .readdirSync(ICON_DIR)
    .filter((f) => /\.(png|jpe?g|webp|svg)$/i.test(f));
  assert.deepEqual(strays, [], 'no image files should live in the icon package');
});

/* ------------------------------------------------------------------ *
 * 2. Button-level replacements — active surfaces
 * ------------------------------------------------------------------ */

test('home: live router home still renders HomeLuxuryTechV1', () => {
  assert.match(LIVE_HOME, /import \{ HomeLuxuryTechV1 \} from '\.\.\/components\/home'/);
  assert.match(LIVE_HOME, /return <HomeLuxuryTechV1 \/>/);
});

test('home: Recent Scans button uses recent-scans icon, keeps handler + label', () => {
  assert.match(HOME, /icon=\{<KScanIcon name="recent-scans"/);
  assert.match(HOME, /title="RECENT SCANS"/);
  assert.match(HOME, /testID="home-luxury-feature-recent-scans"/);
  assert.match(HOME, /accessibilityLabel="Recent Scans"/);
  assert.match(
    HOME,
    /router\.push\(\{ pathname: '\/library', params: \{ section: 'recent' \} \}\)/,
  );
});

test('home: Visual Search button uses visual-search icon, keeps /scan', () => {
  // 24, not 28: a 24-unit viewBox drawn at 24pt maps one user unit to a whole
  // number of device pixels, so stroke edges land on pixel boundaries. 28
  // scaled by 7/6 and softened every edge in the set.
  assert.match(HOME, /icon=\{<KScanIcon name="visual-search" size=\{24\}/);
  assert.match(HOME, /title="VISUAL SEARCH"/);
  assert.match(HOME, /testID="home-luxury-feature-scan"/);
  assert.match(HOME, /accessibilityLabel="Open Visual Search"/);
});

test('home: Closet button uses save-organize icon, keeps /library', () => {
  assert.match(HOME, /icon=\{<KScanIcon name="save-organize"/);
  assert.match(HOME, /title="CLOSET"/);
  assert.match(HOME, /accessibilityLabel="Open Closet"/);
});

test('home: Dressing Rooms button uses dressing-rooms icon, keeps route', () => {
  assert.match(HOME, /icon=\{<KScanIcon name="dressing-rooms"/);
  assert.match(HOME, /title="DRESSING ROOMS"/);
  assert.match(HOME, /router\.push\('\/dressing-rooms'\)/);
  assert.match(HOME, /accessibilityLabel="Open Dressing Rooms"/);
});

test('home: TextScan button uses textscan icon and keeps flag-gated navigation', () => {
  // Previously 20pt/compact, which rendered TextScan's stroke ~30% lighter
  // than its siblings. It now shares the one Home icon size.
  assert.match(HOME, /icon=\{<KScanIcon name="textscan" size=\{24\} variant="standard"/);
  assert.match(HOME, /title="TEXTSCAN"/);
  assert.match(HOME, /testID="home-luxury-textscan"/);
  assert.match(HOME, /onPress=\{handleOpenTextScan\}/);
  assert.match(HOME, /TEXTSCAN_UI_ENABLED/);
  assert.match(HOME, /isFeatureEnabled\('textScan'\)/);
});

test('home: Start Scan CTA uses visual-search icon legible on the plum fill', () => {
  assert.match(HOME, /testID="home-luxury-start-scan"/);
  assert.match(HOME, /title="START SCAN"/);
  assert.match(HOME, /name="visual-search"[\s\S]{0,160}?color=\{LUXURY\.colors\.inverse\}/);
  assert.match(HOME, /accentColor=\{LUXURY\.colors\.goldChampagne\}/);
  // Route and accessible name preserved.
  assert.match(HOME, /accessibilityLabel="Start a scan"/);
  assert.match(HOME, /accessibilityHint="Opens the scan landing"/);
});

test('scan landing: TextScan button uses textscan icon, keeps handler + label', () => {
  assert.match(SCAN_LANDING, /<KScanIcon name="textscan" size=\{16\} variant="compact" \/>/);
  assert.match(SCAN_LANDING, />Describe an item</);
  assert.match(SCAN_LANDING, /onPress=\{onTextScan\}/);
  assert.match(SCAN_LANDING, /accessibilityLabel="Describe an item with TextScan"/);
  assert.match(SCAN_LANDING, /testID="scan-room-textscan"/);
  assert.match(SCAN_LANDING, /\{textScanEnabled && \(/);
  // Row layout added so the icon and label stay aligned and centered.
  assert.match(SCAN_LANDING, /textScanButton:\s*\{[\s\S]*?flexDirection: 'row'/);
  assert.match(SCAN_LANDING, /textScanButton:\s*\{[\s\S]*?minHeight: 44/);
});

test('live camera: TextScan pill uses textscan icon, keeps handler + label', () => {
  assert.match(LIVE_CAMERA, /<KScanIcon name="textscan" size=\{14\} variant="compact" \/>/);
  assert.match(LIVE_CAMERA, />TextScan</);
  assert.match(LIVE_CAMERA, /onPress=\{onTextScan\}/);
  assert.match(LIVE_CAMERA, /accessibilityLabel="Open TextScan"/);
  assert.match(LIVE_CAMERA, /\{textScanEnabled && \(/);
  assert.match(LIVE_CAMERA, /controlPillWithIcon:\s*\{[\s\S]*?flexDirection: 'row'/);
});

test('buttons: icon slot contract is the existing LuxuryButton API (no new framework)', () => {
  assert.match(LUXURY_BUTTON, /icon\?: React\.ReactNode/);
  assert.match(LUXURY_BUTTON, /accessibilityLabel=\{accessibilityLabel \?\? title\}/);
});

test('home: chip icons are decorative under an already-labeled button', () => {
  assert.match(HOME, /accessibilityElementsHidden/);
  assert.match(HOME, /importantForAccessibility="no"/);
  assert.match(HOME, /chipIconWrap:\s*\{[\s\S]*?width: 28[\s\S]*?height: 28/);
});

/* ------------------------------------------------------------------ *
 * 3. Global proof — no approved-icon button still shows a generic AI-star
 * ------------------------------------------------------------------ */

const SPARKLE = /[✦✧✨★☆⋆]/; // ✦ ✧ ✨ ★ ☆ ⋆

/** Files that are present but not reachable from any route. */
const DORMANT = new Set([
  path.join('components', 'home', 'HomeLegacy.tsx'),
  path.join('components', 'home', 'HomeV2.tsx'),
]);

/**
 * Button-icon sites that legitimately keep a sparkle because NO approved
 * custom icon exists for that action. Documented, not silently tolerated.
 */
const ALLOWED_SPARKLE_BUTTONS = new Map([
  [
    path.join('components', 'account-home', 'WelcomeStepV1.tsx'),
    'GET STARTED — onboarding CTA, no approved product icon for this action',
  ],
  [
    path.join('components', 'account-home', 'PermissionsStepV1.tsx'),
    'CONTINUE TO HOME / SAVING — onboarding CTA, no approved product icon',
  ],
]);

const readFileForDetector = (...segments) => read(...segments);

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (entry.name.endsWith('.tsx')) acc.push(full);
  }
  return acc;
}

/**
 * Components whose `icon` prop is illustration / empty-state artwork rather
 * than a button affordance. Per the Batch 5 scope these are NOT replaced.
 */
const ILLUSTRATION_COMPONENTS = new Set(['EmptyStateCard', 'InlineNotice']);

/**
 * Nearest enclosing JSX element name at or above `index`.
 * On the hit line itself only the text BEFORE the prop is considered, so that
 * markup inside the prop value (e.g. `icon={<Text>✦</Text>}`) is not mistaken
 * for the owning element.
 */
function enclosingElement(lines, index, propStart) {
  const head = propStart >= 0 ? lines[index].slice(0, propStart) : lines[index];
  const own = head.match(/<([A-Z]\w*)/);
  if (own) return own[1];
  for (let i = index - 1; i >= 0; i -= 1) {
    const match = lines[i].match(/<([A-Z]\w*)/);
    if (match) return match[1];
  }
  return null;
}

/** Lines where a sparkle is used as a BUTTON icon (icon slot or CTA title). */
function findSparkleButtonLines(source) {
  const lines = source.split('\n');
  const hits = [];
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!SPARKLE.test(line)) return;
    const propMatch = raw.match(/\b(icon|title)=/);
    if (!propMatch) return;
    // An `icon`/`title` prop on illustration artwork is not a button icon.
    const owner = enclosingElement(lines, i, propMatch.index);
    if (owner && ILLUSTRATION_COMPONENTS.has(owner)) return;
    hits.push({ line, n: i + 1, owner });
  });
  return hits;
}

test('global: no active app button uses a generic AI-star where an approved icon exists', () => {
  const files = [
    ...walk(path.join(ROOT, 'app')),
    ...walk(path.join(ROOT, 'components')),
  ];

  const offenders = [];
  for (const file of files) {
    const rel = path.relative(ROOT, file);
    if (DORMANT.has(rel) || ALLOWED_SPARKLE_BUTTONS.has(rel)) continue;
    const hits = findSparkleButtonLines(fs.readFileSync(file, 'utf8'));
    for (const hit of hits) offenders.push(`${rel}:${hit.n} → ${hit.line}`);
  }

  assert.deepEqual(
    offenders,
    [],
    `Button-level AI-star placeholders remain:\n${offenders.join('\n')}`,
  );
});

test('global: the sparkle-button detector is not vacuous', () => {
  // Negative control — every allowlisted file must STILL be a genuine
  // sparkle-button site. If one is cleaned up or renamed, the allowlist entry
  // must be removed rather than left to silently weaken the proof above.
  for (const [rel, reason] of ALLOWED_SPARKLE_BUTTONS) {
    const hits = findSparkleButtonLines(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    assert.ok(
      hits.length > 0,
      `allowlist entry is stale (${reason}): ${rel} no longer has a sparkle button`,
    );
  }
  // And the detector must positively identify a button owner, not just any tag.
  const welcome = readFileForDetector('components', 'account-home', 'WelcomeStepV1.tsx');
  assert.ok(findSparkleButtonLines(welcome).some((h) => /Button/.test(h.owner ?? '')));
});

test('global: dormant home implementations remain unrouted', () => {
  // Their sparkles are unreachable, which is why they are excluded above.
  const files = [
    ...walk(path.join(ROOT, 'app')),
    ...walk(path.join(ROOT, 'components')),
  ];
  for (const file of files) {
    const rel = path.relative(ROOT, file);
    if (rel === path.join('components', 'home', 'index.ts')) continue;
    const source = fs.readFileSync(file, 'utf8');
    if (DORMANT.has(rel)) continue;
    assert.doesNotMatch(
      source,
      /<(HomeLegacy|HomeV2)\s*\/>/,
      `${rel} must not render a dormant home implementation`,
    );
  }
});

test('global: exactly one active home implementation owns the / route', () => {
  const appRoot = fs.readdirSync(path.join(ROOT, 'app'));
  assert.ok(appRoot.includes('index.tsx'));
  assert.match(LIVE_HOME, /HomeLuxuryTechV1/);
  assert.doesNotMatch(LIVE_HOME, /HomeLegacy|HomeV2/);
});

/* ------------------------------------------------------------------ *
 * 4. Preservation — decorative sparkles must NOT be replaced
 * ------------------------------------------------------------------ */

test('preserve: YOUR STYLIST section-header sparkle is untouched (decorative)', () => {
  assert.match(STYLIST_CARD, /<Text style=\{styles\.sparkle\}>✦<\/Text>/);
  assert.doesNotMatch(STYLIST_CARD, /KScanIcon/);
});

test('preserve: decorative and non-button sparkles remain across active surfaces', () => {
  const decorative = [
    [['app', 'privacy.tsx'], /styles\.trustBullet\}>✦/],
    [['app', 'onboarding', 'index.tsx'], /styles\.trustBullet\}>✦/],
    [['app', 'text-scan', 'index.tsx'], /styles\.introSparkle\}>✦/],
    [['app', 'text-scan', 'index.tsx'], /styles\.processingSparkle\}>✦/],
    [['components', 'text-scan', 'AIStarBadge.tsx'], /styles\.sparkle\}>✦/],
    [['components', 'text-scan', 'TextScanSuggestionChip.tsx'], /styles\.sparkle\}>✦/],
    [['components', 'scan-room', 'ScanRoomHeader.tsx'], /styles\.dividerText\}>✧/],
    [['components', 'scan-results', 'ScanResultV2.tsx'], /styles\.dividerText\}>✧/],
    [['components', 'scan-room', 'ScanLanding.tsx'], /styles\.featureIcon\}>✦/],
  ];
  for (const [segments, pattern] of decorative) {
    assert.match(read(...segments), pattern, `${segments.join('/')} lost a decorative glyph`);
  }
});

test('preserve: empty-state artwork icons are not replaced', () => {
  assert.match(LIVE_CAMERA, /styles\.permissionIcon\}>✦/);
  assert.match(read('components', 'scan-room', 'AnalyzingScan.tsx'), /styles\.errorIcon\}>✦/);
});

test('preserve: dressing-room cover-fallback glyphs are unchanged', () => {
  const dr = read('app', 'dressing-rooms', 'index.tsx');
  assert.match(dr, /const SHARED_ROOM_GLYPH = '✦'/);
  assert.match(dr, /const OWNED_ROOM_GLYPH = '◇'/);
  assert.doesNotMatch(dr, /KScanIcon/);
});

test('preserve: permission card icons and profile avatar fallback unchanged', () => {
  const permissions = read('components', 'account-home', 'PermissionsStepV1.tsx');
  assert.match(permissions, /icon="◉"/);
  assert.match(permissions, /icon="◈"/);
  assert.doesNotMatch(permissions, /KScanIcon/);
  // Home profile button keeps its initial/sparkle avatar fallback. Asserted on
  // the BEHAVIOUR, not on the identifier: Build 29 moved name resolution into
  // `resolvePreferredName`, renaming `profileName` to `preferredName` without
  // changing what the avatar renders. Pinning the old identifier reported a
  // regression that did not exist while still being blind to a real one.
  assert.match(HOME, /(\w+) \? \1\.charAt\(0\)\.toUpperCase\(\) : '✦'/);
});

test('preserve: VoiceScan placeholder stays inactive and non-interactive', () => {
  assert.match(HOME, /testID="home-luxury-voicescan-coming-soon"/);
  assert.match(HOME, /VOICESCAN_ENABLED/);
  assert.match(HOME, /accessibilityRole="text"/);
  assert.doesNotMatch(HOME, /voiceScanPill[\s\S]{0,400}?onPress/);
});
