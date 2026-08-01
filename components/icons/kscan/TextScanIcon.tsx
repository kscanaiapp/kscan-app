import React from 'react';
import { Line } from 'react-native-svg';
import { IconSvg, ScanBrackets, resolveIconColors, strokeProps } from './iconShared';
import type { KScanIconGlyphProps } from './iconTypes';

/**
 * TextScan — scan brackets framing three lines of text.
 *
 * CONCEPT PRESERVED: text inside a scan frame, never a plain document.
 *
 * WHAT CHANGED AND WHY. Two defects, both structural rather than cosmetic:
 *
 * 1. The top-right bracket used to be cut into two disconnected segments to
 *    clear a gold sparkle. At Home's render size that gap read as a broken
 *    frame, and it meant TextScan and Visual Search no longer shared a
 *    silhouette. The frame is now the shared `ScanBrackets` primitive, so the
 *    two icons are provably identical.
 * 2. The sparkle itself was a radius-2 detail carrying four curve segments —
 *    the single muddiest element in the set at small sizes. It is removed
 *    rather than shrunk; the brackets already carry the "scan" meaning, and the
 *    gold accent is spent where it earns clarity instead (Recent Scans' clock
 *    hands, the Closet rod, the Dressing Room reflection).
 *
 * The three lines sit on even coordinates with a uniform four-unit rhythm, and
 * the last line is short so the block reads as text rather than as a bar chart.
 */
export function TextScanIcon(props: KScanIconGlyphProps) {
  const { color, size, variant } = resolveIconColors(props);
  const compact = variant === 'compact';

  // Compact trims a unit from each end so the text block never crowds the
  // brackets when the glyph is rendered below its intended size.
  const x1 = compact ? 8 : 7;
  const x2 = compact ? 16 : 17;
  const shortX2 = compact ? 12 : 13;

  return (
    <IconSvg size={size} accessibilityLabel={props.accessibilityLabel}>
      <ScanBrackets color={color} />
      <Line x1={x1} y1={8} x2={x2} y2={8} stroke={color} {...strokeProps} />
      <Line x1={x1} y1={12} x2={x2} y2={12} stroke={color} {...strokeProps} />
      <Line x1={x1} y1={16} x2={shortX2} y2={16} stroke={color} {...strokeProps} />
    </IconSvg>
  );
}
