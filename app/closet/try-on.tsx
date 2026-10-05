import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, StyleSheet } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { LuxuryScreen, KScanHeader, InlineNotice, SecondaryButton } from '../../components/luxury';
import { TryItOnEntry } from '../../components/vto/TryItOnEntry';
import { useVtoAvailability } from '../../hooks/useVtoAvailability';
import { useAuthSession } from '../../contexts/AuthSessionContext';
import { captureActorScope, currentActorScopeKey, isActorScopeCurrent } from '../../services/actorScope';
import { loadClosetTyped } from '../../services/closetLibrary';
import { getClosetItemProjections } from '../../services/closetItemProjection';
import { resolveOwnedClosetVtoInput } from '../../services/vto/vtoOwnedGarment';
import { goBackOrHome } from '../../services/navigationExit';
import { LUXURY, SPACING } from '../../constants/theme';
import type { VtoGarmentInput } from '../../types/vto';

function OwnedTryOnContent() {
  const { closetItemId } = useLocalSearchParams<{ closetItemId?: string }>();
  const scope = useRef(captureActorScope()).current;
  const [state, setState] = useState<{ loading: boolean; title?: string; garment?: VtoGarmentInput; error?: string }>({ loading: true });
  const [attempt, setAttempt] = useState(0);
  const availability = useVtoAvailability({
    category: state.garment?.category, imageUrl: state.garment?.imageUrl,
    productRef: state.garment?.productRef, ownedMediaReady: state.garment?.ownedMediaReady,
  });
  useEffect(() => {
    let cancelled = false;
    const current = () => !cancelled && isActorScopeCurrent(scope);
    setState({ loading: true });
    void (async () => {
      try {
        const loaded = await loadClosetTyped(scope.actorId, { actorRequest: scope });
        if (!current()) return;
        if (!loaded.ok) throw new Error('Closet unavailable');
        const item = getClosetItemProjections(loaded.items).find(entry => entry.id === closetItemId);
        if (!item) { setState({ loading: false, error: 'This Closet item is unavailable.' }); return; }
        const result = await resolveOwnedClosetVtoInput(item);
        if (!current()) return;
        if (result.ok === true) setState({ loading: false, title: item.title, garment: result.garment });
        else setState({ loading: false, error: result.reason === 'missing_media'
          ? 'This item needs a synced garment photo before try-on.'
          : result.reason === 'unsupported_category' ? 'Try-on is not available for this category.'
            : 'Unable to prepare this item. Please try again.' });
      } catch { if (current()) setState({ loading: false, error: 'Unable to prepare this item. Please try again.' }); }
    })();
    return () => { cancelled = true; };
  }, [scope, closetItemId, attempt]);
  return <LuxuryScreen>
    <KScanHeader title={state.title ?? 'Try on your piece'} subtitle="FROM YOUR CLOSET" onBack={() => goBackOrHome(router)} />
    {state.loading ? <ActivityIndicator accessibilityLabel="Preparing your garment" /> : null}
    {state.error ? <><InlineNotice variant="error" title="Try-on unavailable" body={state.error} />
      <SecondaryButton title="Try again" onPress={() => setAttempt(value => value + 1)} /></> : null}
    {state.garment ? <>
      {state.garment.imageUrl ? <Image source={{ uri: state.garment.imageUrl }} style={styles.image} resizeMode="contain" accessibilityLabel={`${state.title} garment`} /> : null}
      {availability.loading ? <ActivityIndicator accessibilityLabel="Checking try-on availability" />
        : availability.available || availability.upgradeOpportunity
          ? <TryItOnEntry garment={state.garment} garmentTitle={state.title ?? 'Your piece'} origin="closet_item" testID="owned-closet-try-on" />
          : <InlineNotice title="Try-on unavailable" body={availability.eligibility.eligible === false && availability.eligibility.reason === 'unsupported_category'
            ? 'Try-on is not available for this category.' : 'Try-on is currently unavailable. Please try again later.'} />}
    </> : null}
  </LuxuryScreen>;
}

export default function OwnedClosetTryOnScreen() {
  useAuthSession();
  return <OwnedTryOnContent key={currentActorScopeKey()} />;
}
const styles = StyleSheet.create({ image: { height: 320, margin: SPACING.xl, backgroundColor: LUXURY.colors.pearl } });
