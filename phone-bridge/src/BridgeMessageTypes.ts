export type BridgeMessageType =
  | 'HELLO'
  | 'DEVICE_STATE'
  | 'REQUEST_PERMISSIONS'
  | 'PERMISSIONS_RESULT'
  | 'CAPTURE_PHOTO'
  | 'PHOTO_CAPTURED'
  | 'PHOTO_ERROR'
  | 'ANALYSIS_STARTED'
  | 'ANALYSIS_RESULT'
  | 'SAVE_ITEM'
  | 'OPEN_ON_PHONE'
  | 'AUTH_SESSION'
  | 'ERROR';

export interface BridgeMessage<T = Record<string, unknown>> {
  type: BridgeMessageType;
  timestamp: number;
  sessionId: string;
  requestId?: string;
  payload?: T;
}

export interface BridgeErrorPayload {
  code: string;
  message: string;
  recoverable?: boolean;
}

export const BRIDGE_MESSAGE_TYPES: BridgeMessageType[] = [
  'HELLO',
  'DEVICE_STATE',
  'REQUEST_PERMISSIONS',
  'PERMISSIONS_RESULT',
  'CAPTURE_PHOTO',
  'PHOTO_CAPTURED',
  'PHOTO_ERROR',
  'ANALYSIS_STARTED',
  'ANALYSIS_RESULT',
  'SAVE_ITEM',
  'OPEN_ON_PHONE',
  'AUTH_SESSION',
  'ERROR',
];
