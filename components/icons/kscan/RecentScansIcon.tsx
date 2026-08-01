import React from 'react';
import { Path, Rect } from 'react-native-svg';
import { IconSvg, resolveIconColors, strokeProps } from './iconShared';
import type { KScanIconGlyphProps } from './iconTypes';

/**
 * Recent Scans — a scan card with a second card layered behind it, and clock
 * hands marking recency.
 *
 * CONCEPT PRESERVED: layered scan/history cards. Not a bare clock, not a bare
 * image.
 *
 * WHAT CHANGED AND WHY. The old glyph had three separate problems that
 * compounded into the "muddy" look:
 *
 * 1. Both cards were full stroked rectangles with `fill: none`, and they
 *    overlapped across most of their area — so the back card's edges were
 *    visible THROUGH the front card. Six stroke lines crossed the middle of a
 *    24-unit glyph. The card behind is now drawn as only the part that would
 *    actually peek out (top edge and right edge), so no stroke crosses another
 *    anywhere in this icon.
 * 2. Recency was a partial arc (`A3.4 3.4 0 1 1`) that ran across the front
 *    card's bottom-right corner and collided with it. The clock is now implied
 *    by hands alone, centred in the card, touching nothing.
 * 3. The hands were 1.6-unit gold segments — below the size at which a stroke
 *    can render as a line rather than a dot. They are now 4 and 3 units, drawn
 *    as one continuous polyline.
 *
 * Every coordinate is a whole unit, so at a 1:1 render each stroke edge lands
 * on a whole device pixel instead of being antialiased across two.
 */
export function RecentScansIcon(props: KScanIconGlyphProps) {
  const { color, accentColor, size, variant } = resolveIconColors(props);
  const compact = variant === 'compact';

  return (
    <IconSvg size={size} accessibilityLabel={props.accessibilityLabel}>
      {/*
        The card behind, drawn as the L it would actually show: top edge,
        rounded corner, right edge. Compact tightens the offset by one unit so
        the peek stays inside the frame at small sizes.
      */}
      <Path
        d={compact ? 'M8 4 H18 A2 2 0 0 1 20 6 V16' : 'M8 3 H19 A2 2 0 0 1 21 5 V16'}
        stroke={color}
        {...strokeProps}
      />
      {/* Front card. */}
      <Rect
        x={3}
        y={compact ? 8 : 7}
        width={compact ? 13 : 14}
        height={compact ? 13 : 14}
        rx={2}
        stroke={color}
        {...strokeProps}
      />
      {/*
        Clock hands, centred in the front card. One polyline: twelve o'clock
        down to the centre, then out to three. No dial circle — at this size the
        card edge already supplies the enclosing form, and a second concentric
        outline was exactly the kind of detail that muddied the original.
      */}
      <Path
        d={compact ? 'M9 11 V14 H12' : 'M10 10 V14 H13'}
        stroke={accentColor}
        {...strokeProps}
      />
    </IconSvg>
  );
}
