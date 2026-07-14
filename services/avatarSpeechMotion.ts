import type {
  AvatarSpeechAlignment,
  AvatarSpeechPhase,
} from '../stores/avatarSpeechStore';

export type AvatarMouthState = 'closed' | 'halfOpen' | 'open';

export const MOUTH_PAUSE_THRESHOLD_SECONDS = 0.2;
const MOUTH_TRANSITION_SECONDS = 0.12;
const SPEAKABLE_CHARACTER = /[\p{L}\p{N}]/u;

export function deriveAvatarMouthState(input: {
  phase: AvatarSpeechPhase;
  playbackSeconds: number;
  alignment: AvatarSpeechAlignment | null;
}): AvatarMouthState {
  if (input.phase !== 'playing' || !input.alignment || input.playbackSeconds < 0) {
    return 'closed';
  }

  const { characters, characterStartTimesSeconds: starts, characterEndTimesSeconds: ends } =
    input.alignment;
  let activeIndex = -1;
  for (let index = 0; index < characters.length; index += 1) {
    if (starts[index] <= input.playbackSeconds && input.playbackSeconds <= ends[index]) {
      activeIndex = index;
      break;
    }
    if (starts[index] > input.playbackSeconds) {
      const priorEnd = index > 0 ? ends[index - 1] : 0;
      if (starts[index] - priorEnd >= MOUTH_PAUSE_THRESHOLD_SECONDS) return 'closed';
      break;
    }
  }
  if (activeIndex < 0 || !SPEAKABLE_CHARACTER.test(characters[activeIndex])) {
    return 'closed';
  }

  const transition = Math.floor(input.playbackSeconds / MOUTH_TRANSITION_SECONDS);
  return (transition + activeIndex) % 2 === 0 ? 'halfOpen' : 'open';
}
