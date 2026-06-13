import { Platform } from 'react-native';

export const COLORS = {
  // ── Backgrounds ──────────────────────────────────────────────────────────────
  bg:            '#FAF7FF',
  bgElevated:    '#FBF8FF',
  surface:       'rgba(20, 24, 32, 0.86)',      // card/glass surface
  surfaceStrong: 'rgba(26, 31, 46, 0.92)',      // elevated glass
  surfaceSoft:   'rgba(255, 255, 255, 0.06)',   // very subtle tint
  canvas:        '#FAF7FF',
  canvasLavender:'#F7F0FF',
  canvasWarm:    '#FAF7FF',
  surfaceCard:   '#FFFFFF',
  surfaceRaised: '#FBF8FF',
  surfaceMuted:  '#F1EAFE',
  lavenderSurface: '#F1EAFE',
  obsidian:      '#09090B',
  graphite:      '#121212',
  graphiteRaised:'#1A1A1C',

  // ── Absolute ─────────────────────────────────────────────────────────────────
  white: '#FFFFFF',
  black: '#000000',

  // ── Text ─────────────────────────────────────────────────────────────────────
  textPrimary:   '#241433',
  textSecondary: '#6B5A78',
  textTertiary:  '#8B7A99',
  textMuted:     '#8B7A99',
  textInverse:   '#FFFFFF',
  editorialTextPrimary:   '#241433',
  editorialTextSecondary: '#6B5A78',
  editorialTextMuted:     '#8B7A99',
  chrome:                 '#EDE9FE',
  chromeMuted:            '#B8A8D9',
  chromeMist:             '#EEF7FA',
  chromeLine:             '#E7DDF5',

  // ── Accent — Purple identity + premium gold ──────────────────────────────────
  purpleDeep:    '#5B21B6',
  purpleCore:    '#6D28D9',
  purplePrimary: '#7C3AED',
  purpleSoft:    '#A78BFA',
  purpleGlow:    '#C084FC',
  purpleMist:    '#F5F0FF',
  accent:        '#7C3AED',
  accentSoft:    '#F5F0FF',
  accentGlow:    '#C084FC',
  champagneGold: '#F4C76B',
  softGold:      '#FFF4D6',
  gold:          '#F4C76B',
  goldPressed:   '#9A6A1F',
  goldMuted:     '#FFF4D6',
  goldText:      '#76531C',

  // ── AR signals ───────────────────────────────────────────────────────────────
  arPurple: '#7C3AED',
  arBlue:   '#3B82F6',
  electricCyan:   '#22D3EE',
  electricBlue:   '#38BDF8',
  electricViolet: '#C084FC',
  scanCyan:       '#22D3EE',
  scanAccent:     '#22D3EE',
  activeVision:   '#22D3EE',

  // ── Chrome borders ────────────────────────────────────────────────────────────
  border:       '#E7DDF5',
  borderStrong: '#A78BFA',
  chipBorder:   '#2A2F3A',                      // chrome chip border
  borderHairline: '#E7DDF5',
  borderSubtle:   '#D8C7F7',
  darkOverlay: 'rgba(9, 9, 11, 0.72)',
  darkOverlayBorder: 'rgba(167, 139, 250, 0.35)',
  hudLine: 'rgba(255, 255, 255, 0.72)',

  // ── Cards ────────────────────────────────────────────────────────────────────
  cardBg:     'rgba(20, 24, 32, 0.86)',
  cardBorder: '#E7DDF5',
  lightCardBg: '#FFFFFF',
  lightCardBorder: 'rgba(0, 0, 0, 0.06)',

  // ── Utility ──────────────────────────────────────────────────────────────────
  backdrop: 'rgba(4, 6, 10, 0.78)',
  overlay:  'rgba(0, 0, 0, 0.30)',

  // ── Status ───────────────────────────────────────────────────────────────────
  error:     '#B65454',
  errorSoft: '#FFAAAA',
  success:   '#3C7D4A',
  warning:   '#F4D27A',
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
  scanningLineColor:  COLORS.gold,
  frameGlow:          COLORS.accentGlow,
};

export const BUTTONS = {
  minWidth:          196,
  height:            54,
  horizontalPadding: SPACING.xl,
  primaryBackground: COLORS.gold,
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

export const api = {
  retryPorts:      [8081, 8082],
  healthTimeoutMs: 1200,
  timeoutMs:       8000,
};
