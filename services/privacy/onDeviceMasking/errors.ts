export class OnDevicePrivacyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OnDevicePrivacyError';
  }
}

export class UnsupportedCodecError extends OnDevicePrivacyError {
  constructor(message = 'No supported local image codec is available.') {
    super(message);
    this.name = 'UnsupportedCodecError';
  }
}

export class UnsupportedDetectorError extends OnDevicePrivacyError {
  constructor(regionType: string) {
    super(`On-device ${regionType} detection is not supported in this build.`);
    this.name = 'UnsupportedDetectorError';
  }
}

export class InvalidBufferError extends OnDevicePrivacyError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidBufferError';
  }
}

export class MaskingVerificationError extends OnDevicePrivacyError {
  constructor(message: string) {
    super(message);
    this.name = 'MaskingVerificationError';
  }
}
