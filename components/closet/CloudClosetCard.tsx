import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { KPlusGate } from '../kplus/KPlusGate';
import { SecondaryButton } from '../luxury';
import { LUXURY, RADIUS, SPACING } from '../../constants/theme';
import { CLOSET_CLOUD_SYNC_V1, CLOSET_CROSS_DEVICE_RESTORE_V1, CLOSET_LEGACY_MIGRATION_V1 } from '../../constants/featureFlags';
import { captureActorScope, currentActorScopeKey, isActorScopeCurrent } from '../../services/actorScope';
import { hasRuntimeCapabilityProof } from '../../services/kplus/kplusCapabilityProof';
import { listClosetSyncEntries } from '../../services/closet/closetSyncStore';
import { isClosetSyncRunning, runClosetSyncPass } from '../../services/closet/closetSyncEngine';
import { isClosetRestoreRunning, runClosetRestorePass } from '../../services/closet/closetRestoreEngine';
import { runClosetHistoricalMigrationPass } from '../../services/closet/closetHistoricalMigrationEngine';
import { projectCloudClosetStatus } from '../../services/closet/closetCloudStatus';
import { emitClosetCandidateEvent } from '../../services/closetTelemetry';
import type { ClosetSyncEntry } from '../../services/closet/closetSyncContract';

export function CloudClosetCard({ items, onRefresh }: {
  items: readonly { id: string; updatedAt?: string }[];
  onRefresh: () => unknown;
}) {
  // Discovery cannot outrun proof. This does not stop the existing engines.
  if (!CLOSET_CLOUD_SYNC_V1 || !CLOSET_CROSS_DEVICE_RESTORE_V1 || !CLOSET_LEGACY_MIGRATION_V1
    || !hasRuntimeCapabilityProof('cloud_closet', 'closet_outbound_sync')) return null;
  return (
    <KPlusGate source="closet_intelligence">
      {({ state, isActive, resolving, openUpgrade }) => (
        <CloudClosetStatusCard key={currentActorScopeKey()} items={items} onRefresh={onRefresh} entitlement={state}
          active={isActive} resolving={resolving} openUpgrade={openUpgrade} />
      )}
    </KPlusGate>
  );
}

function CloudClosetStatusCard({ items, onRefresh, entitlement, active, resolving, openUpgrade }: {
  items: readonly { id: string; updatedAt?: string }[];
  onRefresh: () => unknown;
  entitlement: string;
  active: boolean;
  resolving: boolean;
  openUpgrade: () => void;
}) {
  const [snapshot, setSnapshot] = useState<{ scope: ReturnType<typeof captureActorScope>; entries: Record<string, ClosetSyncEntry>; readFailed: boolean; syncing: boolean; restoring: boolean } | null>(null);
  const [requested, setRequested] = useState(false);
  const read = useCallback(async () => {
    const scope = captureActorScope();
    try {
      const entries = await listClosetSyncEntries(scope.actorId);
      if (isActorScopeCurrent(scope)) setSnapshot({ scope, entries, readFailed: false, syncing: isClosetSyncRunning(), restoring: isClosetRestoreRunning() });
    } catch {
      if (isActorScopeCurrent(scope)) setSnapshot({ scope, entries: {}, readFailed: true, syncing: false, restoring: false });
    }
  }, []);
  useEffect(() => { emitClosetCandidateEvent('cloud_closet_card_rendered'); }, []);
  useFocusEffect(useCallback(() => {
    // Observe local authority only. Polling never invokes network/cloud work.
    void read();
    const timer = setInterval(() => { void read(); }, 1500);
    return () => clearInterval(timer);
  }, [read]));
  const current = snapshot && isActorScopeCurrent(snapshot.scope) ? snapshot : null;
  const status = projectCloudClosetStatus({ entitlement, entries: current?.entries ?? {}, items,
    readFailed: !current || current.readFailed, syncing: current?.syncing ?? false, restoring: current?.restoring ?? false,
    outboundProven: hasRuntimeCapabilityProof('cloud_closet', 'closet_outbound_sync') });
  const check = async () => {
    if (requested || resolving) return;
    if (!active) { openUpgrade(); return; }
    const scope = captureActorScope();
    setRequested(true);
    emitClosetCandidateEvent('cloud_closet_sync_requested');
    try {
      await runClosetHistoricalMigrationPass({ reason: 'manual_check' });
      if (!isActorScopeCurrent(scope)) return;
      const synced = await runClosetSyncPass({ reason: 'manual_check' });
      if (!isActorScopeCurrent(scope)) return;
      if (synced.ran && synced.failed === 0 && synced.blocked === 0 && synced.processed > 0) emitClosetCandidateEvent('cloud_closet_sync_completed');
      await runClosetRestorePass({ reason: 'manual_check', bypassCooldown: true });
      if (!isActorScopeCurrent(scope)) return;
      onRefresh();
    } finally {
      setRequested(false);
      void read();
    }
  };
  return (
    <View style={styles.card} testID="cloud-closet-card">
      <Text style={styles.title}>CLOUD CLOSET · K+</Text>
      <Text style={styles.body}>Your Closet on this device stays free.</Text>
      <Text style={styles.body}>{hasRuntimeCapabilityProof('cloud_closet', 'closet_cross_device_restore')
        ? 'Keep your Closet backed up and restore it across devices.' : 'Back up your Closet with K+.'}</Text>
      <Text style={styles.status} accessibilityLiveRegion="polite" testID="cloud-closet-status">{status}</Text>
      <SecondaryButton title={active ? 'CHECK CLOUD CLOSET' : 'EXPLORE K+'} onPress={() => { void check(); }}
        disabled={resolving || requested || status === 'SYNCING' || status === 'RESTORING'} testID="cloud-closet-check" />
    </View>
  );
}
const styles = StyleSheet.create({
  card: { padding: SPACING.lg, marginBottom: SPACING.lg, borderRadius: RADIUS.md, backgroundColor: LUXURY.colors.pearl, borderWidth: StyleSheet.hairlineWidth, borderColor: LUXURY.colors.border },
  title: { ...LUXURY.typography.sectionLabel },
  body: { ...LUXURY.typography.body, marginTop: SPACING.sm },
  status: { ...LUXURY.typography.caption, marginVertical: SPACING.md },
});
