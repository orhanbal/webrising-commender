import CoreGraphics

/// The path data written by scripts/gen-icons.py (IconData.g.swift): absolute
/// M/L/Q/C/Z with space-separated numbers, nonzero fill, a 24x24 box, y down.
public enum IconPath {
    /// The box the outlines are drawn in.
    public static let box: CGFloat = 24

    public enum ParseError: Error, Equatable {
        case unexpected(UInt8)
        case number
    }

    /// The outline of `name` (Bold when `active`) scaled to `size` points square, y down.
    public static func cgPath(_ name: WCIconName, active: Bool, size: CGFloat) -> CGPath {
        (try? parse(IconData.path(name, active: active), scale: size / box)) ?? CGMutablePath()
    }

    /// Parses generated path data, every coordinate multiplied by `scale`.
    public static func parse(_ data: String, scale: CGFloat = 1) throws -> CGPath {
        let path = CGMutablePath()
        let bytes = Array(data.utf8)
        var i = 0

        func number() throws -> CGFloat {
            let start = i
            while i < bytes.count, (bytes[i] >= 48 && bytes[i] <= 57) || bytes[i] == 45 || bytes[i] == 46 {
                i += 1
            }
            guard i > start, let value = Double(String(decoding: bytes[start..<i], as: UTF8.self)) else {
                throw ParseError.number
            }
            return CGFloat(value) * scale
        }

        // The first number follows the letter; the others a single space.
        func point(first: Bool) throws -> CGPoint {
            if !first {
                guard i < bytes.count, bytes[i] == 32 else { throw ParseError.number }
                i += 1
            }
            let x = try number()
            guard i < bytes.count, bytes[i] == 32 else { throw ParseError.number }
            i += 1
            let y = try number()
            return CGPoint(x: x, y: y)
        }

        while i < bytes.count {
            let command = bytes[i]
            i += 1
            switch command {
            case UInt8(ascii: "M"):
                let p = try point(first: true)
                path.move(to: p)
            case UInt8(ascii: "L"):
                let p = try point(first: true)
                path.addLine(to: p)
            case UInt8(ascii: "Q"):
                let control = try point(first: true)
                let end = try point(first: false)
                path.addQuadCurve(to: end, control: control)
            case UInt8(ascii: "C"):
                let c1 = try point(first: true)
                let c2 = try point(first: false)
                let end = try point(first: false)
                path.addCurve(to: end, control1: c1, control2: c2)
            case UInt8(ascii: "Z"):
                path.closeSubpath()
            default:
                throw ParseError.unexpected(command)
            }
        }
        return path
    }
}
