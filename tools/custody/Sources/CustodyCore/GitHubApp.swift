// GitHub App installation tokens for ONE repo (`ashlr-custody gh-token`).
//
// WHY the helper talks to GitHub itself: the App private key can mint tokens
// for every repo the App is installed on. Minting inside the helper means
// only a one-hour token, downscoped to one repo and to exactly the fleet's
// permissions, ever leaves it — never the key, and never the 10-minute App
// JWT that could mint more.

import Foundation

public enum GitHubApp {
  public static let apiBase = "https://api.github.com"
  public static let apiVersion = "2022-11-28"

  /// SPEC-310B §1: read/write contents + pull requests; read checks, statuses
  /// and metadata. No workflows, no administration — requesting exactly this
  /// set means even a misconfigured App cannot hand the fleet more.
  public static let fleetPermissions: [(String, String)] = [
    ("checks", "read"),
    ("contents", "write"),
    ("metadata", "read"),
    ("pull_requests", "write"),
    ("statuses", "read"),
  ]

  public struct Credential: Equatable, Sendable {
    public let appId: String
    public let privateKeyPEM: String
  }

  public struct InputError: Error, Equatable, CustomStringConvertible {
    public let reason: String
    public var description: String { reason }
  }

  /// `store-github-app` stdin: exactly {"appId": "<digits>", "privateKeyPem": "<PEM>"}.
  public static func parseCredential(_ data: Data) throws -> Credential {
    let value: JSONValue
    do { value = try StrictJSONParser.parse(data, maxBytes: 64 * 1024) } catch {
      throw InputError(reason: "expected JSON {\"appId\",\"privateKeyPem\"}: \(error)")
    }
    guard let members = value.objectMembers, Set(members.map(\.key)) == ["appId", "privateKeyPem"], members.count == 2 else {
      throw InputError(reason: "expected exactly the keys appId and privateKeyPem")
    }
    guard let appId = value["appId"]?.stringValue, appId.count >= 1, appId.count <= 20, appId.allSatisfy({ $0.isASCII && $0.isNumber }) else {
      throw InputError(reason: "appId must be the App's numeric id")
    }
    guard let pem = value["privateKeyPem"]?.stringValue else {
      throw InputError(reason: "privateKeyPem must be a string")
    }
    do { _ = try KeyMaterial.rsaPKCS1(fromPEM: pem) } catch {
      throw InputError(reason: "privateKeyPem is not an RSA private key PEM")
    }
    return Credential(appId: appId, privateKeyPEM: pem)
  }

  /// Keychain payload for the credential (the whole thing is the secret).
  public static func serialize(_ c: Credential) -> Data {
    var out = "{"
    CanonicalJSON.writeString("appId", into: &out)
    out += ":"
    CanonicalJSON.writeString(c.appId, into: &out)
    out += ","
    CanonicalJSON.writeString("privateKeyPem", into: &out)
    out += ":"
    CanonicalJSON.writeString(c.privateKeyPEM, into: &out)
    out += "}"
    return Data(out.utf8)
  }

