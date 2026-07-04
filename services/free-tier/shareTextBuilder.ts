/**
 * Free Tier Utility Expansion — share text builder.
 * Plain-text sharing via the built-in React Native Share API only.
 * No image capture, no uploads, no backend.
 */

import type { NormalizedItem, SuggestedOutfit, SavedOutfit } from './wardrobeUtilityTypes';

export const SHARE_WATERMARK = 'Styled with K Scan';

function describeItem(item: NormalizedItem): string {
  const parts = [item.color, item.category].filter(Boolean);
  return item.title ?? (parts.length > 0 ? parts.join(' ') : 'Saved item');
}

export function buildItemShareText(item?: NormalizedItem | null): string {
  if (!item) return 'Check out this look I saved in K Scan.';
  return (
    'Check out this look I saved in K Scan: ' +
    describeItem(item) +
    '\n\nWhat do you think of this outfit?\n' +
    SHARE_WATERMARK
  );
}

export function buildOutfitShareText(
  outfit?: SuggestedOutfit | SavedOutfit | null,
  items?: NormalizedItem[]
): string {
  if (!outfit) return 'Check out this look I saved in K Scan.';
  const resolved =
    items && items.length > 0
      ? items
      : 'items' in outfit && Array.isArray((outfit as SuggestedOutfit).items)
        ? (outfit as SuggestedOutfit).items
        : [];
  const lines = resolved.map((item) => '• ' + describeItem(item));
  return [
    outfit.title || 'A look from my saved items',
    ...lines,
    '',
    'What do you think of this outfit?',
    SHARE_WATERMARK,
  ].join('\n');
}
