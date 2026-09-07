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
import { describeLiveVtoNativeCapability, getLiveVtoNativeModule } from '../services/vto/liveVtoNativeModule';
import { ensureLiveCameraPermission } from '../services/vto/vtoLiveCameraPermission';
import { buildPhotorealPersonInput } from '../services/vto/vtoPhotorealHandoff';
import { useVirtualTryOn } from '../hooks/useVirtualTryOn';
import type { LiveVtoCapturedFrame } from '../types/vtoLive';
import type { VtoGarmentInput } from '../types/vto';

const NativeLiveVtoView = requireNativeViewManager<any>('KScanLiveVto');

/**
 * G3 (2026-09-06): bounded real-staging Photoreal provider E2E proof. Reuses
 * the EXISTING vto-e2e harness's own committed, non-personal, synthetic test
 * garment asset (scripts/vto-e2e/fixtures/garment.png, see
 * garment.fixture.json for its seed/hash evidence) via the SAME public
 * raw.githubusercontent.com committed-asset pattern
 * scripts/vto-e2e/lib/fullcert.mjs#committedGarmentUrl already uses -- not a
 * new fixture. productRef is a clearly-marked diagnostic identity, never a
 * real commerce product. `origin: 'dev_harness'` is the SAME VtoOrigin value
 * the backend harness's own real paid full-certification call already uses
 * (types/vto.ts's VTO_ORIGINS) -- a taxonomy label the server accepts for a
 * real generation, not a bypass or a fake-mode flag.
 */
