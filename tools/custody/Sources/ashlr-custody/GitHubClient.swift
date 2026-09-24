// Mints a one-repo installation token for the ashlr-fleet GitHub App.
// Request shapes and response checks live in CustodyCore.GitHubApp (tested);
// this file only signs the App JWT and performs the two HTTPS calls.

import CustodyCore
import Foundation
import Security

enum GitHubClient {
  static func mint(repo: String, credential: GitHubApp.Credential, now: Date = Date()) throws -> GitHubApp.IssuedToken {
    guard let (_, name) = GitHubApp.splitRepo(repo), let installationURL = GitHubApp.installationURL(repo: repo) else {
      throw CustodyFailure("refused", "--repo must be owner/name", exit: .refused)
    }
    let jwt = try appJWT(credential: credential, now: now)
    let session = URLSession(configuration: ephemeralConfiguration())

    let (lookupStatus, lookupBody) = try send(session, request(url: installationURL, method: "GET", jwt: jwt, body: nil))
    if lookupStatus == 404 {
      throw CustodyFailure("github", "the ashlr-fleet App is not installed on \(repo)", exit: .remote)
    }
    guard lookupStatus == 200 else { throw httpFailure(lookupStatus, lookupBody, "installation lookup") }
    let installationId: Int64
    do { installationId = try GitHubApp.parseInstallationId(lookupBody) } catch {
      throw CustodyFailure("github", "\(error)", exit: .remote)
    }

    let body = GitHubApp.accessTokenBody(repoName: name)
    let (tokenStatus, tokenBody) = try send(session, request(url: GitHubApp.accessTokenURL(installationId: installationId), method: "POST", jwt: jwt, body: body))
    guard tokenStatus == 201 else { throw httpFailure(tokenStatus, tokenBody, "token request") }
    do {
      return try GitHubApp.parseAccessToken(tokenBody, repo: repo, now: Date())
    } catch {
      throw CustodyFailure("github", "\(error)", exit: .remote)
    }
  }

  /// No cookies, cache or URL credential storage: nothing about the call is
  /// written anywhere.
  static func ephemeralConfiguration() -> URLSessionConfiguration {
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = 20
    config.timeoutIntervalForResource = 40
    config.httpCookieStorage = nil
    config.urlCache = nil
    config.urlCredentialStorage = nil
    config.httpShouldSetCookies = false
    return config
  }

  static func appJWT(credential: GitHubApp.Credential, now: Date) throws -> String {
    let der: Data
    do { der = try KeyMaterial.rsaPKCS1(fromPEM: credential.privateKeyPEM) } catch {
      throw CustodyFailure("keystore", "the stored GitHub App key is not an RSA private key; run store-github-app again", exit: .keystore)
    }
    let attributes: [String: Any] = [
      kSecAttrKeyType as String: kSecAttrKeyTypeRSA,
      kSecAttrKeyClass as String: kSecAttrKeyClassPrivate,
    ]
    var error: Unmanaged<CFError>?
    guard let key = SecKeyCreateWithData(der as CFData, attributes as CFDictionary, &error) else {
      throw CustodyFailure("keystore", "the stored GitHub App key cannot be loaded; run store-github-app again", exit: .keystore)
    }
    let input = GitHubApp.jwtSigningInput(appId: credential.appId, now: now)
    guard let signature = SecKeyCreateSignature(key, .rsaSignatureMessagePKCS1v15SHA256, Data(input.utf8) as CFData, &error) as Data? else {
      throw CustodyFailure("keystore", "cannot sign the GitHub App JWT", exit: .keystore)
    }
    return input + "." + GitHubApp.base64url(signature)
  }

  static func request(url: URL, method: String, jwt: String, body: Data?) -> URLRequest {
    var req = URLRequest(url: url)
    req.httpMethod = method
    req.setValue("Bearer \(jwt)", forHTTPHeaderField: "Authorization")
    req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
    req.setValue(GitHubApp.apiVersion, forHTTPHeaderField: "X-GitHub-Api-Version")
    req.setValue("ashlr-custody/\(CustodyCLI.version)", forHTTPHeaderField: "User-Agent")
    if let body {
      req.httpBody = body
      req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    return req
  }

  static func send(_ session: URLSession, _ request: URLRequest) throws -> (Int, Data) {
    guard request.url?.scheme == "https", request.url?.host == "api.github.com" else {
      throw CustodyFailure("internal", "refusing a non-GitHub request", exit: .internalError)
    }
    let done = DispatchSemaphore(value: 0)
    var result: (Int, Data)?
    var failure: Error?
    let task = session.dataTask(with: request) { data, response, error in
      if let error { failure = error } else if let http = response as? HTTPURLResponse {
        result = (http.statusCode, data ?? Data())
      }
      done.signal()
    }
    task.resume()
    done.wait()
    if let result { return result }
    _ = failure
    throw CustodyFailure("network", "GitHub could not be reached", exit: .remote)
  }

  /// Status plus GitHub's own `message` (never the request, JWT or token).
  static func httpFailure(_ status: Int, _ body: Data, _ what: String) -> CustodyFailure {
    var detail = ""
    if let value = try? StrictJSONParser.parse(body, maxBytes: 256 * 1024), let message = value["message"]?.stringValue {
      detail = ": " + String(message.prefix(200))
    }
    return CustodyFailure("github", "GitHub \(what) failed with HTTP \(status)\(detail)", exit: .remote)
  }
}
