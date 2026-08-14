import type { AvatarMotionMode } from './avatarMotionState';

// Textual equivalents for every semantic avatar state.
//
// Motion is never the only channel: whatever Elise conveys visually has a
// visible/screen-reader-accessible sentence here. Copy is per-state and
// stylist-name aware; playback frames and mouth changes are deliberately not
// representable, because announcing them would be noise.

export interface AvatarStatusInput {
  mode: AvatarMotionMode;
  stylistName: string;
}

/**
 * The status sentence for a mode, or null when there is nothing to say
 * (idle, and the transient interrupted settle).
 */
export function getAvatarMotionStatusText(input: AvatarStatusInput): string | null {
  const name = input.stylistName?.trim() || 'Elise';
  switch (input.mode) {
    case 'listening':
      return `${name} is listening`;
    case 'thinking':
      return `${name} is considering your request`;
    case 'speaking':
      return `${name} is speaking`;
    case 'reacting':
    case 'interrupted':
    case 'idle':
    default:
      return null;
  }
}

/** Modes that produce an announcement. Used for deduplication logic. */
export function isAnnounceableMotionMode(mode: AvatarMotionMode): boolean {
  return mode === 'listening' || mode === 'thinking' || mode === 'speaking';
}

export interface AnnouncementDecision {
  announce: boolean;
  text: string | null;
  /** Mode to remember as the last announced one. */
  nextAnnouncedMode: AvatarMotionMode | null;
}

/**
 * Decide whether a mode change should be announced.
 *
 * Exactly one announcement per semantic transition: repeats of the same mode
 * are suppressed, and a mode with no status text clears the memory without
 * announcing. Callers pass the previously announced mode, so no announcement
 * can fire during continuous speech.
 */
export function decideMotionAnnouncement(
  mode: AvatarMotionMode,
  lastAnnouncedMode: AvatarMotionMode | null,
  stylistName: string,
): AnnouncementDecision {
  const text = getAvatarMotionStatusText({ mode, stylistName });
  if (!text) return { announce: false, text: null, nextAnnouncedMode: null };
  if (mode === lastAnnouncedMode) {
    return { announce: false, text, nextAnnouncedMode: lastAnnouncedMode };
  }
  return { announce: true, text, nextAnnouncedMode: mode };
}
