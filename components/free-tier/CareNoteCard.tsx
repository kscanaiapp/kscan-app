/**
 * Free Tier Utility Expansion — care & maintenance notes card.
 * No notifications or reminder permissions.
 */

import React from 'react';
import {
  FREE_TIER_CARE_NOTES_ENABLED,
  isFreeTierFeatureEnabled,
} from '../../constants/freeTierUtilityFlags';
import { useCareNotes } from '../../hooks/useCareNotes';
import { CARE_NOTE_TAGS } from '../../services/free-tier/wardrobeUtilityTypes';
import { UtilityBody, UtilityCard, UtilityChip, UtilityRow, UtilityTitle } from './freeTierUi';

export function CareNoteCard(props: { itemId?: string }) {
  const enabled = isFreeTierFeatureEnabled(FREE_TIER_CARE_NOTES_ENABLED);
  const { notes, loading, toggleTag } = useCareNotes();
  if (!enabled || !props.itemId || loading) return null;
  const entry = notes[props.itemId];

  return (
    <UtilityCard>
      <UtilityTitle kicker="Care notes">Keep this piece ready to wear</UtilityTitle>
      {entry?.note ? <UtilityBody>{entry.note}</UtilityBody> : null}
      <UtilityRow>
        {CARE_NOTE_TAGS.map((tag) => (
          <UtilityChip
            key={tag}
            label={tag}
            active={(entry?.tags ?? []).includes(tag)}
            onPress={() => toggleTag(props.itemId as string, tag)}
          />
        ))}
      </UtilityRow>
    </UtilityCard>
  );
}
