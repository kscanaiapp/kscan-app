// swift-tools-version:5.9
import PackageDescription

/// SwiftPM manifest for the PURE-LOGIC half of the Live VTO iOS native
/// module -- the Swift equivalent of Android's `:kscan-live-vto-native:testDebugUnitTest`
/// JVM unit test task.
///
/// `LiveVtoCore` points at `ios/Core`, which holds the exact same Swift
/// source files the real Expo module's podspec also compiles (via its own
/// `s.source_files = "**/*.{h,m,swift}"` glob) -- ONE set of files serving
/// TWO build systems, the same relationship Android's zero-Android-import
/// Kotlin files have to `RuntimeBoundaryTest`. `LiveVtoCore` itself has zero
/// UIKit, zero ExpoModulesCore, and zero MediaPipe imports (see
/// `LiveVtoRuntimeBoundaryTests.swift`), so `swift test` here proves the
/// geometry/deformation/replay/backpressure/perception-adapter math runs
/// correctly independent of Xcode's UIKit toolchain -- this package builds
/// and tests on any platform with a Swift 5.9+ toolchain, matching the
/// spirit (though not the OS) of the mission's "Linux SwiftPM" tier: no
/// local Linux Swift toolchain was available in the environment this port
/// was written in, so this evidence is produced by macOS CI's `swift test`
/// step instead -- see docs/vto-live-bridge-contract.md.
let package = Package(
  name: "LiveVtoCore",
  platforms: [.iOS(.v15), .macOS(.v12)],
  products: [
    .library(name: "LiveVtoCore", targets: ["LiveVtoCore"]),
  ],
  targets: [
    .target(
      name: "LiveVtoCore",
      path: "ios/Core"
    ),
    .testTarget(
      name: "LiveVtoCoreTests",
      dependencies: ["LiveVtoCore"],
      path: "Tests/LiveVtoCoreTests"
    ),
  ]
)
