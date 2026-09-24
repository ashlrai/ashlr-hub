// Strict StandingGrantV1 validation — what the helper checks before it will
// even ask for Touch ID.
//
// The TypeScript verifier (authority/standing-grant.ts, unit U1) is the
// authority on whether a signed grant is ACCEPTED. This validator decides
// what the helper is willing to SIGN, and it errs strict: an unknown key, a
// value above a compiled ceiling, a rollout stage that would widen the grant,
// or any number that is not a non-negative safe integer is refused. Every
// refusal names the exact field so the Command surface can show Mason why.

import CryptoKit
import Foundation

public struct GrantRefusal: Error, Equatable, CustomStringConvertible {
  /// JSON path of the offending field, e.g. `rollout.stages[1].maxFiles`.
  public let path: String
  public let reason: String
  public var description: String { path.isEmpty ? reason : "\(path): \(reason)" }
}

public struct GrantRepo: Equatable, Sendable {
  public let nameWithOwner: String
  public let stage: String
  public let enforcement: String
  public let maxRisk: String
  public let maxMergesPerDay: Int64
}

public struct GrantSeat: Equatable, Sendable {
  public let id: String
  public let enabled: Bool
  public let reserveFloorPercent: Int64
  public let maxSessionWindowPercent: Int64?
  public let roles: [String]
}

public struct GrantStageRepo: Equatable, Sendable {
  public let nameWithOwner: String
  public let stage: String
}

public struct GrantCriteria: Equatable, Sendable {
  public let minMerges: Int64
  public let minPostMergeGreenPct: Int64
  public let maxRevertRatePct: Int64
  public let minHours: Int64
}

public struct GrantStage: Equatable, Sendable {
  public let id: String
  public let repos: [GrantStageRepo]
  public let engines: [String]
  public let maxRisk: String
  public let maxFiles: Int64
  public let maxLines: Int64
  public let maxMergesPerRepoPerDay: Int64
  public let leaderClasses: [String]
  public let criteria: GrantCriteria
}

/// A grant that passed every check, plus the exact bytes that will be signed.
public struct ValidatedGrant: Equatable, Sendable {
  public let grantId: String
  public let grantSeq: Int64
  public let keyId: String
  public let issuedAt: String
  public let expiresAt: String
  public let issuedAtDate: Date
  public let expiresAtDate: Date
  public let hostBinding: String
  public let authoritySurfaceDigest: String
  public let repos: [GrantRepo]
  public let maxFiles: Int64
  public let maxLines: Int64
  public let selfRepo: String
  public let maxMode: String
  public let meteredUsdPerDay: Int64
  /// Sorted by seat id.
  public let seats: [GrantSeat]
  public let engines: [String]
  public let leaderClasses: [String]
  public let vetoMinutes: Int64
  public let conductorGoals: Bool
  public let stages: [GrantStage]
  /// canonicalizeDaemonActivationValue(payload).
  public let canonical: String
  /// sha256 hex of `canonical` — the AuthorityGrantDraft digest Mason's Touch ID sheet shows.
  public let digestHex: String
}

public struct GrantValidationContext: Sendable {
  public let now: Date
  /// Tolerated clock difference between the drafting server and this Mac.
  public let maxClockSkew: TimeInterval
  public init(now: Date, maxClockSkew: TimeInterval = 300) {
    self.now = now
    self.maxClockSkew = maxClockSkew
  }
}

public enum StandingGrantValidator {
  static let riskRank: [String: Int] = ["low": 0, "medium": 1]
  static let stageRank: [String: Int] = ["propose": 0, "merge": 1]

  /// Parse + validate a StandingGrantV1 payload (NOT an envelope — an
  /// envelope has unknown top-level keys and is refused like anything else).
  public static func validate(json data: Data, context: GrantValidationContext) throws -> ValidatedGrant {
    let value: JSONValue
    do {
      value = try StrictJSONParser.parse(data)
    } catch let error as JSONParseError {
      throw GrantRefusal(path: "", reason: "not a StandingGrantV1: \(error)")
    }
    return try validate(value, context: context)
  }

