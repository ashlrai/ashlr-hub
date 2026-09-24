import CryptoKit
import XCTest
@testable import CustodyCore

final class StandingGrantTests: XCTestCase {
  var fx: GrantFixture!

  override func setUpWithError() throws {
    fx = try GrantFixture.load()
  }

  // MARK: accepted

  func testFixtureValidatesToTheTypeScriptCanonicalBytes() throws {
    let g = try StandingGrantValidator.validate(fx.payload, context: fixtureContext)
    XCTAssertEqual(g.canonical, fx.canonical, "Swift and TypeScript must sign the same bytes")
    XCTAssertEqual(g.digestHex, fx.digest)
    XCTAssertEqual(g.repos.map(\.nameWithOwner), ["ashlrai/fleet-canary", "ashlrai/measurably", "ashlrai/ashlrcode"])
    XCTAssertEqual(g.seats.map(\.id), ["claude-a", "codex-a", "grok-a"])
    XCTAssertEqual(g.seats.first?.maxSessionWindowPercent, 70)
    XCTAssertEqual(g.stages.map(\.id), ["shadow", "2a"])
    XCTAssertEqual(g.maxFiles, 10)
    XCTAssertEqual(g.leaderClasses, ["A", "B"])
  }

  func testFixtureValidatesFromRawBytesAndFromEscapedInput() throws {
    let raw = try StandingGrantValidator.validate(json: Data(fx.canonical.utf8), context: fixtureContext)
    XCTAssertEqual(raw.canonical, fx.canonical)
    // JSONSerialization escapes '/' as '\/'; the signed bytes must not change.
    let escaped = fx.canonical.replacingOccurrences(of: "/", with: "\\/")
    let g = try StandingGrantValidator.validate(json: Data(escaped.utf8), context: fixtureContext)
    XCTAssertEqual(g.canonical, fx.canonical)
  }

  // MARK: refused — not a grant

  func testRefusesAnEnvelopeAndArbitraryPayloads() throws {
    let envelope = JSONValue.object([JSONMember(key: "payload", value: fx.payload), JSONMember(key: "signature", value: .string("x"))])
    assertRefused(envelope, path: "payload")
    assertRefused(.array([fx.payload]), path: "")
    assertRefused(.string("sign me"), path: "")
    assertRefused(.object([]), path: "v")
    XCTAssertThrowsError(try StandingGrantValidator.validate(json: Data("not json".utf8), context: fixtureContext))
    XCTAssertThrowsError(try StandingGrantValidator.validate(json: Data("{\"v\":1,\"v\":1}".utf8), context: fixtureContext))
  }

  func testRefusesUnknownAndMissingKeysAtEveryLevel() {
    let p = fx.payload
    assertRefused(p.replacing([.key("extra")], with: .bool(true)), path: "extra")
    assertRefused(p.replacing([.key("rollout")], with: nil), path: "rollout")
    assertRefused(p.replacing([.key("repos"), .index(0), .key("path")], with: .string("/x")), path: "repos[0].path")
    assertRefused(p.replacing([.key("merge"), .key("maxLines")], with: nil), path: "merge.maxLines")
    assertRefused(p.replacing([.key("spend"), .key("seats"), .key("grok-a"), .key("weekly")], with: .integer(1)), path: "spend.seats.grok-a.weekly")
    assertRefused(p.replacing([.key("leader"), .key("classes")], with: nil), path: "leader.classes")
    assertRefused(p.replacing([.key("rollout"), .key("stages"), .index(1), .key("criteria"), .key("bonus")], with: .integer(1)),
                  path: "rollout.stages[1].criteria.bonus")
  }

  // MARK: refused — ceilings

