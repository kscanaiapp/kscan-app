import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import * as Crypto from 'expo-crypto';
import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
import { COLORS, RADIUS, SPACING, TYPOGRAPHY } from '../../constants/theme';
import { compressSanitizedImageForAnalysis } from '../../services/privacyImageUpload';
import {
  MetaWearableCompanionError,
  approveAndClaimMetaSession,
  cacheMetaWearableResult,
  createMetaPairingChallenge,
  denyMetaPairing,
  getOrCreateMetaPhoneDeviceId,
  listMetaWearableSessions,
  openMetaWearableResultOnPhone,
  revokeMetaWearableSession,
  saveMetaWearableResult,
  submitMetaWearableScan,
  type MetaWearablePairingChallenge,
  type MetaWearableScanResult,
  type MetaWearableSessionClaim,
  type MetaWearableSessionSummary,
} from '../../services/metaWearableCompanion';
import {
  getMetaWearablePrivacyReadiness,
  removeMetaWearableLocalAsset,
  sanitizeMetaWearableCapture,
  type MetaWearableCaptureSource,
} from '../../services/metaWearablePrivacy';
import {
  getMetaCapabilities,
  initializeMetaAdapter,
  isMetaAdapterLinked,
  renderMetaResultOnGlasses,
  startMetaGlassesCapture,
} from '../../services/metaWearableDeviceNative';

function safeCode(error: unknown): string {
  return error instanceof MetaWearableCompanionError ? error.code : 'WEARABLE_REQUEST_FAILED';
}

function primaryMatchOf(result: MetaWearableScanResult): Record<string, unknown> {
  return result.primaryMatch && typeof result.primaryMatch === 'object'
    ? (result.primaryMatch as Record<string, unknown>)
    : {};
}

function ActionButton({ label, onPress, disabled = false, secondary = false }: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  secondary?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        secondary && styles.buttonSecondary,
        (pressed || disabled) && styles.buttonPressed,
      ]}
    >
      <Text style={[styles.buttonText, secondary && styles.buttonSecondaryText]}>{label}</Text>
    </Pressable>
  );
}

