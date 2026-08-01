const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ICON_DIR = path.join(ROOT, 'components', 'icons', 'kscan');
const THEME = fs.readFileSync(path.join(ROOT, 'constants', 'theme.ts'), 'utf8');
const PACKAGE_JSON = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const ICON_FILES = [
  'DressingRoomsIcon.tsx',
  'TextScanIcon.tsx',
  'RecentScansIcon.tsx',
  'VisualSearchIcon.tsx',
  'SaveOrganizeIcon.tsx',
  'VoiceScanIcon.tsx',
  'StyleIcon.tsx',
  'KScanIcon.tsx',
  'iconTypes.ts',
  'index.ts',
  'iconShared.tsx',
];

const SEMANTIC_NAMES = [
  'dressing-rooms',
  'textscan',
  'recent-scans',
  'visual-search',
  'save-organize',
  'voice-scan',
  'style',
];

function readIcon(name) {
  return fs.readFileSync(path.join(ICON_DIR, name), 'utf8');
}

test('unit: icon package files exist', () => {
  for (const file of ICON_FILES) {
    assert.ok(fs.existsSync(path.join(ICON_DIR, file)), `missing ${file}`);
  }
});

test('unit: react-native-svg is a direct dependency', () => {
  assert.ok(PACKAGE_JSON.dependencies['react-native-svg'], 'react-native-svg must be installed');
});

test('unit: registry lists every semantic name exactly once', () => {
  const registrySource = readIcon('KScanIcon.tsx');
  for (const name of SEMANTIC_NAMES) {
    const key = name.includes('-') ? `'${name}'` : name;
    const matches = registrySource.match(new RegExp(`${key.replace(/-/g, '\\-')}\\s*:`, 'g')) || [];
    assert.equal(matches.length, 1, `registry must contain ${name} once`);
  }
  assert.match(registrySource, /as const satisfies Record<KScanIconName/);
});

test('unit: KScanIconName union matches registry keys', () => {
  const types = readIcon('iconTypes.ts');
  for (const name of SEMANTIC_NAMES) {
    assert.match(types, new RegExp(`'${name}'`));
  }
  assert.match(types, /type KScanIconVariant = 'compact' \| 'standard'/);
});

