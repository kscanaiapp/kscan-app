/**
 * Free Tier Utility Expansion — preview/sample content.
 *
 * ONLY for empty states and isolated component previews. Never inject these
 * into the user's real Library, scan history, or activity data.
 */

import type { NormalizedItem } from './wardrobeUtilityTypes';

export const PREVIEW_BADGE_LABEL = 'Example';

export const PREVIEW_ITEMS: NormalizedItem[] = [
  {
    id: 'preview_blazer',
    title: 'Black blazer (example)',
    category: 'Outerwear',
    color: 'Black',
    occasionTags: ['work'],
    source: 'manual',
  },
  {
    id: 'preview_jeans',
    title: 'Blue relaxed jeans (example)',
    category: 'Bottoms',
    color: 'Blue',
    occasionTags: ['casual'],
    source: 'manual',
  },
  {
    id: 'preview_tee',
    title: 'Ivory tee (example)',
    category: 'Top',
    color: 'Ivory',
    occasionTags: ['casual', 'weekend'],
    source: 'manual',
  },
];
