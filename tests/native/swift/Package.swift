// swift-tools-version:5.9
import PackageDescription

// XCTest ships with the Swift toolchain, so this package builds and tests with
// no dependency resolution at all — the fixture proves the workflow rather than
// the package registry.
let package = Package(
    name: "CiwfFixture",
    products: [
        .library(name: "CiwfFixture", targets: ["CiwfFixture"])
    ],
    targets: [
        .target(name: "CiwfFixture"),
        .testTarget(name: "CiwfFixtureTests", dependencies: ["CiwfFixture"])
    ]
)
