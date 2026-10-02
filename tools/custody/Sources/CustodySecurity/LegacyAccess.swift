// In-memory ACL metadata only. This module never queries, reads, creates,
// deletes or updates a Keychain ITEM and never authenticates a person.
import CustodyCore
import Foundation
import Security

public enum CustodyLegacyAccess {
  static func refuse(_ code: String = "reauthorization-refused") -> CustodyFailure {
    CustodyFailure(code, "cannot safely reauthorize this existing item; nothing was changed", exit: .refused)
  }

  public struct PreparedAccess {
    public let updated: SecAccess
    public let original: AccessSnapshot
    public let expected: AccessSnapshot
  }

  public struct ACLSnapshot: Equatable {
    let applications: [Data]?
    let description: String?
    let prompt: UInt16
    let authorizations: [String]
  }

  public struct AccessSnapshot: Equatable {
    let owner: uid_t
    let group: gid_t
    let ownerType: UInt32
    let acls: [ACLSnapshot]
  }

  public static func snapshot(_ access: SecAccess) throws -> AccessSnapshot {
    var owner: uid_t = 0
    var group: gid_t = 0
    var ownerType = SecAccessOwnerType()
    var all: CFArray?
    guard SecAccessCopyOwnerAndACL(access, &owner, &group, &ownerType, nil) == errSecSuccess,
          SecAccessCopyACLList(access, &all) == errSecSuccess,
          let acls = all as? [SecACL], acls.allSatisfy({ CFGetTypeID($0) == SecACLGetTypeID() }) else { throw refuse("unsupported-access") }
    let snapshots = try acls.map { acl -> ACLSnapshot in
      var applications: CFArray?
      var description: CFString?
      var prompt = SecKeychainPromptSelector()
      guard SecACLCopyContents(acl, &applications, &description, &prompt) == errSecSuccess,
            let authorizations = SecACLCopyAuthorizations(acl) as? [String] else { throw refuse("unsupported-access") }
      var appData: [Data]? = nil
      if let applications {
        guard let apps = applications as? [SecTrustedApplication],
              apps.allSatisfy({ CFGetTypeID($0) == SecTrustedApplicationGetTypeID() }) else { throw refuse("unsupported-access") }
        appData = try apps.map { app in
          var opaque: CFData?
          guard SecTrustedApplicationCopyData(app, &opaque) == errSecSuccess, let opaque else { throw refuse() }
          // Opaque equality only; these bytes do not establish an app path.
          return opaque as Data
        }
      }
      return ACLSnapshot(applications: appData, description: description.map { $0 as String },
                         prompt: prompt.rawValue, authorizations: authorizations)
    }
    return AccessSnapshot(owner: owner, group: group, ownerType: ownerType, acls: snapshots)
  }

  public static func prepare(_ access: SecAccess, trusted: SecTrustedApplication) throws -> PreparedAccess {
    let original = try snapshot(access)
    guard !original.acls.contains(where: { $0.authorizations.contains(kSecACLAuthorizationAny as String) }) else {
      throw refuse("unsupported-access")
    }
    var all: CFArray?
    guard SecAccessCopyACLList(access, &all) == errSecSuccess,
          let acls = all as? [SecACL], acls.allSatisfy({ CFGetTypeID($0) == SecACLGetTypeID() }) else { throw refuse("unsupported-access") }
    let selected = acls.filter { acl in
      (SecACLCopyAuthorizations(acl) as? [String])?.contains(kSecACLAuthorizationDecrypt as String) == true
    }
    guard selected.count == 1 else { throw refuse("unsupported-access") }
    for acl in selected {
      var applications: CFArray?
      var description: CFString?
      var prompt = SecKeychainPromptSelector()
      guard SecACLCopyContents(acl, &applications, &description, &prompt) == errSecSuccess,
            let authorizations = SecACLCopyAuthorizations(acl) as? [String] else { throw refuse("unsupported-access") }
      let apps = applications as? [SecTrustedApplication]
      try Reauthorization.requireDecryptLayout(authorizations: authorizations,
        decrypt: kSecACLAuthorizationDecrypt as String, applicationCount: apps?.count, hasDescription: description != nil)
      guard let description else {
        // The application's nil/empty list was refused separately above.
        // A missing description is unsupported metadata, not an ACL mode.
        throw refuse("unsupported-access")
      }
      guard SecACLSetContents(acl, [trusted] as CFArray, description, prompt) == errSecSuccess else { throw refuse() }
    }
    // Authorizations, prompt flags, descriptions, owner and non-decrypt ACLs
    // (including partition rules) remain as copied. No opaque blobs are decoded.
    return PreparedAccess(updated: access, original: original, expected: try snapshot(access))
  }

}
