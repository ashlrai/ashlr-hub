// What Mason sees before he authorizes a signature.
//
// WHY the helper renders it (not the caller): anything that can ask for a
// signature could also lie about what it is asking for. The prompt text is
// built here, from the fields that were just validated and will be signed,
// so the Touch ID dialog always describes the exact payload. It leads with
// what raises authority the most (duration, repos that may merge, caps,
// spend) and ends with the digest the Command surface shows, so Mason can
// match the dialog to the sheet he approved from.

import Foundation

public struct GrantPrompt: Equatable, Sendable {
  /// LAContext.localizedReason — completes "ashlr-custody is trying to …".
  public let reason: String
  /// Every field, one per line, printed to the terminal before the dialog.
  public let fullScope: String
}

public enum GrantPromptRenderer {
  /// The system dialog wraps long text but has no scroll bar; past this the
  /// repo list is abbreviated and the terminal copy carries the rest.
  public static let maxReasonLength = 900

  public static func render(_ g: ValidatedGrant) -> GrantPrompt {
    let days = Int((g.expiresAtDate.timeIntervalSince(g.issuedAtDate) / 86_400).rounded())
    let until = humanInstant(g.expiresAtDate)
    let shortDigest = String(g.digestHex.prefix(12))
    let merging = g.repos.filter { $0.stage == "merge" }.count

    let repoPhrases = g.repos.map { r in
      "\(r.nameWithOwner) (\(r.stage), \(r.enforcement), \(r.maxRisk) risk, \(r.maxMergesPerDay)/day)"
    }
    let seatPhrases = g.seats.map { s -> String in
      if !s.enabled { return "\(s.id) off" }
      var text = "\(s.id) keeps \(s.reserveFloorPercent)%"
      if let ceiling = s.maxSessionWindowPercent { text += ", idle above \(ceiling)% 5h" }
      return text
    }
    let ladder = g.stages.map(\.id).joined(separator: " → ")
    let leader = g.leaderClasses.isEmpty ? "Leader proposes only" : "Leader class \(g.leaderClasses.joined(separator: "+")) (veto \(g.vetoMinutes) min)"

    func reason(repoLimit: Int) -> String {
      var repos = repoPhrases.prefix(repoLimit).joined(separator: "; ")
      if repoPhrases.count > repoLimit {
        repos += "; +\(repoPhrases.count - repoLimit) more (see terminal)"
      }
      var parts: [String] = []
      parts.append("approve Ashlr standing grant #\(g.grantSeq) for \(days) days, until \(until).")
      parts.append("\(g.repos.count) repos, \(merging) may merge: \(repos).")
      parts.append("Rollout: \(ladder).")
      parts.append("Caps: \(g.maxFiles) files / \(g.maxLines) lines; ashlr-hub \(g.selfRepo).")
      parts.append("Engines: \(g.engines.joined(separator: ", ")). Budget up to \(g.maxMode), $\(g.meteredUsdPerDay)/day metered.")
      if !seatPhrases.isEmpty { parts.append("Seats: \(seatPhrases.joined(separator: "; ")).") }
      parts.append("\(leader)\(g.conductorGoals ? "; goals run live" : "").")
      parts.append("Digest \(shortDigest).")
      return parts.joined(separator: " ")
    }

    var limit = repoPhrases.count
    var text = reason(repoLimit: limit)
    while text.count > maxReasonLength && limit > 1 {
      limit -= 1
      text = reason(repoLimit: limit)
    }
    if text.count > maxReasonLength {
      text = String(text.prefix(maxReasonLength - 1)) + "…"
    }

    var lines: [String] = []
    lines.append("Ashlr standing grant — review before Touch ID")
    lines.append("  grant       \(g.grantId)  #\(g.grantSeq)  key \(g.keyId)")
    lines.append("  valid       \(g.issuedAt) → \(g.expiresAt)  (\(days) days)")
    lines.append("  digest      \(g.digestHex)")
    lines.append("  host        \(g.hostBinding)")
    lines.append("  surface     \(g.authoritySurfaceDigest)")
    lines.append("  repos (\(g.repos.count)):")
    for r in g.repos {
      lines.append("    \(r.nameWithOwner)  stage=\(r.stage) enforcement=\(r.enforcement) maxRisk=\(r.maxRisk) maxMergesPerDay=\(r.maxMergesPerDay)")
    }
    lines.append("  merge       maxFiles=\(g.maxFiles) maxLines=\(g.maxLines) selfRepo=\(g.selfRepo)")
    lines.append("  spend       maxMode=\(g.maxMode) meteredUsdPerDay=\(g.meteredUsdPerDay)")
    for s in g.seats {
      let ceiling = s.maxSessionWindowPercent.map { " maxSessionWindowPercent=\($0)" } ?? ""
      lines.append("    seat \(s.id)  enabled=\(s.enabled) reserveFloorPercent=\(s.reserveFloorPercent)\(ceiling) roles=\(s.roles.joined(separator: ","))")
    }
    lines.append("  engines     \(g.engines.joined(separator: ", "))")
    lines.append("  leader      classes=\(g.leaderClasses.joined(separator: ",")) vetoMinutes=\(g.vetoMinutes)")
    lines.append("  conductor   goals=\(g.conductorGoals)")
    lines.append("  rollout (auto-advance, never past the last stage):")
    for (i, st) in g.stages.enumerated() {
      let repos = st.repos.map { "\($0.nameWithOwner)=\($0.stage)" }.joined(separator: ", ")
      lines.append("    \(i + 1). \(st.id)  repos=[\(repos)] engines=[\(st.engines.joined(separator: ","))] maxRisk=\(st.maxRisk) \(st.maxFiles) files/\(st.maxLines) lines \(st.maxMergesPerRepoPerDay)/repo/day leader=[\(st.leaderClasses.joined(separator: ","))]")
      let c = st.criteria
      lines.append("       advance after ≥\(c.minHours) h, ≥\(c.minMerges) merges, green ≥\(c.minPostMergeGreenPct)%, reverts ≤\(c.maxRevertRatePct)%, 0 sandbox violations, 0 reserve breaches")
    }
    return GrantPrompt(reason: text, fullScope: lines.joined(separator: "\n"))
  }

  static func humanInstant(_ date: Date) -> String {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = TimeZone(identifier: "UTC")
    f.dateFormat = "MMM d yyyy HH:mm 'UTC'"
    return f.string(from: date)
  }
}

public enum GrantSigning {
  /// The exact bytes the Secure Enclave key signs.
  public static func message(for grant: ValidatedGrant) -> Data {
    Data((GrantContract.signingDomain + grant.canonical).utf8)
  }

  /// SignedStandingGrantV1 as canonical JSON ("payload" < "signature").
  public static func envelope(for grant: ValidatedGrant, signatureP1363: Data) throws -> String {
    guard signatureP1363.count == 64 else {
      throw GrantRefusal(path: "signature", reason: "an ES256 signature is 64 bytes (r‖s)")
    }
    let signature = signatureP1363.base64EncodedString()
    return "{\"payload\":\(grant.canonical),\"signature\":\"\(signature)\"}"
  }
}
