// The StandingGrantV1 contract, mirrored from src/core/authority/types.ts
// (STANDING_GRANT_SIGNING_DOMAIN, STANDING_GRANT_CEILINGS,
// STANDING_GRANT_PATTERNS, STANDING_GRANT_KEYS, STANDING_GRANT_OPTIONAL_KEYS
// and the enum vocab those types use).
//
// WHY a mirror and not a generated file: the helper is built by Mason with
// `swift build` and installed root-owned; it must not read its policy from
// any file at run time (a writable policy file would be a way to widen what
// it signs). test/custody-helper-contract-310b.test.ts parses THIS file and
// fails when any value here drifts from the TypeScript contract, so keep the
// one-declaration-per-line shape below (`static let name = value`).

public enum GrantContract {
  // Signed bytes = signingDomain ‖ canonical JSON of the payload.
  public static let signingDomain = "ashlr:standing-grant:v1\u{0}"

  // --- STANDING_GRANT_CEILINGS -------------------------------------------
  public static let maxTtlMs: Int64 = 2_592_000_000
  public static let maxRisk = "medium"
  public static let maxFiles: Int64 = 10
  public static let maxLines: Int64 = 300
  public static let maxMergesPerRepoPerDay: Int64 = 24
  public static let localAuthoredMaxRisk = "low"
  public static let localAuthoredMaxFiles: Int64 = 4
  public static let localAuthoredMaxLines: Int64 = 150
  public static let localEnforcementMaxRisk = "low"
  public static let localEnforcementMaxFiles: Int64 = 4
  public static let localEnforcementMaxLines: Int64 = 150
  public static let localEnforcementMaxMergesPerDay: Int64 = 4
  public static let minVetoMinutes: Int64 = 30
  public static let maxVetoMinutes: Int64 = 1440
  public static let maxStageHours: Int64 = 720
  public static let maxMeteredUsdPerDay: Int64 = 10000
  public static let maxRepos: Int64 = 32
  public static let maxStages: Int64 = 8
  public static let maxSeats: Int64 = 64
  public static let maxRolesPerSeat: Int64 = 3

  // --- STANDING_GRANT_PATTERNS (ICU regex; sources identical to the TS literals) ---
  public static let patternGrantId = #"^[a-f0-9]{32}$"#
  public static let patternKeyId = #"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$"#
  public static let patternSha256Hex = #"^[a-f0-9]{64}$"#
  public static let patternIsoInstant = #"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$"#
  public static let patternNameWithOwner = #"^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$"#
  public static let patternStageId = #"^[a-z0-9][a-z0-9-]{0,31}$"#
  public static let patternSeatId = #"^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,199}$"#
  public static let patternSignature = #"^[A-Za-z0-9+/]{86}==$"#

  // --- STANDING_GRANT_KEYS (exact key set per object level) ---------------
  public static let keysEnvelope = ["payload", "signature"]
  public static let keysGrant = ["v", "grantId", "grantSeq", "keyId", "issuedAt", "expiresAt", "hostBinding", "authoritySurfaceDigest", "repos", "merge", "spend", "engines", "leader", "conductorGoals", "rollout"]
  public static let keysRepo = ["nameWithOwner", "stage", "enforcement", "maxRisk", "maxMergesPerDay"]
  public static let keysMerge = ["maxFiles", "maxLines", "selfRepo"]
  public static let keysSpend = ["maxMode", "meteredUsdPerDay", "seats"]
  public static let keysSeat = ["enabled", "reserveFloorPercent", "maxSessionWindowPercent", "roles"]
  public static let keysLeader = ["classes", "vetoMinutes"]
  public static let keysRollout = ["stages", "autoAdvance"]
  public static let keysStage = ["id", "repos", "engines", "maxRisk", "maxFiles", "maxLines", "maxMergesPerRepoPerDay", "leaderClasses", "criteria"]
  public static let keysStageRepo = ["nameWithOwner", "stage"]
  public static let keysCriteria = ["minMerges", "minPostMergeGreenPct", "maxRevertRatePct", "minHours", "maxSandboxViolations", "reserveBreaches"]
  // STANDING_GRANT_OPTIONAL_KEYS
  public static let optionalKeysSeat = ["maxSessionWindowPercent"]

  // --- Enum vocab (fleet-types.ts / routing/types.ts / leader-types.ts) ---
  public static let repoStages = ["propose", "merge"]
  public static let repoEnforcements = ["server", "local"]
  public static let mergeRisks = ["low", "medium"]
  public static let selfRepoModes = ["propose-only", "merge-non-authority"]
  public static let budgetModes = ["reserve", "balanced", "all-in"]
  public static let seatRoles = ["producer", "judge", "leader"]
  public static let fleetEngines = ["local", "grok-cli", "claude-cli", "codex"]
  public static let leaderGrantClasses = ["A", "B"]

  /// JavaScript's Number.MAX_SAFE_INTEGER: every number in a grant is a safe integer.
  public static let maxSafeInteger: Int64 = 9_007_199_254_740_991
}