  public static func validate(_ value: JSONValue, context: GrantValidationContext) throws -> ValidatedGrant {
    let top = try exactObject(value, path: "", keys: GrantContract.keysGrant, optional: [])

    let v = try integer(top["v"], path: "v", range: 1...1)
    _ = v
    let grantId = try string(top["grantId"], path: "grantId", pattern: GrantContract.patternGrantId)
    let grantSeq = try integer(top["grantSeq"], path: "grantSeq", range: 1...GrantContract.maxSafeInteger)
    let keyId = try string(top["keyId"], path: "keyId", pattern: GrantContract.patternKeyId)
    let issuedAt = try string(top["issuedAt"], path: "issuedAt", pattern: GrantContract.patternIsoInstant)
    let expiresAt = try string(top["expiresAt"], path: "expiresAt", pattern: GrantContract.patternIsoInstant)
    let issuedAtDate = try instant(issuedAt, path: "issuedAt")
    let expiresAtDate = try instant(expiresAt, path: "expiresAt")
    let ttlMs = (expiresAtDate.timeIntervalSince(issuedAtDate) * 1000).rounded()
    if ttlMs <= 0 {
      throw GrantRefusal(path: "expiresAt", reason: "must be after issuedAt")
    }
    if ttlMs > Double(GrantContract.maxTtlMs) {
      throw GrantRefusal(path: "expiresAt", reason: "a grant lasts at most 30 days")
    }
    if issuedAtDate.timeIntervalSince(context.now) > context.maxClockSkew {
      throw GrantRefusal(path: "issuedAt", reason: "is in the future on this Mac's clock")
    }
    if expiresAtDate <= context.now {
      throw GrantRefusal(path: "expiresAt", reason: "has already passed")
    }
    let hostBinding = try string(top["hostBinding"], path: "hostBinding", pattern: GrantContract.patternSha256Hex)
    let surface = try string(top["authoritySurfaceDigest"], path: "authoritySurfaceDigest", pattern: GrantContract.patternSha256Hex)

    // --- repos
    let repoValues = try array(top["repos"], path: "repos", count: 1...Int(GrantContract.maxRepos))
    var repos: [GrantRepo] = []
    var repoNamesLower = Set<String>()
    for (i, item) in repoValues.enumerated() {
      let p = "repos[\(i)]"
      let obj = try exactObject(item, path: p, keys: GrantContract.keysRepo, optional: [])
      let name = try string(obj["nameWithOwner"], path: "\(p).nameWithOwner", pattern: GrantContract.patternNameWithOwner)
      if !repoNamesLower.insert(name.lowercased()).inserted {
        throw GrantRefusal(path: "\(p).nameWithOwner", reason: "\(name) is listed twice")
      }
      let stage = try oneOf(obj["stage"], path: "\(p).stage", allowed: GrantContract.repoStages)
      let enforcement = try oneOf(obj["enforcement"], path: "\(p).enforcement", allowed: GrantContract.repoEnforcements)
      let maxRisk = try oneOf(obj["maxRisk"], path: "\(p).maxRisk", allowed: GrantContract.mergeRisks)
      let maxMerges = try integer(obj["maxMergesPerDay"], path: "\(p).maxMergesPerDay", range: 0...GrantContract.maxMergesPerRepoPerDay)
      if enforcement == "local" {
        if maxRisk != GrantContract.localEnforcementMaxRisk {
          throw GrantRefusal(path: "\(p).maxRisk", reason: "a repo without server-side enforcement merges \(GrantContract.localEnforcementMaxRisk) risk only")
        }
        if maxMerges > GrantContract.localEnforcementMaxMergesPerDay {
          throw GrantRefusal(path: "\(p).maxMergesPerDay", reason: "a repo without server-side enforcement merges at most \(GrantContract.localEnforcementMaxMergesPerDay) a day")
        }
      }
      repos.append(GrantRepo(nameWithOwner: name, stage: stage, enforcement: enforcement, maxRisk: maxRisk, maxMergesPerDay: maxMerges))
    }

    // --- merge
    let merge = try exactObject(top["merge"], path: "merge", keys: GrantContract.keysMerge, optional: [])
    let maxFiles = try integer(merge["maxFiles"], path: "merge.maxFiles", range: 1...GrantContract.maxFiles)
    let maxLines = try integer(merge["maxLines"], path: "merge.maxLines", range: 1...GrantContract.maxLines)
    let selfRepo = try oneOf(merge["selfRepo"], path: "merge.selfRepo", allowed: GrantContract.selfRepoModes)

    // --- spend
    let spend = try exactObject(top["spend"], path: "spend", keys: GrantContract.keysSpend, optional: [])
    let maxMode = try oneOf(spend["maxMode"], path: "spend.maxMode", allowed: GrantContract.budgetModes)
    let metered = try integer(spend["meteredUsdPerDay"], path: "spend.meteredUsdPerDay", range: 0...GrantContract.maxMeteredUsdPerDay)
    guard let seatMembers = spend["seats"]?.objectMembers else {
      throw GrantRefusal(path: "spend.seats", reason: "must be an object keyed by seat id")
    }
    if seatMembers.count > Int(GrantContract.maxSeats) {
      throw GrantRefusal(path: "spend.seats", reason: "at most \(GrantContract.maxSeats) seats")
    }
    var seats: [GrantSeat] = []
    for member in seatMembers {
      let p = "spend.seats.\(member.key)"
      _ = try checkString(member.key, path: p, pattern: GrantContract.patternSeatId)
      let obj = try exactObject(member.value, path: p, keys: GrantContract.keysSeat, optional: GrantContract.optionalKeysSeat)
      let enabled = try bool(obj["enabled"], path: "\(p).enabled")
      let floor = try integer(obj["reserveFloorPercent"], path: "\(p).reserveFloorPercent", range: 0...100)
      var ceiling: Int64? = nil
      if let raw = obj["maxSessionWindowPercent"] {
        ceiling = try integer(raw, path: "\(p).maxSessionWindowPercent", range: 0...100)
      }
      let roleValues = try array(obj["roles"], path: "\(p).roles", count: 0...Int(GrantContract.maxRolesPerSeat))
      var roles: [String] = []
      for (j, r) in roleValues.enumerated() {
        let role = try oneOf(r, path: "\(p).roles[\(j)]", allowed: GrantContract.seatRoles)
        if roles.contains(role) { throw GrantRefusal(path: "\(p).roles[\(j)]", reason: "\(role) is listed twice") }
        roles.append(role)
      }
      seats.append(GrantSeat(id: member.key, enabled: enabled, reserveFloorPercent: floor, maxSessionWindowPercent: ceiling, roles: roles))
    }
    seats.sort { CanonicalJSON.lessByUTF16($0.id, $1.id) }

    // --- engines
    let engines = try uniqueEnumList(top["engines"], path: "engines", allowed: GrantContract.fleetEngines, count: 1...GrantContract.fleetEngines.count)

    // --- leader
    let leader = try exactObject(top["leader"], path: "leader", keys: GrantContract.keysLeader, optional: [])
    let leaderClasses = try uniqueEnumList(leader["classes"], path: "leader.classes", allowed: GrantContract.leaderGrantClasses, count: 0...GrantContract.leaderGrantClasses.count)
    let vetoMinutes = try integer(leader["vetoMinutes"], path: "leader.vetoMinutes", range: GrantContract.minVetoMinutes...GrantContract.maxVetoMinutes)

    let conductorGoals = try bool(top["conductorGoals"], path: "conductorGoals")

    // --- rollout ladder: every stage may only NARROW the grant.
    let rollout = try exactObject(top["rollout"], path: "rollout", keys: GrantContract.keysRollout, optional: [])
    guard rollout["autoAdvance"] == .bool(true) else {
      throw GrantRefusal(path: "rollout.autoAdvance", reason: "must be true")
    }
    let stageValues = try array(rollout["stages"], path: "rollout.stages", count: 1...Int(GrantContract.maxStages))
    let grantRepoByName = Dictionary(uniqueKeysWithValues: repos.map { ($0.nameWithOwner, $0) })
    var stageIds = Set<String>()
    var stages: [GrantStage] = []
    for (i, item) in stageValues.enumerated() {
      let p = "rollout.stages[\(i)]"
      let obj = try exactObject(item, path: p, keys: GrantContract.keysStage, optional: [])
      let id = try string(obj["id"], path: "\(p).id", pattern: GrantContract.patternStageId)
      if !stageIds.insert(id).inserted { throw GrantRefusal(path: "\(p).id", reason: "stage \(id) is listed twice") }
      let stageRepoValues = try array(obj["repos"], path: "\(p).repos", count: 0...Int(GrantContract.maxRepos))
      var stageRepos: [GrantStageRepo] = []
      var seenStageRepos = Set<String>()
      for (j, r) in stageRepoValues.enumerated() {
        let rp = "\(p).repos[\(j)]"
        let robj = try exactObject(r, path: rp, keys: GrantContract.keysStageRepo, optional: [])
        let name = try string(robj["nameWithOwner"], path: "\(rp).nameWithOwner", pattern: GrantContract.patternNameWithOwner)
        guard let grantRepo = grantRepoByName[name] else {
          throw GrantRefusal(path: "\(rp).nameWithOwner", reason: "\(name) is not one of the grant's repos")
        }
        if !seenStageRepos.insert(name).inserted { throw GrantRefusal(path: "\(rp).nameWithOwner", reason: "\(name) is listed twice") }
        let stage = try oneOf(robj["stage"], path: "\(rp).stage", allowed: GrantContract.repoStages)
        if stageRank[stage]! > stageRank[grantRepo.stage]! {
          throw GrantRefusal(path: "\(rp).stage", reason: "\(name) is granted \(grantRepo.stage) at most")
        }
        stageRepos.append(GrantStageRepo(nameWithOwner: name, stage: stage))
      }
      let stageEngines = try uniqueEnumList(obj["engines"], path: "\(p).engines", allowed: GrantContract.fleetEngines, count: 0...GrantContract.fleetEngines.count)
      for (j, engine) in stageEngines.enumerated() where !engines.contains(engine) {
        throw GrantRefusal(path: "\(p).engines[\(j)]", reason: "\(engine) is not one of the grant's engines")
      }
      let stageRisk = try oneOf(obj["maxRisk"], path: "\(p).maxRisk", allowed: GrantContract.mergeRisks)
      let stageFiles = try integer(obj["maxFiles"], path: "\(p).maxFiles", range: 0...maxFiles)
      let stageLines = try integer(obj["maxLines"], path: "\(p).maxLines", range: 0...maxLines)
      let stageMerges = try integer(obj["maxMergesPerRepoPerDay"], path: "\(p).maxMergesPerRepoPerDay", range: 0...GrantContract.maxMergesPerRepoPerDay)
      let stageClasses = try uniqueEnumList(obj["leaderClasses"], path: "\(p).leaderClasses", allowed: GrantContract.leaderGrantClasses, count: 0...GrantContract.leaderGrantClasses.count)
      for (j, cls) in stageClasses.enumerated() where !leaderClasses.contains(cls) {
        throw GrantRefusal(path: "\(p).leaderClasses[\(j)]", reason: "class \(cls) is not granted to the Leader")
      }
      let c = try exactObject(obj["criteria"], path: "\(p).criteria", keys: GrantContract.keysCriteria, optional: [])
      let criteria = GrantCriteria(
        minMerges: try integer(c["minMerges"], path: "\(p).criteria.minMerges", range: 0...GrantContract.maxSafeInteger),
        minPostMergeGreenPct: try integer(c["minPostMergeGreenPct"], path: "\(p).criteria.minPostMergeGreenPct", range: 0...100),
        maxRevertRatePct: try integer(c["maxRevertRatePct"], path: "\(p).criteria.maxRevertRatePct", range: 0...100),
        minHours: try integer(c["minHours"], path: "\(p).criteria.minHours", range: 0...GrantContract.maxStageHours)
      )
      _ = try integer(c["maxSandboxViolations"], path: "\(p).criteria.maxSandboxViolations", range: 0...0)
      _ = try integer(c["reserveBreaches"], path: "\(p).criteria.reserveBreaches", range: 0...0)
      stages.append(GrantStage(id: id, repos: stageRepos, engines: stageEngines, maxRisk: stageRisk, maxFiles: stageFiles,
                               maxLines: stageLines, maxMergesPerRepoPerDay: stageMerges, leaderClasses: stageClasses, criteria: criteria))
    }

    let canonical: String
    do {
      canonical = try CanonicalJSON.encode(value)
    } catch {
      throw GrantRefusal(path: "", reason: "\(error)")
    }
    let digest = SHA256.hash(data: Data(canonical.utf8)).map { String(format: "%02x", $0) }.joined()

    return ValidatedGrant(
      grantId: grantId, grantSeq: grantSeq, keyId: keyId, issuedAt: issuedAt, expiresAt: expiresAt,
      issuedAtDate: issuedAtDate, expiresAtDate: expiresAtDate, hostBinding: hostBinding,
      authoritySurfaceDigest: surface, repos: repos, maxFiles: maxFiles, maxLines: maxLines, selfRepo: selfRepo,
      maxMode: maxMode, meteredUsdPerDay: metered, seats: seats, engines: engines, leaderClasses: leaderClasses,
      vetoMinutes: vetoMinutes, conductorGoals: conductorGoals, stages: stages, canonical: canonical, digestHex: digest
    )
  }

