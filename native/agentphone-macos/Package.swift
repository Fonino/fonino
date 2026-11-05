// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "agentphone-macos",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "agentphone-macos", path: "Sources/agentphone-macos")
    ]
)
