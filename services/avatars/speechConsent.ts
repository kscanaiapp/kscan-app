import { getActorContext } from '../actorContext';
import {
  hasThirdPartyAiConsentNow, loadThirdPartyAiConsent,
  recordThirdPartyAiConsent, withdrawThirdPartyAiConsent,
} from '../thirdPartyAiConsent';

export const SPEECH_CONSENT_VERSION = 'elise-speech-third-party-v1';
// Owner approved this exact version/copy on 2026-10-11. Copy changes require
// a new consent version and a fresh substantive disclosure approval.
export const SPEECH_DISCLOSURE_APPROVED = true;
export const SPEECH_CONSENT_COPY = Object.freeze({
  title: 'Turn on spoken replies?',
  intro: 'K Scan AI sends the text of Elise’s spoken reply or greeting to ElevenLabs to generate a synthetic voice.',
  points: Object.freeze([
    'Replies may contain information from your conversation.',
    'ElevenLabs processes this text and generated audio under its privacy policy.',
    'This speech feature does not send your microphone recordings or photos to ElevenLabs.',
    'Generated audio is temporarily cached on this device for playback.',
    'Turning this on allows new eligible replies to play automatically on this device.',
    'You can turn this off in Privacy settings. Written replies remain available.',
  ]),
  accept: 'Turn on spoken replies',
  cancel: 'Keep text only',
  failure: 'We could not save your choice. Spoken replies remain off. Please try again.',
  withdrawalFailure: 'Spoken replies are off for this session, but we could not save that change. Please retry before restarting the app.',
  privacyUrl: 'https://kscan.app/legal/privacy',
  providerPrivacyUrl: 'https://elevenlabs.io/privacy-policy',
});

export function hasSpeechConsent(actorId: string): boolean {
  return SPEECH_DISCLOSURE_APPROVED && Boolean(actorId) && getActorContext().actorId === actorId &&
    hasThirdPartyAiConsentNow('elise_speech', SPEECH_CONSENT_VERSION);
}

export async function loadSpeechConsent(actorId: string): Promise<boolean> {
  if (!SPEECH_DISCLOSURE_APPROVED || getActorContext().actorId !== actorId) return false;
  await loadThirdPartyAiConsent('elise_speech', SPEECH_CONSENT_VERSION);
  return hasSpeechConsent(actorId);
}

export async function grantSpeechConsent(actorId: string): Promise<boolean> {
  if (!SPEECH_DISCLOSURE_APPROVED || getActorContext().actorId !== actorId) return false;
  return await recordThirdPartyAiConsent('elise_speech', SPEECH_CONSENT_VERSION) && hasSpeechConsent(actorId);
}

export async function withdrawSpeechConsent(actorId: string): Promise<boolean> {
  if (getActorContext().actorId !== actorId) return false;
  return withdrawThirdPartyAiConsent('elise_speech');
}
