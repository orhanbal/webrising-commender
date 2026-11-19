import AppKit
import SwiftUI

/// The look of the app's sidebar windows (Servers, server management, Task
/// Manager): a toolbar (automatic style, as SwiftUI's own windows), so the sidebar runs to the top of the window
/// with the close / minimize / zoom buttons inside it and the page title in
/// the toolbar, as in Finder or Mail. Without a toolbar macOS put the buttons
/// above the sidebar and the title in a separate strip.
enum WindowChrome {
    static func apply<Content: View>(_ window: NSWindow, hosting: NSHostingController<Content>, id: String) {
        if #available(macOS 14.0, *) {
            // The SwiftUI .navigationTitle and .toolbar items go into the window's own.
            hosting.sceneBridgingOptions = [.title, .toolbars]
        }
        window.styleMask.insert(.fullSizeContentView)
        window.titlebarAppearsTransparent = false
        window.titleVisibility = .visible
        if window.toolbar == nil {
            let toolbar = NSToolbar(identifier: "WECOMMANDER.\(id)")
            toolbar.displayMode = .iconOnly
            toolbar.allowsUserCustomization = false
            window.toolbar = toolbar
        }
        window.toolbarStyle = .automatic
        // Attach the content again now that the window has its toolbar: SwiftUI
        // then lays the title bar out like its own windows (52 pt on macOS 26,
        // measured against a WindowGroup window). With the toolbar added after
        // the content, the bar stayed 66 pt and the title and buttons sat low.
        let frame = window.frame
        let minSize = window.contentMinSize
        window.contentViewController = nil
        window.contentViewController = hosting
        window.contentMinSize = minSize
        window.setFrame(frame, display: false)
    }
}
