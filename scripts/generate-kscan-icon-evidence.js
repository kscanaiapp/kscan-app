/**
 * Generates standalone SVG evidence sheets for visual QA.
 * Output lives under docs/icon-qa/evidence and is never imported by the app.
 */
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, '..', 'docs', 'icon-qa', 'evidence');
const PLUM = '#3F0B2F';
const GOLD = '#B08D4B';
const CREAM = '#F7F1E8';
const WHITE = '#FDFBF8';

const SIZES = [20, 24, 28, 32, 48];

/** Simplified path evidence matching product meanings (not app imports). */
const ICONS = {
  'dressing-rooms': {
    plum: `
      <path d="M2.5 21 H21.5" fill="none" stroke="${PLUM}" stroke-width="2" stroke-linecap="round"/>
      <path d="M3 21 V6.5 Q3 4.5 5 4.5 H9.2 Q10.5 4.5 10.5 6 V21" fill="none" stroke="${PLUM}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M21 21 V6.5 Q21 4.5 19 4.5 H14.8 Q13.5 4.5 13.5 6 V21" fill="none" stroke="${PLUM}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M5 7.8 L6.8 7 L8.6 7.8 V9.5 H5 Z M5 9.5 L4.3 15 H9.3 L8.6 9.5" fill="none" stroke="${PLUM}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M14.4 7.6 H19.4 V11.2 H14.4 Z M15.2 11.2 V15.2 H18.6 V11.2" fill="none" stroke="${PLUM}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    `,
    gold: `
      <ellipse cx="12" cy="12.5" rx="1.9" ry="6.8" fill="none" stroke="${GOLD}" stroke-width="2"/>
      <path d="M10.5 3.2 L12 1.5 L13.5 3.2 L12 4.9 Z" fill="none" stroke="${GOLD}" stroke-width="1.6" stroke-linejoin="round"/>
      <path d="M4.8 18.2 H7.6 Q8.4 18.2 8.4 17.5 L7.8 16.9 H5.8 L4.8 17.6" fill="none" stroke="${GOLD}" stroke-width="1.6" stroke-linecap="round"/>
      <path d="M15.2 17.2 H18.6 L19 18.8 H14.8 Z" fill="none" stroke="${GOLD}" stroke-width="1.6" stroke-linecap="round"/>
    `,
  },
  textscan: {
    plum: `
      <path d="M3 6.5 V4.2 Q3 3 4.2 3 H6.5" fill="none" stroke="${PLUM}" stroke-width="2" stroke-linecap="round"/>
      <path d="M17.5 3 H14.8" fill="none" stroke="${PLUM}" stroke-width="2" stroke-linecap="round"/>
      <path d="M21 7.5 V6.5" fill="none" stroke="${PLUM}" stroke-width="2" stroke-linecap="round"/>
      <path d="M3 17.5 V19.8 Q3 21 4.2 21 H6.5" fill="none" stroke="${PLUM}" stroke-width="2" stroke-linecap="round"/>
      <path d="M17.5 21 H19.8 Q21 21 21 19.8 V17.5" fill="none" stroke="${PLUM}" stroke-width="2" stroke-linecap="round"/>
      <line x1="6.5" y1="9" x2="16" y2="9" stroke="${PLUM}" stroke-width="2" stroke-linecap="round"/>
      <line x1="6.5" y1="12.5" x2="18" y2="12.5" stroke="${PLUM}" stroke-width="2" stroke-linecap="round"/>
      <line x1="6.5" y1="16" x2="13.5" y2="16" stroke="${PLUM}" stroke-width="2" stroke-linecap="round"/>
    `,
    gold: `<path d="M19.5 4.5 C19.5 3.3 20.7 3.3 20.7 4.5 C21.9 4.5 21.9 5.7 20.7 5.7 C20.7 6.9 19.5 6.9 19.5 5.7 C18.3 5.7 18.3 4.5 19.5 4.5 Z" fill="none" stroke="${GOLD}" stroke-width="1.6"/>`,
  },
  'recent-scans': {
    plum: `
      <path d="M8 3.5 H17.5 Q19 3.5 19 5 V14.5" fill="none" stroke="${PLUM}" stroke-width="2" stroke-linecap="round"/>
      <path d="M6.5 4.5 H16.8 Q18.2 4.5 18.2 5.9 V15.2" fill="none" stroke="${PLUM}" stroke-width="2" stroke-linecap="round"/>
      <path d="M4 6.5 H14.5 Q16.2 6.5 16.2 8.2 V18.5 Q16.2 20.2 14.5 20.2 H4 Q2.3 20.2 2.3 18.5 V8.2 Q2.3 6.5 4 6.5 Z" fill="none" stroke="${PLUM}" stroke-width="2" stroke-linejoin="round"/>
      <path d="M7.2 10.4 L9.2 9.5 L11.2 10.4 V12.2 H7.2 Z M7.2 12.2 L6.3 17.2 H12.1 L11.2 12.2" fill="none" stroke="${PLUM}" stroke-width="2" stroke-linejoin="round"/>
    `,
    gold: `
      <circle cx="18" cy="18" r="4" fill="none" stroke="${GOLD}" stroke-width="2"/>
      <line x1="18" y1="18" x2="18" y2="15.6" stroke="${GOLD}" stroke-width="1.6" stroke-linecap="round"/>
      <line x1="18" y1="18" x2="19.8" y2="19.2" stroke="${GOLD}" stroke-width="1.6" stroke-linecap="round"/>
    `,
  },
  'visual-search': {
    plum: `
      <path d="M2.5 6 V3.7 Q2.5 2.5 3.7 2.5 H6" fill="none" stroke="${PLUM}" stroke-width="2" stroke-linecap="round"/>
      <path d="M18 2.5 H20.3 Q21.5 2.5 21.5 3.7 V6" fill="none" stroke="${PLUM}" stroke-width="2" stroke-linecap="round"/>
      <path d="M2.5 18 V20.3 Q2.5 21.5 3.7 21.5 H6" fill="none" stroke="${PLUM}" stroke-width="2" stroke-linecap="round"/>
      <path d="M9 5.5 L12 8 L15 5.5 M9 5.5 V9.4 H15 V5.5 M9 9.4 H15 V11.2 H9 Z M9 11.2 L7.5 18.5 H16.5 L15 11.2" fill="none" stroke="${PLUM}" stroke-width="2" stroke-linejoin="round"/>
      <path d="M18.8 18.8 L21.2 21.2" fill="none" stroke="${PLUM}" stroke-width="2" stroke-linecap="round"/>
    `,
    gold: `
      <circle cx="15.8" cy="15.5" r="4.6" fill="none" stroke="${GOLD}" stroke-width="2"/>
      <path d="M17.5 8 C17.5 6.8 18.7 6.8 18.7 8 C19.9 8 19.9 9.2 18.7 9.2 C18.7 10.4 17.5 10.4 17.5 9.2 C16.3 9.2 16.3 8 17.5 8 Z" fill="none" stroke="${GOLD}" stroke-width="1.6"/>
    `,
  },
  'save-organize': {
    plum: `
      <path d="M3.5 4.5 H20.5 Q21.5 4.5 21.5 5.5 V20 H3.5 V5.5 Q3.5 4.5 4.5 4.5" fill="none" stroke="${PLUM}" stroke-width="2" stroke-linejoin="round"/>
      <line x1="3.5" y1="21.2" x2="21.5" y2="21.2" stroke="${PLUM}" stroke-width="2" stroke-linecap="round"/>
      <line x1="14" y1="4.5" x2="14" y2="20" stroke="${PLUM}" stroke-width="2"/>
      <path d="M6.4 8.4 L8.8 7.5 L11.2 8.4 V10.2 H6.4 Z M6.4 10.2 L5.5 17 H12.1 L11.2 10.2" fill="none" stroke="${PLUM}" stroke-width="2" stroke-linejoin="round"/>
    `,
    gold: `
      <circle cx="12" cy="17" r="3.2" fill="none" stroke="${GOLD}" stroke-width="2"/>
      <path d="M10.4 17 L11.7 18.3 L13.9 15.8" fill="none" stroke="${GOLD}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M16.2 6.2 H19.6 L20.2 7.8 H15.6 Z" fill="none" stroke="${GOLD}" stroke-width="1.6"/>
    `,
  },
  style: {
    plum: `
      <path d="M12 3.2 C12 2.4 12.8 2.2 13.3 2.7" fill="none" stroke="${PLUM}" stroke-width="2" stroke-linecap="round"/>
      <path d="M7.2 6.4 L4.8 8.6 V15.2 H7.8 V12 H16.2 V15.2 H19.2 V8.6 L16.8 6.4 M9.6 6.8 L12 9.6 L14.4 6.8" fill="none" stroke="${PLUM}" stroke-width="2" stroke-linejoin="round"/>
      <path d="M7.8 15.2 H16.2 L15.4 20 H8.6 Z" fill="none" stroke="${PLUM}" stroke-width="2" stroke-linejoin="round"/>
    `,
    gold: `
      <circle cx="12" cy="11.6" r="0.7" fill="${GOLD}"/>
      <path d="M3.5 20.5 H7.4 Q8.5 20.5 8.5 19.5 L7.6 18.6 H5 L3.5 19.6" fill="none" stroke="${GOLD}" stroke-width="1.7" stroke-linecap="round"/>
      <path d="M16 18 H20.2 L20.8 20.6 H15.4 Z M17.1 16.8 Q18.1 15.6 19.1 16.8" fill="none" stroke="${GOLD}" stroke-width="1.7" stroke-linecap="round"/>
      <path d="M18.8 4.8 C18.8 3.6 20 3.6 20 4.8 C21.2 4.8 21.2 6 20 6 C20 7.2 18.8 7.2 18.8 6 C17.6 6 17.6 4.8 18.8 4.8 Z" fill="none" stroke="${GOLD}" stroke-width="1.6"/>
    `,
  },
};