  func testRefusesValuesAboveTheCompiledCeilings() {
    let p = fx.payload
    assertRefused(p.replacing([.key("merge"), .key("maxFiles")], with: .integer(11)), path: "merge.maxFiles")
    assertRefused(p.replacing([.key("merge"), .key("maxLines")], with: .integer(301)), path: "merge.maxLines")
    assertRefused(p.replacing([.key("merge"), .key("maxFiles")], with: .integer(40)), path: "merge.maxFiles")
    assertRefused(p.replacing([.key("repos"), .index(0), .key("maxRisk")], with: .string("high")), path: "repos[0].maxRisk")
    assertRefused(p.replacing([.key("repos"), .index(0), .key("maxMergesPerDay")], with: .integer(25)), path: "repos[0].maxMergesPerDay")
    assertRefused(p.replacing([.key("spend"), .key("meteredUsdPerDay")], with: .integer(10_001)), path: "spend.meteredUsdPerDay")
    assertRefused(p.replacing([.key("spend"), .key("maxMode")], with: .string("unlimited")), path: "spend.maxMode")
    assertRefused(p.replacing([.key("spend"), .key("seats"), .key("claude-a"), .key("reserveFloorPercent")], with: .integer(101)),
                  path: "spend.seats.claude-a.reserveFloorPercent")
    assertRefused(p.replacing([.key("leader"), .key("vetoMinutes")], with: .integer(29)), path: "leader.vetoMinutes")
    assertRefused(p.replacing([.key("leader"), .key("classes")], with: .array([.string("C")])), path: "leader.classes[0]")
    assertRefused(p.replacing([.key("engines")], with: .array([.string("local"), .string("api.x.ai")])), path: "engines[1]")
    assertRefused(p.replacing([.key("rollout"), .key("stages"), .index(0), .key("criteria"), .key("minHours")], with: .integer(721)),
                  path: "rollout.stages[0].criteria.minHours")
  }

  func testLocalEnforcementIsCappedAtLowRiskAndFourMerges() {
    let p = fx.payload  // repos[1] is ashlrai/measurably, enforcement local
    assertRefused(p.replacing([.key("repos"), .index(1), .key("maxRisk")], with: .string("medium")), path: "repos[1].maxRisk")
    assertRefused(p.replacing([.key("repos"), .index(1), .key("maxMergesPerDay")], with: .integer(5)), path: "repos[1].maxMergesPerDay")
  }

  func testCriteriaNeverTolerateViolationsOrReserveBreaches() {
    let base: [PathPart] = [.key("rollout"), .key("stages"), .index(1), .key("criteria")]
    assertRefused(fx.payload.replacing(base + [.key("maxSandboxViolations")], with: .integer(1)), path: "rollout.stages[1].criteria.maxSandboxViolations")
    assertRefused(fx.payload.replacing(base + [.key("reserveBreaches")], with: .integer(1)), path: "rollout.stages[1].criteria.reserveBreaches")
    assertRefused(fx.payload.replacing([.key("rollout"), .key("autoAdvance")], with: .bool(false)), path: "rollout.autoAdvance")
  }

  // MARK: refused — a stage may only narrow the grant

  func testRolloutStagesCannotWidenTheGrant() {
    let st: [PathPart] = [.key("rollout"), .key("stages"), .index(1)]
    // ashlrcode is granted `propose`; a stage cannot lift it to `merge`.
    assertRefused(fx.payload.replacing(st + [.key("repos"), .index(1), .key("stage")], with: .string("merge")), path: "rollout.stages[1].repos[1].stage")
    let stranger = JSONValue.object([JSONMember(key: "nameWithOwner", value: .string("ashlrai/elsewhere")), JSONMember(key: "stage", value: .string("propose"))])
    assertRefused(fx.payload.replacing(st + [.key("repos"), .index(0)], with: stranger), path: "rollout.stages[1].repos[0].nameWithOwner")
    let smallEngines = fx.payload.replacing([.key("engines")], with: .array([.string("local")]))
    assertRefused(smallEngines, path: "rollout.stages[0].engines[1]")
    assertRefused(fx.payload.replacing(st + [.key("maxFiles")], with: .integer(11)), path: "rollout.stages[1].maxFiles")
    let tighterMerge = fx.payload.replacing([.key("merge"), .key("maxLines")], with: .integer(100))
    assertRefused(tighterMerge, path: "rollout.stages[0].maxLines")
    let leaderAOnly = fx.payload.replacing([.key("leader"), .key("classes")], with: .array([]))
    assertRefused(leaderAOnly, path: "rollout.stages[1].leaderClasses[0]")
    let dupStage = fx.payload.replacing(st + [.key("id")], with: .string("shadow"))
    assertRefused(dupStage, path: "rollout.stages[1].id")
    assertRefused(fx.payload.replacing([.key("rollout"), .key("stages")], with: .array([])), path: "rollout.stages")
  }

