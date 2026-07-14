import * as Crypto from 'expo-crypto';
import * as FileSystem from 'expo-file-system/legacy';

import type { StylistVoiceProfile } from '../../constants/stylistIdentity';

const SPEECH_DIRECTORY_NAME = 'kscan-stylist-speech/';
const TEMP_FILE_PREFIX = 'speech-';
const STARTUP_CLEANUP_LIMIT = 50;
const SPEECH_FILE_CONTRACT_VERSION = 'stylist-speech-v1-audio-mpeg';

function speechDirectory(): string {
  if (!FileSystem.cacheDirectory) {
    throw new Error('The application cache is unavailable.');
  }
  return `${FileSystem.cacheDirectory}${SPEECH_DIRECTORY_NAME}`;
}

async function ensureSpeechDirectory(): Promise<string> {
  const directory = speechDirectory();
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  return directory;
}

export async function createTemporaryStylistSpeechFile(input: {
  actorId: string;
  sessionId: string;
  messageId: string;
  stylistId: string;
  voiceProfile: Exclude<StylistVoiceProfile, 'silent'>;
  audioBase64: string;
}): Promise<string> {
  const directory = await ensureSpeechDirectory();
  const cacheKey = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    [
      input.actorId,
      input.sessionId,
      input.messageId,
      input.stylistId,
      input.voiceProfile,
      SPEECH_FILE_CONTRACT_VERSION,
    ].join('\u001f'),
  );
  const finalUri = `${directory}${TEMP_FILE_PREFIX}${cacheKey}.mp3`;
  const pendingUri = `${finalUri}.pending`;

  await Promise.all([
    FileSystem.deleteAsync(finalUri, { idempotent: true }),
    FileSystem.deleteAsync(pendingUri, { idempotent: true }),
  ]);
  try {
    await FileSystem.writeAsStringAsync(pendingUri, input.audioBase64, {
      encoding: FileSystem.EncodingType.Base64,
    });
    const pendingInfo = await FileSystem.getInfoAsync(pendingUri);
    if (!pendingInfo.exists || pendingInfo.isDirectory || pendingInfo.size <= 0) {
      throw new Error('Speech audio file was empty.');
    }
    await FileSystem.moveAsync({ from: pendingUri, to: finalUri });
    const finalInfo = await FileSystem.getInfoAsync(finalUri);
    if (!finalInfo.exists || finalInfo.isDirectory || finalInfo.size <= 0) {
      throw new Error('Speech audio file was unavailable.');
    }
    return finalUri;
  } catch (error) {
    await Promise.all([
      FileSystem.deleteAsync(pendingUri, { idempotent: true }).catch(() => undefined),
      FileSystem.deleteAsync(finalUri, { idempotent: true }).catch(() => undefined),
    ]);
    throw error;
  }
}

export async function deleteTemporaryStylistSpeechFile(uri: string | null): Promise<void> {
  if (!uri) return;
  const directory = speechDirectory();
  if (!uri.startsWith(directory) || !uri.includes(TEMP_FILE_PREFIX)) return;
  await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => undefined);
}

export async function cleanupOrphanedStylistSpeechFiles(): Promise<void> {
  let directory: string;
  try {
    directory = speechDirectory();
    const info = await FileSystem.getInfoAsync(directory);
    if (!info.exists || !info.isDirectory) return;
  } catch {
    return;
  }

  let names: string[];
  try {
    names = await FileSystem.readDirectoryAsync(directory);
  } catch {
    return;
  }
  const staleNames = names
    .filter((name) => name.startsWith(TEMP_FILE_PREFIX))
    .sort()
    .slice(0, STARTUP_CLEANUP_LIMIT);
  await Promise.all(
    staleNames.map((name) =>
      FileSystem.deleteAsync(`${directory}${name}`, { idempotent: true }).catch(() => undefined),
    ),
  );
}
