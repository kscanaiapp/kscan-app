/** TODO: High-bandwidth photo transfer when Wi-Fi direct available */
export class WifiTransferSession {
  async open(): Promise<void> {
    // stub
  }

  async close(): Promise<void> {
    // stub
  }

  async sendImageRef(_requestId: string, _ref: string): Promise<void> {
    throw new Error('WifiTransferSession not implemented');
  }
}
