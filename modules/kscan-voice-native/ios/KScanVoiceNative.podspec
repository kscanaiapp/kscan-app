require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'KScanVoiceNative'
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

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  # Same reasoning as KScanPiiNative.podspec: Tests/ imports XCTest, which
  # is unavailable to the app's own release/archive target, so it is
  # excluded from the main source glob and built only via the test_spec.
  s.source_files = "**/*.{h,m,swift}"
  s.exclude_files = "Tests/**/*"

  s.test_spec 'Tests' do |test_spec|
    test_spec.source_files = "Tests/**/*.swift"
    test_spec.frameworks = 'XCTest'
  end
end
