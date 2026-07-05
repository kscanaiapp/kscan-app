/**
 * Free Tier Utility Expansion — collections / lookbooks section.
 * Default names are shown as empty-state ideas only, never injected into data.
 */

import React, { useState } from 'react';
import { Alert, StyleSheet, TextInput } from 'react-native';
import {
  FREE_TIER_COLLECTIONS_ENABLED,
  isFreeTierFeatureEnabled,
} from '../../constants/freeTierUtilityFlags';
import { useOutfitCollections } from '../../hooks/useOutfitCollections';
import { COLLECTION_NAME_IDEAS } from '../../services/free-tier/outfitCollections';
import type { OutfitCollection } from '../../services/free-tier/wardrobeUtilityTypes';
import { OutfitCollectionCard } from './OutfitCollectionCard';
import { FT_COLORS, UtilityBody, UtilityButton, UtilityCard, UtilityChip, UtilityRow, UtilityTitle } from './freeTierUi';

export function OutfitCollectionsSection() {
  const enabled = isFreeTierFeatureEnabled(FREE_TIER_COLLECTIONS_ENABLED);
  const { collections, loading, create, rename, remove } = useOutfitCollections();
  const [draftName, setDraftName] = useState('');
  const [pendingRenameId, setPendingRenameId] = useState<string | null>(null);
  if (!enabled || loading) return null;

  const handleSubmit = () => {
    const name = draftName.trim();
    if (!name) return;
    if (pendingRenameId) {
      rename(pendingRenameId, name);
      setPendingRenameId(null);
      setDraftName('');
    } else {
      create(name);
      setDraftName('');
    }
  };

  const confirmDelete = (collection: OutfitCollection) => {
    Alert.alert('Delete collection', 'Remove "' + collection.name + '"? Items stay saved.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => remove(collection.id) },
    ]);
  };

  const promptRename = (collection: OutfitCollection) => {
    setDraftName(collection.name);
    Alert.alert('Rename collection', 'Update the name below, then tap Rename.', [
      { text: 'OK' },
    ]);
    setPendingRenameId(collection.id);
  };

  return (
    <>
      <UtilityTitle kicker="Collections">Lookbooks from your saved items</UtilityTitle>
      {collections.length === 0 ? (
        <UtilityCard>
          <UtilityBody>
            Create collections for work, travel, or nights out. Ideas:
          </UtilityBody>
          <UtilityRow>
            {COLLECTION_NAME_IDEAS.map((idea) => (
              <UtilityChip key={idea} label={idea} onPress={() => setDraftName(idea)} />
            ))}
          </UtilityRow>
        </UtilityCard>
      ) : (
        collections.map((collection) => (
          <OutfitCollectionCard
            key={collection.id}
            collection={collection}
            onRename={promptRename}
            onDelete={confirmDelete}
          />
        ))
      )}
      <TextInput
        style={styles.input}
        placeholder="New collection name"
        placeholderTextColor={FT_COLORS.textMuted}
        value={draftName}
        onChangeText={setDraftName}
        onSubmitEditing={handleSubmit}
        returnKeyType="done"
        blurOnSubmit={true}
        maxLength={60}
      />
      <UtilityRow>
        <UtilityButton label="Create collection" disabled={!draftName.trim()} onPress={handleSubmit} />
        {pendingRenameId && draftName.trim() ? (
          <UtilityButton
            label="Rename"
            subtle
            onPress={() => {
              rename(pendingRenameId, draftName.trim());
              setPendingRenameId(null);
              setDraftName('');
            }}
          />
        ) : null}
      </UtilityRow>
    </>
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
    marginTop: 4,
  },
});
