/**
 * The ONE explicit, user-triggered path from a try-on result to durable
 * storage. Nothing else in VTO writes anything.
 *
 * WHY THIS IS A SEPARATE COMPONENT. VTO's privacy posture is that a result is
 * session-scoped: it lives in memory, is labelled as an AI visualization, and
 * disappears when the sheet closes. `__tests__/vtoPrivacyAndWiring.test.js`
 * enforces that by forbidding persistence imports in the sheet, the store, the
 * client and the entry point -- and that rule should stay exactly as strict as
 * it is. Saving is therefore quarantined here instead of being spread through
 * the sheet: one file, one button, one durable path, trivially auditable.
 *
 * THE RULE THIS COMPONENT MUST NOT BREAK. There is no auto-save. Mounting this
 * writes nothing; rendering it writes nothing. A file is materialized only
 * inside `handlePress`, and it is deleted again when the save flow closes, so
 * abandoning the flow leaves nothing behind. A result the user never
 * explicitly saved still vanishes with the sheet.
 *
 * It reuses the existing Dressing Room save surface (AddScanToDressingRoomModal)
 * rather than inventing a VTO-specific one, so room listing, room creation,
 * upload and error copy stay in one place.
 */

import React, { useCallback, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { AddScanToDressingRoomModal } from '../AddScanToDressingRoomModal';
import { InlineNotice, SecondaryButton } from '../luxury';
import { SPACING } from '../../constants/theme';
import { selectionTick } from '../../services/haptics';
import {
  discardVtoResultExport,
  exportVtoResultToCache,
} from '../../services/vto/vtoResultExport';
import { emitVtoEvent } from '../../services/vto/vtoTelemetry';
import type { VtoOrigin } from '../../types/vto';

export interface VtoSaveToDressingRoomProps {
  /** The validated result's data URI. Null until there is one to save. */
  dataUri: string | null;
  requestId: string | null;
  /** Fashion metadata carried from the commerce candidate, for the saved item. */
  category?: string | null;
  brand?: string | null;
  productRef?: string | null;
  origin: VtoOrigin;
  testID?: string;
}

const EXPORT_ERROR = 'This try-on could not be prepared for saving. Please try again.';

export function VtoSaveToDressingRoom({
  dataUri,
  requestId,
  category,
  brand,
  productRef,
  origin,
  testID,
}: VtoSaveToDressingRoomProps) {
  const [exportedUri, setExportedUri] = useState<string | null>(null);
  const [modalVisible, setModalVisible] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const handlePress = useCallback(async () => {
    if (busyRef.current || !dataUri) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      // The ONLY place a try-on result becomes a file on disk.
      const exported = await exportVtoResultToCache({ dataUri, requestId });
      setExportedUri(exported.localUri);
      setModalVisible(true);
      emitVtoEvent('vto_result_save_opened', { origin });
    } catch {
      // Provider/file detail is never surfaced; one honest recoverable message.
      setError(EXPORT_ERROR);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [dataUri, requestId, origin]);

  const handleClose = useCallback(() => {
    setModalVisible(false);
    // Whether the user saved or backed out, the cache copy has served its
    // purpose: a completed save already uploaded the bytes, and an abandoned
    // one must leave nothing behind.
    const uri = exportedUri;
    setExportedUri(null);
    void discardVtoResultExport(uri);
  }, [exportedUri]);

  if (!dataUri) return null;

  return (
    <View style={styles.wrap} testID={testID ?? 'vto-save-to-dressing-room'}>
      <SecondaryButton
        title="Save to Dressing Room"
        onPress={() => {
          selectionTick();
          void handlePress();
        }}
        disabled={busy}
        testID="vto-save-button"
      />
      {error ? (
        <InlineNotice
          variant="error"
          title="Couldn't prepare this try-on"
          body={error}
          accessibilityRole="alert"
          testID="vto-save-error"
          style={styles.notice}
        />
      ) : null}
      {modalVisible ? (
        <AddScanToDressingRoomModal
          visible
          localImageUri={exportedUri}
          onClose={handleClose}
          scan={{
            // 'upload_inspiration' is an EXISTING kind in the Dressing Room
            // taxonomy that maps to `inspiration_item`. A try-on is exactly
            // that -- a user-supplied image kept for inspiration -- so this
            // reuses the taxonomy rather than widening a guarded contract.
            sourceType: 'upload_inspiration',
            sourceId: productRef ?? null,
            createdAt: new Date().toISOString(),
            metadata: {
              category: category ?? null,
              brand: brand ?? null,
            },
          }}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignSelf: 'stretch',
    marginTop: SPACING.md,
  },
  notice: {
    marginTop: SPACING.sm,
  },
});