  // MARK: - field helpers

  static func exactObject(_ value: JSONValue?, path: String, keys: [String], optional: [String]) throws -> JSONValue {
    let label = path.isEmpty ? "the grant" : path
    guard let value, let members = value.objectMembers else {
      throw GrantRefusal(path: path, reason: "\(label) must be an object")
    }
    let allowed = Set(keys)
    for member in members where !allowed.contains(member.key) {
      throw GrantRefusal(path: path.isEmpty ? member.key : "\(path).\(member.key)", reason: "unknown key (not part of StandingGrantV1)")
    }
    let present = Set(members.map(\.key))
    for key in keys where !optional.contains(key) && !present.contains(key) {
      throw GrantRefusal(path: path.isEmpty ? key : "\(path).\(key)", reason: "missing")
    }
    return value
  }

  static func integer(_ value: JSONValue?, path: String, range: ClosedRange<Int64>) throws -> Int64 {
    guard let value else { throw GrantRefusal(path: path, reason: "missing") }
    guard case let .integer(n) = value else {
      throw GrantRefusal(path: path, reason: "must be a non-negative integer")
    }
    if !range.contains(n) {
      if range.lowerBound == range.upperBound {
        throw GrantRefusal(path: path, reason: "must be \(range.lowerBound)")
      }
      throw GrantRefusal(path: path, reason: "\(n) is outside \(range.lowerBound)…\(range.upperBound)")
    }
    return n
  }

