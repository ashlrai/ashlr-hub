// Command-line surface and the error protocol shared with
// src/core/authority/custody-client.ts.
//
// Protocol: success → exit 0 and ONE line of JSON on stdout. Failure → a
// non-zero exit code from CustodyFailure.ExitCode and, as the LAST line of
// stderr, {"error":{"code":"…","message":"…"}}. Messages never contain a
// secret: they are built from fixed text and validated field names only.

import Foundation

public enum CustodyCommand: Equatable, Sendable {
  case version
  case status
  case initKey(rotate: Bool)
  case pubkey
  case hostBinding
  /// nil = read the payload from stdin (`-`).
  case signGrant(path: String?)
  case storeGithubApp
  case storeClaudeToken
  case ghToken(repo: String)
  case claudeToken
  case help
}

public struct CustodyFailure: Error, Equatable, CustomStringConvertible {
  public enum ExitCode: Int32, Sendable {
    case internalError = 1
    case usage = 2
    case refused = 3
    case missing = 4
    case auth = 5
    case keystore = 6
    case remote = 7
    case exists = 8
  }

  public let code: String
  public let message: String
  public let exit: ExitCode

  public init(_ code: String, _ message: String, exit: ExitCode) {
    self.code = code
    self.message = message
    self.exit = exit
  }

  public var description: String { "\(code): \(message)" }

  /// The single stderr line the TypeScript client parses.
  public var json: String {
    var out = "{\"error\":{"
    CanonicalJSON.writeString("code", into: &out)
    out += ":"
    CanonicalJSON.writeString(code, into: &out)
    out += ","
    CanonicalJSON.writeString("message", into: &out)
    out += ":"
    CanonicalJSON.writeString(message, into: &out)
    out += "}}"
    return out
  }

  public static func usage(_ message: String) -> CustodyFailure {
    CustodyFailure("usage", message, exit: .usage)
  }
}

public enum CustodyCLI {
  public static let version = "1.0.0"

  public static let usageText = """
  usage: ashlr-custody <command>

    version                    print the helper version
    status                     key + stored-credential presence (no Touch ID, no network)
    init [--rotate]            create the Secure Enclave signing key (Touch ID)
    pubkey                     print {keyId, publicKeyPem}
    host-binding               print this Mac's grant host binding
    sign-grant <file|->        sign a StandingGrantV1 payload (Touch ID; shows the full scope)
    store-github-app           read {"appId","privateKeyPem"} on stdin into the Keychain
    store-claude-token         read a `claude setup-token` token on stdin into the Keychain
    gh-token --repo <o/name>   mint a 1-hour GitHub App token for ONE repo
    claude-token               print the stored Claude token (restricted judge calls only)
  """

  public static func parse(_ argv: [String]) throws -> CustodyCommand {
    guard let first = argv.first else { throw CustodyFailure.usage("missing command") }
    let rest = Array(argv.dropFirst())
    func noArgs(_ command: CustodyCommand) throws -> CustodyCommand {
      guard rest.isEmpty else { throw CustodyFailure.usage("\(first) takes no arguments") }
      return command
    }
    switch first {
    case "version", "--version": return try noArgs(.version)
    case "help", "--help", "-h": return try noArgs(.help)
    case "status": return try noArgs(.status)
    case "pubkey": return try noArgs(.pubkey)
    case "host-binding": return try noArgs(.hostBinding)
    case "store-github-app": return try noArgs(.storeGithubApp)
    case "store-claude-token": return try noArgs(.storeClaudeToken)
    case "claude-token": return try noArgs(.claudeToken)
    case "init":
      if rest.isEmpty { return .initKey(rotate: false) }
      if rest == ["--rotate"] { return .initKey(rotate: true) }
      throw CustodyFailure.usage("init takes only --rotate")
    case "sign-grant":
      guard rest.count == 1, let source = rest.first, !source.isEmpty else {
        throw CustodyFailure.usage("sign-grant takes one argument: a payload file, or - for stdin")
      }
      if source == "-" { return .signGrant(path: nil) }
      if source.hasPrefix("-") { throw CustodyFailure.usage("unknown option \(source)") }
      return .signGrant(path: source)
    case "gh-token":
      guard rest.count == 2, rest[0] == "--repo" else {
        throw CustodyFailure.usage("gh-token takes exactly --repo <owner/name>")
      }
      guard GitHubApp.splitRepo(rest[1]) != nil else {
        throw CustodyFailure("refused", "--repo must be owner/name", exit: .refused)
      }
      return .ghToken(repo: rest[1])
    default:
      throw CustodyFailure.usage("unknown command \(first)")
    }
  }
}

/// Minimal JSON object writer for the helper's stdout lines.
public struct JSONLine {
  private var parts: [String] = []
  public init() {}

  public mutating func string(_ key: String, _ value: String?) {
    var out = ""
    CanonicalJSON.writeString(key, into: &out)
    out += ":"
    if let value { CanonicalJSON.writeString(value, into: &out) } else { out += "null" }
    parts.append(out)
  }

  public mutating func bool(_ key: String, _ value: Bool?) {
    var out = ""
    CanonicalJSON.writeString(key, into: &out)
    out += ":" + (value.map { $0 ? "true" : "false" } ?? "null")
    parts.append(out)
  }

  public mutating func integer(_ key: String, _ value: Int64) {
    var out = ""
    CanonicalJSON.writeString(key, into: &out)
    out += ":\(value)"
    parts.append(out)
  }

  public var text: String { "{" + parts.joined(separator: ",") + "}" }
}
