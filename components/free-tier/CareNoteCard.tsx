/**
 * Free Tier Utility Expansion — care & maintenance notes card.
 * No notifications or reminder permissions.
 */

import React, { useState } from 'react';
import { StyleSheet, TextInput } from 'react-native';
import {
  FREE_TIER_CARE_NOTES_ENABLED,
  isFreeTierFeatureEnabled,
} from '../../constants/freeTierUtilityFlags';
import { useCareNotes } from '../../hooks/useCareNotes';
import { CARE_NOTE_TAGS } from '../../services/free-tier/wardrobeUtilityTypes';
import { FT_COLORS, UtilityBody, UtilityButton, UtilityCard, UtilityChip, UtilityRow, UtilityTitle } from './freeTierUi';

export function CareNoteCard(props: { itemId?: string }) {
  const enabled = isFreeTierFeatureEnabled(FREE_TIER_CARE_NOTES_ENABLED);
  const { notes, loading, save, toggleTag } = useCareNotes();
  const [draft, setDraft] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  if (!enabled || !props.itemId || loading) return null;
  const entry = notes[props.itemId];
  const itemId = props.itemId;

  const submitNote = async () => {
    const text = draft.trim();
    if (!text || isSaving) return; // guard against rapid double-submit
    setIsSaving(true);
    try {
      await save(itemId, { note: text });
      setDraft('');
    } finally {
      setIsSaving(false);
    }
  };

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
            onPress={() => toggleTag(itemId, tag)}
          />
        ))}
      </UtilityRow>
      <TextInput
        style={styles.input}
        placeholder="Add a note (e.g. dry clean only)"
        placeholderTextColor={FT_COLORS.textMuted}
        value={draft}
        onChangeText={setDraft}
        onSubmitEditing={submitNote}
        returnKeyType="done"
        blurOnSubmit={true}
        maxLength={280}
        multiline
      />
      {draft.trim() ? (
        <UtilityRow>
          <UtilityButton
            label={isSaving ? 'Saving…' : 'Save note'}
            disabled={isSaving}
            onPress={submitNote}
          />
        </UtilityRow>
      ) : null}
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
    minHeight: 60,
    textAlignVertical: 'top',
  },
});
