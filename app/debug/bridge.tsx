/**
 * K Scan Bridge Alpha debug screen (Phase 16).
 *
 * Dev-only surface for inspecting and exercising the app-level glasses
 * bridge. PRODUCTION-GATED: when the bridge debug gate is closed (release
 * build without EXPO_PUBLIC_ENABLE_BRIDGE_DEBUG=true) this route renders
 * a redirect home and exposes nothing. It is not linked from any
 * production navigation; open it via the kscan://debug/bridge deep link
 * or by navigating to /debug/bridge in a dev build.
 *
 * Privacy: this screen renders bridge metadata only. It never renders
 * image payloads or raw base64, and never uploads anything.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Redirect } from 'expo-router';
import { COLORS, RADIUS, SPACING, TYPOGRAPHY } from '../../constants/theme';
import { BridgeService, type BridgeStatus } from '../../services/bridge/BridgeService';
import { MockLoopbackTransport } from '../../services/bridge/MockLoopbackTransport';
import { WifiDevTransport } from '../../services/bridge/WifiDevTransport';
import { getBridgePermissionStatus } from '../../services/bridge/BridgePermissionStatus';
import { isBridgeDebugEnabled } from '../../services/bridge/bridgeDebugGate';

function createBridgeService(): BridgeService {
  return new BridgeService({
    transport: new WifiDevTransport(),
    getPermissionStatus: () => getBridgePermissionStatus(Platform.OS),
    isDevMode: true,
  });
}

function StatusRow({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'warn' | 'error' }) {
  const valueColor =
    tone === 'ok' ? COLORS.success : tone === 'error' ? COLORS.error : tone === 'warn' ? COLORS.warning : COLORS.textPrimary;
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, { color: valueColor }]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

function ActionButton({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [styles.button, pressed && styles.buttonPressed, disabled && styles.buttonDisabled]}
    >
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

export default function BridgeDebugScreen() {
  // Production gate: render nothing debug-related when closed.
  if (!isBridgeDebugEnabled()) {
    return <Redirect href="/" />;
  }
  return <BridgeDebugContent />;
}

function BridgeDebugContent() {
  const serviceRef = useRef<BridgeService | null>(null);
  if (!serviceRef.current) {
    serviceRef.current = createBridgeService();
  }
  const service = serviceRef.current;

  const [status, setStatus] = useState<BridgeStatus>(() => service.getStatus());
  const [note, setNote] = useState<string>('Bridge idle. Start the dev bridge to begin.');

  useEffect(() => {
    const unsubscribe = service.subscribe(setStatus);
    return () => {
      unsubscribe();
      void service.stopBridge();
    };
  }, [service]);

  const startDevBridge = useCallback(async () => {
    try {
      await service.startDevBridge();
      setNote('Dev bridge ready over Wi-Fi WebSocket transport.');
    } catch {
      // WebSocket server unreachable — fall back to the in-memory loopback
      // so the capture flow can still be exercised on-device.
      try {
        service.setTransport(new MockLoopbackTransport());
        await service.startDevBridge();
        setNote('Wi-Fi dev server unreachable; using mock loopback transport.');
      } catch {
        setNote('Bridge failed to start on both Wi-Fi and mock transports.');
      }
    }
  }, [service]);

  const stopBridge = useCallback(async () => {
    await service.stopBridge();
    setNote('Bridge stopped.');
  }, [service]);

  const simulateCapture = useCallback(async () => {
    const response = await service.simulateGlassesCaptureRequest();
    if (response.type === 'capture.success') {
      setNote(`Simulated capture succeeded (requestId ${response.requestId}).`);
    } else {
      setNote(`Simulated capture failed: ${response.code}`);
    }
  }, [service]);

  const refreshPermissions = useCallback(async () => {
    // Query-only: never triggers permission prompts.
    await service.refreshPermissions();
    setNote('Permission status refreshed (query-only, no prompts).');
  }, [service]);

  const resetBridge = useCallback(() => {
    service.resetBridge();
    setNote('Bridge state reset.');
  }, [service]);

  const perms = status.permissionStatus;

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <Text style={styles.title}>K Scan Bridge Alpha</Text>
      <Text style={styles.subtitle}>Dev-only debug surface — not a production feature</Text>

      <View style={styles.card}>
        <Text style={styles.cardLabel}>Bridge</Text>
        <StatusRow
          label="State"
          value={status.bridgeState}
          tone={status.bridgeState === 'ready' ? 'ok' : status.bridgeState === 'error' ? 'error' : undefined}
        />
        <StatusRow label="Active transport" value={status.activeTransport ?? '—'} />
        <StatusRow label="Dev mode" value={status.isDevMode ? 'yes' : 'no'} tone={status.isDevMode ? 'ok' : 'error'} />
        <StatusRow label="Last message" value={status.lastMessageType ?? '—'} />
        <StatusRow label="Last requestId" value={status.lastRequestId ?? '—'} />
        <StatusRow
          label="Last error"
          value={status.lastErrorCode ?? 'none'}
          tone={status.lastErrorCode ? 'error' : 'ok'}
        />
        <StatusRow label="Updated" value={status.updatedAt} />
      </View>

      <View style={styles.card}>
        <Text style={styles.cardLabel}>Transports</Text>
        <StatusRow
          label="Wi-Fi dev"
          value={status.wifiStatus ? `${status.wifiStatus.connectionState}${status.wifiStatus.detail ? ` (${status.wifiStatus.detail})` : ''}` : 'inactive'}
          tone={status.wifiStatus?.connectionState === 'connected' ? 'ok' : undefined}
        />
        <StatusRow label="DAT" value={`${status.datStatus.connectionState} — awaiting official Meta SDK`} tone="warn" />
        <StatusRow label="Bluetooth" value={`${status.bluetoothStatus.connectionState} — protocol unknown`} tone="warn" />
      </View>

      <View style={styles.card}>
        <Text style={styles.cardLabel}>Permissions (query-only)</Text>
        <StatusRow label="DAT" value={perms?.datPermission ?? 'not checked'} />
        <StatusRow label="Bluetooth" value={perms?.bluetoothPermission ?? 'not checked'} />
        <StatusRow label="Local network" value={perms?.localNetworkPermission ?? 'not checked'} />
        <StatusRow label="Microphone" value={perms?.microphonePermission ?? 'not checked'} />
      </View>

      <View style={styles.card}>
        <Text style={styles.cardLabel}>Actions</Text>
        <ActionButton label="Start Dev Bridge" onPress={() => void startDevBridge()} />
        <ActionButton label="Stop Bridge" onPress={() => void stopBridge()} />
        <ActionButton label="Simulate Glasses Capture" onPress={() => void simulateCapture()} />
        <ActionButton label="Refresh Permissions" onPress={() => void refreshPermissions()} />
        <ActionButton label="Reset Bridge" onPress={resetBridge} />
      </View>

      <Text style={styles.note}>{note}</Text>
      <Text style={styles.footer}>
        Image payloads are never rendered, logged, persisted, or uploaded from this screen.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  content: {
    padding: SPACING.lg,
    paddingTop: SPACING.xxxl,
    gap: SPACING.md,
  },
  title: {
    ...TYPOGRAPHY.headline,
  },
  subtitle: {
    ...TYPOGRAPHY.sectionLabel,
    marginBottom: SPACING.sm,
  },
  card: {
    backgroundColor: COLORS.cardBg,
    borderColor: COLORS.cardBorder,
    borderWidth: 1,
    borderRadius: RADIUS.md,
    padding: SPACING.lg,
    gap: SPACING.sm,
  },
  cardLabel: {
    ...TYPOGRAPHY.sectionLabel,
    marginBottom: SPACING.xs,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: SPACING.md,
  },
  rowLabel: {
    fontSize: 13,
    color: COLORS.textSecondary,
  },
  rowValue: {
    fontSize: 13,
    fontWeight: '500',
    color: COLORS.textPrimary,
    flexShrink: 1,
  },
  button: {
    backgroundColor: COLORS.accentSoft,
    borderColor: COLORS.borderStrong,
    borderWidth: 1,
    borderRadius: RADIUS.sm,
    paddingVertical: SPACING.md,
    alignItems: 'center',
    marginTop: SPACING.xs,
  },
  buttonPressed: {
    backgroundColor: COLORS.accentGlow,
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  buttonText: {
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.accent,
    letterSpacing: 1,
  },
  note: {
    fontSize: 13,
    color: COLORS.textSecondary,
    lineHeight: 20,
  },
  footer: {
    fontSize: 11,
    color: COLORS.textTertiary,
    lineHeight: 16,
    marginBottom: SPACING.xxl,
  },
});
