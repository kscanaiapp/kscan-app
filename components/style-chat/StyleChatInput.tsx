import { useState } from 'react';
import { View, TextInput, Pressable, Text, StyleSheet, useWindowDimensions, Platform } from 'react-native';

const VOICE_UI_ENABLED = false;
const ANDROID_NAV_BAR_BOTTOM_PADDING = 56;

/**
 * FUTURE: Voice input entry point.
 * When microphone permission, privacy disclosures, and backend voice contract
 * are ready, mount a voice input affordance on the left side of the composer,
 * before the text input. Keep disabled until approved.
 */
function VoiceInputPlaceholder() {
  if (!VOICE_UI_ENABLED) return null;
  return null;
}
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LUXURY, RADIUS, SPACING } from '../../constants/theme';
import { ELISE_IDENTITY } from '../../constants/elise';

interface StyleChatInputProps {
  onSend: (text: string) => void;
  stylistDisplayName: string;
  value?: string;
  onChangeText?: (text: string) => void;
  /** Editing remains available unless the session itself is unavailable. */
  inputEditable?: boolean;
  /** Prevents submission without freezing draft editing. */
  sendDisabled?: boolean;
  /** Announces an in-flight send without coupling it to input editability. */
  sendBusy?: boolean;
  /** Opens the Elise attachment menu when the attach control is shown. */
  onAttachPress?: () => void;
  /** When false (default), composer matches the pre-attach layout. */
  showAttachButton?: boolean;
  /**
   * Fired when the user reaches for the composer. The screen uses it to silence
   * Elise; this component does not know about speech and must not.
   */
  onComposerFocus?: () => void;
}

export function StyleChatInput({
  onSend,
  stylistDisplayName,
  value,
  onChangeText,
  inputEditable = true,
  sendDisabled = false,
  sendBusy = false,
  onAttachPress,
  showAttachButton = false,
  onComposerFocus,
}: StyleChatInputProps) {
  const [internalText, setInternalText] = useState('');
  const isControlled = typeof value === 'string';
  const text = isControlled ? value : internalText;
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const isLandscape = width > height;
  const composerBottomPadding =
    Platform.OS === 'android'
      ? Math.max(insets.bottom + SPACING.md, ANDROID_NAV_BAR_BOTTOM_PADDING)
      : (insets.bottom > 0 ? insets.bottom : 12) + 8;
  const safeContainerPadding = {
    paddingLeft: Math.max(SPACING.xl, insets.left),
    paddingRight: Math.max(SPACING.xl, insets.right),
    paddingBottom: composerBottomPadding,
  };

  const canSubmit = text.trim().length > 0 && inputEditable && !sendDisabled;
  const attachEnabled = showAttachButton && typeof onAttachPress === 'function';

  const handleTextChange = (next: string) => {
    if (!isControlled) setInternalText(next);
    onChangeText?.(next);
  };

  const handleSend = () => {
    if (!canSubmit) return;
    onSend(text.trim());
    if (!isControlled) setInternalText('');
  };

  return (
    <View style={[styles.container, safeContainerPadding]}>
      {/* Future voice affordance — invisible while gated. */}
      <VoiceInputPlaceholder />
      {attachEnabled ? (
        <Pressable
          testID="stylechat-attach-button"
          style={({ pressed }) => [
            styles.attachBtn,
            !inputEditable ? styles.attachBtnDisabled : null,
            pressed && inputEditable ? styles.attachBtnPressed : null,
          ]}
          onPress={onAttachPress}
          disabled={!inputEditable}
          accessibilityRole="button"
          accessibilityLabel={ELISE_IDENTITY.attachAccessibilityLabel}
          accessibilityHint="Opens options to add a photo, scan, Closet item, or Dressing Room piece"
          accessibilityState={{ disabled: !inputEditable }}
        >
          <Text style={styles.attachText}>＋</Text>
        </Pressable>
      ) : null}
      <TextInput
        testID="style-chat-input"
        style={[styles.input, isLandscape ? styles.inputLandscape : null]}
        value={text}
        onChangeText={handleTextChange}
        onFocus={onComposerFocus}
        placeholder={`Ask ${stylistDisplayName} about this look, your Closet, or what to wear next`}
        placeholderTextColor={LUXURY.colors.stone}
        selectionColor={LUXURY.colors.gold}
        cursorColor={LUXURY.colors.gold}
        multiline
        maxLength={1000}
        returnKeyType="send"
        onSubmitEditing={handleSend}
        blurOnSubmit={false}
        editable={inputEditable}
        textAlignVertical="top"
        accessibilityLabel="Message composer"
        accessibilityHint={`Type a styling question for ${stylistDisplayName}`}
      />
      <Pressable
        testID="style-chat-send-button"
        style={({ pressed }) => [
          styles.sendBtn,
          canSubmit ? styles.sendBtnActive : styles.sendBtnInactive,
          pressed && canSubmit ? styles.sendBtnPressed : null,
        ]}
        onPress={handleSend}
        disabled={!canSubmit}
        accessibilityLabel={`Send message to ${stylistDisplayName}`}
        accessibilityHint={`Send your styling question to ${stylistDisplayName}`}
        accessibilityRole="button"
        accessibilityState={{ disabled: !canSubmit, busy: sendBusy }}
      >
        <Text style={[styles.sendText, !canSubmit ? styles.sendTextDisabled : null]}>
          Send
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    minWidth: 0,
    paddingHorizontal: SPACING.xl,
    paddingVertical: SPACING.md,
    borderTopWidth: 1,
    borderTopColor: LUXURY.colors.hairline,
    backgroundColor: LUXURY.colors.ivory,
    gap: SPACING.sm,
  },
  attachBtn: {
    width: 44,
    height: 44,
    minWidth: 44,
    minHeight: 44,
    flexShrink: 0,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: LUXURY.colors.plum,
    backgroundColor: LUXURY.colors.pearl,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 2,
  },
  attachBtnPressed: {
    backgroundColor: LUXURY.colors.champagne,
    borderColor: LUXURY.colors.goldBrushed,
  },
  attachBtnDisabled: {
    opacity: 0.45,
  },
  attachText: {
    ...LUXURY.typography.bodyStrong,
    color: LUXURY.colors.plum,
    fontSize: 22,
    lineHeight: 24,
  },
  input: {
    flex: 1,
    flexShrink: 1,
    minWidth: 0,
    minHeight: 48,
    maxHeight: 110,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
    paddingTop: SPACING.sm + 2,
    color: LUXURY.colors.ink,
    fontSize: 15,
    lineHeight: 22,
  },
  inputLandscape: {
    maxHeight: 84,
  },
  sendBtn: {
    height: 48,
    minWidth: 72,
    flexShrink: 0,
    paddingHorizontal: SPACING.lg,
    borderRadius: RADIUS.pill,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
  },
  sendBtnActive: {
    backgroundColor: LUXURY.colors.plum,
    borderColor: LUXURY.colors.plumSoft,
    ...LUXURY.cards.product.shadow,
  },
  sendBtnInactive: {
    backgroundColor: LUXURY.colors.plumMuted,
    borderColor: LUXURY.colors.border,
  },
  sendBtnPressed: {
    backgroundColor: LUXURY.colors.plumCore,
  },
  sendText: {
    ...LUXURY.typography.cta,
    fontSize: 12,
    color: LUXURY.colors.inverse,
  },
  sendTextDisabled: {
    color: LUXURY.colors.stone,
  },
});
