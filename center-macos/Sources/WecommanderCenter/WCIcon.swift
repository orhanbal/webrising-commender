import AppKit
import CenterCore
import SwiftUI

/// The app's icons: the Vuesax (Iconsax) set, Linear by default and Bold for a
/// selected / active state (the selected sidebar row, a toggle that is on, a
/// live terminal). The outlines come from CenterCore/IconData.g.swift
/// (scripts/gen-icons.py) and are drawn into template images, so they take the
/// text colour (and the selection's colour) like SF Symbols.
enum WCIcons {
    private static let cache = NSCache<NSString, NSImage>()

    /// A template image `size` points square (AppKit: menus, the status item).
    static func image(_ name: WCIconName, active: Bool = false, size: CGFloat = 16) -> NSImage {
        let key = "\(name.rawValue)/\(active)/\(size)" as NSString
        if let image = cache.object(forKey: key) { return image }
        let path = IconPath.cgPath(name, active: active, size: size)
        // flipped: y grows downward, as in the path data.
        let image = NSImage(size: NSSize(width: size, height: size), flipped: true) { _ in
            guard let context = NSGraphicsContext.current?.cgContext else { return false }
            context.addPath(path)
            context.setFillColor(NSColor.black.cgColor)
            context.fillPath(using: .winding)
            return true
        }
        image.isTemplate = true
        cache.setObject(image, forKey: key)
        return image
    }
}

/// An icon for SwiftUI: `WCIcon(.server)`, `WCIcon(.terminal, active: true)`.
/// A plain `Image` (a template image), so it goes wherever an SF Symbol's
/// `Image(systemName:)` went: labels, toolbars, menus and their labels.
/// `size` is in points; the image does not follow `.font(...)`.
func WCIcon(_ name: WCIconName, active: Bool = false, size: CGFloat = 16) -> Image {
    Image(nsImage: WCIcons.image(name, active: active, size: size))
        .renderingMode(.template)
}

extension Label where Title == Text, Icon == Image {
    /// `Label(title, systemImage:)` with a Vuesax icon.
    init(_ title: String, icon: WCIconName, active: Bool = false) {
        self.init {
            Text(title)
        } icon: {
            WCIcon(icon, active: active)
        }
    }
}
