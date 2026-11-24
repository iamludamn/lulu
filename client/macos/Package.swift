// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "Lulu",
    platforms: [.macOS(.v26)],
    dependencies: [.package(path: "../ios/PiStackKit")],
    targets: [
        .executableTarget(
            name: "Lulu",
            dependencies: [.product(name: "PiStackKit", package: "PiStackKit")]
        )
    ],
    swiftLanguageModes: [.v5]
)