export default function MetaWearableCompanionScreen() {
  const [phoneDeviceId, setPhoneDeviceId] = useState<string | null>(null);
  const [challenge, setChallenge] = useState<MetaWearablePairingChallenge | null>(null);
  const [session, setSession] = useState<MetaWearableSessionClaim | null>(null);
  const [sessions, setSessions] = useState<MetaWearableSessionSummary[]>([]);
  const [result, setResult] = useState<MetaWearableScanResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Generate a pairing code to link this phone as the Meta glasses candidate session.');
  const [lastErrorCode, setLastErrorCode] = useState<string | null>(null);
  const [glassesStatus, setGlassesStatus] = useState<string>('NOT_LINKED');

  const refreshSessions = useCallback(async () => {
    try {
      const next = await listMetaWearableSessions();
      setSessions(next);
    } catch (error) {
      setLastErrorCode(safeCode(error));
    }
  }, []);

  useEffect(() => {
    void (async () => {
      setPhoneDeviceId(await getOrCreateMetaPhoneDeviceId());
      // Bring the Meta adapter up once, early. This never throws and never
      // blocks: a build without the DAT SDK simply reports no glasses and the
      // screen keeps working on the phone camera.
      if (isMetaAdapterLinked()) {
        const ready = await initializeMetaAdapter();
        setGlassesStatus(ready ? getMetaCapabilities().reason ?? 'READY' : 'INIT_FAILED');
      } else {
        setGlassesStatus('NOT_LINKED');
      }
    })();
    void refreshSessions();
  }, [refreshSessions]);

  const generateChallenge = useCallback(async () => {
    setBusy(true);
    setLastErrorCode(null);
    try {
      const next = await createMetaPairingChallenge();
      setChallenge(next);
      setStatus('Pairing code ready. Approve to claim a wearable session for this phone.');
    } catch (error) {
      setLastErrorCode(safeCode(error));
      setStatus('Could not create a pairing code. Try again.');
    } finally {
      setBusy(false);
    }
  }, []);

  const approve = useCallback(async () => {
    if (!challenge || !phoneDeviceId) return;
    setBusy(true);
    setLastErrorCode(null);
    try {
      const claim = await approveAndClaimMetaSession(
        challenge.challengeCode,
        phoneDeviceId,
        challenge.pairingHandle,
        challenge.pairingSecret,
      );
      setSession(claim);
      setChallenge(null);
      setStatus('Paired. This phone now holds a short-lived wearable session.');
      await refreshSessions();
    } catch (error) {
      setLastErrorCode(safeCode(error));
      setStatus('Pairing could not be approved. Generate a new code and try again.');
    } finally {
      setBusy(false);
    }
  }, [challenge, phoneDeviceId, refreshSessions]);

  const deny = useCallback(async () => {
    if (!challenge) return;
    setBusy(true);
    try {
      await denyMetaPairing(challenge.challengeCode);
      setChallenge(null);
      setStatus('Pairing denied.');
    } catch (error) {
      setLastErrorCode(safeCode(error));
    } finally {
      setBusy(false);
    }
  }, [challenge]);

  const capture = useCallback(async () => {
    if (!session || busy) return;
    setBusy(true);
    setLastErrorCode(null);
    let rawUri: string | null = null;
    let sanitizedUri: string | null = null;
    let compressedUri: string | null = null;
    let glassesCapture: ReturnType<typeof startMetaGlassesCapture> = null;
    try {
      // Prefer the real glasses. `startMetaGlassesCapture` returns null when
      // the DAT adapter is absent, unregistered, has no connected device, or
      // lacks camera permission — in every one of those cases the phone camera
      // is the correct capture surface, not an error.
      let dimensions: { width?: number; height?: number } | undefined;
      let captureSource: MetaWearableCaptureSource = 'phone_camera';

      const glasses = startMetaGlassesCapture();
      if (glasses) {
        setStatus('Capturing from your Meta glasses…');
        glassesCapture = glasses;
        const shot = await glasses.promise;
        rawUri = shot.uri;
        dimensions = { width: shot.width, height: shot.height };
        captureSource = 'meta_glasses';
      } else {
        const permission = await ImagePicker.requestCameraPermissionsAsync();
        if (!permission.granted) throw new MetaWearableCompanionError('CAMERA_PERMISSION_DENIED');
        setStatus('Opening phone camera…');
        const picker = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 1, exif: false });
        if (picker.canceled || !picker.assets?.[0]?.uri) {
          setStatus('Capture cancelled.');
          return;
        }
        const asset = picker.assets[0];
        rawUri = asset.uri;
        dimensions = { width: asset.width, height: asset.height };
      }

      setStatus('Running the on-device privacy check…');
      const privacy = await sanitizeMetaWearableCapture(rawUri, dimensions, { source: captureSource });
      sanitizedUri = privacy.sanitizedUri;
      setStatus('Finding matches…');
      const compressed = await compressSanitizedImageForAnalysis(sanitizedUri, { width: 800, quality: 0.78 });
      compressedUri = compressed.uri;
      const requestId = Crypto.randomUUID();
      const scanned = await submitMetaWearableScan(session.wearableToken, compressed.base64, requestId);
      cacheMetaWearableResult(scanned.result);
      setResult(scanned.result);
      // Only display-capable hardware gets a glance; on camera-first glasses
      // this is a no-op and the phone stays the result surface.
      void renderMetaResultOnGlasses(scanned.result);
      setStatus('StyleMatch ready.');
    } catch (error) {
      const code = safeCode(error);
      setLastErrorCode(code);
      setStatus(code.startsWith('PRIVACY_') ? 'Privacy check failed. Nothing was uploaded.' : 'The scan could not be completed.');
    } finally {
      // Releasing the handle also guarantees a photo still in flight is
      // discarded rather than delivered into a flow that has already ended.
      glassesCapture?.cancel();
      if (compressedUri && compressedUri !== sanitizedUri) removeMetaWearableLocalAsset(compressedUri);
      if (sanitizedUri && sanitizedUri !== rawUri) removeMetaWearableLocalAsset(sanitizedUri);
      if (rawUri) removeMetaWearableLocalAsset(rawUri);
      setBusy(false);
    }
  }, [session, busy]);

  const saveResult = useCallback(async () => {
    if (!session || !result) return;
    setBusy(true);
    setLastErrorCode(null);
    try {
      const resultId = typeof result.resultId === 'string' ? result.resultId : '';
      await saveMetaWearableResult(session.wearableToken, result, resultId);
      setStatus('Saved to K Scan.');
    } catch (error) {
      setLastErrorCode(safeCode(error));
      setStatus('Save failed.');
    } finally {
      setBusy(false);
    }
  }, [session, result]);

  const openOnPhone = useCallback(async () => {
    if (!session || !result) return;
    const resultId = typeof result.resultId === 'string' ? result.resultId : '';
    if (!resultId) return;
    setBusy(true);
    setLastErrorCode(null);
    try {
      await openMetaWearableResultOnPhone(session.wearableToken, resultId, result);
      setStatus('Opened the exact result on this phone.');
      router.push(`/wearables/result/${encodeURIComponent(resultId)}` as never);
    } catch (error) {
      setLastErrorCode(safeCode(error));
      setStatus('Could not open the result.');
    } finally {
      setBusy(false);
    }
  }, [session, result]);

  const removeSession = useCallback((row: MetaWearableSessionSummary) => {
    Alert.alert('Remove Meta glasses?', 'This immediately revokes the wearable session.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove', style: 'destructive', onPress: () => {
          void revokeMetaWearableSession(row.sessionId, 'user_revoked')
            .then(async () => {
              if (session?.sessionId === row.sessionId) {
                setSession(null);
                setResult(null);
              }
              await refreshSessions();
            })
            .catch((error) => setLastErrorCode(safeCode(error)));
        },
      },
    ]);
  }, [refreshSessions, session]);

  const privacyReadiness = getMetaWearablePrivacyReadiness();
  const primary = result ? primaryMatchOf(result) : {};
  const alternatives = result && Array.isArray(result.alternatives) ? result.alternatives : [];

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.headerRow}>
          <Pressable accessibilityRole="button" onPress={() => router.back()}><Text style={styles.back}>‹ Back</Text></Pressable>
          <Text style={styles.eyebrow}>PRIVATE HARDWARE CANDIDATE</Text>
        </View>
        <Text style={styles.title}>Meta Companion</Text>
        <Text style={styles.subtitle}>{status}</Text>

        {!session ? (
          <View style={styles.card}>
            <Text style={styles.cardLabel}>PAIR META GLASSES</Text>
            {challenge ? (
              <>
                <Text style={styles.code}>{challenge.challengeCode}</Text>
                <Text style={styles.body}>Candidate build: this phone minted its own pairing code (there is no physical glasses transport yet). Approve to claim the session as this phone.</Text>
                <View style={styles.actions}>
                  <ActionButton label="Approve" disabled={busy} onPress={() => void approve()} />
                  <ActionButton label="Deny" secondary disabled={busy} onPress={() => void deny()} />
                </View>
              </>
            ) : (
              <ActionButton label={busy ? 'Working…' : 'Generate Pairing Code'} disabled={busy} onPress={() => void generateChallenge()} />
            )}
          </View>
        ) : (
          <View style={[styles.card, styles.requestCard]}>
            <Text style={styles.cardLabel}>SCAN</Text>
            <Text style={styles.body}>Capture comes from your Meta glasses when they are connected and permitted, and from this phone otherwise. Either way the image stays local until face detection and solid masking succeed.</Text>
            <Text style={styles.meta}>GLASSES ADAPTER · {glassesStatus}</Text>
            <ActionButton label={busy ? 'Processing…' : 'Open Camera'} disabled={busy} onPress={() => void capture()} />
          </View>
        )}

        {result ? (
          <View style={styles.card}>
            <Text style={styles.cardLabel}>RESULT</Text>
            <Text style={styles.deviceName}>{typeof result.summary === 'string' ? result.summary : 'StyleMatch'}</Text>
            <Text style={styles.body}>{typeof primary.title === 'string' ? primary.title : 'Fashion item'}</Text>
            {alternatives.length ? <Text style={styles.meta}>{alternatives.length} alternative match{alternatives.length === 1 ? '' : 'es'} available</Text> : null}
            <View style={styles.actions}>
              <ActionButton label="Save" disabled={busy} onPress={() => void saveResult()} />
              <ActionButton label="Open on Phone" secondary disabled={busy} onPress={() => void openOnPhone()} />
            </View>
          </View>
        ) : null}

        <View style={styles.card}>
          <Text style={styles.cardLabel}>CONNECTED DEVICES</Text>
          {sessions.length === 0 ? <Text style={styles.body}>No active wearable session.</Text> : sessions.map((row) => (
            <View key={row.sessionId} style={styles.sessionRow}>
              <View style={styles.sessionText}>
                <Text style={styles.deviceName}>{row.deviceName}</Text>
                <Text style={styles.meta}>ACTIVE · expires {new Date(row.expiresAt).toLocaleTimeString()}</Text>
              </View>
              <Pressable accessibilityRole="button" onPress={() => removeSession(row)}><Text style={styles.remove}>Remove</Text></Pressable>
            </View>
          ))}
        </View>

        <View style={styles.diagnosticCard}>
          <Text style={styles.cardLabel}>PRIVACY READINESS</Text>
          <Text style={styles.meta}>Policy {privacyReadiness.policyVersion}</Text>
          <Text style={styles.meta}>LOCAL DETECTOR · SOLID MASK · FAIL CLOSED · {privacyReadiness.maxDimension}px</Text>
          {lastErrorCode ? <Text style={styles.error}>Last safe error: {lastErrorCode}</Text> : null}
        </View>
        {busy ? <ActivityIndicator color={COLORS.electricCyan} /> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.obsidian },
  content: { padding: SPACING.xl, gap: SPACING.lg },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  back: { color: COLORS.electricCyan, fontSize: 16 },
  eyebrow: { ...TYPOGRAPHY.caption, color: COLORS.chromeMuted, fontSize: 9 },
  title: { color: COLORS.white, fontSize: 32, fontWeight: '700', letterSpacing: -0.6 },
  subtitle: { color: COLORS.chrome, fontSize: 15, lineHeight: 22 },
  card: { backgroundColor: COLORS.graphite, borderColor: COLORS.graphiteLine, borderWidth: 1, borderRadius: RADIUS.lg, padding: SPACING.lg, gap: SPACING.md },
  requestCard: { borderColor: COLORS.electricCyan },
  diagnosticCard: { backgroundColor: COLORS.obsidianSoft, borderColor: COLORS.purpleSoft, borderWidth: 1, borderRadius: RADIUS.lg, padding: SPACING.lg, gap: SPACING.sm },
  cardLabel: { ...TYPOGRAPHY.caption, color: COLORS.electricCyan },
  code: { color: COLORS.white, fontSize: 34, fontWeight: '700', letterSpacing: 8, textAlign: 'center' },
  actions: { flexDirection: 'row', gap: SPACING.md },
  button: { flex: 1, minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: RADIUS.pill, backgroundColor: COLORS.purpleSoft, paddingHorizontal: SPACING.lg },
  buttonSecondary: { backgroundColor: 'transparent', borderColor: COLORS.chromeDark, borderWidth: 1 },
  buttonPressed: { opacity: 0.55 },
  buttonText: { color: COLORS.white, fontSize: 13, fontWeight: '700', letterSpacing: 1.2, textTransform: 'uppercase' },
  buttonSecondaryText: { color: COLORS.chrome },
  body: { color: COLORS.chrome, fontSize: 14, lineHeight: 21 },
  sessionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderTopColor: COLORS.graphiteLine, borderTopWidth: StyleSheet.hairlineWidth, paddingTop: SPACING.md },
  sessionText: { flex: 1, gap: SPACING.xs },
  deviceName: { color: COLORS.white, fontSize: 16, fontWeight: '600' },
  meta: { color: COLORS.chromeMuted, fontSize: 10, lineHeight: 16, letterSpacing: 1.2 },
  remove: { color: COLORS.error, fontWeight: '600', padding: SPACING.md },
  error: { color: '#FF8C96', fontSize: 12 },
});
