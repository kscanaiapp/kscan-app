require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'KScanLiveVtoNative'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = package['license']
  s.author         = 'K Scan AI'
  s.homepage       = 'https://kscan.ai'
  s.platforms      = {
    :ios => '15.1'
  }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://kscan.ai' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  # Verified current at 1.0.0 against CocoaPods trunk on 2026-09-06 -- the
  # same release Android's com.google.mediapipe:tasks-vision:1.0.0 pins.
  # See docs/vto-live-bridge-contract.md, "Perception" section.
  s.dependency 'MediaPipeTasksVision', '1.0.0'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  # Same reasoning as KScanPiiNative.podspec / KScanVoiceNative.podspec:
  # Tests/ imports XCTest, which is unavailable to the app's own
  # release/archive target, so it is excluded from the main source glob and
  # built only via the test_spec.
  s.source_files = "**/*.{h,m,swift}"
  s.exclude_files = "Tests/**/*"

  # Governed fixtures (goldens/bodyframes.json-adjacent .ksgarment assets) and
  # the checksum-enforced pose-landmarker model, packaged as one dedicated
  # resource bundle so Swift can locate them reliably regardless of
  # use_frameworks!/static-framework configuration. See
  # LiveVtoAssetBundle.swift.
  s.resource_bundles = {
    'KScanLiveVtoNativeAssets' => ['Assets/**/*']
  }

  s.test_spec 'Tests' do |test_spec|
    test_spec.source_files = "Tests/**/*.swift"
    test_spec.frameworks = 'XCTest'
  end
end