test('unit: every glyph uses 24x24 viewBox and accepts size/color/accent/a11y props', () => {
  const shared = readIcon('iconShared.tsx');
  assert.match(shared, /KSCAN_ICON_VIEWBOX/);
  assert.match(readIcon('iconTypes.ts'), /0 0 24 24/);

  const glyphFiles = [
    'DressingRoomsIcon.tsx',
    'TextScanIcon.tsx',
    'RecentScansIcon.tsx',
    'VisualSearchIcon.tsx',
    'SaveOrganizeIcon.tsx',
    'VoiceScanIcon.tsx',
    'StyleIcon.tsx',
  ];
  for (const file of glyphFiles) {
    const source = readIcon(file);
    assert.match(source, /resolveIconColors\(props\)/);
    assert.match(source, /accessibilityLabel=\{props\.accessibilityLabel\}/);
    assert.match(source, /variant/);
    assert.doesNotMatch(source, /\.png|\.jpe?g|\.webp|data:image|https?:\/\//i);
    assert.doesNotMatch(source, /<\s*Text[\s>]/);
    assert.doesNotMatch(source, /children:\s*['"`]/);
  }
});

test('unit: compact and standard variants are implemented in glyphs', () => {
  for (const file of [
    'TextScanIcon.tsx',
    'VisualSearchIcon.tsx',
    'RecentScansIcon.tsx',
    'SaveOrganizeIcon.tsx',
    'DressingRoomsIcon.tsx',
    'VoiceScanIcon.tsx',
    'StyleIcon.tsx',
  ]) {
    const source = readIcon(file);
    assert.match(source, /variant === 'compact'|compact/);
  }
});

test('unit: theme tokens provide plum and gold defaults', () => {
  assert.match(THEME, /plum:\s*COLORS\.accent/);
  assert.match(THEME, /goldBrushed:\s*'#B08D4B'/);
  const shared = readIcon('iconShared.tsx');
  assert.match(shared, /LUXURY\.colors\.plum/);
  assert.match(shared, /LUXURY\.colors\.goldBrushed/);
});

test('unit: invalid icon names fail safely at runtime', () => {
  const source = readIcon('KScanIcon.tsx');
  assert.match(source, /isKScanIconName/);
  assert.match(source, /return null/);
});

test('unit: index re-exports registry and types', () => {
  const index = readIcon('index.ts');
  assert.match(index, /KSCAN_ICON_REGISTRY/);
  assert.match(index, /KScanIcon/);
  assert.match(index, /KScanIconName/);
});

// ── Crispness and family governance (icon refinement pass) ──────────────────
//
// The icons were soft for two independent reasons, and both are now asserted so
// neither can quietly come back:
//   1. geometry — overlapping strokes, partial arcs and sub-2-unit details that
//      cannot resolve at the size Home renders;
//   2. scaling — a 24-unit viewBox drawn at a size that is not a whole-number
//      multiple of the grid, so no edge landed on a device pixel.

const HOME_GLYPHS = [
  'RecentScansIcon.tsx',
  'VisualSearchIcon.tsx',
  'TextScanIcon.tsx',
  'SaveOrganizeIcon.tsx',
  'DressingRoomsIcon.tsx',
  'VoiceScanIcon.tsx',
];

/** Strips comments so an assertion tests the drawing, not the prose about it. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

test('unit: no glyph uses a blur, shadow, glow, opacity or filter effect', () => {
  for (const file of HOME_GLYPHS) {
    const source = readIcon(file);
    assert.doesNotMatch(source, /filter|blur|shadow|glow|fillOpacity|strokeOpacity|opacity=/i, file);
  }
});

test('unit: every glyph stroke uses the shared round-cap language', () => {
  const shared = readIcon('iconShared.tsx');
  assert.match(shared, /strokeLinecap: 'round'/);
  assert.match(shared, /strokeLinejoin: 'round'/);
  assert.match(shared, /strokeWidth: KSCAN_ICON_STROKE/);
  for (const file of HOME_GLYPHS) {
    // Glyphs must inherit strokeProps rather than hand-rolling stroke settings,
    // which is how the set drifted into inconsistent weights before.
    assert.match(readIcon(file), /\{\.\.\.strokeProps\}/, file);
    assert.doesNotMatch(readIcon(file), /strokeWidth=\{/, `${file} overrides the shared stroke`);
  }
});

test('unit: Visual Search and TextScan share one scan-bracket primitive', () => {
  const shared = readIcon('iconShared.tsx');
  assert.match(shared, /export function ScanBrackets/);
  // Visual Search frames in gold and TextScan in plum, but both must take the
  // frame from the one primitive rather than drawing their own.
  for (const file of ['VisualSearchIcon.tsx', 'TextScanIcon.tsx']) {
    assert.match(readIcon(file), /<ScanBrackets color=\{(color|accentColor)\} \/>/, file);
  }
  // The old TextScan cut its top-right bracket into two segments to clear a
  // sparkle, which broke the frame and split the family in two.
  assert.doesNotMatch(readIcon('TextScanIcon.tsx'), /Sparkle/);
});

test('unit: Closet reads as a wardrobe with a hanger, not a bookmark', () => {
  const source = readIcon('SaveOrganizeIcon.tsx');
  assert.match(source, /Wardrobe body/);
  assert.match(source, /Hook, hanging over the rail/);
  assert.match(source, /Closet rail/);

  // The hook and the hanger apex must stay on the centre line and meet, or the
  // hanger stops reading as something suspended.
  const hook = source.match(/d="M12 (\d+) V(\d+)"/);
  assert.ok(hook, 'hanger hook must be a vertical segment on x=12');
  const body = source.match(/M12 (\d+) L\$\{shoulderLeft\} (\d+) H\$\{shoulderRight\} Z/);
  assert.ok(body, 'hanger body must span shoulder to shoulder from the apex');
  assert.equal(hook[2], body[1], 'the hook must terminate exactly at the hanger apex');

  // A hanger is wider than it is tall. The first attempt used a 6-unit drop,
  // which closed into a solid wedge at render size and read as a tent.
  const drop = Number(body[2]) - Number(body[1]);
  assert.ok(drop <= 4, `hanger drop ${drop} is too deep to stay open at 24pt`);

  // Asserted against the code only: the doc comment names the bookmark it
  // replaced, and that explanation is worth keeping.
  assert.doesNotMatch(stripComments(source), /bookmark/i);
});

test('unit: Dressing Rooms is an arch with a garment, and cedes the hanger to Closet', () => {
  const source = readIcon('DressingRoomsIcon.tsx');
  // Full-height arch: a true semicircle over vertical walls.
  assert.match(source, /M5 21 V10 A7 7 0 0 1 19 10 V21 Z/);
  // Both tiles may show something to hang from; what must never converge is
  // the silhouette. Closet peaks (a bare hanger), this one flares (a dress on
  // one), and that is what keeps them tellable apart without labels.
  assert.match(source, /A-line flare/);
  const closet = readIcon('SaveOrganizeIcon.tsx');
  assert.match(closet, /M12 11 L\$\{shoulderLeft\} 15 H\$\{shoulderRight\} Z/);
  assert.match(source, /M10 10 L\$\{hemLeft\} 19 H\$\{hemRight\} L14 10/);
});

test('unit: Closet and Dressing Rooms do not share a silhouette', () => {
  const closet = readIcon('SaveOrganizeIcon.tsx');
  const rooms = readIcon('DressingRoomsIcon.tsx');
  // Closet is the only one with a rectangular body; Dressing Rooms is the only
  // one with an arch. If either gains the other's frame they become confusable.
  assert.match(closet, /<Rect/);
  assert.doesNotMatch(closet, /A7 7 0 0 1/);
  assert.doesNotMatch(rooms, /<Rect/);
  assert.match(rooms, /A7 7 0 0 1/);
});

test('unit: no raster assets imported under components/icons/kscan', () => {
  for (const file of fs.readdirSync(ICON_DIR)) {
    if (!file.endsWith('.tsx') && !file.endsWith('.ts')) continue;
    const source = readIcon(file);
    assert.doesNotMatch(source, /require\(['"`].*\.(png|jpe?g|webp)/i);
    assert.doesNotMatch(source, /from ['"`].*\.(png|jpe?g|webp)/i);
    assert.doesNotMatch(source, /base64,/i);
  }
});
