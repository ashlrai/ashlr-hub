import XCTest
@testable import CustodyCore

final class ReauthorizationTests: XCTestCase {
  final class Effects {
    var events: [String] = []
    var matches = ["original-item"]
    var image = "installed-image"
    var acl = "original-acl"
    var operatorFailure: CustodyFailure?
    var imageFailure: CustodyFailure?
    var prepareFailure: CustodyFailure?
    var authFailure: CustodyFailure?
    var applyFailure: CustodyFailure?
    var verifyFailure: CustodyFailure?
    var onAuthentication: (() -> Void)?
    var reason = ""

    func run(_ account: ReauthorizationAccount = .githubApp) throws {
      try Reauthorization.perform(
        account: account,
        requireOperator: { self.events.append("operator"); if let failure = self.operatorFailure { throw failure } },
        installedIdentity: { self.events.append("image"); if let failure = self.imageFailure { throw failure }; return self.image },
        findItems: { self.events.append("lookup"); return self.matches },
        sameItem: { $0 == $1 },
        prepareAccess: { item in
          self.events.append("prepare:\(item)")
          if let failure = self.prepareFailure { throw failure }
          return self.acl
        },
        authenticate: { reason in
          self.events.append("authenticate"); self.reason = reason
          if let failure = self.authFailure { throw failure }
          self.onAuthentication?()
        },
        requireUnchangedAccess: { _, original in
          self.events.append("acl-recheck")
          if self.acl != original { throw CustodyFailure("access-changed", "changed", exit: .refused) }
        },
        applyAccess: { item, _ in
          self.events.append("apply:\(item)")
          if let failure = self.applyFailure { throw failure }
        },
        verifyAppliedAccess: { item, _ in
          self.events.append("verify:\(item)")
          if let failure = self.verifyFailure { throw failure }
        }
      )
    }
  }

  func testExplicitSingleAccountParserAndFixedResponse() throws {
    XCTAssertEqual(try CustodyCLI.parse(["reauthorize", "github-app"]), .reauthorize(account: .githubApp))
    XCTAssertEqual(try CustodyCLI.parse(["reauthorize", "claude-token"]), .reauthorize(account: .claudeToken))
    for args in [["reauthorize"], ["reauthorize", "all"], ["reauthorize", "--account", "github-app"],
                 ["reauthorize", "github-app", "claude-token"], ["reauthorize", "github-app", "--force"],
                 ["reauthorize", ""], ["reauthorize", "GITHUB-APP"]] {
      XCTAssertThrowsError(try CustodyCLI.parse(args))
    }
    XCTAssertEqual(Reauthorization.successJSON(account: .githubApp),
      "{\"v\":1,\"ok\":true,\"account\":\"github-app\",\"operation\":\"reauthorize-existing-item\"}")
    XCTAssertEqual(CustodyCLI.version, "1.2.0")
  }

  func testHumanAuthenticationPrecedesExactlyOneExistingItemCommit() throws {
    for account in [ReauthorizationAccount.githubApp, .claudeToken] {
      let effects = Effects()
      try effects.run(account)
      XCTAssertEqual(effects.events, ["operator", "image", "lookup", "prepare:original-item", "authenticate",
                                      "operator", "image", "lookup", "acl-recheck", "apply:original-item",
                                      "operator", "image", "lookup", "verify:original-item"])
      XCTAssertTrue(effects.reason.hasPrefix("Allow the currently installed Phantom custody helper"))
      XCTAssertTrue(effects.reason.contains(account.rawValue))
      XCTAssertTrue(effects.reason.contains("No credential or signing key will be replaced"))
    }
  }

  func testOperatorAndInstalledImageRefusedBeforeAnyKeychainOrAuthentication() {
    let operatorEffects = Effects()
    operatorEffects.operatorFailure = CustodyFailure("operator-required", "operator", exit: .refused)
    XCTAssertThrowsError(try operatorEffects.run())
    XCTAssertEqual(operatorEffects.events, ["operator"])
    let imageEffects = Effects()
    imageEffects.imageFailure = CustodyFailure("installed-helper-required", "image", exit: .refused)
    XCTAssertThrowsError(try imageEffects.run())
    XCTAssertEqual(imageEffects.events, ["operator", "image"])
  }

  func testMissingAndDuplicateItemsNeverAuthenticateOrCommit() {
    for matches in [[], ["one", "two"]] {
      let effects = Effects(); effects.matches = matches
      XCTAssertThrowsError(try effects.run()) { error in
        XCTAssertEqual((error as? CustodyFailure)?.code, matches.isEmpty ? "not-stored" : "ambiguous-item")
      }
      XCTAssertEqual(effects.events, ["operator", "image", "lookup"])
    }
  }

  func testUnsupportedMetadataAndCancelledHumanNeverCommit() {
    let unsupported = Effects()
    unsupported.prepareFailure = CustodyFailure("unsupported-access", "unsupported", exit: .refused)
    XCTAssertThrowsError(try unsupported.run())
    XCTAssertFalse(unsupported.events.contains("authenticate"))
    let cancelled = Effects()
    cancelled.authFailure = CustodyFailure("auth-cancelled", "cancelled", exit: .auth)
    XCTAssertThrowsError(try cancelled.run())
    XCTAssertEqual(cancelled.events.last, "authenticate")
    XCTAssertFalse(cancelled.events.contains("apply:original-item"))
  }

