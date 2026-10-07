// Existing-item ACL repair. Platform effects are injected so tests never
// access a Keychain, authenticate a person, or read a credential.
import Foundation

public enum ReauthorizationAccount: String, Equatable, Sendable {
  case githubApp = "github-app"
  case claudeToken = "claude-token"

  public var reason: String {
    "Allow the currently installed Phantom custody helper to access the existing \(rawValue) Keychain item. No credential or signing key will be replaced."
  }
}

public struct ReauthorizationOperatorContext {
  public static let nonOperatorMarkers = [
    "ASHLR_IN_DAEMON", "ASHLR_IN_SWARM", "CLAUDECODE", "AI_AGENT",
    "CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED",
  ]
  public let stdinTTY: Bool
  public let stdoutTTY: Bool
  public let loginHomeMatches: Bool
  public let uid: UInt32
  public let effectiveUID: UInt32
  public let environment: [String: String]

  public init(stdinTTY: Bool, stdoutTTY: Bool, loginHomeMatches: Bool,
              uid: UInt32, effectiveUID: UInt32, environment: [String: String]) {
    self.stdinTTY = stdinTTY; self.stdoutTTY = stdoutTTY
    self.loginHomeMatches = loginHomeMatches
    self.uid = uid; self.effectiveUID = effectiveUID; self.environment = environment
  }

  public func requireOperator() throws {
    let marked = Self.nonOperatorMarkers.contains {
      guard let value = environment[$0] else { return false }
      return !value.isEmpty && value != "0"
    }
    guard stdinTTY, stdoutTTY, loginHomeMatches, uid != 0, uid == effectiveUID, !marked else {
      throw CustodyFailure("operator-required", "run reauthorize yourself in your login Terminal, without sudo or an agent", exit: .refused)
    }
  }
}

public enum Reauthorization {
  // The exact single-app crypto ACL produced by SecAccessCreate on macOS.
  // It is shared by these operations; the separate encrypt/changeACL rules
  // are preserved. No arbitrary mixed authorization set is accepted.
  public static let legacyDecryptAuthorizations = [
    "ACLAuthorizationDecrypt", "ACLAuthorizationDerive", "ACLAuthorizationExportClear",
    "ACLAuthorizationExportWrapped", "ACLAuthorizationMAC", "ACLAuthorizationSign",
  ]
  /// A broad or mixed-purpose ACL is not the single-helper decrypt layout
  /// this repair understands. Keep those cases for explicit human inspection.
  public static func requireDecryptLayout(authorizations: [String], decrypt: String,
                                          applicationCount: Int?, hasDescription: Bool) throws {
    let legacy = decrypt == "ACLAuthorizationDecrypt" &&
      authorizations.count == legacyDecryptAuthorizations.count &&
      Set(authorizations) == Set(legacyDecryptAuthorizations)
    guard (authorizations == [decrypt] || legacy), applicationCount == 1, hasDescription else {
      throw CustodyFailure("unsupported-access", "cannot safely reauthorize this existing item; nothing was changed", exit: .refused)
    }
  }

  /// Metadata is inspected without UI before authenticating. Recheck both
  /// identities after the human interaction; never repair a newly substituted
  /// item or grant an old running image access after an installer swap.
  public static func perform<Item, Access, Identity: Equatable>(
    account: ReauthorizationAccount,
    requireOperator: () throws -> Void,
    installedIdentity: () throws -> Identity,
    findItems: () throws -> [Item],
    sameItem: (Item, Item) -> Bool,
    prepareAccess: (Item) throws -> Access,
    authenticate: (String) throws -> Void,
    requireUnchangedAccess: (Item, Access) throws -> Void,
    applyAccess: (Item, Access) throws -> Void,
    verifyAppliedAccess: (Item, Access) throws -> Void
  ) throws {
    try requireOperator()
    let identity = try installedIdentity()
    func uniqueItem() throws -> Item {
      let items = try findItems()
      guard !items.isEmpty else {
        throw CustodyFailure("not-stored", "the requested existing Keychain item is missing; nothing was changed", exit: .missing)
      }
      guard items.count == 1 else {
        throw CustodyFailure("ambiguous-item", "more than one matching Keychain item exists; nothing was changed", exit: .refused)
      }
      return items[0]
    }
    let item = try uniqueItem()
    let access = try prepareAccess(item)
    try authenticate(account.reason)
    try requireOperator()
    guard try installedIdentity() == identity else {
      throw CustodyFailure("helper-changed", "the installed helper changed during authentication; nothing was changed", exit: .refused)
    }
    guard sameItem(item, try uniqueItem()) else {
      throw CustodyFailure("item-changed", "the Keychain item changed during authentication; nothing was changed", exit: .refused)
    }
    try requireUnchangedAccess(item, access)
    try applyAccess(item, access)
    do {
      try requireOperator()
      guard try installedIdentity() == identity, sameItem(item, try uniqueItem()) else {
        throw CustodyFailure("postcondition", "postcondition", exit: .refused)
      }
      try verifyAppliedAccess(item, access)
    } catch {
      // The OS already accepted SetAccess. Do not claim nothing changed and
      // do not attempt a second mutation or automatic rollback.
      throw CustodyFailure("reauthorization-unverified", "the OS accepted the access change, but metadata verification did not complete; inspect the item before retrying", exit: .keystore)
    }
  }

  public static func successJSON(account: ReauthorizationAccount) -> String {
    var line = JSONLine()
    line.integer("v", 1)
    line.bool("ok", true)
    line.string("account", account.rawValue)
    line.string("operation", "reauthorize-existing-item")
    return line.text
  }
}
