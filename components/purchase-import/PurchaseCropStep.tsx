// Receipt & Purchase Intelligence V1 — the REQUIRED line-item crop.
//
// This is the data-minimization boundary for Privacy Path B (see
// docs/receipt-intelligence/00-phase0-decision-log.md). K Scan has no on-device
// text redaction, so the customer frames the purchased items and leaves out
// addresses, contact details and payment information BEFORE anything leaves
// the device.
//
// It cannot be skipped: the only way forward is "Read purchases", which sends
// the cropped region and nothing else. The customer also confirms what the crop
// contains, and the copy never claims that cropping guarantees nothing
// sensitive remains.
//
// Accessibility: each edge is an `adjustable` control. VoiceOver and TalkBack
// users move it in 5% steps with the standard swipe-up and swipe-down
// gestures. Nothing depends on dragging.

import React, { useMemo, useRef, useState } from 'react';
import {
  Image,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
  type AccessibilityActionEvent,
  type LayoutChangeEvent,
} from 'react-native';
import { InlineNotice, PrimaryButton, SecondaryButton } from '../luxury';
import { LUXURY, RADIUS, SPACING, FONTS } from '../../constants/theme';
import { MIN_CROP_FRACTION, type NormalizedCrop } from '../../services/purchaseImport/purchaseImportImage';
import { selectionTick } from '../../services/haptics';

type Edge = 'top' | 'bottom' | 'left' | 'right';

const STEP = 0.05;
const MAX_PREVIEW_HEIGHT = 440;

