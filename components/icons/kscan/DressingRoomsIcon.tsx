import React from 'react';
import { Path } from 'react-native-svg';
import { IconSvg, resolveIconColors, strokeProps } from './iconShared';
import type { KScanIconGlyphProps } from './iconTypes';

/**
 * Dressing Rooms — a fitting-room mirror with a look hanging in it.
 *
 * SEMANTIC REWORK, not a polish pass. The previous glyph was an empty arch on
 * a small floor stand. An empty arch is a doorway, a window or a mirror
 * depending on who is looking; nothing in it said clothing, and nothing said
 * trying clothes on.
 *
 * HOW THIS STAYS DISTINCT FROM CLOSET. The two tiles sit next to each other, so
 * they are drawn to differ on every axis at once:
 *
 *              Closet                    Dressing Rooms
 *   frame      square, flat-topped       tall arch, curved top
 *   contents   a bare hanger             a garment ON the hanger
 *   meaning    clothes put away          clothes being tried
 *
 * Closet shows the hanger empty because storage is the idea; here it carries a
 * dress, because the idea is the look itself.
 */
export function DressingRoomsIcon(props: KScanIconGlyphProps) {
  const { color, accentColor, size, variant } = resolveIconColors(props);
  const compact = variant === 'compact';

  // Compact narrows the hem so the flare cannot reach the arch wall.
  const hemLeft = compact ? 8 : 7;
  const hemRight = compact ? 16 : 17;

  return (
    <IconSvg size={size} accessibilityLabel={props.accessibilityLabel}>
      {/*
        Full-height arch: vertical walls rising to a true semicircle, closed
        along the floor. No stand — a mirror standing on the floor reads taller
        and cleaner, and the legs were three more strokes competing for the
        same pixels.

        The arch takes the full width it can. An earlier pass shrank it to make
        a side column for small "motion" marks; at the size this actually
        renders those marks were specks, and the cost was an arch and a dress
        too cramped to read. One large form beats two small ones here.
      */}
      <Path
        d="M5 21 V10 A7 7 0 0 1 19 10 V21 Z"
        stroke={accentColor}
        {...strokeProps}
      />
      {/*
        Hook and crossbar. The hook used to be a lone vertical stem above the
        garment, which at this size read as a bag handle or a padlock shackle
        rather than as something to hang a dress on. Giving it a crossbar makes
        the reading unambiguous, and the bar doubles as the garment's shoulder
        line so it costs no extra stroke.
      */}
      <Path d="M12 8 V10" stroke={color} {...strokeProps} />
      <Path d="M8 10 H16" stroke={color} {...strokeProps} />
      {/*
        The dress hangs from the middle of that bar, not from its ends. The bar
        is deliberately wider than the garment's shoulders so it projects on
        both sides and reads as a separate crossbar; when the two were the same
        width the bar simply became the dress's top edge and the hook above it
        turned into a bag handle.

        Flat shoulders and a straight A-line flare are also deliberate — an
        earlier pass peaked them, which domed the silhouette into a bell, and
        Closet's hanger had domed the same way so the two tiles became a matched
        pair. Closet is a peak, this is a flare.
      */}
      <Path
        d={`M10 10 L${hemLeft} 19 H${hemRight} L14 10`}
        stroke={color}
        {...strokeProps}
      />
    </IconSvg>
  );
}
