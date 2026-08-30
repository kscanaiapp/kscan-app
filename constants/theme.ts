import { Platform } from 'react-native';

export const COLORS = {
  // ── Backgrounds ──────────────────────────────────────────────────────────────
  bg:            '#F7F3EC',
  bgElevated:    '#FAF7F1',
  surface:       'rgba(18, 16, 26, 0.88)',      // dark glass surface
  surfaceStrong: 'rgba(33, 29, 44, 0.94)',      // elevated dark glass
  surfaceSoft:   'rgba(247, 243, 236, 0.08)',   // subtle pearl tint
  canvas:        '#FAF8F5',                     // luminous alabaster; bright luxury pearl, minimal warm undertone
  canvasLavender:'#E8E1EC',
  canvasWarm:    '#FFFDF9',                     // pristine bleached silk; clean reflective content backing
  surfaceCard:   '#FFFFFF',
  surfaceRaised: '#FCFAF6',                     // elevated pearl island surface
  surfaceMuted:  '#F0ECE6',                     // technical smoke; crisp inset fields
  lavenderSurface: '#E8E1EC',
  obsidian:      '#09070D',
  obsidianSoft:  '#12101A',
  graphite:      '#1A1722',
  graphiteRaised:'#211D2C',
  graphiteLine:  '#342D42',

  // ── Absolute ─────────────────────────────────────────────────────────────────
  white: '#FFFFFF',
  black: '#000000',

  // ── Text ─────────────────────────────────────────────────────────────────────
  textPrimary:   '#15120F',
  textSecondary: '#514A43',
  textTertiary:  '#81776D',
  textMuted:     '#81776D',
  textInverse:   '#FFFDF9',                     // light text aligned to pristine pearl
  editorialTextPrimary:   '#15120F',
  editorialTextSecondary: '#514A43',
  editorialTextMuted:     '#81776D',
  chrome:                 '#D8D0C7',
  chromeMuted:            '#8A8178',
  chromeMist:             '#D8D0C7',
  chromeLine:             '#B8AFA5',
  chromeDark:             '#5E5650',

  // ── Accent — Purple identity + premium gold ──────────────────────────────────
  purpleDeep:    '#26041D',                     // deep aubergine shadow base
  purpleCore:    '#5A1A3E',
  purplePrimary: '#52103E',                     // active/pressed plum
  purpleSoft:    '#6E1F55',                     // restrained rim/highlight plum
  purpleGlow:    '#8A4D73',
  purpleMist:    '#EEE4EC',
  accent:        '#3F0B2F',                     // liquid aubergine; dark blackberry-ink plum
  accentSoft:    '#EEE4EC',
  accentGlow:    '#7A3A68',
  champagneGold: '#C6A15B',
  softGold:      '#E7D4A8',
  gold:          '#C6A15B',
  goldPressed:   '#7A5624',
  goldMuted:     '#E7D4A8',
  goldText:      '#7A5624',

  // ── AR signals ───────────────────────────────────────────────────────────────
  arPurple: '#6A214F',
  arBlue:   '#0D9FB3',
  electricCyan:   '#22D3EE',
  electricBlue:   '#0D9FB3',
  electricViolet: '#7A3A68',
  scanCyan:       '#0D9FB3',
  scanAccent:     '#0D9FB3',
  activeVision:   '#67E8F9',

  // ── Chrome borders ────────────────────────────────────────────────────────────
  border:       '#D8D0C7',
  borderStrong: '#8A8178',
  chipBorder:   '#342D42',                      // chrome chip border
  borderHairline: '#D8D0C7',
  borderSubtle:   '#B8AFA5',
  darkOverlay: 'rgba(9, 7, 13, 0.72)',
  darkOverlayBorder: 'rgba(216, 208, 199, 0.28)',
  hudLine: 'rgba(247, 243, 236, 0.72)',

  // ── Cards ────────────────────────────────────────────────────────────────────
  cardBg:     'rgba(18, 16, 26, 0.88)',
  cardBorder: '#D8D0C7',
  lightCardBg: '#FFFFFF',
  lightCardBorder: 'rgba(21, 18, 15, 0.08)',

  // ── Utility ──────────────────────────────────────────────────────────────────
  backdrop: 'rgba(9, 7, 13, 0.78)',
  overlay:  'rgba(9, 7, 13, 0.30)',

  // ── Status ───────────────────────────────────────────────────────────────────
  error:     '#823038',
  errorSoft: '#F1E6E7',
  success:   '#6F8F73',
  // Light sage tint of `success`, for DARK surfaces only — the mirror of
  // errorSoft. `success` itself is 3.89:1 on the dark auth card and 3.59:1 on
  // white, so it never carries status text on its own; this tint scores 9.14:1
  // on the composited auth card. Do not use it on a light surface.
  successSoft: '#C3D6C6',
  warning:   '#C6A15B',

  // ── StyleChat V6.3 — bright pearl surfaces / gloss plum actions (screen-scoped) ─
  // Added (not mutating shared tokens): StyleChat surfaces were dark-on-dark.
  chatScreenBg:        '#FFFDF9',                 // luminous warm pearl screen/window + bottom chin
  chatPanelBg:         '#FFFDF9',                 // message list + session panel backing
  chatSessionCardBg:   '#FFFFFF',                 // session card (paired with champagne edge)
  chatComposerInputBg: '#FFFFFF',                 // input field (paired with champagne edge)
  chatAssistantBubble: '#FFFFFF',                 // assistant bubble (paired with champagne edge)
  chatHairline:        '#B8A878',                 // warm champagne edge for white-on-pearl definition
  chatErrorText:       '#6B1F55',                 // readable plum for error/system text on pearl
  chatSendBg:          '#74245E',                 // brighter V6.3 plum CTA fill (ivory text)
  chatSendPressed:     '#6E1F55',                 // pressed plum (= purpleSoft tone)
  chatUserBubble:      '#7B2A66',                 // brighter plum user bubble (ivory text)
  chatGlossTop:        'rgba(255, 255, 255, 0.30)', // top sheen on plum CTAs / bubbles
  chatPressTint:       'rgba(116, 36, 94, 0.10)',   // faint plum press / inactive tint on pearl
  chatCursorAccent:    '#0D9FB3',                 // = scanCyan; cursor/focus micro-accent only
};

