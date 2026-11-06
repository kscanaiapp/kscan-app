import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { PrivacyToggle } from '../PrivacyToggle';
import { useScannerMediaPreferences } from '../../hooks/useScannerMediaPreferences';
import { LUXURY, SPACING } from '../../constants/theme';

/**
 * The onboarding step is not accessible after completion. Scanner choices
 * therefore have a permanent Settings home. These device-local switches
 * prevent Scanner capture/photo selection, not OS permission changes or
 * unrelated Photo VTO / Live VTO features.
 */
export function ScannerMediaSettingsSection() {
  const { preferences, ready, busy, error, refresh, setPreference } =
    useScannerMediaPreferences();

  return (
    <View style={styles.section} testID="privacy-scanner-media-choices">
      <Text style={styles.title} accessibilityRole="header">Scanner Access</Text>
      <Text style={styles.description}>
        Your choices on this device. Camera permission is still managed by your phone;
        photos are selected one at a time in the system picker. These controls apply
        to Scanner searches, not other features.
      </Text>
      <View testID="privacy-scanner-camera-setting">
        <PrivacyToggle
          title={`Scanner Camera — ${preferences.camera ? 'ON' : 'OFF'}`}
          body="When off, Scanner cannot open its camera or capture an image. Turning it on does not grant Android or iOS camera permission."
          value={preferences.camera}
          disabled={!ready}
          busy={busy}
          onChange={(value) => { void setPreference('camera', value); }}
        />
      </View>
      <View testID="privacy-scanner-photos-setting">
        <PrivacyToggle
          title={`Scanner Photos — ${preferences.photos ? 'ON' : 'OFF'}`}
          body="When off, Scanner cannot open the photo picker. Turning it on lets you choose individual photos, without granting blanket library access."
          value={preferences.photos}
          disabled={!ready}
          busy={busy}
          onChange={(value) => { void setPreference('photos', value); }}
        />
      </View>
      {error ? (
        <View style={styles.error}>
          <Text accessibilityRole="alert" style={styles.errorText}>{error}</Text>
          <Pressable accessibilityRole="button" testID="privacy-scanner-media-retry" onPress={() => void refresh()}>
            <Text style={styles.retry}>Retry loading choices</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: SPACING.md },
  title: { ...LUXURY.typography.bodyStrong, color: LUXURY.colors.ink },
  description: { ...LUXURY.typography.caption, color: LUXURY.colors.graphite, textTransform: 'none', lineHeight: 19 },
  error: { gap: SPACING.sm },
  errorText: { ...LUXURY.typography.caption, color: LUXURY.colors.plum, textTransform: 'none' },
  retry: { ...LUXURY.typography.bodyStrong, color: LUXURY.colors.plum, textDecorationLine: 'underline' },
});
