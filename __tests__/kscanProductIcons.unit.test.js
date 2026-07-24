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

test('unit: registry lists all six semantic names exactly once', () => {
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

test('unit: no raster assets imported under components/icons/kscan', () => {
  for (const file of fs.readdirSync(ICON_DIR)) {
    if (!file.endsWith('.tsx') && !file.endsWith('.ts')) continue;
    const source = readIcon(file);
    assert.doesNotMatch(source, /require\(['"`].*\.(png|jpe?g|webp)/i);
    assert.doesNotMatch(source, /from ['"`].*\.(png|jpe?g|webp)/i);
    assert.doesNotMatch(source, /base64,/i);
  }
});
