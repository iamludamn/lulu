// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "PiStackKit",
    platforms: [.iOS(.v26), .macOS(.v26)],
    products: [.library(name: "PiStackKit", targets: ["PiStackKit"])],
    targets: [.target(name: "PiStackKit")],
    swiftLanguageModes: [.v5]
)
