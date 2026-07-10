import { SCAN_CONTRACT_VERSION } from './version';
import type { FashionAttributes } from './fashionAttributes';
import type { ProductMatch } from './productMatch';
import type { ScanError } from './errors';

/**
 * Top-level status of a scan response.
 */
export type ScanStatus =
  | 'success'
  | 'non_fashion'
  | 'partial'
  | 'error';

export interface ScanProcessingMeta {
  provider?: string;
  parserVersion?: string;
  promptVersion?: string;
  latencyMs?: number;
}

export interface ScanResponse {
  contractVersion: string;
  requestId: string;
  status: ScanStatus;
  attributes?: FashionAttributes;
  products?: ProductMatch[];
  message?: string;
  processing?: ScanProcessingMeta;
  error?: ScanError;
}

/**
 * Build a successful scan response.
 */
export function buildScanResponse(
  requestId: string,
  status: ScanStatus,
  payload?: {
    attributes?: FashionAttributes;
    products?: ProductMatch[];
    message?: string;
    processing?: ScanProcessingMeta;
    error?: ScanError;
  },
): ScanResponse {
  return {
    contractVersion: SCAN_CONTRACT_VERSION,
    requestId,
    status,
    attributes: payload?.attributes,
    products: payload?.products,
    message: payload?.message,
    processing: payload?.processing,
    error: payload?.error,
  };
}
