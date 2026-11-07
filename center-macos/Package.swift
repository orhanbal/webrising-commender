// swift-tools-version:5.9
// WECOMMANDER Management Center for macOS: a native menu bar app (AppKit +
// SwiftUI). CenterCore holds the gateway client, models, texts and settings
// and is unit tested; WecommanderCenter is the app. Resources are copied into
// the .app bundle by scripts/build-center-macos.sh, not through SwiftPM.
import PackageDescription

let package = Package(
    name: "WecommanderCenter",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "WecommanderCenter", targets: ["WecommanderCenter"]),
    ],
    targets: [
        .target(name: "CenterCore"),
        .executableTarget(name: "WecommanderCenter", dependencies: ["CenterCore"]),
        .testTarget(name: "CenterCoreTests", dependencies: ["CenterCore"]),
    ]
)
