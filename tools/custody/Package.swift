// swift-tools-version:5.9
//
// ashlr-custody — the Secure Enclave custody helper for Ashlr standing grants
// (SPEC-310B §1, unit B-U2). Installed root-owned at
// /usr/local/libexec/ashlr-custody by scripts/install-custody.sh.
//
// Every rule that decides what may be signed or handed out
// (strict grant parsing, ceilings, canonical bytes, prompt text, GitHub token
// requests) lives in CustodyCore, which has no hardware dependency and is
// covered by `swift test`. CustodySecurity adds metadata-only in-memory ACL
// preparation with real SDK regressions, without Keychain items or human
// authentication. The executable adds the Secure Enclave key, Touch ID,
// actual Keychain items and the network.
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
    // Metadata-only, in-memory legacy ACL adapter; no Keychain item APIs.
    .target(name: "CustodySecurity", dependencies: ["CustodyCore"],
      linkerSettings: [.linkedFramework("Security")]),
    .executableTarget(
      name: "ashlr-custody",
      dependencies: ["CustodyCore", "CustodySecurity"],
      linkerSettings: [
        .linkedFramework("CryptoKit"),
        .linkedFramework("LocalAuthentication"),
        .linkedFramework("Security"),
        .linkedFramework("IOKit"),
      ]
    ),
    .testTarget(
      name: "CustodyCoreTests",
      dependencies: ["CustodyCore", "CustodySecurity"],
      resources: [.copy("Fixtures")]
    ),
  ]
)