export const colors = COLORS;

export const SPACING = {
  xxs: 2,
  xs:  4,
  sm:  8,
  md:  12,
  lg:  16,
  xl:  24,
  xxl: 32,
  xxxl: 40,
};

export const RADIUS = {
  sm:   12,
  md:   16,
  lg:   24,
  xl:   28,
  pill: 999,
};

export const SHADOWS = {
  editorialSmall: {
    shadowColor: COLORS.black,
    shadowOpacity: 0.06,
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 14,
    elevation: 3,
  },
  editorialRaised: {
    shadowColor: COLORS.black,
    shadowOpacity: 0.08,
    shadowOffset: { width: 0, height: 8 },
    shadowRadius: 24,
    elevation: 6,
  },
  darkFloat: {
    shadowColor: COLORS.black,
    shadowOpacity: 0.32,
    shadowOffset: { width: 0, height: 10 },
    shadowRadius: 24,
    elevation: 8,
  },
};

export const TYPOGRAPHY = {
  brand: {
    fontSize: 22,
    fontWeight: '700' as const,
    letterSpacing: 4,
    color: COLORS.textPrimary,
    textTransform: 'uppercase' as const,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: '600' as const,
    letterSpacing: 2.6,
    color: COLORS.textTertiary,
    textTransform: 'uppercase' as const,
  },
  categoryLabel: {
    fontSize: 11,
    fontWeight: '600' as const,
    letterSpacing: 2.6,
    color: COLORS.accent,
  },
  headline: {
    fontSize: 24,
    fontWeight: '600' as const,
    color: COLORS.textPrimary,
  },
  title: {
    fontSize: 16,
    fontWeight: '600' as const,
    letterSpacing: 1.2,
    color: COLORS.textPrimary,
  },
  subtitle: {
    fontSize: 13,
    fontWeight: '500' as const,
    letterSpacing: 2.4,
    color: COLORS.textSecondary,
    textTransform: 'uppercase' as const,
  },
  body: {
    fontSize: 15,
    fontWeight: '400' as const,
    color: COLORS.textSecondary,
    lineHeight: 24,
  },
  bodyStrong: {
    fontSize: 14,
    fontWeight: '500' as const,
    color: COLORS.textPrimary,
    lineHeight: 22,
  },
  caption: {
    fontSize: 12,
    fontWeight: '500' as const,
    letterSpacing: 1.8,
    color: COLORS.textTertiary,
    textTransform: 'uppercase' as const,
  },
  chipLabel: {
    fontSize: 10,
    fontWeight: '600' as const,
    color: COLORS.textTertiary,
    letterSpacing: 2.4,
    textTransform: 'uppercase' as const,
  },
  chipValue: {
    fontSize: 13,
    fontWeight: '500' as const,
    color: COLORS.accent,
    lineHeight: 18,
  },
  cta: {
    fontSize: 14,
    fontWeight: '600' as const,
    letterSpacing: 2.4,
    textTransform: 'uppercase' as const,
  },
};

