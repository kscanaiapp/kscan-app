import type { StyleChatMessage, StyleChatSession } from './style-chat/types';
import type { AvatarSpeechState } from '../stores/avatarSpeechStore';
import type { SpeakAvatarMessagePayload } from './avatarSpeech';

/** Device-local, actor-partitioned policy; never a speech authorization. */
export interface HomeWelcomeRecord {
  version: 1;
  sessionId?: string;
  attemptDay?: string;
  playedDay?: string;
}

export interface HomeWelcomeBinding {
  actorId: string;
  sessionId: string;
  messageId: string;
  avatarId: string;
}

interface Dependencies {
  read: (actorId: string) => Promise<HomeWelcomeRecord>;
  write: (actorId: string, record: HomeWelcomeRecord) => Promise<void>;
  hasConsent: (actorId: string) => Promise<boolean>;
  onboardingComplete: (actorId: string) => Promise<boolean>;
  latestSession: () => Promise<StyleChatSession | null>;
  ownedSession: (sessionId: string, actorId: string) => Promise<StyleChatSession | null>;
  createSession: (actorId: string) => Promise<StyleChatSession>;
  messages: (sessionId: string, actorId: string) => Promise<StyleChatMessage[]>;
  ensureGreeting: (actorId: string, sessionId: string, text: string) => Promise<{
    message: StyleChatMessage | null;
    inserted: boolean;
  }>;
  observeSpeech: (listener: (state: AvatarSpeechState) => void) => () => void;
  speak: (payload: SpeakAvatarMessagePayload) => Promise<void>;
  stop: (binding: HomeWelcomeBinding) => Promise<void>;
  now: () => Date;
}

interface WelcomeInput {
  actorId: string;
  avatarId: string;
  text: string;
  eligible: boolean;
  /** Includes the captured actor epoch, focus, foreground and live gates. */
  isCurrent: () => boolean;
  onBinding: (binding: HomeWelcomeBinding) => void;
}

function isMatchingGreeting(message: StyleChatMessage, sessionId: string, text: string): boolean {
  return Boolean(message.id) && message.sessionId === sessionId && message.sender === 'assistant' &&
    message.content === text && message.uiBlocks.some((block) => block.type === 'greeting');
}

/**
 * Home has an explicit app-open policy distinct from Chat history reopening:
 * one automatic attempt per actor/device/UTC-day, and no re-arm in this process.
 * A durable attempt precedes paid dispatch; only confirmed native playback
 * writes playedDay. Neither marker can substitute for server ownership/consent.
 * A settled text-only launch (including voice off or consent off) also retires
 * this process's welcome. Opting in later requires a cold app restart for an
 * automatic welcome; foregrounding/remounting never replays the old greeting.
 * Cold restart still obeys the durable daily attempt when one already exists.
 */
export function createHomeEliseWelcome(deps: Dependencies) {
  // Deliberately survives logout/account cycling. Actor epochs guard async work;
  // resetting this set on A -> B -> A would re-arm the first launch of A.
  const attemptedActors = new Set<string>();

  return function start(input: WelcomeInput) {
    let cancelled = false;
    let binding: HomeWelcomeBinding | null = null;
    let unobserve: (() => void) | undefined;
    const current = () => !cancelled && input.isCurrent();
    const cancel = () => {
      cancelled = true;
      unobserve?.();
      unobserve = undefined;
      if (binding) void deps.stop(binding);
    };

    const done = (async () => {
      if (!input.actorId || !current() || attemptedActors.has(input.actorId)) return;
      attemptedActors.add(input.actorId);
      // Text still renders for all of these cases. No session or provider work.
      if (!input.eligible) return;
      try {
        const [record, consent, onboarded] = await Promise.all([
          deps.read(input.actorId),
          deps.hasConsent(input.actorId),
          deps.onboardingComplete(input.actorId),
        ]);
        if (!current() || !consent || !onboarded) return;
        const day = deps.now().toISOString().slice(0, 10);
        if (record.attemptDay === day || record.playedDay === day) return;

        // Keep an owned envelope pointer, not a transcript. Revalidate it on the
        // server: deletes on another device and account changes must fail closed.
        let session = record.sessionId
          ? await deps.ownedSession(record.sessionId, input.actorId)
          : null;
        if (!current()) return;
        if (!session) session = await deps.latestSession();
        if (!current()) return;
        let messages = session ? await deps.messages(session.id, input.actorId) : [];
        if (!current()) return;
        let message = session
          ? messages.find((item) => isMatchingGreeting(item, session!.id, input.text))
          : undefined;

        // Never rewrite old chat/name history or seed a nonempty legacy chat.
        // The saved pointer reuses this envelope on later days/launches.
        if (!message && (!session || messages.length > 0)) {
          session = await deps.createSession(input.actorId);
          if (!current()) return;
          messages = [];
        }
        if (!session) return;
        if (!message) {
          const result = await deps.ensureGreeting(input.actorId, session.id, input.text);
          if (!current()) return;
          // A concurrent insert loser cannot claim a fresh automatic utterance.
          if (!result.inserted || !result.message) return;
          message = result.message;
        }
        if (!isMatchingGreeting(message, session.id, input.text)) return;
        const attempt: HomeWelcomeRecord = {
          ...record, version: 1, sessionId: session.id, attemptDay: day,
        };
        // Storage failure aborts before Speech. Never retry automatically today.
        await deps.write(input.actorId, attempt);
        if (!current()) return;

        binding = {
          actorId: input.actorId, sessionId: session.id,
          messageId: message.id, avatarId: input.avatarId,
        };
        input.onBinding(binding);
        const ownedBinding = binding;
        unobserve = deps.observeSpeech((speech) => {
          if (!current() || speech.phase !== 'playing' ||
            speech.actorId !== ownedBinding.actorId ||
            speech.sessionId !== ownedBinding.sessionId ||
            speech.messageId !== ownedBinding.messageId ||
            speech.avatarId !== ownedBinding.avatarId ||
            speech.stylistId !== ownedBinding.avatarId) return;
          unobserve?.();
          unobserve = undefined;
          // The durable attempt remains if this best-effort success write fails.
          void deps.write(input.actorId, { ...attempt, playedDay: day }).catch(() => {});
        });
        if (!current()) { cancel(); return; }
        await deps.speak({ ...binding, stylistId: input.avatarId, source: 'greeting' });
      } catch {
        // Welcome never blocks Home or turns a provider/storage failure into a
        // foreground/remount retry. The visible canonical text remains usable.
        unobserve?.();
        unobserve = undefined;
      }
    })();
    return { done, cancel };
  };
}
