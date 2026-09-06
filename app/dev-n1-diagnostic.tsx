/**
 * TEMPORARY N1 runtime-evidence probe. Not a product screen.
 *
 * Reachable ONLY via the existing EXPO_PUBLIC_DEV_INITIAL_ROUTE dev harness
 * (constants/featureFlags.ts), which is __DEV__-gated and absent from every
 * EAS profile -- this route is inert in any build that matters. Exists to
 * capture native-runtime evidence (docs/vto-live-native-runtime-n1.md)
 * without touching the real auth-gated Scan Results -> ProductShelf ->
 * TryItOnEntry path. Kept across gates (N1-A, N1-B, N1-D, now N1-E) rather
 * than recreated per gate -- tracked in the N1 defect ledger, not left silent.
 *
 * Everything this screen reads across the bridge is bounded: one geometry
 * snapshot on demand (rate-limited native-side), and aggregate replay /
 * perception counters. No frames, no BodyFrames, no per-frame geometry, no
 * landmark array -- amendment D24 / mission section 26. The replay and
 * perception pipelines run entirely native; JS only sets the `replay` /
 * `perception` props.
 */
import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { requireNativeViewManager } from 'expo-modules-core';
import { describeLiveVtoNativeCapability } from '../services/vto/liveVtoNativeModule';
import { ensureLiveCameraPermission } from '../services/vto/vtoLiveCameraPermission';

const NativeLiveVtoView = requireNativeViewManager<any>('KScanLiveVto');

