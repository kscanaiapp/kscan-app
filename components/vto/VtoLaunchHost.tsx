/**
 * The shared Virtual Try-On launch host.
 *
 * WHY THIS EXISTS. Virtual Try-On is a contextual capability with more than one
 * way in: a product card, and an offer Elise's conversation carries. Both must
 * reach the SAME governed surface -- one sheet, one request lifecycle, one
 * consent step -- so the part that is genuinely common lives here instead of
 * being re-implemented per entry point:
 *
 *   - whether the sheet is open, and whether it is collapsed;
 *   - the single VirtualTryOnSheet mount;
 *   - the minimized pill and the way back from it;
 *   - the awareness history every opening and every result updates.
 *
 * WHAT STAYS WITH THE ENTRY POINT. Whether a control is offered at all, what it
 * says, the K+ conversation, and how a garment is adapted from its source.
 * This host is handed a garment that is already launchable; it decides nothing
 * about eligibility or entitlement, and it cannot start a request or choose a
 * photo -- the sheet still asks for both, exactly as before.
 *
 * It is not a second sheet and not a second store: the sheet below is the only
 * one in the app, and the request state it binds is still the one module-scoped
 * store in services/vto/vtoRequestStore.ts.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';

import { useVtoAwarenessBlocker } from '../../hooks/useVtoAwareness';
import { useVtoSessionStatus } from '../../hooks/useVtoSessionStatus';
import { selectionTick } from '../../services/haptics';
import { markVtoCompleted, markVtoInitiated } from '../../services/vto/vtoAwareness';
import type { VtoCapability } from '../../services/vto/vtoLiveCapability';
import { emitVtoEvent } from '../../services/vto/vtoTelemetry';
import { VirtualTryOnSheet } from './VirtualTryOnSheet';
import { VtoMinimizedPill } from './VtoMinimizedPill';
import type { VtoGarmentInput, VtoInlineGarmentLoader, VtoOrigin } from '../../types/vto';

export interface VtoLaunchState {
  /** True from an explicit open until the sheet is closed. */
  sheetVisible: boolean;
  /** True while the open sheet is collapsed to its pill. */
  minimized: boolean;
  /** Read-only view of the running generation. */
  session: ReturnType<typeof useVtoSessionStatus>;
  /** Opens the sheet. The ONE way in. */
  open: () => void;
  close: () => void;
  minimize: () => void;
  restore: () => void;
  /** Collapses the sheet and hands control to the host's own Watch surface. */
  watchFromTryOn: () => void;
}

/**
 * The launch lifecycle, held by whichever entry point owns this try-on.
 *
 * State lives in the caller's component on purpose: it is per entry, so only
 * the card or message that opened a try-on shows its sheet and its pill.
 */
export function useVtoLaunchHost({
  origin,
  onWatch,
}: {
  origin: VtoOrigin;
  onWatch?: () => void;
}): VtoLaunchState {
  const [sheetVisible, setSheetVisible] = useState(false);
  const [minimized, setMinimized] = useState(false);
  // Read-only: observing the running generation must not claim authority over
  // it. See hooks/useVtoSessionStatus.ts.
  const session = useVtoSessionStatus();

  const open = useCallback(() => {
    // Opening the try-on surface is what retires the Home introduction.
    markVtoInitiated();
    setMinimized(false);
    setSheetVisible(true);
  }, []);

  const close = useCallback(() => {
    setMinimized(false);
    setSheetVisible(false);
  }, []);

  const minimize = useCallback(() => {
    setMinimized(true);
  }, []);

  const restore = useCallback(() => {
    selectionTick();
    emitVtoEvent('vto_restored', { origin });
    setMinimized(false);
  }, [origin]);

  const watchFromTryOn = useCallback(() => {
    if (!onWatch) return;
    // Native watch UI must not stack over the VTO Modal. Keep the result alive
    // and expose a truthful return affordance while Commerce owns the action.
    setMinimized(true);
    onWatch();
  }, [onWatch]);

  // A result on screen is the "completed" half of the awareness history.
  useEffect(() => {
    if (sheetVisible && session.status === 'success') markVtoCompleted();
  }, [session.status, sheetVisible]);

  // While this entry's own sheet is up, no first-use cue appears anywhere.
  useVtoAwarenessBlocker(sheetVisible && !minimized);

  return { sheetVisible, minimized, session, open, close, minimize, restore, watchFromTryOn };
}

/**
 * The identity of the garment a try-on was opened for: the product reference
 * AND what the source says it is (an owned Closet item, or a user-supplied
 * garment by content hash). Two garments with different identities are never
 * the same try-on, whatever the parent passes next.
 */
export function vtoGarmentLaunchIdentity(garment: VtoGarmentInput): string {
  const source = garment.source;
  if (!source) return `ref:${garment.productRef}`;
  if (source.type === 'closet_item') return `closet:${source.closetItemId}|${garment.productRef}`;
  return `supplied:${source.contentHash}|${garment.productRef}`;
}

