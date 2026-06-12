import { useState } from 'react';
import { View, TextInput, Pressable, Text, StyleSheet, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { COLORS, RADIUS, SPACING, TYPOGRAPHY } from '../../constants/theme';

interface StyleChatInputProps {
  onSend: (text: string) => void;
  disabled?: boolean;
}

export function StyleChatInput({ onSend, disabled = false }: StyleChatInputProps) {
  const [text, setText] = useState('');
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const isLandscape = width > height;
  const safeContainerPadding = {
    paddingLeft: Math.max(SPACING.xl, insets.left),
    paddingRight: Math.max(SPACING.xl, insets.right),
  };

  const canSubmit = text.trim().length > 0 && !disabled;

  const handleSend = () => {
    if (!canSubmit) return;
    onSend(text.trim());
    setText('');
  };

  return (
    <View style={[styles.container, safeContainerPadding]}>
      <TextInput
        testID="style-chat-input"
        style={[styles.input, isLandscape ? styles.inputLandscape : null]}
        value={text}
        onChangeText={setText}
        placeholder="Ask your AI stylist…"
        placeholderTextColor={COLORS.textTertiary}
        multiline
        maxLength={1000}
        returnKeyType="send"
        onSubmitEditing={handleSend}
        blurOnSubmit={false}
        editable={!disabled}
        textAlignVertical="top"
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
        accessibilityLabel="Send message"
        accessibilityRole="button"
      >
        <Text style={[styles.sendText, !canSubmit ? styles.sendTextDisabled : null]}>
          SEND
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
    borderTopColor: COLORS.border,
    backgroundColor: COLORS.bgElevated,
    gap: SPACING.sm,
  },
  input: {
    flex: 1,
    flexShrink: 1,
    minWidth: 0,
    minHeight: 44,
    maxHeight: 110,
    borderRadius: RADIUS.sm,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surface,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
    color: COLORS.textPrimary,
    fontSize: 15,
    lineHeight: 22,
  },
  inputLandscape: {
    maxHeight: 84,
  },
  sendBtn: {
    height: 44,
    minWidth: 64,
    flexShrink: 0,
    paddingHorizontal: SPACING.lg,
    borderRadius: RADIUS.sm,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
  },
  sendBtnActive: {
    backgroundColor: COLORS.gold,
    borderColor: COLORS.gold,
  },
  sendBtnInactive: {
    backgroundColor: 'transparent',
    borderColor: COLORS.border,
  },
  sendBtnPressed: {
    backgroundColor: COLORS.goldPressed,
    borderColor: COLORS.goldPressed,
  },
  sendText: {
    ...TYPOGRAPHY.cta,
    fontSize: 12,
    color: COLORS.textInverse,
  },
  sendTextDisabled: {
    color: COLORS.textTertiary,
  },
});
