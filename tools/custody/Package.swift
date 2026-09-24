// swift-tools-version:5.9
//
// ashlr-custody — the Secure Enclave custody helper for Ashlr standing grants
// (SPEC-310B §1, unit B-U2). Installed root-owned at
// /usr/local/libexec/ashlr-custody by scripts/install-custody.sh.
//
// WHY two targets: every rule that decides what may be signed or handed out
// (strict grant parsing, ceilings, canonical bytes, prompt text, GitHub token
// requests) lives in CustodyCore, which has no hardware dependency and is
// covered by `swift test`. The executable only adds what cannot run in a test:
// the Secure Enclave key, Touch ID, the Keychain and the network.
//
// Language mode 5 (tools 5.9): the executable bridges callback-based system
// APIs (LocalAuthentication, URLSession) with semaphores, which Swift 6's
// strict concurrency checking rejects without adding anything for a
// single-threaded CLI.
import PackageDescription

let package = Package(
  name: "ashlr-custody",
  platforms: [.macOS(.v13)],
  products: [
    .executable(name: "ashlr-custody", targets: ["ashlr-custody"]),
  ],
  targets: [
    .target(name: "CustodyCore"),
    .executableTarget(
      name: "ashlr-custody",
      dependencies: ["CustodyCore"],
      linkerSettings: [
        .linkedFramework("CryptoKit"),
        .linkedFramework("LocalAuthentication"),
        .linkedFramework("Security"),
        .linkedFramework("IOKit"),
      ]
    ),
    .testTarget(
      name: "CustodyCoreTests",
      dependencies: ["CustodyCore"],
      resources: [.copy("Fixtures")]
    ),
  ]
)
