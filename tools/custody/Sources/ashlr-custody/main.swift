// ashlr-custody — entry point. See CustodyCore/Commands.swift for the
// command surface and the stdout/stderr protocol.

import CryptoKit
import CustodyCore
import Foundation
import LocalAuthentication

enum IO {
  static func out(_ line: String) {
    FileHandle.standardOutput.write(Data((line + "\n").utf8))
  }

  static func err(_ text: String) {
    FileHandle.standardError.write(Data((text + "\n").utf8))
  }

  /// Read at most `limit` bytes; more is an error, never a silent truncation.
  static func readStdin(limit: Int) throws -> Data {
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 16 * 1024)
    while true {
      let n = read(0, &buffer, buffer.count)
      if n < 0 { throw CustodyFailure("refused", "cannot read stdin", exit: .refused) }
      if n == 0 { break }
      data.append(buffer, count: n)
      if data.count > limit { throw CustodyFailure("refused", "input is larger than \(limit) bytes", exit: .refused) }
    }
    return data
  }

  static func readFile(_ path: String, limit: Int) throws -> Data {
    var st = stat()
    guard stat(path, &st) == 0, (st.st_mode & S_IFMT) == S_IFREG else {
      throw CustodyFailure("refused", "\(path) is not a readable regular file", exit: .refused)
    }
    guard st.st_size <= limit else { throw CustodyFailure("refused", "\(path) is larger than \(limit) bytes", exit: .refused) }
    guard let data = FileManager.default.contents(atPath: path) else {
      throw CustodyFailure("refused", "cannot read \(path)", exit: .refused)
    }
    return data
  }
}

enum Runner {
  static func run(_ command: CustodyCommand) throws {
    switch command {
    case .help:
      IO.out(CustodyCLI.usageText)

    case .version:
      var line = JSONLine()
      line.integer("v", 1)
      line.string("version", CustodyCLI.version)
      IO.out(line.text)

    case .status:
      SecretStore.disableInteraction()
      var line = JSONLine()
      line.integer("v", 1)
      line.string("version", CustodyCLI.version)
      line.bool("secureEnclave", SecureEnclave.isAvailable)
      do {
        let record = try KeyStore.load()
        line.bool("keyInitialized", record != nil)
        line.string("keyId", record?.keyId)
      } catch {
        line.bool("keyInitialized", nil)
        line.string("keyId", nil)
      }
      line.bool("githubApp", SecretStore.exists(.githubApp))
      line.bool("claudeToken", SecretStore.exists(.claudeToken))
      IO.out(line.text)

    case let .initKey(rotate):
      if try KeyStore.load() != nil && !rotate {
        throw CustodyFailure("key-exists", "a custody key already exists; `init --rotate` replaces it (the old key is kept on disk, renamed)", exit: .exists)
      }
      let reason = rotate
        ? "replace the Ashlr custody signing key (grants signed by the old key stay valid until Mason removes it from trust-roots.ts)"
        : "create the Ashlr custody signing key"
      let context = try Presence.authenticate(reason: reason)
      let key = try EnclaveKey.create(context: context)
      let record = try KeyStore.save(key: key, rotate: rotate)
      var line = JSONLine()
      line.string("keyId", record.keyId)
      line.string("publicKeyPem", record.publicKeyPEM)
      IO.out(line.text)

    case .pubkey:
      guard let record = try KeyStore.load() else {
        throw CustodyFailure("key-missing", "no custody key yet; run `ashlr-custody init`", exit: .missing)
      }
      var line = JSONLine()
      line.string("keyId", record.keyId)
      line.string("publicKeyPem", record.publicKeyPEM)
      IO.out(line.text)

    case .hostBinding:
      guard let binding = Host.binding() else {
        throw CustodyFailure("internal", "cannot read this Mac's IOPlatformUUID", exit: .internalError)
      }
      var line = JSONLine()
      line.string("hostBinding", binding)
      IO.out(line.text)

    case let .signGrant(path):
      try signGrant(path: path)

    case .storeGithubApp:
      let data = try IO.readStdin(limit: 64 * 1024)
      let credential: GitHubApp.Credential
      do { credential = try GitHubApp.parseCredential(data) } catch {
        throw CustodyFailure("refused", "\(error)", exit: .refused)
      }
      // Prove the key is usable before storing it (a JWT is only signed, never sent).
      _ = try GitHubClient.appJWT(credential: credential, now: Date())
      try SecretStore.store(.githubApp, data: GitHubApp.serialize(credential))
      var line = JSONLine()
      line.bool("ok", true)
      line.string("appId", credential.appId)
      IO.out(line.text)

    case .storeClaudeToken:
      let data = try IO.readStdin(limit: 8 * 1024)
      let token: String
      do { token = try ClaudeToken.parse(data) } catch {
        throw CustodyFailure("refused", "\(error)", exit: .refused)
      }
      try SecretStore.store(.claudeToken, data: Data(token.utf8))
      var line = JSONLine()
      line.bool("ok", true)
      IO.out(line.text)

    case let .ghToken(repo):
      SecretStore.disableInteraction()
      guard let stored = try SecretStore.read(.githubApp) else {
        throw CustodyFailure("not-stored", "no GitHub App key stored; run `ashlr authority github-app` (or store-github-app)", exit: .missing)
      }
      let credential: GitHubApp.Credential
      do { credential = try GitHubApp.parseCredential(stored) } catch {
        throw CustodyFailure("keystore", "the stored GitHub App credential is unreadable; store it again", exit: .keystore)
      }
      let issued = try GitHubClient.mint(repo: repo, credential: credential)
      var line = JSONLine()
      line.string("token", issued.token)
      line.string("expiresAt", issued.expiresAt)
      IO.out(line.text)

    case .claudeToken:
      SecretStore.disableInteraction()
      guard let stored = try SecretStore.read(.claudeToken), let token = String(data: stored, encoding: .utf8) else {
        throw CustodyFailure("not-stored", "no Claude token stored; run `claude setup-token`, then store-claude-token", exit: .missing)
      }
      var line = JSONLine()
      line.string("token", token)
      line.string("expiresAt", nil)
      IO.out(line.text)
    }
  }

