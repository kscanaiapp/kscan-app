/**
 * Free Tier Utility Expansion — seasonal closet nudges (local only, no notifications).
 */

import type { CareNoteEntry, NormalizedItem } from './wardrobeUtilityTypes';

export type Season = 'spring' | 'summer' | 'fall' | 'winter';

export function currentSeason(now: Date = new Date()): Season {
  const month = now.getMonth(); // 0-11 (northern-hemisphere approximation)
  if (month >= 2 && month <= 4) return 'spring';
  if (month >= 5 && month <= 7) return 'summer';
  if (month >= 8 && month <= 10) return 'fall';
  return 'winter';
}

export interface SeasonalNudge {
  season: Season;
  headline: string;
  body: string;
  inSeasonItemIds: string[];
  offSeasonItemIds: string[];
}

const SEASON_MATCHERS: Record<Season, string[]> = {
  spring: ['spring'],
  summer: ['summer'],
  fall: ['fall', 'autumn'],
  winter: ['winter'],
};

/** Returns a nudge only when at least one item carries season tags. */
export function getSeasonalNudge(
  items: NormalizedItem[],
  extras?: { care?: Record<string, CareNoteEntry>; now?: Date }
): SeasonalNudge | null {
  const safeItems = Array.isArray(items) ? items : [];
  const tagged = safeItems.filter((i) => (i.seasonTags ?? []).length > 0);
  if (tagged.length === 0) return null;

  const season = currentSeason(extras?.now ?? new Date());
  const matchers = SEASON_MATCHERS[season];
  const inSeason: string[] = [];
  const offSeason: string[] = [];
  for (const item of tagged) {
    const tags = (item.seasonTags ?? []).map((t) => t.toLowerCase());
    if (matchers.some((m) => tags.some((t) => t.includes(m)))) inSeason.push(item.id);
    else offSeason.push(item.id);
  }

  const hasCareNotes = Object.keys(extras?.care ?? {}).length > 0;
  return {
    season,
    headline: 'Ready to rotate your closet?',
    body:
      offSeason.length > 0
        ? 'Some saved items look off-season. Consider storing them' +
          (hasCareNotes ? ' and reviewing their care notes.' : '.')
        : 'Your ' + season + ' items are saved here. Review seasonal items.',
    inSeasonItemIds: inSeason.slice(0, 10),
    offSeasonItemIds: offSeason.slice(0, 10),
  };
}
