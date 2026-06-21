/** TODO: Request phone camera capture for glasses without camera */
export class PhotoCaptureRelay {
  async captureForGlasses(_requestId: string): Promise<{ mimeType: string; source: 'phone' }> {
    throw new Error('PhotoCaptureRelay not implemented');
  }
}
