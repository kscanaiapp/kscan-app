import React from 'react';
import { Line, Path, Rect } from 'react-native-svg';
import { IconSvg, resolveIconColors, strokeProps } from './iconShared';
import type { KScanIconGlyphProps } from './iconTypes';

/**
 * Closet — a wardrobe with a hanger on its rail.
 *
 * SEMANTIC REWORK, not a polish pass. The previous glyph was a rounded card
 * with a gold bookmark tab: it said "saved" or "bookmarked", which is a
 * generic action, not this feature. Nothing about it said wardrobe, and a
 * bookmark is one of the shapes explicitly ruled out for this tile.
 *
 * The registry key stays `save-organize` on purpose. It is referenced by the
 * Home tile, the dev review screen and the icon governance suite, and renaming
 * it would be an API change dressed up as an icon change. Only the drawing
 * moved.
 *
 * COMPOSITION
 *   - a square wardrobe outline in gold: enclosed and stable, reading as
 *     storage, and secondary to what it contains
 *   - a gold rail across the interior — the detail that makes the box a
 *     wardrobe rather than a picture frame or a generic container
 *   - a hanger on that rail in plum, curved-shouldered, so the primary colour
 *     carries the primary meaning
 *
 * The hanger is deliberately the clearest hanger in the set: this tile owns
 * that meaning, and Dressing Rooms is drawn so it cannot compete for it.
 */
export function SaveOrganizeIcon(props: KScanIconGlyphProps) {
  const { color, accentColor, size, variant } = resolveIconColors(props);
  const compact = variant === 'compact';

  // Compact narrows the shoulders by a unit per side.
  const shoulderLeft = compact ? 7 : 6;
  const shoulderRight = compact ? 17 : 18;

  return (
    <IconSvg size={size} accessibilityLabel={props.accessibilityLabel}>
      {/* Wardrobe body, in gold: the container is structure, not subject. */}
      <Rect
        x={3}
        y={3}
        width={18}
        height={18}
        rx={2}
        stroke={accentColor}
        {...strokeProps}
      />
      {/* Closet rail — the detail that makes the box a wardrobe interior. */}
      <Line x1={8} y1={7} x2={16} y2={7} stroke={accentColor} {...strokeProps} />
      {/* Hook, hanging over the rail. */}
      <Path d="M12 7 V11" stroke={color} {...strokeProps} />
      {/*
        Hanger shoulders: wide, shallow and angular. A curved sweep was tried
        here and had to be abandoned — at 1.5 stroke on a 24 grid a quadratic
        deep enough to look like shoulders closes into a dome, and the glyph
        reads as a bell or a lampshade. Worse, the Dressing Rooms garment
        domed the same way, and the two tiles stopped being tellable apart.
        Four units of drop across twelve of width is the flattest shape that
        still reads as a hanger, and it cannot be mistaken for a dome. The rail
        above it was shortened at the same time: at full width it ran almost
        edge to edge and competed with the wardrobe outline it sits inside.
      */}
      {/*
        One closed path, not a triangle plus a separate bar: the `H` segment IS
        the bar, so drawing a Line over it too stroked the base twice and made
        it visibly heavier than the shoulders it belongs to.
      */}
      <Path
        d={`M12 11 L${shoulderLeft} 15 H${shoulderRight} Z`}
        stroke={color}
        {...strokeProps}
      />
    </IconSvg>
  );
}
