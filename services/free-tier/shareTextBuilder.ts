/**
 * Free Tier Utility Expansion — share text builder.
 * Plain-text sharing via the built-in React Native Share API only.
 * No image capture, no uploads, no backend.
 */

import type { NormalizedItem, SuggestedOutfit, SavedOutfit } from './wardrobeUtilityTypes';

export const SHARE_WATERMARK = 'Styled with K Scan AI';

/**
 * Canonical share URL. kscan.app is configured as an app link / universal
 * link in app.json (iOS associated domains + Android intent filter), so on
 * devices with K Scan installed this opens the app first, with the website
 * as the web fallback. Matches the existing Dressing Room share pattern.
 */
export const KSCAN_SHARE_URL = 'https://kscan.app';

function describeItem(item: NormalizedItem): string {
  const parts = [item.color, item.category].filter(Boolean);
  return item.title ?? (parts.length > 0 ? parts.join(' ') : 'Saved item');
}

export function buildItemShareText(item?: NormalizedItem | null): string {
  if (!item) return 'Check out this look I saved in K Scan AI.';
  return (
    'Check out this look I saved in K Scan AI: ' +
    describeItem(item) +
    '\n\nWhat do you think of this outfit?\n' +
    SHARE_WATERMARK +
    ' — ' +
    KSCAN_SHARE_URL
  );
}

export function buildOutfitShareText(
  outfit?: SuggestedOutfit | SavedOutfit | null,
  items?: NormalizedItem[]
): string {
  if (!outfit) return 'Check out this look I saved in K Scan AI.';
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
    SHARE_WATERMARK + ' — ' + KSCAN_SHARE_URL,
  ].join('\n');
}