  // MARK: refused — identity, time and number shapes

  func testRefusesBadIdentityAndTime() {
    let p = fx.payload
    assertRefused(p.replacing([.key("v")], with: .integer(2)), path: "v")
    assertRefused(p.replacing([.key("grantId")], with: .string("0123456789ABCDEF0123456789ABCDEF")), path: "grantId")
    assertRefused(p.replacing([.key("grantSeq")], with: .integer(0)), path: "grantSeq")
    assertRefused(p.replacing([.key("grantSeq")], with: .integer(9_007_199_254_740_992)), path: "grantSeq")
    assertRefused(p.replacing([.key("hostBinding")], with: .string("x")), path: "hostBinding")
    assertRefused(p.replacing([.key("keyId")], with: .string("mason key")), path: "keyId")
    assertRefused(p.replacing([.key("expiresAt")], with: .string("2026-10-24T12:00:00.001Z")), path: "expiresAt")  // 30 d + 1 ms
    assertRefused(p.replacing([.key("expiresAt")], with: .string("2026-09-24T12:00:00.000Z")), path: "expiresAt")  // not after issuedAt
    assertRefused(p.replacing([.key("issuedAt")], with: .string("2026-02-30T12:00:00.000Z")), path: "issuedAt")  // not a real instant
    assertRefused(p.replacing([.key("issuedAt")], with: .string("2026-09-24T12:00:00Z")), path: "issuedAt")      // not toISOString()
    assertRefused(p.replacing([.key("issuedAt")], with: .string("2026-09-24T12:11:00.000Z")), path: "issuedAt")  // future (> 5 min skew)
    let late = GrantValidationContext(now: ISOInstant.parse("2026-10-24T12:00:00.000Z")!)
    XCTAssertThrowsError(try StandingGrantValidator.validate(p, context: late)) { error in
      XCTAssertEqual((error as? GrantRefusal)?.path, "expiresAt")
    }
  }

  func testRefusesNonIntegerAndMistypedValues() {
    let p = fx.payload
    assertRefused(p.replacing([.key("merge"), .key("maxFiles")], with: .number(4.5)), path: "merge.maxFiles")
    assertRefused(p.replacing([.key("merge"), .key("maxFiles")], with: .integer(-1)), path: "merge.maxFiles")
    assertRefused(p.replacing([.key("merge"), .key("maxFiles")], with: .string("4")), path: "merge.maxFiles")
    assertRefused(p.replacing([.key("conductorGoals")], with: .integer(1)), path: "conductorGoals")
    assertRefused(p.replacing([.key("repos"), .index(0), .key("nameWithOwner")], with: .string("ashlrai/fleet-cänary")), path: "repos[0].nameWithOwner")
    assertRefused(p.replacing([.key("repos"), .index(1), .key("nameWithOwner")], with: .string("ASHLRAI/Fleet-Canary")), path: "repos[1].nameWithOwner")
    assertRefused(p.replacing([.key("spend"), .key("seats"), .key("grok-a"), .key("roles")], with: .array([.string("judge"), .string("judge")])),
                  path: "spend.seats.grok-a.roles[1]")
    assertRefused(p.replacing([.key("spend"), .key("seats"), .key("grok-a"), .key("roles")], with: .array([.string("judge"), .string("leader"), .string("producer"), .string("judge")])),
                  path: "spend.seats.grok-a.roles")
  }

  func testSeatCountIsBounded() {
    var members: [JSONMember] = []
    for i in 0..<65 {
      members.append(JSONMember(key: "seat-\(i)", value: .object([
        JSONMember(key: "enabled", value: .bool(false)), JSONMember(key: "reserveFloorPercent", value: .integer(100)),
        JSONMember(key: "roles", value: .array([])),
      ])))
    }
    assertRefused(fx.payload.replacing([.key("spend"), .key("seats")], with: .object(members)), path: "spend.seats")
  }
}
