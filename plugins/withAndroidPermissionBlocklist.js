const { AndroidConfig, createRunOncePlugin } = require('expo/config-plugins');

const FORBIDDEN_ANDROID_PERMISSIONS = [
  'android.permission.RECORD_AUDIO',
  'android.permission.ACCESS_FINE_LOCATION',
  'android.permission.READ_EXTERNAL_STORAGE',
  'android.permission.WRITE_EXTERNAL_STORAGE',
];

const withAndroidPermissionBlocklist = (config) =>
  AndroidConfig.Permissions.withBlockedPermissions(config, FORBIDDEN_ANDROID_PERMISSIONS);

module.exports = createRunOncePlugin(
  withAndroidPermissionBlocklist,
  'with-android-permission-blocklist',
  '1.0.0'
);
