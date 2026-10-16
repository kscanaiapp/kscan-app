import Foundation

/// A plain 2D float vector.
///
/// Field-for-field port of Android's `LiveVtoVec2.kt` (`Vec2`), itself
/// deliberately not `android.graphics.PointF` for the same reason this is
/// deliberately not `CGPoint`: every geometry stage of this runtime --
/// anchors, control-point targets, rigid fit, rigid gate, mesh deformation --
/// runs on this type and therefore has zero UIKit/ExpoModulesCore
/// dependencies, which is what makes the whole geometry pipeline runnable in
/// a plain SwiftPM host test (`swift test`), independent of a simulator or
/// device, and structurally incapable of touching a `UIView` or the main
/// thread.
///
/// Values are immutable; every operation returns a new instance.
public struct Vec2: Equatable, Hashable {
  public let x: Float
  public let y: Float

  public init(_ x: Float, _ y: Float) {
    self.x = x
    self.y = y
  }

  public static func + (a: Vec2, b: Vec2) -> Vec2 { Vec2(a.x + b.x, a.y + b.y) }
  public static func - (a: Vec2, b: Vec2) -> Vec2 { Vec2(a.x - b.x, a.y - b.y) }
  public static func * (a: Vec2, s: Float) -> Vec2 { Vec2(a.x * s, a.y * s) }

  public func length() -> Float { Float(Foundation.hypot(Double(x), Double(y))) }

  public func normalized() -> Vec2 {
    let l = length()
    return l < 1e-6 ? Vec2(0, 0) : Vec2(x / l, y / l)
  }

  /// True when either component is NaN or infinite -- the finite-ness guard every stage boundary checks.
  public var isFinite: Bool { x.isFinite && y.isFinite }
}

public func dot(_ a: Vec2, _ b: Vec2) -> Float { a.x * b.x + a.y * b.y }
