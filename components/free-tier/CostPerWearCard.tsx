/**
 * Free Tier Utility Expansion — cost-per-wear tracker card.
 * "Estimated" copy only; no financial-accuracy claims.
 */

import React, { useState } from 'react';
import { StyleSheet, Text, TextInput } from 'react-native';
import {
  FREE_TIER_COST_PER_WEAR_ENABLED,
  isFreeTierFeatureEnabled,
} from '../../constants/freeTierUtilityFlags';
import { useCostPerWear } from '../../hooks/useCostPerWear';
import { formatCostPerWear } from '../../services/free-tier/costPerWear';
import type { NormalizedItem } from '../../services/free-tier/wardrobeUtilityTypes';
import { FT_COLORS, UtilityBody, UtilityButton, UtilityCard, UtilityRow, UtilityTitle } from './freeTierUi';

export function CostPerWearCard(props: { item?: NormalizedItem | null }) {
  const enabled = isFreeTierFeatureEnabled(FREE_TIER_COST_PER_WEAR_ENABLED);
  const { wear, loading, markWorn, setPrice, reset } = useCostPerWear();
  const [draftPrice, setDraftPrice] = useState('');
  if (!enabled || !props.item || loading) return null;

  const entry = wear[props.item.id];
  const wearCount = entry?.wearCount ?? 0;
  const cpw = formatCostPerWear(
    entry && typeof entry.estimatedPrice === 'number' && wearCount > 0
      ? Math.round((entry.estimatedPrice / wearCount) * 100) / 100
      : null
  );

  const submitPrice = () => {
    const parsed = Number(draftPrice.replace(/[^0-9.]/g, ''));
    if (Number.isFinite(parsed) && parsed > 0) {
      setPrice((props.item as NormalizedItem).id, parsed);
      setDraftPrice('');
    }
  };

  return (
    <UtilityCard>
      <UtilityTitle kicker="Wear tracker">Estimated cost per wear</UtilityTitle>
      <Text style={styles.count}>
        Worn {wearCount}
        {wearCount === 1 ? ' time' : ' times'}
        {entry?.estimatedPrice ? ' · est. $' + entry.estimatedPrice.toFixed(2) : ''}
      </Text>
      {cpw ? (
        <UtilityBody>{cpw}</UtilityBody>
      ) : (
        <UtilityBody>Add price to calculate cost per wear.</UtilityBody>
      )}
      {typeof entry?.estimatedPrice !== 'number' ? (
        <TextInput
          style={styles.input}
          placeholder="Estimated price (e.g. 89.99)"
          placeholderTextColor={FT_COLORS.textMuted}
          keyboardType="decimal-pad"
          value={draftPrice}
          onChangeText={setDraftPrice}
          onSubmitEditing={submitPrice}
          returnKeyType="done"
          blurOnSubmit={true}
          maxLength={10}
        />
      ) : null}
      <UtilityRow>
        <UtilityButton label="Worn today" onPress={() => markWorn(props.item as NormalizedItem)} />
        {typeof entry?.estimatedPrice !== 'number' && draftPrice.trim() ? (
          <UtilityButton label="Save price" subtle onPress={submitPrice} />
        ) : null}
        {wearCount > 0 ? (
          <UtilityButton
            label="Reset count"
            subtle
            onPress={() => reset((props.item as NormalizedItem).id)}
          />
        ) : null}
      </UtilityRow>
    </UtilityCard>
  );
}

const styles = StyleSheet.create({
  count: { fontSize: 13, color: FT_COLORS.plum, marginBottom: 4, fontWeight: '600' },
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
