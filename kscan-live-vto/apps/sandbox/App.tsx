/**
 * LiveVTO sandbox — illustrative composition, not executed in this
 * session. See README.md. This shows the intended shape of a dev-client
 * screen once the LiveVTO native module actually exists: a thin React
 * component issuing the narrow Section 10 commands and reacting to the
 * narrow Section 10 events plus the local guidance-state selector — no
 * per-frame data of any kind crosses into this file.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { Button, StyleSheet, Text, View } from 'react-native';
import {
  CANDIDATE_PRIVACY_DISCLAIMER,
  type GuidanceState,
  type LiveVTOEvent,
} from '@kscan-live-vto/contract';
import { unknownGarmentDescriptor } from '@kscan-live-vto/garment-contract';

// TODO: once native/ios + native/android are actually built and this app
// is registered as a real Expo dev-client project, this becomes:
//   import { requireNativeViewManager } from 'expo-modules-core';
//   const LiveVTONativeView = requireNativeViewManager('LiveVTO');
// There is no such module to require yet in this session.
function LiveVTONativeViewPlaceholder(props: { style?: object }) {
  return (
    <View style={[styles.placeholder, props.style]}>
      <Text style={styles.placeholderText}>LiveVTO native view not built in this session</Text>
    </View>
  );
}

export default function App() {
  const [guidance, setGuidance] = useState<GuidanceState>('NO_PERSON');
  const [ready, setReady] = useState(false);

  // Placeholder garment — a real one comes from the asset pipeline's
  // .ksgarment output, loaded via loadGarment(descriptor, uri).
  const placeholderGarment = useMemo(() => unknownGarmentDescriptor('sandbox-fixture-001', '1.0'), []);

  const handleNativeEvent = useCallback((event: LiveVTOEvent) => {
    switch (event.type) {
      case 'ready':
        setReady(true);
        break;
      case 'qualityChanged':
        setGuidance(event.payload.guidance);
        break;
      case 'trackingLost':
        setGuidance('NO_PERSON');
        break;
      default:
        break;
    }
  }, []);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>LIVE PREVIEW — APPROXIMATE VISUALIZATION</Text>
      <Text style={styles.disclaimer}>{CANDIDATE_PRIVACY_DISCLAIMER}</Text>

      <LiveVTONativeViewPlaceholder style={styles.preview} />

      <Text style={styles.guidance}>{ready ? guidance : 'not started'}</Text>

      <Button
        title="start (no-op: native module not built)"
        onPress={() => {
          // TODO: real native view ref call once LiveVTO exists — see
          // packages/live-vto-contract/src/nativeView.ts LiveVTOCommands.start().
          void placeholderGarment;
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  title: { fontWeight: '600' },
  disclaimer: { fontSize: 12, opacity: 0.7, textAlign: 'center', paddingHorizontal: 24 },
  preview: { width: '80%', aspectRatio: 3 / 4, backgroundColor: '#111', alignItems: 'center', justifyContent: 'center' },
  placeholder: { alignItems: 'center', justifyContent: 'center' },
  placeholderText: { color: '#888', fontSize: 12, textAlign: 'center', paddingHorizontal: 12 },
  guidance: { fontWeight: '500' },
});
