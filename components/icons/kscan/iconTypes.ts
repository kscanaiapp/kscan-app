import type { ReactElement } from 'react';

export type KScanIconName =
  | 'dressing-rooms'
  | 'textscan'
  | 'recent-scans'
  | 'visual-search'
  | 'save-organize'
  | 'voice-scan'
  | 'style'
  | 'watchlist';

export type KScanIconVariant = 'compact' | 'standard';

/** Props shared by every product glyph and the registry wrapper. */
export type KScanIconGlyphProps = {
  size?: number;
  variant?: KScanIconVariant;
  /** Primary plum stroke. Defaults to LUXURY.colors.plum. */
  color?: string;
  /** Gold accent stroke/fill. Defaults to LUXURY.colors.goldBrushed. */
  accentColor?: string;
  /**
   * When set, the SVG is exposed to assistive tech.
   * Omit (or leave undefined) when a parent button already announces the action.
   */
  accessibilityLabel?: string;
};

export type KScanIconProps = KScanIconGlyphProps & {
  name: KScanIconName;
};

export type KScanIconComponent = (props: KScanIconGlyphProps) => ReactElement;

export const KSCAN_ICON_VIEWBOX = '0 0 24 24';
/**
 * Stroke weight for every product glyph.
 *
 * 1.5 rather than 2: at the size Home renders, a 2-unit stroke on a 24-unit
 * grid left too little negative space inside small forms — hanger shoulders and
 * garment bodies closed up into solid wedges. The lighter weight is also what
 * makes the set read as fashion rather than as a utility toolbar.
 */
export const KSCAN_ICON_STROKE = 1.5;
