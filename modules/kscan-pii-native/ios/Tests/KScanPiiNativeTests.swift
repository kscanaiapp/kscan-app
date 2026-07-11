import XCTest
@testable import KScanPiiNative

class KScanPiiNativeTests: XCTestCase {
    func testConstantsMatchParitySpecification() {
        XCTAssertEqual(NativePrivacyConstants.sanitizerVersion, "native-face-mask-poc-1.0.0")
        XCTAssertEqual(NativePrivacyConstants.maxWidth, 4096)
        XCTAssertEqual(NativePrivacyConstants.maxHeight, 4096)
        XCTAssertEqual(NativePrivacyConstants.maxPixels, 16_777_216)
        XCTAssertEqual(NativePrivacyConstants.defaultPaddingRatio, 0.15, accuracy: 0.0001)
        XCTAssertEqual(NativePrivacyConstants.minPaddingRatio, 0.0, accuracy: 0.0001)
        XCTAssertEqual(NativePrivacyConstants.maxPaddingRatio, 0.5, accuracy: 0.0001)
        XCTAssertEqual(NativePrivacyConstants.iouDeduplicationThreshold, 0.5, accuracy: 0.0001)
        XCTAssertTrue(NativePrivacyConstants.acceptedMimeTypes.contains("image/jpeg"))
        XCTAssertTrue(NativePrivacyConstants.acceptedMimeTypes.contains("image/png"))
        XCTAssertEqual(NativePrivacyConstants.outputMimeType, "image/png")
        XCTAssertEqual(NativePrivacyConstants.checksumAlgorithm, "fnv1a-dual-lane-64")
    }

    func testChecksumMatchesParityVectors() {
        let fixtures: [(name: String, bytes: [UInt8], expected: String)] = [
            ("empty", [], "811c9dc59e3779b900000000"),
            ("single-zero", [0], "050c5d1f53a3c66700000001"),
            ("abc", [97, 98, 99], "1a47e90bc574722700000003"),
            ("rgba-white", [255, 255, 255, 255], "e3160fb1516de17c00000004"),
            ("rgba-black", [0, 0, 0, 255], "dc9546585364785b00000004"),
        ]

        for fixture in fixtures {
            XCTAssertEqual(
                IOSOutputVerifier.checksumBuffer(fixture.bytes),
                fixture.expected,
                "Checksum mismatch for \(fixture.name)"
            )
        }
    }

    func testBoxNormalizerPadsAndRoundsOutward() {
        let faces = [IOSFaceRect(left: 4, top: 4, right: 6, bottom: 6)]
        let result = IOSFaceBoxNormalizer.normalizeAndPad(faces: faces, imageWidth: 10, imageHeight: 10, paddingRatio: 0.5)
        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result[0].x, 3)
        XCTAssertEqual(result[0].y, 3)
        XCTAssertEqual(result[0].width, 4)
        XCTAssertEqual(result[0].height, 4)
    }

    func testBoxNormalizerClampsToBounds() {
        let faces = [IOSFaceRect(left: 6, top: 6, right: 12, bottom: 12)]
        let result = IOSFaceBoxNormalizer.normalizeAndPad(faces: faces, imageWidth: 8, imageHeight: 8, paddingRatio: 0.0)
        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result[0].x, 6)
        XCTAssertEqual(result[0].y, 6)
        XCTAssertEqual(result[0].width, 2)
        XCTAssertEqual(result[0].height, 2)
    }

    func testBoxNormalizerRejectsFullyOutsideBox() {
        let faces = [IOSFaceRect(left: 10, top: 10, right: 12, bottom: 12)]
        let result = IOSFaceBoxNormalizer.normalizeAndPad(faces: faces, imageWidth: 8, imageHeight: 8, paddingRatio: 0.0)
        XCTAssertTrue(result.isEmpty)
    }

    func testBoxNormalizerDeduplicatesByIoU() {
        let faces = [
            IOSFaceRect(left: 0, top: 0, right: 4, bottom: 4),
            IOSFaceRect(left: 1, top: 1, right: 5, bottom: 5),
        ]
        let result = IOSFaceBoxNormalizer.normalizeAndPad(faces: faces, imageWidth: 8, imageHeight: 8, paddingRatio: 0.0)
        XCTAssertEqual(result.count, 1)
    }

    func testBoxNormalizerSortsDeterministically() {
        let faces = [
            IOSFaceRect(left: 2, top: 2, right: 4, bottom: 4),
            IOSFaceRect(left: 0, top: 0, right: 2, bottom: 2),
        ]
        let result = IOSFaceBoxNormalizer.normalizeAndPad(faces: faces, imageWidth: 8, imageHeight: 8, paddingRatio: 0.0)
        XCTAssertEqual(result.count, 2)
        XCTAssertEqual(result[0].x, 0)
        XCTAssertEqual(result[0].y, 0)
        XCTAssertEqual(result[1].x, 2)
        XCTAssertEqual(result[1].y, 2)
    }

    func testCleanupRejectsNonCacheUri() {
        let result = IOSCacheManager.cleanupUri("file:///tmp/outside-cache.png")
        XCTAssertFalse(result.deleted)
        XCTAssertTrue(result.rejected)
    }

    func testCleanupAcceptsOwnedCacheUri() {
        let outputFile = IOSCacheManager.createOutputFile()
        try? "test".write(toFile: outputFile.path, atomically: true, encoding: .utf8)
        let result = IOSCacheManager.cleanupUri(outputFile.absoluteString)
        XCTAssertTrue(result.deleted)
        XCTAssertFalse(result.rejected)
        XCTAssertFalse(FileManager.default.fileExists(atPath: outputFile.path))
    }
}