  public static func base64url(_ data: Data) -> String {
    data.base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  /// `base64url(header).base64url(claims)` for an RS256 App JWT. iat is
  /// backdated 60 s for clock drift and exp is 9 min out (GitHub's max is 10).
  public static func jwtSigningInput(appId: String, now: Date) -> String {
    let iat = Int64(now.timeIntervalSince1970) - 60
    let exp = iat + 60 + 540
    let header = #"{"alg":"RS256","typ":"JWT"}"#
    let claims = "{\"exp\":\(exp),\"iat\":\(iat),\"iss\":\(appId)}"
    return base64url(Data(header.utf8)) + "." + base64url(Data(claims.utf8))
  }

  public static func splitRepo(_ nameWithOwner: String) -> (owner: String, name: String)? {
    guard (try? StandingGrantValidator.checkString(nameWithOwner, path: "repo", pattern: GrantContract.patternNameWithOwner)) != nil else {
      return nil
    }
    let parts = nameWithOwner.split(separator: "/", maxSplits: 1).map(String.init)
    guard parts.count == 2 else { return nil }
    return (parts[0], parts[1])
  }

  public static func installationURL(repo: String) -> URL? {
    guard let (owner, name) = splitRepo(repo) else { return nil }
    return URL(string: "\(apiBase)/repos/\(owner)/\(name)/installation")
  }

  public static func accessTokenURL(installationId: Int64) -> URL {
    URL(string: "\(apiBase)/app/installations/\(installationId)/access_tokens")!
  }

  /// Canonical body: exactly one repository, exactly the fleet permissions.
  public static func accessTokenBody(repoName: String) -> Data {
    let perms = fleetPermissions.map { "\"\($0.0)\":\"\($0.1)\"" }.joined(separator: ",")
    var name = ""
    CanonicalJSON.writeString(repoName, into: &name)
    return Data("{\"permissions\":{\(perms)},\"repositories\":[\(name)]}".utf8)
  }

  public struct ResponseError: Error, Equatable, CustomStringConvertible {
    public let reason: String
    public var description: String { reason }
  }

  public static func parseInstallationId(_ data: Data) throws -> Int64 {
    let value: JSONValue
    do { value = try StrictJSONParser.parse(data, maxBytes: 1024 * 1024) } catch {
      throw ResponseError(reason: "GitHub returned malformed JSON for the installation lookup")
    }
    guard let id = value["id"]?.integerValue, id > 0 else {
      throw ResponseError(reason: "GitHub's installation lookup has no id")
    }
    return id
  }

  public struct IssuedToken: Equatable, Sendable {
    /// SECRET.
    public let token: String
    /// toISOString() form.
    public let expiresAt: String
  }

  /// Accept a token only if it is what was asked for: an installation token
  /// for exactly `repo`, carrying no permission beyond the fleet set.
  public static func parseAccessToken(_ data: Data, repo: String, now: Date) throws -> IssuedToken {
    let value: JSONValue
    do { value = try StrictJSONParser.parse(data, maxBytes: 1024 * 1024) } catch {
      throw ResponseError(reason: "GitHub returned malformed JSON for the access token")
    }
    guard let token = value["token"]?.stringValue, token.hasPrefix("ghs_"), token.count >= 24, token.count <= 255,
          token.utf8.allSatisfy({ ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x41 && $0 <= 0x5A) || ($0 >= 0x61 && $0 <= 0x7A) || $0 == 0x5F }) else {
      throw ResponseError(reason: "GitHub did not return an installation token")
    }
    guard let rawExpiry = value["expires_at"]?.stringValue, let expiry = parseGitHubInstant(rawExpiry) else {
      throw ResponseError(reason: "GitHub's token has no valid expires_at")
    }
    if expiry <= now || expiry.timeIntervalSince(now) > 3600 + 300 {
      throw ResponseError(reason: "GitHub's token expiry is outside the expected hour")
    }
    guard let perms = value["permissions"]?.objectMembers else {
      throw ResponseError(reason: "GitHub's token lists no permissions")
    }
    let allowed = Dictionary(uniqueKeysWithValues: fleetPermissions)
    for member in perms {
      guard let want = allowed[member.key], let got = member.value.stringValue else {
        throw ResponseError(reason: "GitHub granted an unrequested permission: \(member.key)")
      }
      if got == "write" && want != "write" {
        throw ResponseError(reason: "GitHub granted write on \(member.key); the fleet asked for read")
      }
      if got != "read" && got != "write" {
        throw ResponseError(reason: "GitHub granted an unknown access level on \(member.key)")
      }
    }
    if value["repository_selection"]?.stringValue != "selected" {
      throw ResponseError(reason: "GitHub's token is not limited to selected repositories")
    }
    guard let repos = value["repositories"]?.arrayValue, repos.count == 1,
          let fullName = repos[0]["full_name"]?.stringValue, fullName.lowercased() == repo.lowercased() else {
      throw ResponseError(reason: "GitHub's token is not scoped to exactly \(repo)")
    }
    return IssuedToken(token: token, expiresAt: ISOInstant.format(expiry))
  }

  /// GitHub prints `2016-07-11T22:14:10Z` (no fraction).
  static func parseGitHubInstant(_ s: String) -> Date? {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime]
    f.timeZone = TimeZone(identifier: "UTC")
    if let d = f.date(from: s) { return d }
    return ISOInstant.parse(s)
  }
}

public enum ClaudeToken {
  public struct InputError: Error, Equatable, CustomStringConvertible {
    public let reason: String
    public var description: String { reason }
  }

  /// `claude setup-token` prints one opaque token. Accept one line of
  /// printable, whitespace-free ASCII so a pasted prompt or a second secret
  /// can never be stored by mistake.
  public static func parse(_ data: Data) throws -> String {
    guard data.count <= 8192, let text = String(data: data, encoding: .utf8) else {
      throw InputError(reason: "the token must be UTF-8 text under 8 KiB")
    }
    let token = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard token.count >= 20, token.count <= 4096 else {
      throw InputError(reason: "that does not look like a Claude setup token (wrong length)")
    }
    guard token.utf8.allSatisfy({ $0 > 0x20 && $0 < 0x7F }) else {
      throw InputError(reason: "the token must be a single line of printable ASCII")
    }
    return token
  }
}
