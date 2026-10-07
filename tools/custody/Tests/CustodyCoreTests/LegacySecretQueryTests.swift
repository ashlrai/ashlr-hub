// Query dictionaries and injected responses only. No SecItem calls, stored
// credentials, authentication, ACL writes or installed-helper invocation.
import XCTest
import Foundation
import Security
import CustodyCore
@testable import CustodySecurity

final class LegacySecretQueryTests: XCTestCase {
  final class Item {
    let id: String
    init(_ id: String) { self.id = id }
  }

  final class Effects {
    var events: [String] = []
    var status = errSecSuccess
    var items = [Item("selected")]
    var findFailure: CustodyFailure?
    var readFailure: CustodyFailure?
    var readItem: Item?
    let data = Data("synthetic test bytes".utf8)

    func run() throws -> Data? {
      try CustodyLegacySecretQuery.read(
        disableInteraction: { self.events.append("disable"); return self.status },
        findItems: {
          self.events.append("find")
          if let failure = self.findFailure { throw failure }
          return self.items
        },
        readData: { item in
          self.events.append("read")
          self.readItem = item
          if let failure = self.readFailure { throw failure }
          return self.data
        }
      )
    }
  }

  func assertSelector(_ query: [String: Any], file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertEqual(query[kSecClass as String] as? String, kSecClassGenericPassword as String, file: file, line: line)
    XCTAssertEqual(query[kSecAttrService as String] as? String, "synthetic-service", file: file, line: line)
    XCTAssertEqual(query[kSecAttrAccount as String] as? String, "synthetic-account", file: file, line: line)
    XCTAssertEqual(query[kSecUseDataProtectionKeychain as String] as? Bool, false, file: file, line: line)
    XCTAssertEqual(query[kSecAttrSynchronizable as String] as? Bool, false, file: file, line: line)
    XCTAssertNil(query[kSecMatchSearchList as String], file: file, line: line)
    XCTAssertNil(query[kSecValueData as String], file: file, line: line)
    XCTAssertNil(query[kSecAttrAccess as String], file: file, line: line)
  }

  func testSharedReferenceSelectorRequestsAllLegacyNonSyncReferencesWithoutData() {
    let query = CustodyLegacySecretQuery.references(service: "synthetic-service", account: "synthetic-account")
    assertSelector(query)
    XCTAssertEqual(query[kSecReturnRef as String] as? Bool, true)
    XCTAssertEqual(query[kSecMatchLimit as String] as? String, kSecMatchLimitAll as String)
    XCTAssertNil(query[kSecReturnData as String])
    XCTAssertNil(query[kSecMatchItemList as String])
    XCTAssertEqual(query.count, 7)
  }

  func testExactDataQueryRetainsAttributesAndSelectedReference() throws {
    // A synthetic CF object is sufficient to inspect a dictionary; it is
    // deliberately never admitted or passed to a Keychain API.
    let item = "synthetic-reference" as CFString
    let query = CustodyLegacySecretQuery.data(service: "synthetic-service", account: "synthetic-account", item: item)
    assertSelector(query)
    let list = try XCTUnwrap(query[kSecMatchItemList as String] as? [CFTypeRef])
    XCTAssertEqual(list.count, 1)
    XCTAssertTrue(CFEqual(list[0], item))
    XCTAssertEqual(query[kSecReturnData as String] as? Bool, true)
    XCTAssertEqual(query[kSecMatchLimit as String] as? String, kSecMatchLimitOne as String)
    XCTAssertNil(query[kSecReturnRef as String])
    XCTAssertEqual(query.count, 8)
  }

  func testPresenceQueryCannotReadDataAndSeesAllMatchingAttributes() {
    let query = CustodyLegacySecretQuery.attributes(service: "synthetic-service", account: "synthetic-account")
    assertSelector(query)
    XCTAssertEqual(query[kSecReturnAttributes as String] as? Bool, true)
    XCTAssertEqual(query[kSecMatchLimit as String] as? String, kSecMatchLimitAll as String)
    XCTAssertNil(query[kSecReturnData as String])
    XCTAssertNil(query[kSecReturnRef as String])
    XCTAssertEqual(query.count, 7)
  }

  func testAmbiguousAndMalformedPresenceStayUnknownRatherThanUsable() {
    XCTAssertEqual(CustodyLegacySecretQuery.presence([] as CFArray), false)
    XCTAssertEqual(CustodyLegacySecretQuery.presence([["account": "synthetic"]] as CFArray), true)
    XCTAssertNil(CustodyLegacySecretQuery.presence([["account": "one"], ["account": "two"]] as CFArray))
    XCTAssertNil(CustodyLegacySecretQuery.presence(nil))
    XCTAssertNil(CustodyLegacySecretQuery.presence("invalid metadata" as CFString))
    XCTAssertNil(CustodyLegacySecretQuery.presence(["invalid metadata" as CFString] as CFArray))
  }

