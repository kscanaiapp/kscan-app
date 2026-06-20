import React, { useEffect, useCallback } from 'react';
import { View, StyleSheet, BackHandler } from 'react-native';
import { useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useCameraPermissions } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';

import { useAuthSession } from '../../contexts/AuthSessionContext';
import { PermissionsStepV1 } from '../../components/account-home/PermissionsStepV1';
import { usePermissionPreferences } from '../../hooks/usePermissionPreferences';
import { markOnboardingComplete } from '../../services/onboardingCompletion';
import { LUXURY, SPACING } from '../../constants/theme';
import type { PermissionKey } from '../../hooks/usePermissionPreferences';

export default function OnboardingPermissionsScreen() {
  const router = useRouter();
  const { user } = useAuthSession();
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();

  const {
    preferences,
    togglePreference,
    setPreference,
    isSaving,
    savePreferences,
  } = usePermissionPreferences();

  // Check existing camera permission on mount and update UI
  useEffect(() => {
    if (cameraPermission?.granted) {
      setPreference('camera', true);
    }
  }, [cameraPermission, setPreference]);

  // Android hardware back: prevent returning to auth/onboarding
  useEffect(() => {
    const backAction = () => true;
    const subscription = BackHandler.addEventListener('hardwareBackPress', backAction);
    return () => subscription.remove();
  }, []);

  const handleCameraAllow = useCallback(async () => {
    if (cameraPermission?.granted) {
      togglePreference('camera');
      return;
    }
    try {
      const result = await requestCameraPermission();
      if (result.granted) {
        setPreference('camera', true);
      }
    } catch {
      // Non-fatal: user may have denied or device lacks camera
    }
  }, [cameraPermission, requestCameraPermission, togglePreference, setPreference]);

  const handlePhotosAllow = useCallback(async () => {
    if (preferences.photos) {
      togglePreference('photos');
      return;
    }
    try {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status === 'granted') {
        setPreference('photos', true);
      }
    } catch {
      // Non-fatal: device may not support media library
    }
  }, [preferences.photos, togglePreference, setPreference]);

  const handleToggle = useCallback(
    (key: PermissionKey) => {
      if (key === 'camera') {
        void handleCameraAllow();
        return;
      }
      if (key === 'photos') {
        void handlePhotosAllow();
        return;
      }
      togglePreference(key);
    },
    [handleCameraAllow, handlePhotosAllow, togglePreference]
  );

  const handleContinueToHome = useCallback(async () => {
    await savePreferences();
    await markOnboardingComplete(user?.id);
    router.replace('/');
  }, [savePreferences, user, router]);

  const handleNotNow = useCallback(async () => {
    await markOnboardingComplete(user?.id);
    router.replace('/');
  }, [user, router]);

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="dark" />
      <View style={styles.content}>
        <PermissionsStepV1
          preferences={preferences}
          togglePreference={handleToggle}
          isSaving={isSaving}
          onContinueToHome={handleContinueToHome}
          onNotNow={handleNotNow}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: LUXURY.colors.ivory,
  },
  content: {
    flex: 1,
    paddingHorizontal: SPACING.lg,
    paddingTop: SPACING.md,
  },
});
