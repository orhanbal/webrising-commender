import CoreGraphics
import XCTest
@testable import CenterCore

final class IconPathTests: XCTestCase {
    func testEveryIconParsesInBothVariantsInsideTheBox() throws {
        for name in WCIconName.allCases {
            for active in [false, true] {
                let path = try IconPath.parse(IconData.path(name, active: active))
                XCTAssertFalse(path.isEmpty, "\(name)")
                let box = path.boundingBoxOfPath
                XCTAssertGreaterThanOrEqual(box.minX, -0.5, "\(name)")
                XCTAssertGreaterThanOrEqual(box.minY, -0.5, "\(name)")
                XCTAssertLessThanOrEqual(box.maxX, IconPath.box + 0.5, "\(name)")
                XCTAssertLessThanOrEqual(box.maxY, IconPath.box + 0.5, "\(name)")
            }
            XCTAssertNotEqual(IconData.path(name, active: false), IconData.path(name, active: true), "\(name)")
        }
    }

    func testScalesToTheRequestedSize() throws {
        let path = IconPath.cgPath(.add, active: false, size: 12)
        XCTAssertLessThanOrEqual(path.boundingBoxOfPath.maxX, 12.5)
        XCTAssertFalse(path.isEmpty)
    }

    func testRejectsAnythingElse() {
        XCTAssertThrowsError(try IconPath.parse("A1 2"))
        XCTAssertThrowsError(try IconPath.parse("M1,2"))
        XCTAssertThrowsError(try IconPath.parse("M1"))
        XCTAssertNoThrow(try IconPath.parse("M1 2L3.5 -4Q5 6 7 8C1 2 3 4 5 6Z"))
    }
}
