// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "LuluKit",
    platforms: [.iOS(.v26), .macOS(.v26)],
    products: [.library(name: "LuluKit", targets: ["LuluKit"])],
    targets: [.target(name: "LuluKit"), .testTarget(name: "LuluKitTests", dependencies: ["LuluKit"])],
    swiftLanguageModes: [.v5]
)