export function PurchaseCropStep({
  imageUri,
  imageWidth,
  imageHeight,
  onConfirm,
  onCancel,
}: {
  imageUri: string;
  imageWidth: number;
  imageHeight: number;
  onConfirm: (crop: NormalizedCrop) => void;
  onCancel: () => void;
}) {
  const [crop, setCrop] = useState<NormalizedCrop>({ x: 0, y: 0, width: 1, height: 1 });
  const [acknowledged, setAcknowledged] = useState(false);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const cropRef = useRef(crop);
  cropRef.current = crop;
  const startRef = useRef(crop);

  const aspect = imageWidth > 0 && imageHeight > 0 ? imageHeight / imageWidth : 1;
  const displayHeight = box.width ? Math.min(box.width * aspect, MAX_PREVIEW_HEIGHT) : 0;
  const displayWidth = displayHeight && aspect ? displayHeight / aspect : box.width;

  const moveEdge = (current: NormalizedCrop, edge: Edge, delta: number): NormalizedCrop => {
    let { x, y, width, height } = current;
    if (edge === 'top') {
      const bottom = y + height;
      y = Math.min(Math.max(0, y + delta), bottom - MIN_CROP_FRACTION);
      height = bottom - y;
    } else if (edge === 'bottom') {
      height = Math.min(Math.max(MIN_CROP_FRACTION, height + delta), 1 - y);
    } else if (edge === 'left') {
      const right = x + width;
      x = Math.min(Math.max(0, x + delta), right - MIN_CROP_FRACTION);
      width = right - x;
    } else {
      width = Math.min(Math.max(MIN_CROP_FRACTION, width + delta), 1 - x);
    }
    return { x, y, width, height };
  };

  const responders = useMemo(() => {
    const make = (edge: Edge) =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          startRef.current = cropRef.current;
        },
        onPanResponderMove: (_evt, gesture) => {
          const vertical = edge === 'top' || edge === 'bottom';
          const extent = vertical ? displayHeight : displayWidth;
          if (!extent) return;
          const delta = (vertical ? gesture.dy : gesture.dx) / extent;
          setCrop(moveEdge(startRef.current, edge, delta));
        },
        onPanResponderRelease: () => selectionTick(),
      });
    return {
      top: make('top'),
      bottom: make('bottom'),
      left: make('left'),
      right: make('right'),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayHeight, displayWidth]);

  const onAccessibilityAction = (edge: Edge) => (event: AccessibilityActionEvent) => {
    // The announced value is the edge's position, so "increment" always moves
    // the edge toward a larger percentage (down or right), whichever edge it is.
    const delta = event.nativeEvent.actionName === 'increment' ? STEP : -STEP;
    setCrop((c) => moveEdge(c, edge, delta));
  };

  const edgeLabel: Record<Edge, string> = {
    top: 'Top edge of crop',
    bottom: 'Bottom edge of crop',
    left: 'Left edge of crop',
    right: 'Right edge of crop',
  };
  const edgeValue = (edge: Edge) => {
    const pct = (n: number) => `${Math.round(n * 100)} percent`;
    if (edge === 'top') return pct(crop.y);
    if (edge === 'bottom') return pct(crop.y + crop.height);
    if (edge === 'left') return pct(crop.x);
    return pct(crop.x + crop.width);
  };

  const frame = {
    left: crop.x * displayWidth,
    top: crop.y * displayHeight,
    width: crop.width * displayWidth,
    height: crop.height * displayHeight,
  };

  return (
    <View style={styles.root} testID="purchase-import-crop">
      <Text style={styles.kicker}>Step 2 of 3 · Crop</Text>
      <Text style={styles.heading}>Frame only what you bought</Text>
      <Text style={styles.body}>
        Drag the edges so the crop shows the purchased items: names, sizes, colours and prices. Leave out
        shipping and billing addresses, your name and contact details, and payment information.
      </Text>

      <View
        style={styles.stage}
        onLayout={(e: LayoutChangeEvent) =>
          setBox({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })
        }
      >
        {displayHeight > 0 ? (
          <View style={{ width: displayWidth, height: displayHeight }}>
            <Image
              source={{ uri: imageUri }}
              style={{ width: displayWidth, height: displayHeight }}
              resizeMode="stretch"
              accessibilityIgnoresInvertColors
              accessible={false}
            />
            {/* Dim everything outside the crop, so what will be sent is obvious. */}
            <View pointerEvents="none" style={[styles.shade, { top: 0, left: 0, right: 0, height: frame.top }]} />
            <View
              pointerEvents="none"
              style={[styles.shade, { top: frame.top + frame.height, left: 0, right: 0, bottom: 0 }]}
            />
            <View
              pointerEvents="none"
              style={[styles.shade, { top: frame.top, left: 0, width: frame.left, height: frame.height }]}
            />
            <View
              pointerEvents="none"
              style={[
                styles.shade,
                { top: frame.top, left: frame.left + frame.width, right: 0, height: frame.height },
              ]}
            />
            <View pointerEvents="none" style={[styles.frame, frame]} />

            {(['top', 'bottom', 'left', 'right'] as Edge[]).map((edge) => {
              const vertical = edge === 'top' || edge === 'bottom';
              const pos = vertical
                ? {
                    left: frame.left + frame.width / 2 - 36,
                    top: (edge === 'top' ? frame.top : frame.top + frame.height) - 18,
                  }
                : {
                    top: frame.top + frame.height / 2 - 36,
                    left: (edge === 'left' ? frame.left : frame.left + frame.width) - 18,
                  };
              return (
                <View
                  key={edge}
                  {...responders[edge].panHandlers}
                  style={[styles.handleHit, vertical ? styles.handleHitH : styles.handleHitV, pos]}
                  accessible
                  accessibilityRole="adjustable"
                  accessibilityLabel={edgeLabel[edge]}
                  accessibilityValue={{ text: edgeValue(edge) }}
                  accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
                  onAccessibilityAction={onAccessibilityAction(edge)}
                  testID={`purchase-import-crop-${edge}`}
                >
                  <View style={vertical ? styles.handleBarH : styles.handleBarV} />
                </View>
              );
            })}
          </View>
        ) : null}
      </View>

      <Pressable
        onPress={() => {
          selectionTick();
          setAcknowledged((v) => !v);
        }}
        style={styles.ackRow}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: acknowledged }}
        accessibilityLabel="My crop shows only the purchased items"
        testID="purchase-import-crop-acknowledge"
      >
        <View style={[styles.checkbox, acknowledged ? styles.checkboxOn : null]}>
          <Text style={styles.checkmark}>{acknowledged ? '✓' : ''}</Text>
        </View>
        <Text style={styles.ackText}>My crop shows only the purchased items</Text>
      </Pressable>

      <InlineNotice
        variant="info"
        body="Only the cropped area is sent to be read, and it isn’t kept. Cropping reduces what’s shared, but it can’t guarantee every personal detail is excluded, so check the edges."
        testID="purchase-import-crop-notice"
      />

      <View style={styles.actions}>
        <PrimaryButton
          title="Read Purchases"
          onPress={() => onConfirm(crop)}
          disabled={!acknowledged}
          accessibilityHint={acknowledged ? undefined : 'Confirm the crop shows only purchased items first'}
          testID="purchase-import-crop-confirm"
        />
        <SecondaryButton title="Choose Another Image" onPress={onCancel} testID="purchase-import-crop-cancel" />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: SPACING.md },
  kicker: { ...LUXURY.typography.sectionLabel },
  heading: { ...LUXURY.typography.displayTitle },
  body: { ...LUXURY.typography.body },
  stage: {
    width: '100%',
    alignItems: 'center',
    backgroundColor: LUXURY.colors.plumDeep,
    borderRadius: RADIUS.md,
    paddingVertical: SPACING.md,
    overflow: 'hidden',
  },
  shade: { position: 'absolute', backgroundColor: 'rgba(12, 8, 20, 0.62)' },
  frame: {
    position: 'absolute',
    borderWidth: 2,
    borderColor: LUXURY.colors.goldChampagne,
    borderRadius: 4,
  },
  handleHit: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
  handleHitH: { width: 72, height: 36 },
  handleHitV: { width: 36, height: 72 },
  handleBarH: { width: 44, height: 6, borderRadius: 3, backgroundColor: LUXURY.colors.goldChampagne },
  handleBarV: { width: 6, height: 44, borderRadius: 3, backgroundColor: LUXURY.colors.goldChampagne },
  ackRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md, paddingVertical: SPACING.sm },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: LUXURY.colors.plum,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxOn: { backgroundColor: LUXURY.colors.plum },
  checkmark: { color: LUXURY.colors.inverse, fontSize: 15, fontFamily: FONTS.sans, fontWeight: '700' },
  ackText: { ...LUXURY.typography.bodyStrong, flex: 1, color: LUXURY.colors.ink },
  actions: { gap: SPACING.sm },
});
