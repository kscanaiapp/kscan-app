import React from 'react';
import { Modal } from 'react-native';

interface ResultSurfaceModalProps {
  onRequestClose: () => void;
  /**
   * Rendered as the LAST child INSIDE this native Modal. Anything that has to
   * appear above the scan result (the "Add to Dressing Room" sheet) must be
   * mounted through here, never as a sibling of the result surface.
   */
  overlay?: React.ReactNode;
  children: React.ReactNode;
}

/**
 * The native Modal both scan-result surfaces (ScanResultV2 and AnalysisCard)
 * render inside.
 *
 * WHY THE OVERLAY LIVES INSIDE IT. On iOS a Modal is presented from the view
 * controller that CONTAINS its host view: React Native's
 * RCTModalHostViewComponentView presents from `[self reactViewController]`, and
 * Libraries/Modal/Modal.js keeps no stack or queue. A Modal that is a SIBLING of
 * this one therefore resolves to the controller that is already presenting it,
 * UIKit refuses to present a second view controller from there, and React Native
 * is never told, so the tap looks like a no-op. A Modal declared inside this one
 * resolves to this Modal's own controller and presents normally. Android stacks
 * Dialogs and never needed the nesting; it is harmless there.
 *
 * Regression tests: __tests__/iosScanResultSheetNesting.test.js.
 */
export function ResultSurfaceModal({ onRequestClose, overlay, children }: ResultSurfaceModalProps) {
  return (
    <Modal transparent animationType="none" onRequestClose={onRequestClose}>
      {children}
      {overlay}
    </Modal>
  );
}
