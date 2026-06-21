import type { BridgeMessage } from './BridgeMessageTypes.js';
import { BluetoothSessionManager } from './BluetoothSessionManager.js';
import { SupabaseSessionRelay } from './SupabaseSessionRelay.js';
import { WifiTransferSession } from './WifiTransferSession.js';

export interface GoogleGlassesBridgeOptions {
  backendUrl: string;
  onMessage(message: BridgeMessage): void;
}

export class GoogleGlassesBridge {
  readonly sessionId: string;
  private readonly bluetooth = new BluetoothSessionManager();
  private readonly wifi = new WifiTransferSession();
  private readonly supabaseRelay = new SupabaseSessionRelay();
  private connected = false;

  constructor(private readonly options: GoogleGlassesBridgeOptions) {
    this.sessionId = `phone-${Date.now()}`;
  }

  async connect(): Promise<void> {
    // TODO: Android XR projected pairing flow
    this.connected = true;
    await this.bluetooth.start();
    await this.supabaseRelay.connect(this.sessionId);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    await this.bluetooth.stop();
    await this.wifi.close();
    await this.supabaseRelay.disconnect();
  }

  async send(message: BridgeMessage): Promise<void> {
    if (!this.connected) {
      throw new Error('BRIDGE_NOT_CONNECTED');
    }
    // Control lane — no image payloads in logs
    await this.bluetooth.send(JSON.stringify({ type: message.type, sessionId: message.sessionId }));
    this.options.onMessage(message);
  }
}
