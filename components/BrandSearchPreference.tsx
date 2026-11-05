import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { PrivacyToggle } from './PrivacyToggle';
import { LUXURY, SPACING } from '../constants/theme';
import { fetchBrandSearchPreference, saveBrandSearchPreference } from '../services/brandSearchPreferenceService';

export function BrandSearchPreference({ userId }: { userId: string | null }) {
  const [state, setState] = useState({ actor: userId, value: false, busy: true, error: '' });
  const currentActor = useRef(userId);
  currentActor.current = userId;
  useEffect(() => {
    let live = true;
    setState({ actor: userId, value: false, busy: !!userId, error: '' });
    if (userId) fetchBrandSearchPreference(userId).then(value => {
      if (live) setState({ actor: userId, value, busy: false, error: '' });
    }).catch(() => {
      if (live) setState({ actor: userId, value: false, busy: false, error: 'Could not load your preference. Please reopen settings to try again.' });
    });
    return () => { live = false; };
  }, [userId]);
  const ready = state.actor === userId;
  return <View style={styles.section}>
    <PrivacyToggle
      title="Include Black-owned brands in shopping discovery"
      body="Broaden shopping searches with relevant brands from a curated source directory. Products use the same relevance standards. Directory inclusion does not verify ownership."
      value={ready && state.value}
      busy={ready && state.busy}
      disabled={!userId || !ready || !!state.error}
      onChange={value => {
        if (!userId || state.busy) return;
        const expected = userId;
        setState(s => ({ ...s, busy: true, error: '' }));
        void saveBrandSearchPreference(expected, value).then(saved => {
          if (currentActor.current === expected) setState({ actor: expected, value: saved, busy: false, error: '' });
        }).catch(() => {
          if (currentActor.current === expected) setState(s => ({ ...s, busy: false, error: 'Could not save your preference. Please reopen settings to try again.' }));
        });
      }}
    />
    {!!state.error && ready && <Text accessibilityRole="alert" style={styles.error}>{state.error}</Text>}
  </View>;
}
const styles = StyleSheet.create({
  section: { marginVertical: SPACING.md },
  error: { color: LUXURY.colors.error, marginTop: SPACING.sm },
});