export interface VtoLaunchHostProps {
  launch: VtoLaunchState;
  garment: VtoGarmentInput;
  garmentTitle: string;
  origin: VtoOrigin;
  /** Absent when the garment has no authoritative commerce destination. */
  onShop?: () => void;
  /** Absent when the garment has no watchable listing. */
  onWatch?: () => void;
  /** Retailer size-guide page, when Commerce has one. Presentation only. */
  sizeGuideUrl?: string | null;
  devScenario?: string;
  capability?: VtoCapability;
  /** Reads a user-supplied garment's bytes at generation time. */
  loadInlineGarment?: VtoInlineGarmentLoader;
  testID?: string;
}

export function VtoLaunchHost({
  launch,
  garment,
  garmentTitle,
  origin,
  onShop,
  onWatch,
  sizeGuideUrl,
  devScenario,
  capability,
  loadInlineGarment,
  testID,
}: VtoLaunchHostProps) {
  const { sheetVisible, minimized, session, close: closeSheet, restore: restoreSheet } = launch;
  const { minimize, watchFromTryOn } = launch;

  // PIN THE GARMENT THE CUSTOMER TAPPED. The sheet follows whatever `garment`
  // it is handed (useVirtualTryOn re-attaches the session photo when the
  // product reference changes), so a parent that re-renders this entry with a
  // different garment while a try-on is open would silently turn it into a
  // different garment -- and its Shop and Watch actions with it. The garment,
  // its title and its actions are therefore captured when the sheet opens, and
  // if the identity later differs they stay as captured until the sheet closes.
  // An unchanged identity passes through untouched (a refreshed image URL for
  // the same garment still arrives).
  const openedFor = useRef<{
    identity: string;
    garment: VtoGarmentInput;
    garmentTitle: string;
    onShop?: () => void;
    onWatch?: () => void;
    sizeGuideUrl?: string | null;
    loadInlineGarment?: VtoInlineGarmentLoader;
  } | null>(null);
  const identity = vtoGarmentLaunchIdentity(garment);
  if (!sheetVisible) {
    openedFor.current = null;
  } else if (openedFor.current === null) {
    openedFor.current = { identity, garment, garmentTitle, onShop, onWatch, sizeGuideUrl, loadInlineGarment };
  }
  const pinned = sheetVisible && openedFor.current !== null && openedFor.current.identity !== identity
    ? openedFor.current
    : null;
  const shownGarment = pinned ? pinned.garment : garment;
  const shownTitle = pinned ? pinned.garmentTitle : garmentTitle;
  const shownShop = pinned ? pinned.onShop : onShop;
  const shownWatch = pinned ? pinned.onWatch : onWatch;
  const shownSizeGuide = pinned ? pinned.sizeGuideUrl : sizeGuideUrl;
  const shownLoader = pinned ? pinned.loadInlineGarment : loadInlineGarment;
  // The launch state's own Watch handler was built from the CURRENT entry's
  // onWatch; while pinned, route to the pinned garment's instead.
  const shownWatchFromTryOn = !shownWatch
    ? undefined
    : pinned
      ? () => { minimize(); shownWatch(); }
      : watchFromTryOn;

  return (
    <>
      {/*
          Mounted only while open, deliberately. The sheet binds the
          module-scoped VTO store and tears the operation down on unmount, so
          an always-mounted copy per entry would mean any entry re-rendering
          could wipe an in-flight try-on started from another. One entry, one
          sheet, one operation.
      */}
      {sheetVisible ? (
        <VirtualTryOnSheet
          visible={!minimized}
          onClose={closeSheet}
          onMinimize={minimize}
          garment={shownGarment}
          garmentTitle={shownTitle}
          origin={origin}
          onShop={shownShop}
          onWatch={shownWatchFromTryOn}
          sizeGuideUrl={shownSizeGuide}
          devScenario={devScenario}
          loadInlineGarment={shownLoader}
          capability={capability}
        />
      ) : null}
      {/*
          MINIMIZED, NOT UNMOUNTED. The sheet above stays mounted while
          collapsed and is merely made invisible, because useVirtualTryOn calls
          leaveVtoSurface on unmount -- rendering it conditionally on
          `!minimized` would cancel the very generation the pill is reporting
          on. Only the owning entry shows a pill: `sheetVisible` is per-entry
          state, so other entries render nothing.
      */}
      {sheetVisible && minimized ? (
        <VtoMinimizedPill
          ready={session.status === 'success'}
          returnOnly={session.status !== 'preparing'
            && session.status !== 'generating'
            && session.status !== 'validating_result'}
          onPress={restoreSheet}
          testID={testID ? `${testID}-pill` : undefined}
        />
      ) : null}
    </>
  );
}