  static func bool(_ value: JSONValue?, path: String) throws -> Bool {
    guard let value else { throw GrantRefusal(path: path, reason: "missing") }
    guard case let .bool(b) = value else { throw GrantRefusal(path: path, reason: "must be true or false") }
    return b
  }

  static func array(_ value: JSONValue?, path: String, count: ClosedRange<Int>) throws -> [JSONValue] {
    guard let value else { throw GrantRefusal(path: path, reason: "missing") }
    guard let items = value.arrayValue else { throw GrantRefusal(path: path, reason: "must be a list") }
    if !count.contains(items.count) {
      throw GrantRefusal(path: path, reason: "must hold \(count.lowerBound)–\(count.upperBound) entries (has \(items.count))")
    }
    return items
  }

  static func string(_ value: JSONValue?, path: String, pattern: String) throws -> String {
    guard let value else { throw GrantRefusal(path: path, reason: "missing") }
    guard let s = value.stringValue else { throw GrantRefusal(path: path, reason: "must be a string") }
    return try checkString(s, path: path, pattern: pattern)
  }

  /// Printable ASCII without '"' or '\\' (the CANONICAL BYTES rule in types.ts), then the pattern.
  static func checkString(_ s: String, path: String, pattern: String) throws -> String {
    for unit in s.utf8 where unit < 0x20 || unit > 0x7E || unit == 0x22 || unit == 0x5C {
      throw GrantRefusal(path: path, reason: "must be printable ASCII")
    }
    guard let re = try? NSRegularExpression(pattern: pattern) else {
      throw GrantRefusal(path: path, reason: "internal: bad pattern")
    }
    let range = NSRange(s.startIndex..<s.endIndex, in: s)
    guard re.firstMatch(in: s, options: [], range: range) != nil else {
      throw GrantRefusal(path: path, reason: "has an invalid format")
    }
    return s
  }

