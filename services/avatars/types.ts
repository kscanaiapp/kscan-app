import type { ImageSourcePropType } from 'react-native';

/**
 * Avatar / stylist speech configuration types.
 *
 * All speech fields are optional so existing consumers and abstract avatar
 * entries continue working without modification. Missing fields resolve to
 * speech disabled.
 */

export type AvatarKind = 'stylist' | 'abstract' | 'placeholder';

export type AvatarSpeechProfile = 'feminine' | 'masculine';

export type AvatarSpeakingMotionMode = 'mouth_overlay' | 'whole_face' | 'none';

export type AvatarSpeechStatus = 'idle' | 'starting' | 'speaking' | 'stopping' | 'error';

export type AvatarSpeechSource = 'greeting' | 'message';

export interface NormalizedMouthRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AvatarSpeechCapability {
  speechEnabled?: boolean;
  voiceProfile?: AvatarSpeechProfile;
  mouthRegion?: NormalizedMouthRegion;
  speakingMotionMode?: AvatarSpeakingMotionMode;
}

export interface AvatarEntry {
  id: string;
  kind: AvatarKind;
  enabled: boolean;
  name: string;
  assetSource: ImageSourcePropType | null;
  speech: AvatarSpeechCapability;
  greetingSpeechEnabled: boolean;
  responseSpeechEnabled: boolean;
}

export interface AvatarSpeechState {
  status: AvatarSpeechStatus;
  actorKey: string | null;
  avatarId: string | null;
  utteranceKey: string | null;
  source: AvatarSpeechSource | null;
  error: string | null;
}

export interface ResolvedVoice {
  identifier: string;
  language: string;
  quality?: number;
  name?: string;
}
