/**
 * Free Tier Utility Expansion — brand sizing memory card.
 * User-entered fit notes only; never infers body size.
 */

import React, { useState } from 'react';
import { StyleSheet, TextInput } from 'react-native';
import {
  FREE_TIER_BRAND_SIZING_ENABLED,
  isFreeTierFeatureEnabled,
} from '../../constants/freeTierUtilityFlags';
import { useBrandSizingMemory } from '../../hooks/useBrandSizingMemory';
import { FT_COLORS, UtilityBody, UtilityButton, UtilityCard, UtilityChip, UtilityRow, UtilityTitle } from './freeTierUi';

export function BrandSizingNoteCard(props: { brand?: string }) {
  const enabled = isFreeTierFeatureEnabled(FREE_TIER_BRAND_SIZING_ENABLED);
  const { entry, loading, saveNote } = useBrandSizingMemory(props.brand);
  const [draftSize, setDraftSize] = useState('');
  const [draftNote, setDraftNote] = useState('');
  if (!enabled || !props.brand || loading) return null;

  return (
    <UtilityCard>
      <UtilityTitle kicker="Sizing memory">{props.brand}</UtilityTitle>
      {entry ? (
        <>
          <UtilityBody>
            {[
              entry.usualSize ? 'Usual size: ' + entry.usualSize : null,
              entry.fitNote,
            ]
              .filter(Boolean)
              .join(' · ') || 'You marked this before.'}
          </UtilityBody>
          <UtilityRow>
            {entry.runsSmall ? <UtilityChip label="Runs small — size up" /> : null}
            {entry.runsLarge ? <UtilityChip label="Runs large — size down" /> : null}
          </UtilityRow>
        </>
      ) : (
        <>
          <UtilityBody>
            Remember how this brand fits — e.g. "size up" or "shoes run narrow."
          </UtilityBody>
          <TextInput
            style={styles.input}
            placeholder="Usual size (e.g. M, 42, 8.5)"
            placeholderTextColor={FT_COLORS.textMuted}
            value={draftSize}
            onChangeText={setDraftSize}
            maxLength={40}
          />
          <TextInput
            style={styles.input}
            placeholder="Fit note (optional)"
            placeholderTextColor={FT_COLORS.textMuted}
            value={draftNote}
            onChangeText={setDraftNote}
            maxLength={200}
          />
          <UtilityRow>
            <UtilityButton
              label="Save sizing note"
              disabled={!draftSize.trim() && !draftNote.trim()}
              onPress={() =>
                saveNote(props.brand as string, {
                  usualSize: draftSize.trim() || undefined,
                  fitNote: draftNote.trim() || undefined,
                })
              }
            />
          </UtilityRow>
        </>
      )}
    </UtilityCard>
  );
}

const styles = StyleSheet.create({
  input: {
    borderWidth: 1,
    borderColor: FT_COLORS.border,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 13,
    color: FT_COLORS.plum,
    backgroundColor: '#FFFFFF',
    marginTop: 8,
  },
});