  static func oneOf(_ value: JSONValue?, path: String, allowed: [String]) throws -> String {
    guard let value else { throw GrantRefusal(path: path, reason: "missing") }
    guard let s = value.stringValue, allowed.contains(s) else {
      throw GrantRefusal(path: path, reason: "must be one of: \(allowed.joined(separator: ", "))")
    }
    return s
  }

  static func uniqueEnumList(_ value: JSONValue?, path: String, allowed: [String], count: ClosedRange<Int>) throws -> [String] {
    let items = try array(value, path: path, count: count)
    var out: [String] = []
    for (i, item) in items.enumerated() {
      let s = try oneOf(item, path: "\(path)[\(i)]", allowed: allowed)
      if out.contains(s) { throw GrantRefusal(path: "\(path)[\(i)]", reason: "\(s) is listed twice") }
      out.append(s)
    }
    return out
  }

  /// Exactly Date.prototype.toISOString()'s output: parse, re-format, compare.
  static func instant(_ s: String, path: String) throws -> Date {
    guard let date = ISOInstant.parse(s), ISOInstant.format(date) == s else {
      throw GrantRefusal(path: path, reason: "is not a real instant (use toISOString())")
    }
    return date
  }
}

public enum ISOInstant {
  static func formatter() -> ISO8601DateFormatter {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    f.timeZone = TimeZone(identifier: "UTC")
    return f
  }

  public static func parse(_ s: String) -> Date? { formatter().date(from: s) }
  public static func format(_ d: Date) -> String { formatter().string(from: d) }
}
