// Keychain items whose ACL trusts ONLY this helper.
//
// The legacy (file-based) login keychain supports per-item access lists of
// trusted applications; the item is created with exactly one entry — the
// calling application, i.e. this binary — so any other process (including
// `/usr/bin/security`) triggers a macOS confirmation dialog instead of
// reading it. Confined agents cannot reach securityd at all (the autonomous
// sandbox profile denies com.apple.SecurityServer). The APIs are deprecated
// but remain the only way to express a per-app ACL without a provisioning
// profile, which an ad-hoc or Developer-ID-signed CLI does not have.

import CustodyCore
import Foundation
import Security

enum SecretStore {
  static let service = "ai.ashlr.custody"

  enum Account: String {
    case githubApp = "github-app"
    case claudeToken = "claude-token"

    var label: String {
      switch self {
      case .githubApp: return "Ashlr custody: GitHub App ashlr-fleet key"
      case .claudeToken: return "Ashlr custody: Claude setup token (claude-a)"
      }
    }
  }

  /// Never let a Keychain dialog appear from a non-interactive call: a token
  /// request at 3 a.m. must fail loudly instead of waiting on a prompt.
  static func disableInteraction() {
    SecKeychainSetUserInteractionAllowed(false)
  }

  static func failure(_ status: OSStatus, _ action: String) -> CustodyFailure {
    if status == errSecInteractionNotAllowed || status == errSecAuthFailed {
      return CustodyFailure("keystore", "the Keychain would not release the item without a prompt — a different build of the helper stored it; run the matching store-… command again", exit: .keystore)
    }
    return CustodyFailure("keystore", "Keychain \(action) failed (OSStatus \(status))", exit: .keystore)
  }

  static func store(_ account: Account, data: Data) throws {
    var access: SecAccess?
    var trusted: SecTrustedApplication?
    guard SecTrustedApplicationCreateFromPath(nil, &trusted) == errSecSuccess, let trusted else {
      throw CustodyFailure("keystore", "cannot describe this helper as the item's only trusted application", exit: .keystore)
    }
    guard SecAccessCreate(account.label as CFString, [trusted] as CFArray, &access) == errSecSuccess, let access else {
      throw CustodyFailure("keystore", "cannot build the item's access list", exit: .keystore)
    }
    let match: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account.rawValue,
    ]
    let deleted = SecItemDelete(match as CFDictionary)
    guard deleted == errSecSuccess || deleted == errSecItemNotFound else { throw failure(deleted, "replace") }
    var add = match
    add[kSecValueData as String] = data
    add[kSecAttrLabel as String] = account.label
    add[kSecAttrAccess as String] = access
    let status = SecItemAdd(add as CFDictionary, nil)
    guard status == errSecSuccess else { throw failure(status, "store") }
  }

  static func read(_ account: Account) throws -> Data? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account.rawValue,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var out: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &out)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = out as? Data else { throw failure(status, "read") }
    return data
  }

  /// Presence only — attributes, never the secret, so no ACL decision is made.
  static func exists(_ account: Account) -> Bool? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account.rawValue,
      kSecReturnAttributes as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var out: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &out)
    if status == errSecSuccess { return true }
    if status == errSecItemNotFound { return false }
    return nil
  }
}
