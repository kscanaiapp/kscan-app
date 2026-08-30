// Auth recovery-card contrast contract (WCAG 2.1 AA).
//
// WHY THIS EXISTS: app/auth/reset.tsx, app/auth/update-password.tsx and
// app/auth/callback.tsx render their content inside a card whose background is
// COLORS.surface — 'rgba(18, 16, 26, 0.88)', a DARK glass panel — while the
// card's title, body and field labels inherited the LIGHT-surface ink tokens
// from TYPOGRAPHY (textPrimary / textSecondary / textTertiary). Composited over
// the screen root (COLORS.bg, opaque) the card resolves to ~#2d2b33, so
// "Recover Access" scored 1.34:1 and the instruction copy 1.60:1 — effectively
// invisible on the account-recovery screens. The sibling errorText style was
// already authored for the dark card (COLORS.errorSoft), which is what made the
// omission detectable rather than a deliberate light-card design.
//
// The ratios below are computed from the real token values parsed out of
// constants/theme.ts, so the test fails if a token value drifts, if an explicit
// dark-surface colour is removed, or if a new light-ink token is introduced.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const themeSource = fs.readFileSync(path.join(ROOT, 'constants', 'theme.ts'), 'utf8');

// ── Exact WCAG 2.1 relative luminance ───────────────────────────────────────
function hexToRgb(hex) {
  const h = hex.replace('#', '').trim();
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}
function channel(c) {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}
function luminance(rgb) {
  const [r, g, b] = rgb.map(channel);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrastRatio(fg, bg) {
  const a = luminance(hexToRgb(fg));
  const b = luminance(hexToRgb(bg));
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}
function compositeOver(rgba, bgHex) {
  const bg = hexToRgb(bgHex);
  const out = [rgba.r, rgba.g, rgba.b].map((c, i) =>
    Math.round(c * rgba.a + bg[i] * (1 - rgba.a)),
  );
  return '#' + out.map((c) => c.toString(16).padStart(2, '0')).join('');
}

// ── Token extraction from the real theme source ─────────────────────────────
function hexToken(name) {
  const m = themeSource.match(new RegExp(`\\b${name}:\\s*'(#[0-9A-Fa-f]{3,8})'`));
  assert.ok(m, `COLORS.${name} must be a hex token in constants/theme.ts`);
  return m[1];
}
function rgbaToken(name) {
  const m = themeSource.match(
    new RegExp(`\\b${name}:\\s*'rgba\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*([0-9.]+)\\s*\\)'`),
  );
  assert.ok(m, `COLORS.${name} must be an rgba token in constants/theme.ts`);
  return { r: +m[1], g: +m[2], b: +m[3], a: +m[4] };
}

const SCREEN_ROOT_BG = hexToken('bg');            // opaque -> composite is deterministic
const CARD_RGBA = rgbaToken('surface');
const CARD_BG = compositeOver(CARD_RGBA, SCREEN_ROOT_BG);

const AA_NORMAL = 4.5;
const AA_LARGE = 3.0; // >=18.66px bold or >=24px; cardTitle is 20px weight 600

// Style keys on the dark card that must declare an explicit readable colour,
// with the WCAG threshold that applies to the size they render at.
const CARD_TEXT_STYLES = [
  { style: 'cardTitle', threshold: AA_LARGE },
  { style: 'cardBody', threshold: AA_NORMAL },
  { style: 'errorText', threshold: AA_NORMAL },
  { style: 'messageText', threshold: AA_NORMAL },
  { style: 'fieldLabel', threshold: AA_NORMAL },
];

const SCREENS = [
  'app/auth/reset.tsx',
  'app/auth/update-password.tsx',
  'app/auth/callback.tsx',
];

/** Pull the `color: COLORS.x` declared on a StyleSheet key, if the key exists. */
function declaredColorToken(source, styleKey) {
  const m = source.match(new RegExp(`\\b${styleKey}:\\s*\\{([\\s\\S]*?)\\n?\\s*\\},`));
  const inline = source.match(new RegExp(`\\b${styleKey}:\\s*\\{([^}]*)\\}`));
  const block = (m && m[1]) || (inline && inline[1]);
  if (block === undefined || block === null) return { present: false };
  const colorMatch = block.match(/color:\s*COLORS\.([A-Za-z0-9_]+)/);
  return { present: true, token: colorMatch ? colorMatch[1] : null };
}

test('the auth recovery card is a dark glass surface (composite is deterministic)', () => {
  assert.ok(CARD_RGBA.a > 0.5, 'COLORS.surface is expected to be a mostly-opaque dark glass');
  const cardLum = luminance(hexToRgb(CARD_BG));
  assert.ok(
    cardLum < 0.2,
    `the composited auth card ${CARD_BG} must be dark; got luminance ${cardLum.toFixed(4)}`,
  );
});

for (const screen of SCREENS) {
  const source = fs.readFileSync(path.join(ROOT, screen), 'utf8');

  test(`${screen}: card renders on COLORS.surface`, () => {
    assert.match(
      source,
      /card:\s*\{[\s\S]*?backgroundColor:\s*COLORS\.surface/,
      'this contract only applies while the card uses the dark glass surface',
    );
  });

  for (const { style, threshold } of CARD_TEXT_STYLES) {
    test(`${screen}: ${style} is legible on the dark card`, (t) => {
      const declared = declaredColorToken(source, style);
      if (!declared.present) {
        t.skip(`${style} is not used on this screen`);
        return;
      }
      assert.ok(
        declared.token,
        `${style} must declare an explicit color for the dark card — ` +
          'inheriting the light-surface TYPOGRAPHY ink makes it unreadable',
      );
      const hex = hexToken(declared.token);
      const ratio = contrastRatio(hex, CARD_BG);
      assert.ok(
        ratio >= threshold,
        `${style} uses COLORS.${declared.token} (${hex}) on ${CARD_BG} = ` +
          `${ratio.toFixed(2)}:1, below the required ${threshold.toFixed(1)}:1`,
      );
    });
  }
}
