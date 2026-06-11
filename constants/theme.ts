import { Platform } from 'react-native';

export const COLORS = {
  // ── Backgrounds ──────────────────────────────────────────────────────────────
  bg:            '#0C0F15',                     // Obsidian
  bgElevated:    '#131720',                     // lifted obsidian
  surface:       'rgba(20, 24, 32, 0.86)',      // card/glass surface
  surfaceStrong: 'rgba(26, 31, 46, 0.92)',      // elevated glass
  surfaceSoft:   'rgba(255, 255, 255, 0.06)',   // very subtle tint
  canvasWarm:    '#F6F4F1',
  surfaceCard:   '#FFFFFF',
  surfaceRaised: '#FAF8F5',
  surfaceMuted:  '#F2F0ED',
  obsidian:      '#09090B',
  graphite:      '#121212',
  graphiteRaised:'#1A1A1C',

  // ── Absolute ─────────────────────────────────────────────────────────────────
  white: '#FFFFFF',
  black: '#000000',

  // ── Text ─────────────────────────────────────────────────────────────────────
  textPrimary:   '#E5E7EB',   // soft chrome white
  textSecondary: '#8C93A3',   // muted chrome
  textTertiary:  '#6B7280',   // deep muted
  textInverse:   '#090B10',   // dark text on gold/light surfaces
  editorialTextPrimary:   '#171717',
  editorialTextSecondary: '#575757',
  editorialTextMuted:     '#6A6A6A',
  chrome:                 '#F5F3EF',
  chromeMuted:            'rgba(245, 243, 239, 0.72)',

  // ── Accent — Champagne Gold ───────────────────────────────────────────────────
  accent:     '#D6B36A',                        // champagne gold
  accentSoft: 'rgba(214, 179, 106, 0.12)',
  accentGlow: 'rgba(214, 179, 106, 0.22)',
  gold:       '#C7A86B',
  goldPressed:'#8B6F2E',
  goldMuted:  'rgba(199, 168, 107, 0.50)',

  // ── AR signals ───────────────────────────────────────────────────────────────
  arPurple: '#8B5CF6',
  arBlue:   '#3B82F6',

  // ── Chrome borders ────────────────────────────────────────────────────────────
  border:       '#2A2F3A',                      // chrome
  borderStrong: 'rgba(214, 179, 106, 0.35)',    // gold highlight
  chipBorder:   '#2A2F3A',                      // chrome chip border
  borderHairline: 'rgba(0, 0, 0, 0.06)',
  borderSubtle:   'rgba(0, 0, 0, 0.10)',
  darkOverlayBorder: 'rgba(255, 255, 255, 0.16)',
  hudLine: 'rgba(255, 255, 255, 0.72)',

  // ── Cards ────────────────────────────────────────────────────────────────────
  cardBg:     'rgba(20, 24, 32, 0.86)',
  cardBorder: '#2A2F3A',
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