const G3_COMMIT_SHA = '03896d4961639ab95e8d8805128bc777e41502d8';
const G3_TEST_GARMENT: VtoGarmentInput = {
  productRef: 'live-vto-g3-diagnostic-product',
  imageUrl: `https://raw.githubusercontent.com/kscanaiapp/kscan-app/${G3_COMMIT_SHA}/scripts/vto-e2e/fixtures/garment.png`,
  category: 'top',
  brand: null,
  commerceSource: null,
};

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

  // G3 (2026-09-06). Bounded real-staging Photoreal provider E2E proof,
  // reusing the EXISTING N1-G native capture (capturePersonFrame/
  // capturePreview -- module-level, no view ref) and the EXISTING JS
  // handoff/store chain (buildPhotorealPersonInput -> adoptPerson ->
  // startVtoGeneration -> the SAME vtoClient.ts/vto-generate AI Photo uses).
  // No new provider adapter, no shadow Edge Function: this only WIRES
  // together contract functions that already exist and are already tested.
  //
  // A physical camera is not required: `capturePersonFrame()` in `perception`
  // mode (the N1-E view above) reads the bundled synthetic test frame
  // perception itself runs inference against -- the SAME mechanism N1-G
  // already proved -- so this is unaffected by the carried Android camera
  // HOLD (docs/vto-live-native-n1-camera.md).
  //
  // IMPORTANT: capturePersonFrame()/capturePreview() are MODULE-level calls
  // that resolve to whichever native view attached MOST RECENTLY (a single
  // weak-referenced "current instance" registry -- see
  // LiveVtoTestRenderView.currentInstance()/LiveVtoRenderView.currentInstance
  // -- there is no view ref involved by design, matching the real app's
  // liveVtoNativeModule.ts contract). This screen mounts N1-B/N1-D/N1-E as
  // three ALWAYS-ON views; N1-E (perception) is the last of those three to
  // attach, so it is the active instance UNLESS "Start camera" below has
  // been toggled on (which mounts a fourth, later-attaching view). Do not
  // toggle the camera on before running G3 capture.
  const vto = useVirtualTryOn({ garment: G3_TEST_GARMENT, origin: 'dev_harness' });
  const [g3PersonFrame, setG3PersonFrame] = useState<LiveVtoCapturedFrame | null>(null);
  const [g3CaptureResult, setG3CaptureResult] = useState('not captured');
  const [g3NegativeControlResult, setG3NegativeControlResult] = useState('not run');
  const g3PhotorealInFlightRef = useRef(false);

  const g3CapturePersonFrame = async () => {
    try {
      const nativeModule = getLiveVtoNativeModule();
      const frame = await nativeModule?.capturePersonFrame();
      setG3PersonFrame(frame ?? null);
      const line = frame
        ? `captured kind=${frame.kind} id=${frame.captureId} ${frame.width}x${frame.height}`
        : 'null (is the perception view the active native instance? camera toggle steals it)';
      // eslint-disable-next-line no-console
      console.log('[G3-CAPTURE-PROBE]', line);
      setG3CaptureResult(line);
    } catch (error) {
      setG3CaptureResult(`threw: ${String(error)}`);
    }
  };

  // Negative control: a REAL native capturePreview() result (kind=PREVIEW),
  // fed into the REAL buildPhotorealPersonInput -- must be refused by
  // assertCleanPersonFrame, proving Preview cannot enter the Photoreal
  // adapter even when the input is genuine native output, not a hand-built
  // test double.
  const g3RunNegativeControl = async () => {
    try {
      const nativeModule = getLiveVtoNativeModule();
      const preview = await nativeModule?.capturePreview();
      if (!preview) {
        setG3NegativeControlResult('capturePreview returned null (no active native instance)');
        return;
      }
      const outcome = await buildPhotorealPersonInput(preview);
      // `=== false` rather than `!outcome.ok`: matches the discriminated-union
      // narrowing idiom vtoRequestStore.ts already uses (this tsconfig does
      // not enable strictNullChecks).
      setG3NegativeControlResult(
        outcome.ok === false
          ? `PASS: refused, code=${outcome.failure.code}`
          : 'FAIL: a PREVIEW frame was accepted by buildPhotorealPersonInput (should have been refused)',
      );
    } catch (error) {
      setG3NegativeControlResult(`threw: ${String(error)}`);
    }
  };

  // The bounded real call. VTO-HA-003-style in-flight guard: a second tap
  // while one handoff+generation is running is dropped rather than starting
  // a second billed attempt.
  const g3RequestPhotoreal = async () => {
    if (g3PhotorealInFlightRef.current) return;
    if (!g3PersonFrame) {
      setG3CaptureResult('capture a PERSON_FRAME first');
      return;
    }
    g3PhotorealInFlightRef.current = true;
    try {
      const outcome = await buildPhotorealPersonInput(g3PersonFrame);
      if (outcome.ok === false) {
        setG3CaptureResult(`handoff refused: ${outcome.failure.code}`);
        return;
      }
      vto.adoptPerson(outcome.person);
      vto.generate();
    } finally {
      g3PhotorealInFlightRef.current = false;
    }
  };

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

      <Text style={styles.label}>
        G3: real staging Photoreal E2E (sign in as a real K+ staging actor FIRST via the normal app login;
        do NOT toggle &quot;Start camera&quot; below before this)
      </Text>
      <Pressable testID="g3-capture-person-frame" style={styles.button} onPress={g3CapturePersonFrame}>
        <Text style={styles.buttonText}>1. Capture PERSON_FRAME (perception)</Text>
      </Pressable>
      <Text testID="g3-capture-result" style={styles.result}>{g3CaptureResult}</Text>
      <Pressable testID="g3-negative-control" style={styles.button} onPress={g3RunNegativeControl}>
        <Text style={styles.buttonText}>2. Negative control: capturePreview -&gt; handoff (expect refusal)</Text>
      </Pressable>
      <Text testID="g3-negative-control-result" style={styles.result}>{g3NegativeControlResult}</Text>
      <Pressable testID="g3-request-photoreal" style={styles.button} onPress={g3RequestPhotoreal}>
        <Text style={styles.buttonText}>3. Request Photoreal (REAL STAGING PROVIDER CALL)</Text>
      </Pressable>
      <Text testID="g3-vto-status" style={styles.result}>
        {`status=${vto.status} failure=${vto.failure?.code ?? 'none'} result=${
          vto.result
            ? `provider=${vto.result.provider} ${vto.result.width}x${vto.result.height} latencyMs=${vto.result.latencyMs}`
            : 'none'
        }`}
      </Text>

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
