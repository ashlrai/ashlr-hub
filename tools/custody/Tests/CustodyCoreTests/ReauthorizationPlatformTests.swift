// Real SDK objects, exclusively in memory. No Keychain item/query/data APIs,
// user authentication, network, signing or installed-helper mutation.
import XCTest
import Security
import CustodyCore
@testable import CustodySecurity

final class ReauthorizationPlatformTests: XCTestCase {
  func fixture() throws -> (SecAccess, SecTrustedApplication) {
    var old: SecTrustedApplication?
    var current: SecTrustedApplication?
    var access: SecAccess?
    XCTAssertEqual(SecTrustedApplicationCreateFromPath("/usr/bin/true", &old), errSecSuccess)
    XCTAssertEqual(SecTrustedApplicationCreateFromPath(nil, &current), errSecSuccess)
    let oldApp = try XCTUnwrap(old)
    XCTAssertEqual(SecAccessCreate("Synthetic in-memory ACL" as CFString, [oldApp] as CFArray, &access), errSecSuccess)
    return (try XCTUnwrap(access), try XCTUnwrap(current))
  }

  func decryptACL(_ access: SecAccess) throws -> SecACL {
    var all: CFArray?
    XCTAssertEqual(SecAccessCopyACLList(access, &all), errSecSuccess)
    let acls = try XCTUnwrap(all as? [SecACL])
    XCTAssertTrue(acls.allSatisfy { CFGetTypeID($0) == SecACLGetTypeID() })
    return try XCTUnwrap(acls.first { acl in
      (SecACLCopyAuthorizations(acl) as? [String])?.contains(kSecACLAuthorizationDecrypt as String) == true
    })
  }

  func testDefaultSDKAccessPreparesAndReadsBackWithoutChangingOtherRules() throws {
    let (access, current) = try fixture()
    let before = try CustodyLegacyAccess.snapshot(access)
    let targetIndices = before.acls.indices.filter { before.acls[$0].authorizations.contains(kSecACLAuthorizationDecrypt as String) }
    XCTAssertEqual(targetIndices.count, 1)
    let target = before.acls[try XCTUnwrap(targetIndices.first)]
    XCTAssertEqual(Set(target.authorizations), Set(Reauthorization.legacyDecryptAuthorizations))
    XCTAssertEqual(target.authorizations.count, 6)
    XCTAssertEqual(target.applications?.count, 1)
    let prepared = try CustodyLegacyAccess.prepare(access, trusted: current)
    XCTAssertEqual(prepared.original, before)
    let after = try CustodyLegacyAccess.snapshot(prepared.updated)
    XCTAssertEqual(after, prepared.expected)
    XCTAssertEqual(after.owner, before.owner)
    XCTAssertEqual(after.group, before.group)
    XCTAssertEqual(after.ownerType, before.ownerType)
    XCTAssertEqual(after.acls.count, before.acls.count)
    var currentData: CFData?
    XCTAssertEqual(SecTrustedApplicationCopyData(current, &currentData), errSecSuccess)
    let trustedBytes = try XCTUnwrap(currentData) as Data
    for i in before.acls.indices {
      if targetIndices.contains(i) {
        XCTAssertEqual(after.acls[i].applications, [trustedBytes])
        XCTAssertNotEqual(after.acls[i].applications, before.acls[i].applications)
        XCTAssertEqual(after.acls[i].description, before.acls[i].description)
        XCTAssertEqual(after.acls[i].prompt, before.acls[i].prompt)
        XCTAssertEqual(after.acls[i].authorizations, before.acls[i].authorizations)
      } else {
        XCTAssertEqual(after.acls[i], before.acls[i])
      }
    }
  }

  func testBroadDefaultDecryptApplicationListIsRefusedInMemory() throws {
    let (access, current) = try fixture()
    let acl = try decryptACL(access)
    var applications: CFArray?
    var description: CFString?
    var prompt = SecKeychainPromptSelector()
    XCTAssertEqual(SecACLCopyContents(acl, &applications, &description, &prompt), errSecSuccess)
    XCTAssertEqual(SecACLSetContents(acl, nil, try XCTUnwrap(description), prompt), errSecSuccess)
    XCTAssertThrowsError(try CustodyLegacyAccess.prepare(access, trusted: current))
  }

  func testAnyAndControlMixedWithDecryptAreRefusedInMemory() throws {
    for tags in [[kSecACLAuthorizationAny], [kSecACLAuthorizationDecrypt, kSecACLAuthorizationChangeACL]] {
      let (access, current) = try fixture()
      XCTAssertEqual(SecACLUpdateAuthorizations(try decryptACL(access), tags as CFArray), errSecSuccess)
      XCTAssertThrowsError(try CustodyLegacyAccess.prepare(access, trusted: current))
    }
  }

  func testMultipleDecryptACLsAreRefusedRatherThanMergingDistinctGrants() throws {
    let (access, current) = try fixture()
    var added: SecACL?
    XCTAssertEqual(SecACLCreateWithSimpleContents(access, [current] as CFArray,
      "Synthetic second decrypt rule" as CFString, [], &added), errSecSuccess)
    XCTAssertEqual(SecACLUpdateAuthorizations(try XCTUnwrap(added), [kSecACLAuthorizationDecrypt] as CFArray), errSecSuccess)
    XCTAssertThrowsError(try CustodyLegacyAccess.prepare(access, trusted: current))
  }
}