  func testInstalledReplacementAndOperatorChangeDuringPromptRefuseCommit() {
    let replaced = Effects(); replaced.onAuthentication = { replaced.image = "new-image" }
    XCTAssertThrowsError(try replaced.run()) { XCTAssertEqual(($0 as? CustodyFailure)?.code, "helper-changed") }
    XCTAssertFalse(replaced.events.contains("apply:original-item"))
    let operatorChanged = Effects()
    operatorChanged.onAuthentication = { operatorChanged.operatorFailure = CustodyFailure("operator-required", "changed", exit: .refused) }
    XCTAssertThrowsError(try operatorChanged.run())
    XCTAssertEqual(operatorChanged.events.last, "operator")
  }

  func testSameReferenceChangedACLAndReplacedOrRemovedItemRefuseCommit() {
    let changedACL = Effects(); changedACL.onAuthentication = { changedACL.acl = "new-rules" }
    XCTAssertThrowsError(try changedACL.run()) { XCTAssertEqual(($0 as? CustodyFailure)?.code, "access-changed") }
    XCTAssertEqual(changedACL.events.last, "acl-recheck")
    for matches in [[], ["replacement-item"], ["original-item", "new-duplicate"]] {
      let effects = Effects(); effects.onAuthentication = { effects.matches = matches }
      XCTAssertThrowsError(try effects.run())
      XCTAssertFalse(effects.events.contains("apply:original-item"))
    }
  }

  func testOSAuthorizationFailurePropagatesWithoutSecondCommitOrSuccess() {
    let effects = Effects()
    effects.applyFailure = CustodyFailure("keychain-authorization-failed", "OS refused", exit: .keystore)
    XCTAssertThrowsError(try effects.run()) { XCTAssertEqual(($0 as? CustodyFailure)?.code, "keychain-authorization-failed") }
    XCTAssertEqual(effects.events.filter { $0.hasPrefix("apply:") }.count, 1)
  }

  func testPostwriteMetadataFailureIsTruthfulAndDoesNotRepeatCommit() {
    let effects = Effects()
    effects.verifyFailure = CustodyFailure("readback", "failed", exit: .keystore)
    XCTAssertThrowsError(try effects.run()) { error in
      let failure = error as? CustodyFailure
      XCTAssertEqual(failure?.code, "reauthorization-unverified")
      XCTAssertTrue(failure?.message.contains("OS accepted the access change") == true)
      XCTAssertFalse(failure?.message.contains("nothing was changed") == true)
    }
    XCTAssertEqual(effects.events.filter { $0.hasPrefix("apply:") }.count, 1)
    XCTAssertEqual(effects.events.last, "verify:original-item")
  }

  func testOperatorContextRejectsEveryAgentMarkerSudoAndMissingTTYOrLoginHome() throws {
    func context(env: [String: String] = [:], stdin: Bool = true, stdout: Bool = true,
                 home: Bool = true, uid: UInt32 = 501, euid: UInt32 = 501) -> ReauthorizationOperatorContext {
      ReauthorizationOperatorContext(stdinTTY: stdin, stdoutTTY: stdout, loginHomeMatches: home,
                                     uid: uid, effectiveUID: euid, environment: env)
    }
    try context().requireOperator()
    for marker in ReauthorizationOperatorContext.nonOperatorMarkers {
      XCTAssertThrowsError(try context(env: [marker: "1"]).requireOperator())
      try context(env: [marker: "0"]).requireOperator()
      try context(env: [marker: ""]).requireOperator()
    }
    for value in [context(stdin: false), context(stdout: false), context(home: false),
                  context(uid: 0, euid: 0), context(euid: 0)] {
      XCTAssertThrowsError(try value.requireOperator())
    }
  }

  func testBroadMixedOrMissingDecryptLayoutIsNotRefreshed() throws {
    try Reauthorization.requireDecryptLayout(authorizations: ["decrypt"], decrypt: "decrypt", applicationCount: 1, hasDescription: true)
    for count in [nil, 0, 2] as [Int?] {
      XCTAssertThrowsError(try Reauthorization.requireDecryptLayout(authorizations: ["decrypt"], decrypt: "decrypt", applicationCount: count, hasDescription: true))
    }
    for tags in [[], ["any"], ["decrypt", "change-acl"], ["decrypt", "decrypt"]] {
      XCTAssertThrowsError(try Reauthorization.requireDecryptLayout(authorizations: tags, decrypt: "decrypt", applicationCount: 1, hasDescription: true))
    }
    XCTAssertThrowsError(try Reauthorization.requireDecryptLayout(authorizations: ["decrypt"], decrypt: "decrypt", applicationCount: 1, hasDescription: false))
    let legacy = Reauthorization.legacyDecryptAuthorizations
    for tags in [legacy, Array(legacy.reversed()), Array(legacy.dropFirst()) + [legacy[0]]] {
      try Reauthorization.requireDecryptLayout(authorizations: tags, decrypt: "ACLAuthorizationDecrypt", applicationCount: 1, hasDescription: true)
    }
    for tags in [Array(legacy.dropLast()), legacy + ["ACLAuthorizationChangeACL"],
                 legacy + [legacy[0]], Array(legacy.dropLast()) + [legacy[0]]] {
      XCTAssertThrowsError(try Reauthorization.requireDecryptLayout(authorizations: tags, decrypt: "ACLAuthorizationDecrypt", applicationCount: 1, hasDescription: true))
    }
  }
}
