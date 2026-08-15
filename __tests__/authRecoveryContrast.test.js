/**
 * Password-recovery contrast (Wave 5, batch 3).
 *
 * THE DEFECT, MEASURED. The recovery card used `COLORS.surface`, which is a
 * DARK GLASS token — `rgba(18, 16, 26, 0.88)`, compositing to about `#2d2b33`
 * over the page — while every piece of text on it used the light-theme tokens.
 * Near-black on near-black:
 *
 *   cardTitle   textPrimary   #15120F  ->  1.34:1
 *   cardBody    textSecondary #514A43  ->  1.60:1
 *   fieldLabel  textTertiary  #81776D  ->  3.18:1
 *
 * against a 4.5:1 requirement for normal text. The title was effectively
 * invisible, on the screen where a locked-out user reads what to do next.
 *
 * The giveaway that this was a mistake rather than a design choice: the input
 * INSIDE that same card already used a light background, and these three
 * recovery screens were the only places in the app using the dark-glass token
 * as a card surface.
 *
 * WHY THIS TEST COMPUTES RATIOS. A source-string assertion ("uses surfaceCard")
 * would pass for any token someone swaps in later, including another dark one.
 * The requirement is a contrast ratio, so the ratio is what is asserted — the
 * tokens are read from the real theme and composited the way the renderer
 * would, alpha included.
 *
 * No new colour is introduced and authentication is not redesigned: the repair
 * moves to `surfaceCard` and `textSecondary`, both already in the theme.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const THEME = fs.readFileSync(path.join(ROOT, 'constants', 'theme.ts'), 'utf8');

/** WCAG 2.1 AA. Large text is >= 18.66px bold or >= 24px. */
const AA_NORMAL = 4.5;

function token(name) {
  const match = new RegExp(`\\b${name}:\\s*'([^']+)'`).exec(THEME);
  assert.ok(match, `theme token ${name} not found`);
  return match[1];
}

function parseColor(value) {
  const rgba = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/.exec(value);
  if (rgba) {
    return {
      r: Number(rgba[1]),
      g: Number(rgba[2]),
      b: Number(rgba[3]),
      a: rgba[4] === undefined ? 1 : Number(rgba[4]),
    };
  }
  const hex = value.replace('#', '');
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
    a: 1,
  };
}

/** Composite a possibly-translucent colour over an opaque one, as the GPU would. */
function composite(front, back) {
  const f = parseColor(front);
  const b = parseColor(back);
  return {
    r: Math.round(f.r * f.a + b.r * (1 - f.a)),
    g: Math.round(f.g * f.a + b.g * (1 - f.a)),
    b: Math.round(f.b * f.a + b.b * (1 - f.a)),
    a: 1,
  };
}

function relativeLuminance(color) {
  const channel = (value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

function contrast(foreground, background) {
  const a = relativeLuminance(typeof foreground === 'string' ? parseColor(foreground) : foreground);
  const b = relativeLuminance(typeof background === 'string' ? parseColor(background) : background);
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

/** The card background each recovery screen actually declares. */
function cardBackgroundToken(relativePath) {
  const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
  const match = /card:\s*\{[\s\S]*?backgroundColor:\s*COLORS\.(\w+)/.exec(source);
  assert.ok(match, `${relativePath} declares no card backgroundColor`);
  return match[1];
}

const RECOVERY_SCREENS = [
  'app/auth/reset.tsx',
  'app/auth/update-password.tsx',
  'app/auth/callback.tsx',
];

/* ------------------------------------------------------------------ */

test('the measured defect is real: the old token fails badly', () => {
  // Kept as the negative control. If someone reverts the card to `surface`,
  // the assertions below fail — and this is the number they fail by.
  const page = token('bg');
  const darkGlass = composite(token('surface'), page);
  const ratio = contrast(token('textPrimary'), darkGlass);
  assert.ok(ratio < 2, `the dark-glass card really did measure ${ratio.toFixed(2)}:1`);
});

for (const screen of RECOVERY_SCREENS) {
  test(`${screen}: card text meets AA contrast`, () => {
    const page = token('bg');
    const card = composite(token(cardBackgroundToken(screen)), page);

    // TYPOGRAPHY.title -> textPrimary, TYPOGRAPHY.body -> textSecondary.
    for (const name of ['textPrimary', 'textSecondary']) {
      const ratio = contrast(token(name), card);
      assert.ok(
        ratio >= AA_NORMAL,
        `${screen}: ${name} on the card is ${ratio.toFixed(2)}:1, below ${AA_NORMAL}:1`,
      );
    }
  });
}

test('the recovery field label meets AA on the card', () => {
  for (const screen of ['app/auth/reset.tsx', 'app/auth/update-password.tsx']) {
    const source = fs.readFileSync(path.join(ROOT, screen), 'utf8');
    const match = /fieldLabel:\s*\{[^}]*color:\s*COLORS\.(\w+)/.exec(source);
    assert.ok(match, `${screen} declares no fieldLabel colour`);

    const card = composite(token(cardBackgroundToken(screen)), token('bg'));
    const ratio = contrast(token(match[1]), card);
    assert.ok(
      ratio >= AA_NORMAL,
      `${screen}: fieldLabel (${match[1]}) is ${ratio.toFixed(2)}:1, below ${AA_NORMAL}:1`,
    );
  }
});

test('no new colour was introduced to fix this', () => {
  // The repair had to come from the existing palette. A hex literal in a
  // recovery screen's styles would mean a parallel colour system started here.
  for (const screen of RECOVERY_SCREENS) {
    const source = fs.readFileSync(path.join(ROOT, screen), 'utf8');
    const styles = source.slice(source.indexOf('StyleSheet.create'));
    assert.doesNotMatch(
      styles,
      /(?:background)?[Cc]olor:\s*'#[0-9a-fA-F]{3,8}'/,
      `${screen} must use theme tokens, not a literal colour`,
    );
  }
});
