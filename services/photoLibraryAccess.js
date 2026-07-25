function hasUsablePhotoLibraryAccess(permission) {
  return Boolean(
    permission &&
      (permission.status === 'granted' || permission.accessPrivileges === 'limited'),
  );
}

async function tryOpenPhotoLibrarySettings(openSettings) {
  try {
    await openSettings();
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  hasUsablePhotoLibraryAccess,
  tryOpenPhotoLibrarySettings,
};
