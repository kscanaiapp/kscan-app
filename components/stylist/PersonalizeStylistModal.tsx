import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  Modal,
  TextInput,
  StyleSheet,
  useWindowDimensions,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LUXURY, RADIUS, SPACING } from '../../constants/theme';
import {
  DEFAULT_STYLIST_IDENTITY,
  isPersistableAvatarId,
  STYLIST_ABSTRACT_PRESETS,
  STYLIST_NAME_MAX_LENGTH,
  STYLIST_NAME_MIN_LENGTH,
  STYLIST_PORTRAIT_PRESETS,
  type StylistIdentity,
} from '../../constants/stylistIdentity';
import { StylistAvatar } from './StylistAvatar';

interface PersonalizeStylistModalProps {
  visible: boolean;
  identity: StylistIdentity;
  onClose: () => void;
  onSave: (identity: Partial<StylistIdentity>) => Promise<boolean> | boolean;
  onRestoreDefault: () => Promise<boolean> | boolean;
  isSaving?: boolean;
  error?: string | null;
}

export function PersonalizeStylistModal({
  visible,
  identity,
  onClose,
  onSave,
  onRestoreDefault,
  isSaving = false,
  error = null,
}: PersonalizeStylistModalProps) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [draftName, setDraftName] = useState(identity.displayName);
  const [draftAvatarId, setDraftAvatarId] = useState(identity.avatarId);
  const [nameError, setNameError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submissionInFlightRef = useRef(false);
  const saving = isSaving || isSubmitting;

  useEffect(() => {
    if (visible) {
      setDraftName(identity.displayName);
      setDraftAvatarId(identity.avatarId);
      setNameError(null);
      setIsSubmitting(false);
      submissionInFlightRef.current = false;
    }
  }, [visible, identity.displayName, identity.avatarId]);

  const validateName = useCallback((value: string): string | null => {
    const trimmed = value.trim().replace(/[\x00-\x1F\x7F]/g, '');
    if (trimmed.length < STYLIST_NAME_MIN_LENGTH) {
      return `Name must be at least ${STYLIST_NAME_MIN_LENGTH} characters.`;
    }
    if (trimmed.length > STYLIST_NAME_MAX_LENGTH) {
      return `Name must be ${STYLIST_NAME_MAX_LENGTH} characters or fewer.`;
    }
    return null;
  }, []);

  const handleNameChange = useCallback((text: string) => {
    // Prevent control characters and enforce max length at input level.
    const cleaned = text.replace(/[\x00-\x1F\x7F]/g, '').slice(0, STYLIST_NAME_MAX_LENGTH);
    setDraftName(cleaned);
    setNameError(validateName(cleaned));
  }, [validateName]);

  const canSave = useMemo(() => {
    const trimmed = draftName.trim().replace(/[\x00-\x1F\x7F]/g, '');
    if (trimmed.length < STYLIST_NAME_MIN_LENGTH || trimmed.length > STYLIST_NAME_MAX_LENGTH) {
      return false;
    }
    if (!isPersistableAvatarId(draftAvatarId)) return false;
    return (
      trimmed !== identity.displayName || draftAvatarId !== identity.avatarId
    );
  }, [draftName, draftAvatarId, identity]);

  const handleSave = useCallback(async () => {
    if (submissionInFlightRef.current) return;
    const trimmed = draftName.trim().replace(/[\x00-\x1F\x7F]/g, '');
    const validation = validateName(trimmed);
    if (validation) {
      setNameError(validation);
      return;
    }
    submissionInFlightRef.current = true;
    setIsSubmitting(true);
    try {
      await onSave({ displayName: trimmed, avatarId: draftAvatarId });
    } finally {
      submissionInFlightRef.current = false;
      setIsSubmitting(false);
    }
  }, [draftName, draftAvatarId, validateName, onSave]);

  const handleRestore = useCallback(async () => {
    if (submissionInFlightRef.current) return;
    setDraftName(DEFAULT_STYLIST_IDENTITY.displayName);
    setDraftAvatarId(DEFAULT_STYLIST_IDENTITY.avatarId);
    setNameError(null);
    submissionInFlightRef.current = true;
    setIsSubmitting(true);
    try {
      await onRestoreDefault();
    } finally {
      submissionInFlightRef.current = false;
      setIsSubmitting(false);
    }
  }, [onRestoreDefault]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={() => {
        if (!saving) onClose();
      }}
      accessibilityViewIsModal
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.flex}
      >
        <View style={styles.backdrop}>
          <View
            style={[
              styles.sheet,
              {
                paddingBottom: Math.max(SPACING.xl, insets.bottom + SPACING.md),
                maxWidth: Math.min(width - SPACING.xl * 2, 420),
              },
            ]}
          >
            <View style={styles.handle} />

            <ScrollView
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={styles.scrollContent}
            >
              <Text style={styles.title} accessibilityRole="header">
                PERSONALIZE YOUR STYLIST
              </Text>
              <Text style={styles.subtitle}>
                Choose the name and avatar you see across K Scan.
              </Text>

              <View style={styles.nameSection}>
                <Text style={styles.label}>DISPLAY NAME</Text>
                <TextInput
                  value={draftName}
                  onChangeText={handleNameChange}
                  placeholder={DEFAULT_STYLIST_IDENTITY.displayName}
                  maxLength={STYLIST_NAME_MAX_LENGTH}
                  editable={!saving}
                  style={styles.input}
                  placeholderTextColor={LUXURY.colors.stone}
                  accessibilityLabel="Stylist display name"
                  accessibilityHint="Enter a name between 2 and 24 characters"
                  autoCorrect={false}
                  autoCapitalize="words"
                  returnKeyType="done"
                />
                {nameError ? <Text style={styles.fieldError}>{nameError}</Text> : null}
              </View>

              <View style={styles.avatarSection}>
                <Text style={styles.label} accessibilityRole="header">ABSTRACT</Text>
                <View style={styles.avatarGrid}>
                  {STYLIST_ABSTRACT_PRESETS.map((preset) => {
                    const selected = preset.id === draftAvatarId;
                    return (
                      <Pressable
                        key={preset.id}
                        testID={`personalize-avatar-${preset.id}`}
                        onPress={() => setDraftAvatarId(preset.id)}
                        disabled={saving}
                        style={[styles.avatarButton, selected && styles.avatarButtonSelected]}
                        accessibilityRole="radio"
                        accessibilityState={{ disabled: saving, selected }}
                        accessibilityLabel={preset.accessibilityLabel}
                      >
                        <StylistAvatar avatarId={preset.id} size={56} />
                      </Pressable>
                    );
                  })}
                </View>
              </View>

              <View style={styles.peopleSection}>
                <Text style={styles.label} accessibilityRole="header">STYLIST</Text>
                <Text style={styles.peopleHelper}>
                  Choose your personal stylist avatar.
                </Text>
                <View style={styles.avatarGrid}>
                  {STYLIST_PORTRAIT_PRESETS.map((preset) => {
                    const selected = preset.id === draftAvatarId;
                    return (
                      <Pressable
                        key={preset.id}
                        testID={`personalize-avatar-${preset.id}`}
                        onPress={() => setDraftAvatarId(preset.id)}
                        disabled={saving}
                        style={[styles.avatarButton, selected && styles.avatarButtonSelected]}
                        accessibilityRole="radio"
                        accessibilityState={{ disabled: saving, selected }}
                        accessibilityLabel={preset.accessibilityLabel}
                      >
                        <StylistAvatar avatarId={preset.id} size={56} />
                      </Pressable>
                    );
                  })}
                </View>
              </View>

              {error ? <Text style={styles.saveError}>{error}</Text> : null}

              <View style={styles.actions}>
                <Pressable
                  onPress={handleSave}
                  disabled={!canSave || saving}
                  style={({ pressed }) => [
                    styles.saveButton,
                    (!canSave || saving) && styles.saveButtonDisabled,
                    pressed && canSave && !saving && styles.saveButtonPressed,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel="Save stylist identity"
                  accessibilityState={{ disabled: !canSave || saving, busy: saving }}
                >
                  <Text style={styles.saveButtonText}>
                    {saving ? 'SAVING…' : 'SAVE'}
                  </Text>
                </Pressable>

                <Pressable
                  onPress={handleRestore}
                  disabled={saving}
                  style={({ pressed }) => [styles.textButton, pressed && styles.textButtonPressed]}
                  accessibilityRole="button"
                  accessibilityLabel="Restore default stylist identity"
                >
                  <Text style={styles.textButtonLabel}>RESTORE DEFAULT</Text>
                </Pressable>

                <Pressable
                  onPress={onClose}
                  disabled={saving}
                  style={({ pressed }) => [styles.textButton, pressed && styles.textButtonPressed]}
                  accessibilityRole="button"
                  accessibilityLabel="Cancel personalizing stylist"
                >
                  <Text style={styles.textButtonLabel}>CANCEL</Text>
                </Pressable>
              </View>
            </ScrollView>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(9, 7, 13, 0.60)',
    justifyContent: 'flex-end',
    alignItems: 'center',
  },
  sheet: {
    width: '100%',
    backgroundColor: LUXURY.colors.cream,
    borderTopLeftRadius: RADIUS.xl,
    borderTopRightRadius: RADIUS.xl,
    paddingTop: SPACING.md,
    paddingHorizontal: SPACING.xl,
    maxHeight: '92%',
    ...LUXURY.cards?.product?.shadow,
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: LUXURY.colors.border,
    alignSelf: 'center',
    marginBottom: SPACING.md,
  },
  scrollContent: {
    paddingBottom: SPACING.lg,
  },
  title: {
    ...LUXURY.typography.sectionLabel,
    fontSize: 14,
    color: LUXURY.colors.ink,
    textAlign: 'center',
    marginBottom: SPACING.sm,
  },
  subtitle: {
    ...LUXURY.typography.body,
    fontSize: 13,
    lineHeight: 20,
    color: LUXURY.colors.graphite,
    textAlign: 'center',
    marginBottom: SPACING.xl,
  },
  nameSection: {
    marginBottom: SPACING.xl,
  },
  label: {
    ...LUXURY.typography.caption,
    fontSize: 10,
    letterSpacing: 1.6,
    color: LUXURY.colors.stone,
    marginBottom: SPACING.sm,
  },
  input: {
    ...LUXURY.typography.body,
    backgroundColor: LUXURY.colors.pearl,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    borderRadius: RADIUS.lg,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.md,
    color: LUXURY.colors.ink,
  },
  fieldError: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.error,
    marginTop: SPACING.xs,
  },
  avatarSection: {
    marginBottom: SPACING.xl,
  },
  avatarGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.md,
  },
  avatarButton: {
    borderRadius: 999,
    padding: SPACING.xs,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  avatarButtonSelected: {
    borderColor: LUXURY.colors.plum,
    backgroundColor: 'rgba(82, 16, 62, 0.06)',
  },
  avatarButtonDisabled: {
    opacity: 0.5,
  },
  peopleSection: {
    marginBottom: SPACING.xl,
  },
  peopleHelper: {
    ...LUXURY.typography.caption,
    fontSize: 12,
    lineHeight: 18,
    color: LUXURY.colors.stone,
    marginBottom: SPACING.md,
  },
  saveError: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.error,
    textAlign: 'center',
    marginBottom: SPACING.md,
  },
  actions: {
    gap: SPACING.md,
  },
  saveButton: {
    backgroundColor: LUXURY.colors.plum,
    borderRadius: RADIUS.pill,
    paddingVertical: SPACING.md,
    alignItems: 'center',
  },
  saveButtonDisabled: {
    backgroundColor: LUXURY.colors.plumMuted,
  },
  saveButtonPressed: {
    backgroundColor: LUXURY.colors.plumCore,
  },
  saveButtonText: {
    ...LUXURY.typography.cta,
    color: LUXURY.colors.inverse,
  },
  textButton: {
    alignItems: 'center',
    paddingVertical: SPACING.sm,
    minHeight: 44,
    justifyContent: 'center',
  },
  textButtonPressed: {
    opacity: 0.7,
  },
  textButtonLabel: {
    ...LUXURY.typography.caption,
    fontWeight: '600',
    color: LUXURY.colors.plum,
    letterSpacing: 1.4,
  },
});
