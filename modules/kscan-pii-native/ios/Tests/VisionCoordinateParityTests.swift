import XCTest
import CoreGraphics
@testable import KScanPiiNative

/**
 Swift half of the Apple Vision coordinate-conversion parity check.

 Reads the SAME vector file the Node suite reads —
 `test-vectors/vision-coordinate-parity.json` — so the two implementations are
 checked against one contract rather than against two copies of it that can
 drift apart.

 REQUIRES macOS/Xcode. On the Step 3B branch this file is compiled and run
 nowhere: the report records iOS native compilation as DEFERRED, and this test
 is the thing that will make that deferral cheap to close.

 The conversion is exercised through `IOSPersonDetector`'s internal helpers via
 `@testable import`, so what is tested is the shipping arithmetic, not a copy of
 it written for the test.
 */
final class VisionCoordinateParityTests: XCTestCase {

    private struct RectCase: Decodable {
        let id: String
        let vision: Rect
        let expectedTopLeft: Rect?
    }

    private struct PointCase: Decodable {
        let id: String
        let vision: Point
        let expectedTopLeft: Point
    }

    private struct Rect: Decodable {
        let x: Double
        let y: Double
        let width: Double
        let height: Double
    }

    private struct Point: Decodable {
        let x: Double
        let y: Double
    }

    private struct Vectors: Decodable {
        let version: String
        let rects: [RectCase]
        let points: [PointCase]
    }

    private static let tolerance = 1e-9

    private func loadVectors() throws -> Vectors {
        // ../../test-vectors relative to ios/Tests.
        let here = URL(fileURLWithPath: #filePath)
        let url = here
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("test-vectors/vision-coordinate-parity.json")
        let data = try Data(contentsOf: url)
        return try JSONDecoder().decode(Vectors.self, from: data)
    }

    func testRectConversionMatchesSharedVectors() throws {
        let vectors = try loadVectors()
        XCTAssertFalse(vectors.rects.isEmpty, "vector file carries no rect cases")

        for testCase in vectors.rects {
            let visionRect = CGRect(
                x: testCase.vision.x,
                y: testCase.vision.y,
                width: testCase.vision.width,
                height: testCase.vision.height
            )
            let converted = IOSPersonDetector.convertRectForTesting(visionRect)

            guard let expected = testCase.expectedTopLeft else {
                XCTAssertNil(converted, "\(testCase.id): a zero-area rect must be rejected, not clamped to a sliver")
                continue
            }

            let actual = try XCTUnwrap(converted, "\(testCase.id): conversion returned nil unexpectedly")
            XCTAssertEqual(actual.x, expected.x, accuracy: Self.tolerance, "\(testCase.id) x")
            XCTAssertEqual(actual.y, expected.y, accuracy: Self.tolerance, "\(testCase.id) y")
            XCTAssertEqual(actual.width, expected.width, accuracy: Self.tolerance, "\(testCase.id) width")
            XCTAssertEqual(actual.height, expected.height, accuracy: Self.tolerance, "\(testCase.id) height")
        }
    }

    func testPointConversionMatchesSharedVectors() throws {
        let vectors = try loadVectors()
        XCTAssertFalse(vectors.points.isEmpty, "vector file carries no point cases")

        for testCase in vectors.points {
            let converted = IOSPersonDetector.convertPointForTesting(
                CGPoint(x: testCase.vision.x, y: testCase.vision.y)
            )
            XCTAssertEqual(converted.x, testCase.expectedTopLeft.x, accuracy: Self.tolerance, "\(testCase.id) x")
            XCTAssertEqual(converted.y, testCase.expectedTopLeft.y, accuracy: Self.tolerance, "\(testCase.id) y")
        }
    }

    /// The one case a MISSING flip would still pass is the symmetric one, so it
    /// is checked explicitly that an asymmetric case actually moves.
    func testConversionIsNotAnIdentityFunction() throws {
        let high = try XCTUnwrap(
            IOSPersonDetector.convertRectForTesting(CGRect(x: 0, y: 0.7, width: 0.3, height: 0.3))
        )
        XCTAssertEqual(high.y, 0.0, accuracy: Self.tolerance,
                       "a region high in the frame must convert to y=0, not y=0.7")
    }

    /// x must survive untouched: a front-camera capture is already mirrored in
    /// pixels before this module sees it.
    func testHorizontalAxisIsNeverMirrored() throws {
        let left = try XCTUnwrap(
            IOSPersonDetector.convertRectForTesting(CGRect(x: 0.05, y: 0.1, width: 0.4, height: 0.8))
        )
        XCTAssertEqual(left.x, 0.05, accuracy: Self.tolerance)
        XCTAssertEqual(left.width, 0.4, accuracy: Self.tolerance)
    }
}
