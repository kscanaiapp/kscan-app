import type { AnalyzeResult, DeviceStateSnapshot } from '../../shared/result-types.js';
import type { BridgeMessage } from './BridgeMessageTypes.js';
import { GoogleGlassesBridge } from './GoogleGlassesBridge.js';

/** Minimal Supabase shape — real app passes @supabase/supabase-js client */
export interface SupabaseLike {
  channel(name: string): { subscribe(): unknown; send(payload: unknown): unknown };
}

export interface KScanGoogleGlassesBridgeOptions {
  supabase: SupabaseLike | null;
  backendUrl: string;
  onScanResult(result: AnalyzeResult): void;
  onDeviceState(state: DeviceStateSnapshot): void;
  onError(error: Error): void;
}

export class KScanGoogleGlassesBridge {
  private readonly options: KScanGoogleGlassesBridgeOptions;
  private readonly inner: GoogleGlassesBridge;
  private running = false;

  constructor(options: KScanGoogleGlassesBridgeOptions) {
    this.options = options;
    this.inner = new GoogleGlassesBridge({
      backendUrl: options.backendUrl,
      onMessage: (msg) => this.handleMessage(msg),
    });
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.inner.connect();
    await this.inner.send({
      type: 'HELLO',
      timestamp: Date.now(),
      sessionId: this.inner.sessionId,
      payload: { client: 'phone', version: '0.1.0-alpha' },
    });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    await this.inner.disconnect();
  }

  async sendAuthSession(): Promise<void> {
    // TODO: relay opaque session blob from Supabase auth — never log token
    await this.inner.send({
      type: 'AUTH_SESSION',
      timestamp: Date.now(),
      sessionId: this.inner.sessionId,
      payload: { relay: 'stub' },
    });
  }

  async capturePhotoForGlasses(requestId: string): Promise<void> {
    await this.inner.send({
      type: 'CAPTURE_PHOTO',
      timestamp: Date.now(),
      sessionId: this.inner.sessionId,
      requestId,
      payload: { preferSource: 'phone' },
    });
  }

  async openProductOnPhone(url: string): Promise<void> {
    await this.inner.send({
      type: 'OPEN_ON_PHONE',
      timestamp: Date.now(),
      sessionId: this.inner.sessionId,
      requestId: String(url.length),
      payload: { url },
    });
  }

  private handleMessage(message: BridgeMessage): void {
    switch (message.type) {
      case 'ANALYSIS_RESULT':
        // payload.result typed at integration boundary
        this.options.onScanResult(message.payload as unknown as AnalyzeResult);
        break;
      case 'DEVICE_STATE':
        this.options.onDeviceState(message.payload as unknown as DeviceStateSnapshot);
        break;
      case 'ERROR': {
        const payload = message.payload as { message?: string };
        this.options.onError(new Error(payload?.message ?? 'Bridge error'));
        break;
      }
      default:
        break;
    }
  }
}