  func testUniqueReaderReadsExactlySelectedIdentityAfterDisablingInteraction() throws {
    let effects = Effects()
    let selected = effects.items[0]
    XCTAssertEqual(try effects.run(), effects.data)
    XCTAssertTrue(effects.readItem === selected)
    XCTAssertEqual(effects.events, ["disable", "find", "read"])
  }

  func testMissingItemReturnsNilWithoutAnyDataRead() throws {
    let effects = Effects(); effects.items = []
    XCTAssertNil(try effects.run())
    XCTAssertNil(effects.readItem)
    XCTAssertEqual(effects.events, ["disable", "find"])
  }

  func testAmbiguousItemsRefuseInsteadOfFirstMatchSecretRead() {
    let effects = Effects(); effects.items.append(Item("other"))
    XCTAssertThrowsError(try effects.run()) { error in
      XCTAssertEqual((error as? CustodyFailure)?.code, "ambiguous-item")
      XCTAssertEqual((error as? CustodyFailure)?.exit, .refused)
    }
    XCTAssertNil(effects.readItem)
    XCTAssertEqual(effects.events, ["disable", "find"])
  }

  func testFailureToDisableInteractionPreventsEvenReferenceLookup() {
    let effects = Effects(); effects.status = errSecAuthFailed
    XCTAssertThrowsError(try effects.run()) { error in
      XCTAssertEqual(error as? CustodyFailure, CustodyLegacySecretQuery.failure(errSecAuthFailed, .disableInteraction))
    }
    XCTAssertEqual(effects.events, ["disable"])
  }

  func testReferenceFailurePropagatesWithoutReadOrRetry() {
    let effects = Effects()
    effects.findFailure = CustodyLegacySecretQuery.failure(errSecInteractionNotAllowed, .find)
    XCTAssertThrowsError(try effects.run()) { XCTAssertEqual($0 as? CustodyFailure, effects.findFailure) }
    XCTAssertEqual(effects.events, ["disable", "find"])
  }

  func testSelectedItemReadFailurePropagatesWithoutRetryOrPrompt() {
    let effects = Effects()
    effects.readFailure = CustodyLegacySecretQuery.failure(errSecAuthFailed, .read)
    XCTAssertThrowsError(try effects.run()) { XCTAssertEqual($0 as? CustodyFailure, effects.readFailure) }
    XCTAssertEqual(effects.events, ["disable", "find", "read"])
  }

  func testRemovalAfterSelectionIsFailureWithoutFallbackRead() {
    let effects = Effects()
    effects.readFailure = CustodyLegacySecretQuery.failure(errSecItemNotFound, .read)
    XCTAssertThrowsError(try effects.run()) { XCTAssertEqual($0 as? CustodyFailure, effects.readFailure) }
    XCTAssertEqual(effects.events, ["disable", "find", "read"])
  }

  func testDistinctAuthorizationErrorsKeepNumericStatusAndSafeAction() {
    let interaction = CustodyLegacySecretQuery.failure(errSecInteractionNotAllowed, .read)
    let authorization = CustodyLegacySecretQuery.failure(errSecAuthFailed, .read)
    XCTAssertNotEqual(interaction.message, authorization.message)
    for (failure, status) in [(interaction, errSecInteractionNotAllowed), (authorization, errSecAuthFailed)] {
      XCTAssertEqual(failure.code, "keystore")
      XCTAssertEqual(failure.exit, .keystore)
      XCTAssertTrue(failure.message.contains("Keychain read failed"))
      XCTAssertTrue(failure.message.contains("OSStatus \(status)"))
      XCTAssertFalse(failure.message.contains("reauthorize"))
      XCTAssertFalse(failure.message.contains("synthetic test bytes"))
    }
  }

  func testOtherStatusIsPreservedWithoutInventingAuthorizationCause() {
    let failure = CustodyLegacySecretQuery.failure(errSecNotAvailable, .find)
    XCTAssertEqual(failure.message, "Keychain find failed (OSStatus \(errSecNotAvailable))")
  }

  func testSuccessWithMalformedReferencePayloadIsNotAUsableItem() {
    for result in [nil, "wrong scalar" as CFString, ["wrong item" as CFString] as CFArray] as [CFTypeRef?] {
      XCTAssertThrowsError(try CustodyLegacySecretQuery.checkedReferences(result)) { error in
        XCTAssertEqual(error as? CustodyFailure, CustodyLegacySecretQuery.invalidResult(.find))
        XCTAssertTrue((error as? CustodyFailure)?.message.contains("invalid result") == true)
      }
    }
  }

  func testSuccessWithMalformedDataIsExplicitInvalidResultWhileEmptyDataIsValid() throws {
    for result in [nil, "wrong data type" as CFString] as [CFTypeRef?] {
      XCTAssertThrowsError(try CustodyLegacySecretQuery.checkedData(result)) { error in
        XCTAssertEqual(error as? CustodyFailure, CustodyLegacySecretQuery.invalidResult(.read))
      }
    }
    XCTAssertEqual(try CustodyLegacySecretQuery.checkedData(Data() as CFData), Data())
  }
}
