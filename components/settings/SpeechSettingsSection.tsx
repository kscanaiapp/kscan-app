import React, { useEffect, useRef, useState } from 'react';
import { Alert, Linking, StyleSheet, Text, View } from 'react-native';
import { LUXURY, RADIUS, SPACING } from '../../constants/theme';
import { STYLIST_SPEECH_ENABLED } from '../../constants/featureFlags';
import { PrivacyToggle } from '../PrivacyToggle';
import { SectionHeader, SecondaryButton } from '../luxury';
import {
  grantSpeechConsent, loadSpeechConsent, withdrawSpeechConsent,
  SPEECH_CONSENT_COPY, SPEECH_DISCLOSURE_APPROVED,
} from '../../services/avatars/speechConsent';
import { stopAvatarSpeechPlayback } from '../../services/avatarSpeech';

export function SpeechSettingsSection({ actorId }: { actorId: string | null }) {
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const epoch = useRef(0);
  useEffect(() => {
    const current = ++epoch.current;
    setEnabled(false); setBusy(true); setError(null);
    if (actorId) void loadSpeechConsent(actorId).then((value) => {
      if (epoch.current === current) { setEnabled(value); setBusy(false); }
    });
    else setBusy(false);
    return () => { epoch.current++; };
  }, [actorId]);

  if (!STYLIST_SPEECH_ENABLED || !SPEECH_DISCLOSURE_APPROVED || !actorId) return null;
  const save = async (next: boolean) => {
    const current = epoch.current;
    setBusy(true); setError(null);
    if (!next) {
      // Withdrawal closes the transmission gate synchronously; cancel pending
      // generation/playback so revocation also stops current device audio.
      const removed = withdrawSpeechConsent(actorId);
      setEnabled(false);
      await stopAvatarSpeechPlayback().catch(() => undefined);
      const ok = await removed;
      if (epoch.current === current) { setBusy(false); if (!ok) setError(SPEECH_CONSENT_COPY.withdrawalFailure); }
      return;
    }
    const ok = await grantSpeechConsent(actorId);
    if (epoch.current === current) { setBusy(false); setEnabled(ok); if (!ok) setError(SPEECH_CONSENT_COPY.failure); }
  };
  const openPolicy = (url: string) => {
    void Linking.openURL(url).catch(() => setError('We could not open the Privacy Policy. Please try again.'));
  };
  const change = (next: boolean) => {
    if (busy) return;
    if (!next) { void save(false); return; }
    const current = epoch.current;
    Alert.alert(SPEECH_CONSENT_COPY.title,
      [SPEECH_CONSENT_COPY.intro, ...SPEECH_CONSENT_COPY.points].join('\n\n'), [
        { text: SPEECH_CONSENT_COPY.cancel, style: 'cancel' },
        { text: SPEECH_CONSENT_COPY.accept, onPress: () => { if (epoch.current === current) void save(true); } },
      ]);
  };
  return <View style={styles.card} testID="settings-speech-consent-section">
    <SectionHeader title="Elise Speech" subtitle="Your choice for this account on this device" />
    <PrivacyToggle title="Spoken replies on this device" body="Allow ElevenLabs to generate Elise’s voice from reply text."
      value={enabled} busy={busy} onChange={change} />
    {error ? <Text accessibilityRole="alert" style={styles.body}>{error}</Text> : null}
    {error === SPEECH_CONSENT_COPY.withdrawalFailure ?
      <SecondaryButton title="Retry saving spoken replies off" disabled={busy} onPress={() => void save(false)} /> : null}
    <SecondaryButton title="K Scan AI Privacy Policy" onPress={() => openPolicy(SPEECH_CONSENT_COPY.privacyUrl)} />
    <SecondaryButton title="ElevenLabs Privacy Policy" onPress={() => openPolicy(SPEECH_CONSENT_COPY.providerPrivacyUrl)} />
  </View>;
}
const styles = StyleSheet.create({
  card: { padding: SPACING.lg, borderRadius: RADIUS.lg, backgroundColor: LUXURY.colors.cream,
    borderWidth: 1, borderColor: LUXURY.colors.border, gap: SPACING.md },
  body: { color: LUXURY.colors.stone, fontSize: 14, lineHeight: 20 },
});
