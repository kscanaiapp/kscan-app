const { AndroidConfig, createRunOncePlugin } = require('expo/config-plugins');

const FORBIDDEN_ANDROID_PERMISSIONS = [
  'android.permission.RECORD_AUDIO',
  'android.permission.ACCESS_FINE_LOCATION',
  'android.permission.ACCESS_BACKGROUND_LOCATION',
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.READ_EXTERNAL_STORAGE',
  'android.permission.WRITE_EXTERNAL_STORAGE',
  'android.permission.READ_MEDIA_IMAGES',
  'android.permission.READ_MEDIA_VIDEO',
  'android.permission.READ_MEDIA_AUDIO',
  'android.permission.MANAGE_EXTERNAL_STORAGE',
  'com.google.android.gms.permission.AD_ID',
  'android.permission.BLUETOOTH',
  'android.permission.BLUETOOTH_ADMIN',
  'android.permission.BLUETOOTH_CONNECT',
  'android.permission.BLUETOOTH_SCAN',
  'android.permission.BLUETOOTH_ADVERTISE',
  'android.permission.READ_CONTACTS',
  'android.permission.WRITE_CONTACTS',
  'android.permission.READ_SMS',
  'android.permission.RECEIVE_SMS',
  'android.permission.SEND_SMS',
  'android.permission.READ_CALL_LOG',
  'android.permission.WRITE_CALL_LOG',
  'android.permission.PROCESS_OUTGOING_CALLS',
  'android.permission.CALL_PHONE',
];

const withAndroidPermissionBlocklist = (config) =>
  AndroidConfig.Permissions.withBlockedPermissions(config, FORBIDDEN_ANDROID_PERMISSIONS);

module.exports = createRunOncePlugin(
  withAndroidPermissionBlocklist,
  'with-android-permission-blocklist',
  '1.1.0'
);
