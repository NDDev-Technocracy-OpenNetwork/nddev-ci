import XCTest
@testable import CiwfFixture

final class ChecksumTests: XCTestCase {
    func testChecksumIsStable() {
        XCTAssertEqual(checksum("ci"), 204)
        XCTAssertEqual(checksum(""), 0)
    }

    func testChecksumStaysInOneByte() {
        for sample in ["", "a", "the quick brown fox"] {
            XCTAssertTrue((0...255).contains(checksum(sample)))
        }
    }
}
