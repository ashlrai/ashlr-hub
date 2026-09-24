import CryptoKit
import XCTest
@testable import CustodyCore

final class SigningAndPromptTests: XCTestCase {
  var fx: GrantFixture!
  var grant: ValidatedGrant!

  override func setUpWithError() throws {
    fx = try GrantFixture.load()
    grant = try StandingGrantValidator.validate(fx.payload, context: fixtureContext)
  }

  func testSigningMessageIsDomainPlusCanonical() {
    let message = GrantSigning.message(for: grant)
    XCTAssertEqual(message, Data(("ashlr:standing-grant:v1\u{0}" + fx.canonical).utf8))
    XCTAssertEqual(message.prefix(24), Data("ashlr:standing-grant:v1\u{0}".utf8))
  }

  func testNodeAndSwiftFixtureSignaturesVerifyOverTheSameBytes() throws {
    let message = GrantSigning.message(for: grant)
    for (pem, sig) in [(fx.nodePublicKeyPEM, fx.nodeSignature), (fx.swiftPublicKeyPEM, fx.swiftSignature)] {
      let key = try P256.Signing.PublicKey(pemRepresentation: pem)
      let signature = try P256.Signing.ECDSASignature(rawRepresentation: try XCTUnwrap(Data(base64Encoded: sig)))
      XCTAssertTrue(key.isValidSignature(signature, for: message))
      var tampered = message
      tampered[tampered.count - 2] ^= 0x01
      XCTAssertFalse(key.isValidSignature(signature, for: tampered))
    }
  }

  func testKeyIdAndPEMAreStableAcrossEncoders() throws {
    let key = try P256.Signing.PublicKey(pemRepresentation: fx.swiftPublicKeyPEM)
    XCTAssertEqual(KeyMaterial.keyId(spkiDER: key.derRepresentation), fx.swiftKeyId)
    XCTAssertTrue(fx.swiftKeyId.range(of: GrantContract.patternKeyId, options: .regularExpression) != nil)
    let pem = KeyMaterial.pem(der: key.derRepresentation, label: "PUBLIC KEY")
    XCTAssertEqual(KeyMaterial.der(fromPEM: pem, label: "PUBLIC KEY"), key.derRepresentation)
    XCTAssertEqual(try P256.Signing.PublicKey(pemRepresentation: pem).rawRepresentation, key.rawRepresentation)
    XCTAssertNil(KeyMaterial.der(fromPEM: pem, label: "PRIVATE KEY"))
  }

  func testEnvelopeIsCanonicalAndCarriesThePayloadVerbatim() throws {
    let raw = Data((0..<64).map { UInt8($0) })
    let text = try GrantSigning.envelope(for: grant, signatureP1363: raw)
    let parsed = try StrictJSONParser.parse(text)
    XCTAssertEqual(parsed.objectMembers?.map(\.key), ["payload", "signature"])
    XCTAssertEqual(try CanonicalJSON.encode(try XCTUnwrap(parsed["payload"])), fx.canonical)
    let sig = try XCTUnwrap(parsed["signature"]?.stringValue)
    XCTAssertTrue(sig.range(of: GrantContract.patternSignature, options: .regularExpression) != nil)
    XCTAssertEqual(try CanonicalJSON.encode(parsed), text)
    XCTAssertThrowsError(try GrantSigning.envelope(for: grant, signatureP1363: Data(count: 72)))
  }

  func testPromptDescribesTheWholeScopeAndTheDigest() {
    let prompt = GrantPromptRenderer.render(grant)
    XCTAssertTrue(prompt.reason.hasPrefix("approve Ashlr standing grant #1 for 30 days"))
    for repo in ["ashlrai/fleet-canary", "ashlrai/measurably", "ashlrai/ashlrcode"] {
      XCTAssertTrue(prompt.reason.contains(repo), repo)
      XCTAssertTrue(prompt.fullScope.contains(repo), repo)
    }
    XCTAssertTrue(prompt.reason.contains("Digest \(fx.digest.prefix(12))"))
    XCTAssertTrue(prompt.reason.contains("Rollout: shadow → 2a"))
    XCTAssertTrue(prompt.reason.contains("claude-a keeps 40%, idle above 70% 5h"))
    XCTAssertTrue(prompt.reason.contains("codex-a off"))
    XCTAssertTrue(prompt.reason.contains("10 files / 300 lines"))
    XCTAssertTrue(prompt.fullScope.contains(fx.digest))
    XCTAssertTrue(prompt.fullScope.contains("0 sandbox violations"))
    XCTAssertLessThanOrEqual(prompt.reason.count, GrantPromptRenderer.maxReasonLength)
  }

  func testPromptAbbreviatesRepoListButNeverDropsTheDigest() throws {
    var repos: [JSONValue] = []
    for i in 0..<32 {
      repos.append(.object([
        JSONMember(key: "nameWithOwner", value: .string("ashlrai/a-rather-long-repository-name-\(i)")),
        JSONMember(key: "stage", value: .string("merge")), JSONMember(key: "enforcement", value: .string("server")),
        JSONMember(key: "maxRisk", value: .string("medium")), JSONMember(key: "maxMergesPerDay", value: .integer(24)),
      ]))
    }
    var p = fx.payload.replacing([.key("repos")], with: .array(repos))
    let stageRepo = JSONValue.object([JSONMember(key: "nameWithOwner", value: .string("ashlrai/a-rather-long-repository-name-0")),
                                      JSONMember(key: "stage", value: .string("propose"))])
    for s in 0..<2 { p = p.replacing([.key("rollout"), .key("stages"), .index(s), .key("repos")], with: .array([stageRepo])) }
    let big = try StandingGrantValidator.validate(p, context: fixtureContext)
    let prompt = GrantPromptRenderer.render(big)
    XCTAssertLessThanOrEqual(prompt.reason.count, GrantPromptRenderer.maxReasonLength)
    XCTAssertTrue(prompt.reason.contains("more (see terminal)"))
    XCTAssertTrue(prompt.reason.contains("Digest \(big.digestHex.prefix(12))"))
    XCTAssertTrue(prompt.fullScope.contains("a-rather-long-repository-name-31"))
  }
}
