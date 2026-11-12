// swift-tools-version:5.9
// WECOMMANDER for macOS: native menu bar app and Servers window (AppKit +
// SwiftUI); SSH, SFTP and tunnels come from wecommander-core (Rust). CenterCore holds the gateway client, models, texts and settings
// and is unit tested; WecommanderCenter is the app. Resources are copied into
// the .app bundle by scripts/build-center-macos.sh, not through SwiftPM.
import PackageDescription

let package = Package(
    name: "WecommanderCenter",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "WecommanderCenter", targets: ["WecommanderCenter"]),
    ],
    dependencies: [
        // Native AppKit terminal view (MIT): the terminal of the Servers window.
        .package(url: "https://github.com/migueldeicaza/SwiftTerm", from: "1.99.3"),
    ],
    targets: [
        .target(name: "CenterCore"),
        .executableTarget(name: "WecommanderCenter", dependencies: [
            "CenterCore",
            .product(name: "SwiftTerm", package: "SwiftTerm"),
        ]),
        .testTarget(name: "CenterCoreTests", dependencies: ["CenterCore"]),
    ]
)
