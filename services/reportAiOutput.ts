import { Alert, Linking, Platform } from 'react-native';

export type AiOutputReportFeature = 'StyleChat' | 'TextScan' | 'Scan Results';

const SUPPORT_EMAIL = 'kscanai.app@gmail.com';

export function reportAiOutput(
  feature: AiOutputReportFeature,
  context?: { sessionId?: string | null; messageId?: string | null; itemId?: string | null }
) {
  const subject = encodeURIComponent(`K Scan AI — Report AI Output (${feature})`);
  const body = encodeURIComponent(
    `I'm reporting AI-generated content that may be offensive or unsafe.\n\n` +
      `Platform: ${Platform.OS}\n` +
      `Feature: ${feature}\n` +
      `Session ID: ${context?.sessionId || 'N/A'}\n` +
      `Message ID: ${context?.messageId || 'N/A'}\n` +
      `Item ID: ${context?.itemId || 'N/A'}\n` +
      `Timestamp: ${new Date().toISOString()}\n\n` +
      `Describe what happened. Do not include private information unless necessary:\n`
  );

  Linking.openURL(`mailto:${SUPPORT_EMAIL}?subject=${subject}&body=${body}`).catch(() => {
    Alert.alert('Could not open mail', `Email ${SUPPORT_EMAIL} to report AI content.`);
  });
}
