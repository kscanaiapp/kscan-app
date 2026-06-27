// Temporary local prototype shape. Aligns with native Android repo FashionAnalyzeResult.
// Will be replaced by canonical backend contract after backend consolidation completes.

export type GlassesCaptureState =
  | 'idle'
  | 'previewing'
  | 'capturing'
  | 'analyzing'
  | 'result'
  | 'error';

export type GlassesPrivacyStatus =
  | 'local_only'
  | 'masking_ready'
  | 'upload_ready'
  | 'uploaded';

export interface GlassesPrototypeSession {
  id: string;
  state: GlassesCaptureState;
  startedAt: string;
  endedAt?: string;
}

export interface GlassesCaptureInput {
  mockTriggerId?: string;
}

export interface GlassesMockResult {
  id: string;
  title: string;
  summary: string;
  category: string;
  color?: string;
  silhouette?: string;
  confidence: number;
  privacyStatus: GlassesPrivacyStatus;
  createdAt: string;

  // LOCAL-ONLY preview. Never send to backend.
  imagePreviewUri?: string;
}

export interface GlassesAnalysisError {
  code: string;
  message: string;
}
