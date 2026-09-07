import Foundation

/// Resolves the CocoaPods resource bundle (`KScanLiveVtoNativeAssets.bundle`,
/// declared by `KScanLiveVtoNative.podspec`'s `resource_bundles`) holding the
/// governed garment fixtures and the bundled pose-landmarker model.
///
/// A dedicated `resource_bundles` entry -- rather than a plain `resources`
/// glob -- is the most portable CocoaPods convention for locating bundled
/// non-code files from Swift regardless of `use_frameworks!`/static-framework
/// configuration, since it always produces one `.bundle` at a knowable name
/// next to the pod's own compiled code, rather than relying on assumptions
/// about the app's main bundle layout.
enum LiveVtoAssetBundle {
  static let bundleName = "KScanLiveVtoNativeAssets"

  /// Falls back to the class bundle itself if the named resource bundle
  /// cannot be located (e.g. a host app that inlines pod resources directly)
  /// so a lookup still has somewhere sane to search rather than crashing.
  static let shared: Bundle = {
    let podBundle = Bundle(for: LiveVtoAssetBundleMarker.self)
    if let url = podBundle.url(forResource: bundleName, withExtension: "bundle"),
       let bundle = Bundle(url: url) {
      return bundle
    }
    return podBundle
  }()
}

/// A private, otherwise-unused type solely so `Bundle(for:)` above resolves
/// to this pod's own compiled bundle, not the app's main bundle.
private final class LiveVtoAssetBundleMarker {}
