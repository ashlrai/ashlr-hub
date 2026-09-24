// hostBinding = sha256 hex of this Mac's IOPlatformUUID, uppercase as `ioreg`
// prints it (StandingGrantV1.hostBinding). The helper refuses to sign a grant
// bound to another machine: such a grant could never be accepted here, and
// signing it would only teach Mason to approve prompts without reading them.

import CryptoKit
import Foundation
import IOKit

enum Host {
  static func platformUUID() -> String? {
    let service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPlatformExpertDevice"))
    guard service != 0 else { return nil }
    defer { IOObjectRelease(service) }
    guard let value = IORegistryEntryCreateCFProperty(service, "IOPlatformUUID" as CFString, kCFAllocatorDefault, 0)?
      .takeRetainedValue() as? String, !value.isEmpty else { return nil }
    return value.uppercased()
  }

  static func binding() -> String? {
    guard let uuid = platformUUID() else { return nil }
    return SHA256.hash(data: Data(uuid.utf8)).map { String(format: "%02x", $0) }.joined()
  }
}
