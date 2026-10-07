// Pure query construction and injected reader orchestration. No Keychain
// item API is called here; the installed executable owns every OS operation.
import CustodyCore
import Foundation
import Security

public enum CustodyLegacySecretQuery {
  public enum Operation: String {
    case replace, store, find, read
    case disableInteraction = "disable interaction"
  }

  public static func match(service: String, account: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecUseDataProtectionKeychain as String: false,
      kSecAttrSynchronizable as String: false,
    ]
  }

  public static func references(service: String, account: String) -> [String: Any] {
    var query = match(service: service, account: account)
    query[kSecReturnRef as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitAll
    return query
  }

  public static func attributes(service: String, account: String) -> [String: Any] {
    var query = match(service: service, account: account)
    query[kSecReturnAttributes as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitAll
    return query
  }

  /// The executable must first validate this reference's type and uniqueness.
  /// Keep the attributes too: an item changed after selection must not be read.
  public static func data(service: String, account: String, item: CFTypeRef) -> [String: Any] {
    var query = match(service: service, account: account)
    query[kSecMatchItemList as String] = [item] as CFArray
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    return query
  }

  public static func failure(_ status: OSStatus, _ operation: Operation) -> CustodyFailure {
    let detail: String
    switch status {
    case errSecInteractionNotAllowed: detail = ": interaction is not allowed for this noninteractive operation"
    case errSecAuthFailed: detail = ": authorization failed"
    default: detail = ""
    }
    return CustodyFailure("keystore", "Keychain \(operation.rawValue) failed (OSStatus \(status))\(detail)", exit: .keystore)
  }

  public static func invalidResult(_ operation: Operation) -> CustodyFailure {
    CustodyFailure("keystore", "Keychain \(operation.rawValue) returned an invalid result (OSStatus \(errSecSuccess))", exit: .keystore)
  }

  public static func requireInteractionDisabled(_ status: OSStatus) throws {
    guard status == errSecSuccess else { throw failure(status, .disableInteraction) }
  }

  public static func checkedReferences(_ result: CFTypeRef?) throws -> [SecKeychainItem] {
    guard let items = result as? [SecKeychainItem],
          items.allSatisfy({ CFGetTypeID($0) == SecKeychainItemGetTypeID() }) else {
      throw invalidResult(.find)
    }
    return items
  }

  public static func checkedData(_ result: CFTypeRef?) throws -> Data {
    guard let data = result as? Data else { throw invalidResult(.read) }
    return data
  }

  /// A unique attributes-only match establishes presence, never decrypt access.
  /// Ambiguous or malformed metadata must remain unknown rather than usable.
  public static func presence(_ result: CFTypeRef?) -> Bool? {
    guard let items = result as? [[String: Any]] else { return nil }
    if items.isEmpty { return false }
    return items.count == 1 ? true : nil
  }

  /// An ambiguous search must never become a first-match secret read. Missing
  /// items retain the existing nil result; OS failures propagate without retry.
  public static func read<Item>(
    disableInteraction: () -> OSStatus,
    findItems: () throws -> [Item],
    readData: (Item) throws -> Data
  ) throws -> Data? {
    try requireInteractionDisabled(disableInteraction())
    let items = try findItems()
    guard !items.isEmpty else { return nil }
    guard items.count == 1 else {
      throw CustodyFailure("ambiguous-item", "more than one matching Keychain item exists; no credential was read", exit: .refused)
    }
    return try readData(items[0])
  }
}
