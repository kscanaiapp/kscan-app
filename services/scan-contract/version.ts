/**
 * Logical version of the shared K Scan scan-analysis contract.
 *
 * This version identifies the request/response shape and adapter behavior.
 * It is independent of the AI parser/prompt versions used by the legacy
 * backend or the scan-identify edge function.
 */
export const SCAN_CONTRACT_VERSION = '1.0.0' as const;
