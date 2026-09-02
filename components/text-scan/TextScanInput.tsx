import React from 'react';
import {
  View,
  TextInput,
  Text,
  StyleSheet,
  ViewStyle,
  TextStyle,
} from 'react-native';
import { LUXURY, RADIUS, SPACING } from '../../constants/theme';

export interface TextScanInputProps {
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  maxLength?: number;
  minLength?: number;
  disabled?: boolean;
  style?: ViewStyle;
  inputStyle?: TextStyle;
  accessibilityLabel?: string;
  /** Optional slot rendered in the footer, alongside the hint/counter -- the Voice Scan mic affordance uses this. */
  rightAccessory?: React.ReactNode;
  /**
   * Optional handle on the underlying TextInput so a caller can focus it
   * imperatively. Voice Scan uses this to hand the user straight into the
   * keyboard once a transcript lands (or once Voice Scan degrades to manual
   * entry), instead of making them tap the field first.
   */
  inputRef?: React.RefObject<TextInput | null>;
}

/**
 * A large, rounded multiline input for natural-language fashion queries.
 */
export function TextScanInput({
  value,
  onChangeText,
  placeholder = 'Describe what you are looking for...',
  maxLength = 240,
  minLength = 3,
  disabled = false,
  style,
  inputStyle,
  accessibilityLabel = 'TextScan search query',
  rightAccessory,
  inputRef,
}: TextScanInputProps) {
  const isValid = value.trim().length >= minLength;

  return (
    <View
      style={[styles.root, style]}
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
    >
      <TextInput
        ref={inputRef}
        value={value}
        onChangeText={(text) => {
          if (text.length <= maxLength) {
            onChangeText(text);
          }
        }}
        placeholder={placeholder}
        placeholderTextColor={LUXURY.inputs.field.placeholderColor}
        maxLength={maxLength}
        multiline
        numberOfLines={4}
        textAlignVertical="top"
        editable={!disabled}
        style={[styles.input, inputStyle]}
        accessibilityLabel={accessibilityLabel}
        accessibilityHint="Type a fashion description to search"
      />
      <View style={styles.footer}>
        <Text style={styles.hint}>
          {isValid ? 'Ready to scan' : `At least ${minLength} characters`}
        </Text>
        <View style={styles.footerEnd}>
          <Text style={styles.counter}>
            {value.length}/{maxLength}
          </Text>
          {rightAccessory}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    backgroundColor: LUXURY.colors.pearl,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    padding: SPACING.lg,
  },
  input: {
    minHeight: 120,
    fontFamily: LUXURY.typography.body.fontFamily,
    fontSize: 16,
    lineHeight: 24,
    color: LUXURY.colors.ink,
    padding: 0,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: SPACING.md,
  },
  footerEnd: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
  },
  hint: {
    ...LUXURY.typography.caption,
    fontSize: 11,
    color: LUXURY.colors.stone,
  },
  counter: {
    ...LUXURY.typography.caption,
    fontSize: 11,
    color: LUXURY.colors.stone,
  },
});