function glyph(name, size, bg) {
  const icon = ICONS[name];
  return `
  <g>
    <rect width="${size + 16}" height="${size + 28}" rx="8" fill="${bg}" stroke="#E8E0D5"/>
    <svg x="8" y="8" width="${size}" height="${size}" viewBox="0 0 24 24">
      ${icon.plum}
      ${icon.gold}
    </svg>
    <text x="${(size + 16) / 2}" y="${size + 22}" text-anchor="middle" font-family="ui-sans-serif,system-ui" font-size="10" fill="#6B6258">${size}px</text>
  </g>`;
}

function sheet(name) {
  const cellW = 72;
  const rows = [
    { label: 'cream', bg: CREAM },
    { label: 'white', bg: WHITE },
    { label: 'plum-inverted', bg: PLUM, invert: true },
  ];
  let y = 48;
  let body = `
    <text x="24" y="28" font-family="ui-sans-serif,system-ui" font-size="18" font-weight="600" fill="${PLUM}">${name}</text>
    <text x="24" y="44" font-family="ui-sans-serif,system-ui" font-size="11" fill="#6B6258">vector evidence · not shipped in app bundle</text>
  `;

  for (const row of rows) {
    body += `<text x="24" y="${y}" font-family="ui-sans-serif,system-ui" font-size="12" fill="#3F0B2F">${row.label}</text>`;
    y += 8;
    let x = 24;
    for (const size of SIZES) {
      const plum = row.invert ? WHITE : PLUM;
      const gold = row.invert ? '#D4B87A' : GOLD;
      const icon = ICONS[name];
      body += `
      <g transform="translate(${x} ${y})">
        <rect width="${size + 16}" height="${size + 28}" rx="8" fill="${row.bg}" stroke="#E8E0D5"/>
        <svg x="8" y="8" width="${size}" height="${size}" viewBox="0 0 24 24">
          ${icon.plum.replaceAll(PLUM, plum)}
          ${icon.gold.replaceAll(GOLD, gold)}
        </svg>
        <text x="${(size + 16) / 2}" y="${size + 22}" text-anchor="middle" font-family="ui-sans-serif,system-ui" font-size="10" fill="${row.invert ? '#E7D4A8' : '#6B6258'}">${size}</text>
      </g>`;
      x += cellW;
    }
    y += 84;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="420" height="${y + 24}" viewBox="0 0 420 ${y + 24}">
  <rect width="100%" height="100%" fill="#F7F1E8"/>
  ${body}
</svg>
`;
}

fs.mkdirSync(OUT, { recursive: true });

const indexLines = [
  '# K Scan Product Icon Visual Evidence',
  '',
  'Generated by `node scripts/generate-kscan-icon-evidence.js`.',
  'These SVG sheets are QA artifacts only and are not imported by the app.',
  '',
  'Design references (docs only, not app assets): `docs/icon-qa/references/`.',
  '',
  '## Sheets',
  '',
];

for (const name of Object.keys(ICONS)) {
  const file = `${name}-size-matrix.svg`;
  fs.writeFileSync(path.join(OUT, file), sheet(name), 'utf8');
  indexLines.push(`- [${file}](./${file})`);
}

const homeMock = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="390" height="720" viewBox="0 0 390 720">
  <rect width="390" height="720" fill="#F7F1E8"/>
  <text x="24" y="40" font-family="ui-sans-serif,system-ui" font-size="16" fill="${PLUM}">Home feature cards — icon mapping evidence</text>
  ${['style', 'visual-search', 'save-organize', 'dressing-rooms'].map((name, i) => {
    const x = 24 + (i % 2) * 176;
    const y = 64 + Math.floor(i / 2) * 150;
    const labels = {
      style: 'AI STYLIST',
      'visual-search': 'VISUAL SEARCH',
      'save-organize': 'SAVE & ORGANIZE',
      'dressing-rooms': 'DRESSING ROOMS',
    };
    return `
    <g transform="translate(${x} ${y})">
      <rect width="160" height="132" rx="16" fill="#FDFBF8" stroke="#E8E0D5"/>
      <svg x="66" y="16" width="28" height="28" viewBox="0 0 24 24">${ICONS[name].plum}${ICONS[name].gold}</svg>
      <text x="80" y="64" text-anchor="middle" font-family="ui-sans-serif,system-ui" font-size="10" letter-spacing="1" fill="${PLUM}">${labels[name]}</text>
    </g>`;
  }).join('')}
  <g transform="translate(24 380)">
    <rect width="160" height="48" rx="24" fill="none" stroke="${GOLD}" stroke-width="1.5"/>
    <svg x="18" y="14" width="20" height="20" viewBox="0 0 24 24">${ICONS.textscan.plum}${ICONS.textscan.gold}</svg>
    <text x="90" y="30" text-anchor="middle" font-family="ui-sans-serif,system-ui" font-size="12" fill="${PLUM}">TextScan</text>
  </g>
  <g transform="translate(24 460)">
    <svg x="0" y="0" width="22" height="22" viewBox="0 0 24 24">${ICONS['recent-scans'].plum}${ICONS['recent-scans'].gold}</svg>
    <text x="32" y="16" font-family="ui-sans-serif,system-ui" font-size="12" letter-spacing="1.4" fill="#8A8178">RECENT SCANS</text>
  </g>
  <text x="24" y="540" font-family="ui-sans-serif,system-ui" font-size="11" fill="#6B6258">Platform note: Android/iOS share the same react-native-svg components.</text>
  <text x="24" y="560" font-family="ui-sans-serif,system-ui" font-size="11" fill="#6B6258">Device screenshots: open /dev/icon-review in a __DEV__ build.</text>
</svg>
`;

fs.writeFileSync(path.join(OUT, 'home-feature-mapping.svg'), homeMock, 'utf8');
indexLines.push('- [home-feature-mapping.svg](./home-feature-mapping.svg)');
fs.writeFileSync(path.join(OUT, 'README.md'), `${indexLines.join('\n')}\n`, 'utf8');

console.log(`Wrote icon evidence to ${OUT}`);
