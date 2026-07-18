import type { MediaLibraryPermissionResponse } from 'expo-image-picker';

export function hasUsablePhotoLibraryAccess(
  permission: Pick<MediaLibraryPermissionResponse, 'status' | 'accessPrivileges'>,
): boolean;

export function tryOpenPhotoLibrarySettings(
  openSettings: () => Promise<void>,
): Promise<boolean>;
