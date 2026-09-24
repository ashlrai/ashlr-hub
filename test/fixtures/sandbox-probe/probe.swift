// Sandbox capability probe for test/confine-autonomous-darwin-310b.test.ts.
//
// Calls the APIs an escaping agent would use DIRECTLY (not via the exec-denied
// Apple binaries), in ways that can never change anything even if a denial
// failed:
//   keychain  — look up an item that does not exist (never stores one)
//   la        — ask whether Touch ID could be evaluated (never prompts)
//   se        — create a throwaway Secure Enclave key with NO presence ACL and
//               never persist it
//   pasteboard — count pasteboard types (reads nothing)
//   lsopen    — open a URL scheme no app handles (can never launch anything)
//   job       — submit a launchd job with no Program, which launchd must
//               reject (so no job can ever be created)
// Prints one JSON object.
import AppKit
import CoreServices
import Foundation
import LocalAuthentication
import Security
import ServiceManagement

var out: [String: Any] = [:]

do {
  let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: "ai.ashlr.test.nonexistent-probe-item",
    kSecReturnAttributes as String: true,
    kSecMatchLimit as String: kSecMatchLimitOne,
  ]
  var result: CFTypeRef?
  out["keychainStatus"] = Int(SecItemCopyMatching(query as CFDictionary, &result))
}

do {
  var error: NSError?
  out["laCanEvaluate"] = LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: &error)
}

do {
  var error: Unmanaged<CFError>?
  if let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage], &error) {
    let attrs: [String: Any] = [
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeySizeInBits as String: 256,
      kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
      kSecPrivateKeyAttrs as String: [kSecAttrIsPermanent as String: false, kSecAttrAccessControl as String: access],
    ]
    out["secureEnclaveKey"] = SecKeyCreateRandomKey(attrs as CFDictionary, &error) != nil
  }
}

out["pasteboardTypes"] = NSPasteboard.general.types?.count ?? -1

out["lsopenStatus"] = Int(LSOpenCFURLRef(URL(string: "ashlr-test-nonexistent-scheme-5d1e://probe")! as CFURL, nil))

do {
  var error: Unmanaged<CFError>?
  let submitted = SMJobSubmit(kSMDomainUserLaunchd, ["Label": "ai.ashlr.test.invalid-probe-5d1e"] as CFDictionary, nil, &error)
  let e = error?.takeRetainedValue()
  out["jobSubmitted"] = submitted
  out["jobErrorCode"] = e.map { CFErrorGetCode($0) } ?? 0
  if submitted { _ = SMJobRemove(kSMDomainUserLaunchd, "ai.ashlr.test.invalid-probe-5d1e" as CFString, nil, true, nil) }
}

let data = try! JSONSerialization.data(withJSONObject: out, options: [.sortedKeys])
print(String(data: data, encoding: .utf8)!)
