import {
  buildNativeRoomPath,
  parseRoomDeepLink,
} from '../services/roomDeepLinks';

export function redirectSystemPath({
  path,
}: {
  path: string | null;
  initial: boolean;
}) {
  try {
    const parsed = parseRoomDeepLink(path);
    if (parsed) {
      return buildNativeRoomPath(parsed.shareToken, parsed.attribution);
    }
  } catch {
    // Leave non-room links on Expo Router's default path handling.
  }

  return path || '/';
}