export const chip = {
  minHeight:        54,
  minWidth:         104,
  paddingHorizontal: SPACING.lg,
  paddingVertical:   SPACING.sm,
  borderRadius:      RADIUS.pill,
  borderWidth:       1,
  borderColor:       COLORS.chipBorder,
  backgroundColor:   COLORS.surface,
  labelMarginBottom: SPACING.xs,
};

export const card = {
  borderRadius:   RADIUS.xl,
  paddingHorizontal: SPACING.xl,
  paddingVertical:   SPACING.xl,
  blurIntensity:  72,
  borderWidth:    1,
  gripWidth:      48,
  gripHeight:     4,
  ctaMinHeight:   52,
  shadowColor:    COLORS.black,
  shadowOpacity:  0.32,
  shadowRadius:   28,
  shadowOffset:   { width: 0, height: 12 },
};

export const MOTION = {
  enterDuration: 520,
  exitDuration:  280,
  microDuration: 220,
  chipStagger:   90,
  pulseDuration: 1200,
  easing: { x1: 0.2, y1: 0.9, x2: 0.2, y2: 1.0 },
};

export const viewfinder = {
  width:              '72%' as const,
  aspectRatio:        3 / 4,
  cornerArmLength:    28,
  cornerStroke:       1.5,
  cornerInset:        SPACING.xxl,
  scanningLineHeight: 1.5,
  scanningLineOffset: 90,
  scanTravelDistance: 280,
  scanningLineColor:  COLORS.scanCyan,
  frameGlow:          COLORS.activeVision,
};

export const BUTTONS = {
  minWidth:          196,
  height:            54,
  horizontalPadding: SPACING.xl,
  primaryBackground: COLORS.accent,
  primaryText:       COLORS.textInverse,
  secondaryBorder:   COLORS.border,
  secondaryText:     COLORS.textSecondary,
  tertiaryText:      COLORS.textTertiary,
};

export const LAYOUT = {
  screenPadding:             SPACING.xl,
  // Platform-aware: covers Pixel 8 Pro punch-hole (≈50dp) on Android;
  // standard notch inset on iOS.
  safeTop:                   Platform.select({ android: 56, ios: 44 }) ?? 44,
  previewHeight:             400,
  previewRadius:             RADIUS.xl,
  actionsMinHeight:          160,
  cameraFooterPaddingBottom: SPACING.xxl,
  cameraFooterPaddingTop:    SPACING.lg,
  modalBottomPadding:        SPACING.xxxl,
};

export const TOAST = {
  top:              108,
  borderRadius:     RADIUS.md,
  paddingHorizontal: 20,
  paddingVertical:   SPACING.lg,
  backgroundColor:  'rgba(9, 12, 18, 0.94)',
};

export const LOADING = {
  indicatorSize:   'large' as const,
  panelRadius:     RADIUS.lg,
  panelPadding:    SPACING.xl,
  panelBackground: COLORS.surface,
};

export const CAPTURE_BUTTON = {
  touchSize:   84,
  outerSize:   80,
  innerSize:   62,
  borderWidth: 2,
};

// ── Cross-platform font fallbacks ─────────────────────────────────────────────
// No custom font assets are added in this polish pass. We rely on system serif
// on iOS (Georgia) and generic serif on Android to suggest editorial luxury
// without increasing bundle size or risking asset loading failures.
export const FONTS = {
  serif: Platform.select({
    ios: 'Georgia',
    android: 'serif',
    default: 'serif',
  }) as string,
  sans: Platform.select({
    ios: 'System',
    android: 'sans-serif',
    default: 'System',
  }) as string,
  mono: Platform.select({
    ios: 'Courier New',
    android: 'monospace',
    default: 'monospace',
  }) as string,
};

