import React from 'react';
import { DressingRoomsIcon } from './DressingRoomsIcon';
import { RecentScansIcon } from './RecentScansIcon';
import { SaveOrganizeIcon } from './SaveOrganizeIcon';
import { StyleIcon } from './StyleIcon';
import { TextScanIcon } from './TextScanIcon';
import { VisualSearchIcon } from './VisualSearchIcon';
import type {
  KScanIconComponent,
  KScanIconName,
  KScanIconProps,
} from './iconTypes';

/**
 * Semantic registry — screens should reference names, not raw SVG paths.
 */
export const KSCAN_ICON_REGISTRY = {
  'dressing-rooms': DressingRoomsIcon,
  textscan: TextScanIcon,
  'recent-scans': RecentScansIcon,
  'visual-search': VisualSearchIcon,
  'save-organize': SaveOrganizeIcon,
  style: StyleIcon,
} as const satisfies Record<KScanIconName, KScanIconComponent>;

export const KSCAN_ICON_NAMES = Object.keys(KSCAN_ICON_REGISTRY) as KScanIconName[];

export function isKScanIconName(value: string): value is KScanIconName {
  return Object.prototype.hasOwnProperty.call(KSCAN_ICON_REGISTRY, value);
}

/**
 * Typed product-icon entry point.
 * Invalid names are rejected at compile time; runtime unknown names render nothing.
 */
export function KScanIcon({ name, ...glyphProps }: KScanIconProps) {
  if (!isKScanIconName(name)) {
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
      console.warn(`[KScanIcon] Unknown icon name: ${String(name)}`);
    }
    return null;
  }
  const Glyph = KSCAN_ICON_REGISTRY[name];
  return <Glyph {...glyphProps} />;
}
