import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { PrivacyToggle } from '../PrivacyToggle';
import { SectionHeader, SecondaryButton } from '../luxury';
import { LUXURY, RADIUS, SPACING } from '../../constants/theme';
import { readGeminiProcessingPermission, setGeminiProcessingPermission } from '../../services/geminiProcessingPermission';

type PermissionState = { actorId: string | null; value: boolean | null; revision: number; busy: boolean; error: boolean };

/** Copy requires the campaign's separate legal review before merge. */
export function GeminiProcessingSettingsSection({ actorId }: { actorId: string | null }) {
  const [state, setState] = useState<PermissionState>({ actorId: null, value: null, revision: 0, busy: true, error: false });
  const sequence = useRef(0);
  const inFlight = useRef(false);
  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    inFlight.current = true;
    setState({ actorId, value: null, revision: 0, busy: true, error: false });
    try {
      const snapshot = actorId ? await readGeminiProcessingPermission(actorId) : null;
      if (sequence.current === request) setState({ actorId, value: snapshot?.granted ?? null, revision: snapshot?.revision ?? 0, busy: false, error: false });
    } catch {
      if (sequence.current === request) setState({ actorId, value: null, revision: 0, busy: false, error: true });
    } finally { if (sequence.current === request) inFlight.current = false; }
  }, [actorId]);
  useEffect(() => {
    void refresh();
    return () => { sequence.current++; };
  }, [refresh]);

  const save = async (next: boolean) => {
    if (!actorId || inFlight.current || state.actorId !== actorId || state.value === null) return;
    inFlight.current = true;
    const request = ++sequence.current;
    setState({ ...state, busy: true, error: false });
    try {
      const snapshot = await setGeminiProcessingPermission(actorId, next, state.revision);
      if (sequence.current === request) setState({ actorId, value: snapshot.granted, revision: snapshot.revision, busy: false, error: false });
    } catch {
      // Timeout can be ambiguous: require an authoritative reread before a
      // further toggle, rather than showing either success or a false rollback.
      if (sequence.current === request) setState({ actorId, value: null, revision: 0, busy: false, error: true });
    } finally { if (sequence.current === request) inFlight.current = false; }
  };
  if (!actorId) return null;
  const current = state.actorId === actorId ? state : { value: null, busy: true, error: false };
  return <View style={styles.card} testID="settings-gemini-processing-section">
    <SectionHeader title="Google Gemini processing" subtitle="Your sharing permission for this account" />
    <PrivacyToggle title="Allow Google Gemini processing"
      body="Allow Google Gemini to process photos and text you submit for scans and styling, including Elise chat. Turning this off prevents new Gemini requests after the change is saved. Data already sent cannot be recalled."
      value={current.value === true} busy={current.busy} disabled={current.value === null}
      onChange={(next) => { void save(next); }} />
    {current.error ? <>
      <Text accessibilityRole="alert" style={styles.body}>We could not verify your saved permission. Retry before continuing.</Text>
      <SecondaryButton title="Retry permission status" onPress={() => { void refresh(); }} />
    </> : null}
  </View>;
}
const styles = StyleSheet.create({
  card: { padding: SPACING.lg, borderRadius: RADIUS.lg, backgroundColor: LUXURY.colors.cream,
    borderWidth: 1, borderColor: LUXURY.colors.border, gap: SPACING.md },
  body: { color: LUXURY.colors.stone, fontSize: 14, lineHeight: 20 },
});