// ── Luxury design tokens (Phase 1) ────────────────────────────────────────────
// These tokens express the warm ivory / deep plum / brushed gold editorial
// direction from the luxury mockups. Existing COLORS/SPACING/RADIUS/SHADOWS
// values are intentionally preserved; LUXURY provides a curated surface for
// new shared components and screen polish without breaking current callers.
export const LUXURY = {
  colors: {
    // Warm ivory / cream surfaces
    ivory:         COLORS.canvas,
    cream:         COLORS.canvasWarm,
    champagne:     '#F5F0E8',
    silk:          COLORS.bg,
    warmWhite:     '#FDFBF8',
    pearl:         COLORS.surfaceCard,
    canvasLavender: COLORS.canvasLavender,

    // Deep plum primary actions
    plum:          COLORS.accent,
    plumDeep:      COLORS.purpleDeep,
    plumCore:      COLORS.purpleCore,
    plumSoft:      COLORS.purpleSoft,
    plumMuted:     COLORS.purpleMist,
    plumGlow:      COLORS.purpleGlow,

    // Brushed gold / camel accents
    gold:          COLORS.gold,
    goldText:      COLORS.goldText,
    goldBrushed:   '#B08D4B',
    goldLight:     COLORS.softGold,
    goldChampagne: '#D4B87A',
    camel:         '#A68B5B',

    // Ink / graphite / stone text
    ink:           COLORS.textPrimary,
    graphite:      COLORS.textSecondary,
    stone:         COLORS.textTertiary,
    inverse:       COLORS.textInverse,

    // Warm borders
    border:        '#E8E0D5',
    borderWarm:    COLORS.border,
    borderStrong:  COLORS.borderStrong,
    hairline:      'rgba(198, 161, 91, 0.28)',

    // Status
    success:       COLORS.success,
    error:         COLORS.error,
    warning:       COLORS.warning,
  },

  typography: {
    displayHero: {
      fontFamily: FONTS.serif,
      fontSize: 36,
      fontWeight: '400' as const,
      letterSpacing: -0.5,
      lineHeight: 44,
      color: COLORS.textPrimary,
    },
    displayHeadline: {
      fontFamily: FONTS.serif,
      fontSize: 28,
      fontWeight: '400' as const,
      letterSpacing: -0.3,
      lineHeight: 36,
      color: COLORS.textPrimary,
    },
    displayTitle: {
      fontFamily: FONTS.serif,
      fontSize: 22,
      fontWeight: '400' as const,
      letterSpacing: 0,
      lineHeight: 30,
      color: COLORS.textPrimary,
    },
    brandMark: {
      fontFamily: FONTS.serif,
      fontSize: 24,
      fontWeight: '600' as const,
      letterSpacing: 3,
      color: COLORS.textPrimary,
      textTransform: 'uppercase' as const,
    },
    sectionLabel: {
      fontFamily: FONTS.sans,
      fontSize: 12,
      fontWeight: '600' as const,
      letterSpacing: 2.6,
      color: COLORS.textTertiary,
      textTransform: 'uppercase' as const,
    },
    body: {
      fontFamily: FONTS.sans,
      fontSize: 15,
      fontWeight: '400' as const,
      lineHeight: 24,
      color: COLORS.textSecondary,
    },
    bodyStrong: {
      fontFamily: FONTS.sans,
      fontSize: 15,
      fontWeight: '600' as const,
      lineHeight: 24,
      color: COLORS.textPrimary,
    },
    caption: {
      fontFamily: FONTS.sans,
      fontSize: 12,
      fontWeight: '500' as const,
      letterSpacing: 1.6,
      color: COLORS.textTertiary,
    },
    cta: {
      fontFamily: FONTS.sans,
      fontSize: 13,
      fontWeight: '600' as const,
      letterSpacing: 2.8,
      color: COLORS.textInverse,
      textTransform: 'uppercase' as const,
    },
    ctaSecondary: {
      fontFamily: FONTS.sans,
      fontSize: 13,
      fontWeight: '600' as const,
      letterSpacing: 2.4,
      color: COLORS.accent,
      textTransform: 'uppercase' as const,
    },
  },

  buttons: {
    primary: {
      backgroundColor: COLORS.accent,
      color: COLORS.textInverse,
      borderRadius: RADIUS.pill,
      height: 56,
      minWidth: 220,
      paddingHorizontal: SPACING.xxl,
      letterSpacing: 2.8,
      fontSize: 13,
      fontWeight: '600' as const,
      shadow: SHADOWS.editorialSmall,
    },
    secondary: {
      backgroundColor: 'transparent',
      color: COLORS.accent,
      borderColor: COLORS.gold,
      borderWidth: 1.5,
      borderRadius: RADIUS.pill,
      height: 52,
      minWidth: 200,
      paddingHorizontal: SPACING.xl,
      letterSpacing: 2.4,
      fontSize: 13,
      fontWeight: '600' as const,
    },
    tertiary: {
      backgroundColor: 'transparent',
      color: COLORS.textSecondary,
      borderRadius: RADIUS.pill,
      height: 44,
      paddingHorizontal: SPACING.lg,
      letterSpacing: 1.6,
      fontSize: 13,
      fontWeight: '500' as const,
    },
  },

  cards: {
    hero: {
      backgroundColor: COLORS.canvasWarm,
      borderRadius: RADIUS.xl,
      borderWidth: 1,
      borderColor: 'rgba(198, 161, 91, 0.24)',
      shadow: SHADOWS.editorialRaised,
      padding: SPACING.xl,
    },
    product: {
      backgroundColor: COLORS.surfaceCard,
      borderRadius: RADIUS.lg,
      borderWidth: 1,
      borderColor: '#F0EAE0',
      shadow: SHADOWS.editorialSmall,
      padding: SPACING.md,
    },
    screen: {
      backgroundColor: COLORS.canvas,
      borderRadius: RADIUS.xl,
      borderWidth: 1,
      borderColor: 'rgba(21, 18, 15, 0.06)',
      shadow: SHADOWS.editorialSmall,
      padding: SPACING.xl,
    },
    darkFloat: {
      backgroundColor: COLORS.surfaceStrong,
      borderRadius: RADIUS.xl,
      borderWidth: 1,
      borderColor: COLORS.darkOverlayBorder,
      shadow: SHADOWS.darkFloat,
      padding: SPACING.xl,
    },
  },

  chips: {
    styleTag: {
      backgroundColor: COLORS.purpleMist,
      color: COLORS.accent,
      borderRadius: RADIUS.pill,
      height: 34,
      paddingHorizontal: SPACING.lg,
      fontSize: 12,
      fontWeight: '500' as const,
      letterSpacing: 0.5,
    },
    metadata: {
      backgroundColor: 'rgba(18, 16, 26, 0.78)',
      color: COLORS.textInverse,
      borderRadius: RADIUS.pill,
      height: 34,
      paddingHorizontal: SPACING.lg,
      fontSize: 12,
      fontWeight: '500' as const,
      letterSpacing: 0.5,
    },
    goldOutline: {
      backgroundColor: 'transparent',
      color: COLORS.goldText,
      borderColor: COLORS.gold,
      borderWidth: 1,
      borderRadius: RADIUS.pill,
      height: 34,
      paddingHorizontal: SPACING.lg,
      fontSize: 12,
      fontWeight: '500' as const,
      letterSpacing: 0.5,
    },
  },

  inputs: {
    field: {
      backgroundColor: COLORS.surfaceCard,
      color: COLORS.textPrimary,
      placeholderColor: COLORS.textTertiary,
      borderRadius: RADIUS.lg,
      borderWidth: 1,
      borderColor: COLORS.border,
      focusedBorderColor: COLORS.gold,
      height: 54,
      paddingHorizontal: SPACING.lg,
      fontSize: 15,
      fontWeight: '400' as const,
    },
    search: {
      backgroundColor: 'rgba(247, 243, 236, 0.92)',
      color: COLORS.textPrimary,
      placeholderColor: COLORS.textTertiary,
      borderRadius: RADIUS.pill,
      borderWidth: 1,
      borderColor: 'rgba(21, 18, 15, 0.08)',
      height: 48,
      paddingHorizontal: SPACING.lg,
      fontSize: 15,
      fontWeight: '400' as const,
    },
  },

  emptyState: {
    iconColor: COLORS.gold,
    titleColor: COLORS.textPrimary,
    bodyColor: COLORS.textSecondary,
    actionColor: COLORS.accent,
  },

  loadingState: {
    indicatorColor: COLORS.accent,
    panelBackground: COLORS.surfaceCard,
    captionColor: COLORS.textTertiary,
  },
} as const;

export const api = {
  retryPorts:      [8081, 8082],
  healthTimeoutMs: 1200,
  timeoutMs:       8000,
};