  static func signGrant(path: String?) throws {
    let limit = StrictJSONParser.defaultMaxBytes
    let data = try path.map { try IO.readFile($0, limit: limit) } ?? IO.readStdin(limit: limit)
    // Validate before touching the key: a non-grant payload is refused the
    // same way on every Mac, whether or not a key exists yet.
    let grant: ValidatedGrant
    do {
      grant = try StandingGrantValidator.validate(json: data, context: GrantValidationContext(now: Date()))
    } catch let refusal as GrantRefusal {
      throw CustodyFailure("refused", "not signed — \(refusal.description)", exit: .refused)
    }
    guard let record = try KeyStore.load() else {
      throw CustodyFailure("key-missing", "no custody key yet; run `ashlr-custody init`", exit: .missing)
    }
    guard grant.keyId == record.keyId else {
      throw CustodyFailure("keyid-mismatch", "the grant names key \(grant.keyId) but this helper holds \(record.keyId)", exit: .refused)
    }
    guard let binding = Host.binding(), grant.hostBinding == binding else {
      throw CustodyFailure("host-mismatch", "the grant is bound to a different Mac", exit: .refused)
    }
    let prompt = GrantPromptRenderer.render(grant)
    IO.err(prompt.fullScope)
    let context = try Presence.authenticate(reason: prompt.reason)
    let signature = try EnclaveKey.sign(GrantSigning.message(for: grant), record: record, context: context)
    IO.out(try GrantSigning.envelope(for: grant, signatureP1363: signature))
  }
}

do {
  let command = try CustodyCLI.parse(Array(CommandLine.arguments.dropFirst()))
  try Runner.run(command)
  exit(0)
} catch let failure as CustodyFailure {
  if failure.exit == .usage { IO.err(CustodyCLI.usageText) }
  IO.err(failure.json)
  exit(failure.exit.rawValue)
} catch {
  IO.err(CustodyFailure("internal", "unexpected failure", exit: .internalError).json)
  exit(CustodyFailure.ExitCode.internalError.rawValue)
}