export default function DevN1Diagnostic() {
  const [capabilityResult, setCapabilityResult] = useState<string>('running...');
  const [geometryResult, setGeometryResult] = useState<string>('running...');
  const [replayResult, setReplayResult] = useState<string>('running...');
  const [perceptionResult, setPerceptionResult] = useState<string>('running...');
  const [cameraPermissionState, setCameraPermissionState] = useState<string>('not requested');
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraStatsResult, setCameraStatsResult] = useState<string>('not started');
  const staticRef = useRef<any>(null);
  const replayRef = useRef<any>(null);
  const perceptionRef = useRef<any>(null);
  const cameraRef = useRef<any>(null);

  useEffect(() => {
    try {
      const capability = describeLiveVtoNativeCapability();
      const line = JSON.stringify(capability);
      // eslint-disable-next-line no-console
      console.log('[N1-A-PROBE]', line);
      setCapabilityResult(line);
    } catch (error) {
      const line = `threw: ${String(error)}`;
      // eslint-disable-next-line no-console
      console.log('[N1-A-PROBE]', line);
      setCapabilityResult(line);
    }
  }, []);

  // N1-B: one geometry snapshot, read once the static view has computed.
  useEffect(() => {
    const timer = setTimeout(async () => {
      try {
        const json = await staticRef.current?.getGeometrySnapshotJson?.();
        // eslint-disable-next-line no-console
        console.log('[N1-B-PROBE]', json);
        setGeometryResult(String(json));
      } catch (error) {
        const line = `threw: ${String(error)}`;
        // eslint-disable-next-line no-console
        console.log('[N1-B-PROBE]', line);
        setGeometryResult(line);
      }
    }, 1200);
    return () => clearTimeout(timer);
  }, []);

  // N1-D: aggregate replay counters, sampled a few times while the native
  // replay clock runs. Sampling here is a diagnostic read of counters, not
  // a frame channel -- the payload is fixed-size regardless of frame rate.
  useEffect(() => {
    let cancelled = false;
    const sample = async (label: string) => {
      if (cancelled) return;
      try {
        const json = await replayRef.current?.getReplayStatsJson?.();
        // eslint-disable-next-line no-console
        console.log(`[N1-D-PROBE-${label}]`, json);
        if (!cancelled) setReplayResult(String(json));
      } catch (error) {
        // eslint-disable-next-line no-console
        console.log(`[N1-D-PROBE-${label}]`, `threw: ${String(error)}`);
      }
    };
    const timers = [
      setTimeout(() => sample('1s'), 1000),
      setTimeout(() => sample('3s'), 3000),
      setTimeout(() => sample('6s'), 6000),
    ];
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, []);

  // N1-E: aggregate perception counters, sampled while real MediaPipe
  // inference runs against the bundled synthetic frame. Same bounded-poll
  // pattern as N1-D -- fixed-size payload regardless of inference rate.
  useEffect(() => {
    let cancelled = false;
    const sample = async (label: string) => {
      if (cancelled) return;
      try {
        const json = await perceptionRef.current?.getPerceptionStatsJson?.();
        // eslint-disable-next-line no-console
        console.log(`[N1-E-PROBE-${label}]`, json);
        if (!cancelled) setPerceptionResult(String(json));
      } catch (error) {
        // eslint-disable-next-line no-console
        console.log(`[N1-E-PROBE-${label}]`, `threw: ${String(error)}`);
      }
    };
    const timers = [
      setTimeout(() => sample('1s'), 1000),
      setTimeout(() => sample('3s'), 3000),
      setTimeout(() => sample('6s'), 6000),
      setTimeout(() => sample('10s'), 10000),
    ];
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, []);

  // N1-F: request the SAME governed permission flow the real Live entry path
  // uses (services/vto/vtoLiveCameraPermission.ts) -- this diagnostic screen
  // does not invent its own permission mechanism. `camera` is only ever set
  // true once the OS has actually granted it; the native side ALSO fails
  // closed on its own if permission is somehow not granted (mission section
  // 16), so this is belt-and-suspenders, not the only guard.
  const requestCameraPermission = async () => {
    const result = await ensureLiveCameraPermission();
    // eslint-disable-next-line no-console
    console.log('[N1-F-PERMISSION-PROBE]', JSON.stringify(result));
    setCameraPermissionState(`${result.state} (prompted=${result.prompted})`);
  };

  // N1-F: aggregate camera+perception counters, sampled while the live
  // camera pipeline runs. Same bounded-poll pattern as N1-D/N1-E.
  useEffect(() => {
    if (!cameraOn) return;
    let cancelled = false;
    const sample = async (label: string) => {
      if (cancelled) return;
      try {
        const json = await cameraRef.current?.getCameraStatsJson?.();
        // eslint-disable-next-line no-console
        console.log(`[N1-F-PROBE-${label}]`, json);
        if (!cancelled) setCameraStatsResult(String(json));
      } catch (error) {
        // eslint-disable-next-line no-console
        console.log(`[N1-F-PROBE-${label}]`, `threw: ${String(error)}`);
      }
    };
    const timers = [
      setTimeout(() => sample('1s'), 1000),
      setTimeout(() => sample('3s'), 3000),
      setTimeout(() => sample('6s'), 6000),
      setTimeout(() => sample('10s'), 10000),
    ];
    const interval = setInterval(() => sample('poll'), 2000);
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
      clearInterval(interval);
    };
  }, [cameraOn]);

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.label}>N1-A capability</Text>
      <Text testID="n1-a-probe-result" style={styles.result}>{capabilityResult}</Text>

      <Text style={styles.label}>N1-B static render (governed fixture, canned pose)</Text>
      <View style={styles.viewFrame}>
        <NativeLiveVtoView ref={staticRef} active style={styles.nativeView} />
      </View>
      <Text testID="n1-b-probe-result" style={styles.result}>{geometryResult}</Text>

      <Text style={styles.label}>N1-D native replay</Text>
      <View style={styles.viewFrame}>
        <NativeLiveVtoView ref={replayRef} replay style={styles.nativeView} />
      </View>
      <Text testID="n1-d-probe-result" style={styles.result}>{replayResult}</Text>

      <Text style={styles.label}>N1-E real local perception (MediaPipe Pose Landmarker)</Text>
      <View style={styles.viewFrame}>
        <NativeLiveVtoView ref={perceptionRef} perception style={styles.nativeView} />
      </View>
      <Text testID="n1-e-probe-result" style={styles.result}>{perceptionResult}</Text>

      <Text style={styles.label}>N1-F live front camera (real device only)</Text>
      <Pressable testID="n1-f-request-permission" style={styles.button} onPress={requestCameraPermission}>
        <Text style={styles.buttonText}>Request camera permission</Text>
      </Pressable>
      <Text testID="n1-f-permission-result" style={styles.result}>{cameraPermissionState}</Text>
      <Pressable
        testID="n1-f-toggle-camera"
        style={[styles.button, !cameraPermissionState.startsWith('granted') && styles.buttonDisabled]}
        disabled={!cameraPermissionState.startsWith('granted')}
        onPress={() => setCameraOn((v) => !v)}
      >
        <Text style={styles.buttonText}>{cameraOn ? 'Stop camera' : 'Start camera'}</Text>
      </Pressable>
      <View style={styles.viewFrame}>
        {cameraOn ? <NativeLiveVtoView ref={cameraRef} camera style={styles.nativeView} /> : null}
      </View>
      <Text testID="n1-f-probe-result" style={styles.result}>{cameraStatsResult}</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 12, backgroundColor: '#101014' },
  label: { color: '#9ad', fontSize: 13, marginTop: 12, marginBottom: 4, fontWeight: '600' },
  result: { color: '#eee', fontSize: 9, fontFamily: 'monospace' },
  viewFrame: { height: 300, backgroundColor: '#000', marginBottom: 6 },
  nativeView: { flex: 1 },
  button: { backgroundColor: '#2a5', paddingVertical: 8, paddingHorizontal: 12, borderRadius: 6, marginTop: 6, alignItems: 'center' },
  buttonDisabled: { backgroundColor: '#444' },
  buttonText: { color: '#fff', fontWeight: '600' },
});
