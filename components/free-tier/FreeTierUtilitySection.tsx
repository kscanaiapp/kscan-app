/**
 * Free Tier Utility Expansion — main mountable section.
 *
 * A single flag-guarded block that screens can drop in (home, library).
 * Accepts raw saved items in any shape; normalization and store loading
 * happen internally. Renders nothing when FREE_TIER_UTILITY_ENABLED is off,
 * so default app behavior is unchanged.
 */

import React, { useMemo } from 'react';
import { View } from 'react-native';
import { FREE_TIER_UTILITY_ENABLED } from '../../constants/freeTierUtilityFlags';
import { useWardrobeUtility } from '../../hooks/useWardrobeUtility';
import { generateOutfits } from '../../services/free-tier/outfitGenerator';
import { saveOutfitAsLook } from '../../services/free-tier/savedOutfits';
import { DailyStylePromptCard } from './DailyStylePromptCard';
import { EmptyClosetUtilityState } from './EmptyClosetUtilityState';
import { OutfitGeneratorCard } from './OutfitGeneratorCard';
import { OutfitCollectionsSection } from './OutfitCollectionsSection';
import { RecentActivityLogCard } from './RecentActivityLogCard';
import { SeasonalNudgeCard } from './SeasonalNudgeCard';
import { StyleChallengeCard } from './StyleChallengeCard';
import { WardrobeStatsCard } from './WardrobeStatsCard';

export type FreeTierSectionVariant = 'home' | 'library';

function FreeTierUtilitySectionInner(props: {
  rawItems?: unknown[];
  variant?: FreeTierSectionVariant;
  onStartScan?: () => void;
}) {
  const utility = useWardrobeUtility(props.rawItems);
  const outfits = useMemo(
    () => generateOutfits(utility.items, { feedback: utility.feedback, maxOutfits: 4 }),
    [utility.items, utility.feedback]
  );

  const variant = props.variant ?? 'home';
  const hasItems = utility.items.length > 0;

  return (
    <View>
      {!hasItems ? (
        <EmptyClosetUtilityState onStartScan={props.onStartScan} />
      ) : null}
      {variant === 'home' ? (
        <>
          {/* Home: daily pick leads, engagement summaries follow */}
          <DailyStylePromptCard
            items={utility.items}
            outfits={outfits}
            feedback={utility.feedback}
            wear={utility.wear}
            onSaveAsLook={(outfit) => {
              saveOutfitAsLook(outfit).catch(() => undefined);
            }}
          />
          <WardrobeStatsCard
            items={utility.items}
            feedback={utility.feedback}
            wear={utility.wear}
          />
          <RecentActivityLogCard />
          <StyleChallengeCard />
        </>
      ) : (
        <>
          {/* Closet: hero tools first (looks + collections), engagement quieter below */}
          <OutfitGeneratorCard items={utility.items} feedback={utility.feedback} />
          <OutfitCollectionsSection />
          {hasItems ? (
            <DailyStylePromptCard
              items={utility.items}
              outfits={outfits}
              feedback={utility.feedback}
              wear={utility.wear}
              onSaveAsLook={(outfit) => {
                saveOutfitAsLook(outfit).catch(() => undefined);
              }}
            />
          ) : null}
        </>
      )}
      <SeasonalNudgeCard items={utility.items} care={utility.care} />
    </View>
  );
}

export function FreeTierUtilitySection(props: {
  /** Raw saved items in any shape (SavedScan, ScanResultV2, product, …). */
  rawItems?: unknown[];
  variant?: FreeTierSectionVariant;
  onStartScan?: () => void;
}) {
  if (!FREE_TIER_UTILITY_ENABLED) return null;
  return <FreeTierUtilitySectionInner {...props} />;
}
