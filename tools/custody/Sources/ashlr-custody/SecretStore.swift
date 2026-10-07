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
import CustodySecurity
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
  static func disableInteraction() throws {
    try CustodyLegacySecretQuery.requireInteractionDisabled(SecKeychainSetUserInteractionAllowed(false))
  }

  static func failure(_ status: OSStatus, _ action: CustodyLegacySecretQuery.Operation) -> CustodyFailure {
    CustodyLegacySecretQuery.failure(status, action)
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
    guard deleted == errSecSuccess || deleted == errSecItemNotFound else { throw failure(deleted, .replace) }
    var add = match
    add[kSecValueData as String] = data
    add[kSecAttrLabel as String] = account.label
    add[kSecAttrAccess as String] = access
    let status = SecItemAdd(add as CFDictionary, nil)
    guard status == errSecSuccess else { throw failure(status, .store) }
  }

  static func read(_ account: Account) throws -> Data? {
    try CustodyLegacySecretQuery.read(
      disableInteraction: { SecKeychainSetUserInteractionAllowed(false) },
      findItems: {
        let query = CustodyLegacySecretQuery.references(service: service, account: account.rawValue)
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return [] as [SecKeychainItem] }
        guard status == errSecSuccess else { throw failure(status, .find) }
        return try CustodyLegacySecretQuery.checkedReferences(result)
      },
      readData: { item in
        let query = CustodyLegacySecretQuery.data(service: service, account: account.rawValue, item: item)
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess else { throw failure(status, .read) }
        return try CustodyLegacySecretQuery.checkedData(result)
      }
    )
  }

  /// Unique presence only — attributes, never the secret or decrypt permission.
  static func exists(_ account: Account) -> Bool? {
    let query = CustodyLegacySecretQuery.attributes(service: service, account: account.rawValue)
    var out: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &out)
    if status == errSecSuccess { return CustodyLegacySecretQuery.presence(out) }
    if status == errSecItemNotFound { return false }
    return nil
  }
}
