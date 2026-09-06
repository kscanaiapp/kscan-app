import Foundation
import CoreImage
import CoreMedia
import UIKit

/// N1-F (iOS parity): converts an `AVCaptureVideoDataOutput` sample buffer's
/// `CVPixelBuffer` into the `UIImage` the EXISTING perception provider
/// already expects (`LiveVtoStaticImageFrame` --
/// `../Perception/LiveVtoMediaPipePoseProvider.swift`). Structural
/// counterpart of Android's `LiveVtoCameraFrameConverter.kt`.
///
/// ── The mirror decision (matches Android's converter exactly) ────────────
///
/// Applied ONCE, here, to the actual pixel buffer handed to MediaPipe --
/// never anywhere else. `LiveVtoBodyFrameAdapter`'s own header documents
/// BodyFrame's contract as front-camera-mirrored and defers the flip to
/// "the camera-input layer" -- this is that layer. `AVCaptureVideoPreviewLayer`
/// mirrors the live front-camera preview automatically (its documented
/// default `automaticallyAdjustsMirroring` behaviour), so the mesh (derived
/// from a `BodyFrame` computed off this SAME already-oriented-and-mirrored
/// buffer) lines up with the displayed preview with no second, independent
/// flip anywhere in the render path. The garment texture's own pixels are
/// never touched here or anywhere downstream.
///
/// ── Orientation (documented, revisitable simplification) ──────────────────
///
/// `LiveVtoCameraController` pins the capture connection's `videoOrientation`
/// to `.portrait` (this lane does not support device rotation for the Live
/// VTO camera screen, matching a typical portrait-only try-on UX). For a
/// FRONT camera with a portrait-pinned connection, `.leftMirrored` is the
/// well-established constant EXIF orientation that yields an upright,
/// mirrored image directly -- front and back cameras are mounted with
/// opposite physical rotations, which is why the back camera's equivalent
/// constant is `.right`, not `.left`. Revisit only if this feature ever
/// needs to support landscape device rotation.
enum LiveVtoCameraFrameConverter {
  /// Reused across frames rather than constructed per-call -- `CIContext`
  /// construction has real overhead, and this pipeline is explicitly bounded
  /// (mission section 8), not something a slow per-frame allocation should
  /// make worse.
  private static let context = CIContext()

  static func toImage(sampleBuffer: CMSampleBuffer) -> UIImage? {
    guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return nil }
    let oriented = CIImage(cvPixelBuffer: pixelBuffer).oriented(.leftMirrored)
    guard let cgImage = context.createCGImage(oriented, from: oriented.extent) else { return nil }
    return UIImage(cgImage: cgImage)
  }
}
