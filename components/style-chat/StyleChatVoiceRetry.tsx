import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { LUXURY, RADIUS, SPACING } from '../../constants/theme';
import { STYLE_CHAT_COPY } from '../../constants/styleChat';
import { useAuthSession } from '../../contexts/AuthSessionContext';
import { useStylistIdentity } from '../../hooks/useStylistIdentity';
import { useAvatarSpeechSelection } from '../../stores/avatarSpeechStore';
import { speakAvatarMessage } from '../../services/avatarSpeech';
import {
  isVoiceRetryInFlight,
  nextVoiceRetryFailedState,
  ownsAvatarSpeechScope,
} from '../../services/avatars/voiceRetryPresentation';

interface StyleChatVoiceRetryProps {
  sessionId: string;
  messageId: string;
}

/**
 * Per-message recovery for a failed spoken reply. The written reply is already
 * on screen and is never replaced by this control; voice is the enhancement
 * that failed. Rendering is scoped to the exact actor, session, message, and
 * avatar that failed, so a stale error from another conversation, another
 * account, or a previous avatar can never appear on this message.
 */
export function StyleChatVoiceRetry({ sessionId, messageId }: StyleChatVoiceRetryProps) {
  const { user } = useAuthSession();
  const { identity } = useStylistIdentity();
  const actorId = user?.id ?? null;
  const [failed, setFailed] = useState(false);

  // Both subscriptions read a primitive, so an assistant reply on screen does
  // not re-render while another message's playback position is advancing.
  const phase = useAvatarSpeechSelection((speech) => speech.phase);
  const ownsSpeechState = useAvatarSpeechSelection((speech) =>
    ownsAvatarSpeechScope(speech, {
      actorId,
      sessionId,
      messageId,
      avatarId: identity.avatarId,
    }),
  );

  useEffect(() => {
    setFailed((previous) => nextVoiceRetryFailedState(previous, { ownsSpeechState, phase }));
  }, [ownsSpeechState, phase]);

  if (!failed || !actorId) return null;

  const retryInFlight = isVoiceRetryInFlight({ ownsSpeechState, phase });

  return (
    <View style={styles.row} testID={`style-chat-voice-retry-${messageId}`}>
      <Text style={styles.notice} maxFontSizeMultiplier={1.3}>
        {STYLE_CHAT_COPY.voiceFailedNotice}
      </Text>
      <Pressable
        testID={`style-chat-voice-retry-button-${messageId}`}
        onPress={() => {
          // Reuses the one authenticated speech path. The Edge Function keeps
          // ownership of message lookup, authorization, voice, and spoken text;
          // the client sends references only.
          void speakAvatarMessage({
            actorId,
            sessionId,
            messageId,
            stylistId: identity.avatarId,
            avatarId: identity.avatarId,
            source: 'message',
            trigger: 'retry',
          });
        }}
        disabled={retryInFlight}
        accessibilityRole="button"
        accessibilityLabel="Play this response again"
        accessibilityHint="Requests the spoken version of this reply again"
        accessibilityState={{ disabled: retryInFlight }}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        style={({ pressed }) => [
          styles.button,
          pressed && !retryInFlight ? styles.buttonPressed : null,
          retryInFlight ? styles.buttonDisabled : null,
        ]}
      >
        <Text style={styles.buttonText} maxFontSizeMultiplier={1.2}>
          {STYLE_CHAT_COPY.voiceRetryLabel}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: SPACING.sm,
    marginTop: SPACING.sm,
  },
  notice: {
    ...LUXURY.typography.caption,
    fontSize: 11,
    color: LUXURY.colors.graphite,
  },
  button: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: SPACING.sm,
    borderRadius: RADIUS.sm,
  },
  buttonPressed: {
    opacity: 0.72,
  },
  buttonDisabled: {
    opacity: 0.38,
  },
  buttonText: {
    ...LUXURY.typography.caption,
    fontSize: 11,
    letterSpacing: 1.2,
    color: LUXURY.colors.plum,
  },
});
