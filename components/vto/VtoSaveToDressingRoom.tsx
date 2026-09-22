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
 * upload and error copy stay in one place. It asks that surface for its
 * try-on copy variant: the scan-era "avoid faces" guidance is wrong for an
 * image the customer deliberately put themselves in (BLOCK-VTO-DL-20).
 *
 * SAVED MEANS CONFIRMED. The "Saved to <room>" state is set only from the
 * modal's `onSaved`, which fires after the Dressing Room write resolves --
 * never on tap, never on modal open (BLOCK-VTO-DL-21). It belongs to ONE
 * result: a new result (Try again), no result (actor reset, cancel), or
 * unmounting clears it and deletes any cache copy still on disk
 * (BLOCK-VTO-DL-22), so a confirmation can never describe a different image.
 *
 * FIRST_CLASS_VTO_PROVENANCE = NO. The item is saved under the existing
 * 'upload_inspiration' kind; a dedicated try-on kind is a backend decision
 * (BACKEND_FOLLOWUP_REQUIRED) and is not invented here.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';

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
  /** Closes the try-on sheet before "View Dressing Room" navigates, so the
   *  sheet is not left open on top of the destination. */
  onLeaveForDressingRoom?: () => void;
  style?: ViewStyle;
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
  onLeaveForDressingRoom,
  style,
  testID,
}: VtoSaveToDressingRoomProps) {
  const [exportedUri, setExportedUri] = useState<string | null>(null);
  const [modalVisible, setModalVisible] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [savedTo, setSavedTo] = useState<string | null>(null);
  const busyRef = useRef(false);
  // Mirrors `exportedUri` for the cleanup below, which must see the latest
  // value without re-subscribing on every change.
  const exportedRef = useRef<string | null>(null);
  exportedRef.current = exportedUri;
  const dataUriRef = useRef(dataUri);
  dataUriRef.current = dataUri;

  // The save state belongs to ONE result. When the result changes or goes
  // away -- a new attempt, a cancel, an actor reset, the sheet closing -- the
  // confirmation is dropped and any cache copy of the old image is deleted.
  useEffect(() => {
    setSavedTo(null);
    setError(null);
    setModalVisible(false);
    return () => {
      const uri = exportedRef.current;
      exportedRef.current = null;
      setExportedUri(null);
      if (uri) void discardVtoResultExport(uri);
    };
  }, [dataUri]);

  const handlePress = useCallback(async () => {
    if (busyRef.current || !dataUri) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      // The ONLY place a try-on result becomes a file on disk.
      const exported = await exportVtoResultToCache({ dataUri, requestId });
      // The result changed (or vanished) while the file was being written:
      // this copy describes an image the sheet no longer shows. Delete it.
      if (dataUriRef.current !== dataUri) {
        void discardVtoResultExport(exported.localUri);
        return;
      }
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

  const handleSaved = useCallback((roomTitle: string) => {
    setSavedTo(roomTitle);
    emitVtoEvent('vto_result_saved', { origin });
  }, [origin]);

  const handleClose = useCallback(() => {
    setModalVisible(false);
    // Whether the user saved or backed out, the cache copy has served its
    // purpose: a completed save already uploaded the bytes, and an abandoned
    // one must leave nothing behind.
    const uri = exportedUri;
    exportedRef.current = null;
    setExportedUri(null);
    void discardVtoResultExport(uri);
  }, [exportedUri]);

  if (!dataUri) return null;

  return (
    <View style={[styles.wrap, style]} testID={testID ?? 'vto-save-to-dressing-room'}>
      <SecondaryButton
        title={savedTo ? 'Save to another room' : 'Save this try-on'}
        onPress={() => {
          selectionTick();
          void handlePress();
        }}
        disabled={busy}
        loading={busy}
        accessibilityHint="Choose a Dressing Room to keep this try-on in"
        testID="vto-save-button"
      />
      {savedTo ? (
        <InlineNotice
          variant="success"
          body={`Saved to ${savedTo}.`}
          accessibilityRole="alert"
          testID="vto-save-confirmed"
          style={styles.notice}
        />
      ) : null}
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
          variant="vto_try_on"
          localImageUri={exportedUri}
          onClose={handleClose}
          onSaved={handleSaved}
          onBeforeNavigate={onLeaveForDressingRoom}
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
  },
  notice: {
    marginTop: SPACING.sm,
  },
});
