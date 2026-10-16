import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { createHomeEliseWelcome, type HomeWelcomeRecord } from './homeEliseWelcome';
import { loadSpeechConsent } from './avatars/speechConsent';
import { resolveOnboardingCompletion } from './onboardingCompletion';
import {
  createStyleChatSession, getLatestStyleChatSession,
  getStyleChatSession, listStyleChatMessages,
} from './style-chat/styleChatRepository';
import { ensureSessionGreeting } from './style-chat/styleChatGreeting';
import { speakAvatarMessage, stopAvatarSpeechPlayback } from './avatarSpeech';
import { getAvatarSpeechState, subscribeToAvatarSpeech } from '../stores/avatarSpeechStore';

async function key(actorId: string) {
  const hash = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, actorId);
  return `@kscan/home-elise-welcome/v1/${hash}`;
}

export function parseHomeWelcomeRecord(value: string | null): HomeWelcomeRecord {
  if (value === null) return { version: 1 };
  const record = JSON.parse(value) as HomeWelcomeRecord;
  if (!record || record.version !== 1 ||
    (record.sessionId !== undefined &&
      (typeof record.sessionId !== 'string' || !/^[a-f0-9-]{36}$/i.test(record.sessionId))) ||
    [record.attemptDay, record.playedDay].some((day) =>
      day !== undefined && (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)))) {
    throw new Error('Invalid Home welcome record');
  }
  return {
    version: 1,
    ...(record.sessionId ? { sessionId: record.sessionId } : {}),
    ...(record.attemptDay ? { attemptDay: record.attemptDay } : {}),
    ...(record.playedDay ? { playedDay: record.playedDay } : {}),
  };
}

// One process authority. No additional provider client, player or speech store.
export const startHomeEliseWelcome = createHomeEliseWelcome({
  read: async (actorId) => parseHomeWelcomeRecord(await AsyncStorage.getItem(await key(actorId))),
  write: async (actorId, record) => AsyncStorage.setItem(await key(actorId), JSON.stringify(record)),
  hasConsent: loadSpeechConsent,
  onboardingComplete: resolveOnboardingCompletion,
  latestSession: getLatestStyleChatSession,
  ownedSession: getStyleChatSession,
  createSession: (actorId) => createStyleChatSession({ mode: 'general' }, actorId),
  messages: listStyleChatMessages,
  ensureGreeting: ensureSessionGreeting,
  observeSpeech: (listener) => subscribeToAvatarSpeech(() => listener(getAvatarSpeechState())),
  speak: speakAvatarMessage,
  stop: stopAvatarSpeechPlayback,
  now: () => new Date(),
});
