import Foundation
import Security
import XCTest
@testable import CustodyCore

final class GitHubAndCommandTests: XCTestCase {
  // MARK: GitHub App credential + key material

  static func rsaPKCS1DER() throws -> Data {
    let attrs: [String: Any] = [kSecAttrKeyType as String: kSecAttrKeyTypeRSA, kSecAttrKeySizeInBits as String: 2048,
                                kSecPrivateKeyAttrs as String: [kSecAttrIsPermanent as String: false]]
    var error: Unmanaged<CFError>?
    let key = try XCTUnwrap(SecKeyCreateRandomKey(attrs as CFDictionary, &error))
    return try XCTUnwrap(SecKeyCopyExternalRepresentation(key, &error) as Data?)
  }

  /// Wrap PKCS#1 in a PKCS#8 PrivateKeyInfo (what `openssl pkcs8 -topk8` emits).
  static func pkcs8(_ pkcs1: Data) -> Data {
    func tlv(_ tag: UInt8, _ content: Data) -> Data {
      var out = Data([tag])
      let n = content.count
      if n < 0x80 { out.append(UInt8(n)) } else if n < 0x100 { out.append(contentsOf: [0x81, UInt8(n)]) } else {
        out.append(contentsOf: [0x82, UInt8(n >> 8), UInt8(n & 0xFF)])
      }
      return out + content
    }
    let alg = tlv(0x30, Data([0x06, 0x09, 0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x01, 0x05, 0x00]))
    return tlv(0x30, Data([0x02, 0x01, 0x00]) + alg + tlv(0x04, pkcs1))
  }

  func testRSAKeyUnwrapsFromPKCS1AndPKCS8() throws {
    let der = try Self.rsaPKCS1DER()
    XCTAssertEqual(try KeyMaterial.rsaPKCS1(fromPEM: KeyMaterial.pem(der: der, label: "RSA PRIVATE KEY")), der)
    XCTAssertEqual(try KeyMaterial.rsaPKCS1(fromPEM: KeyMaterial.pem(der: Self.pkcs8(der), label: "PRIVATE KEY")), der)
    XCTAssertThrowsError(try KeyMaterial.rsaPKCS1(fromPEM: "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----"))
    var ecAlg = Self.pkcs8(der)
    if let i = ecAlg.firstRange(of: Data([0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x01])) {
      ecAlg.replaceSubrange(i, with: Data([0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x02, 0x01, 0x00, 0x00]))
    }
    XCTAssertThrowsError(try KeyMaterial.rsaPKCS1(fromPEM: KeyMaterial.pem(der: ecAlg, label: "PRIVATE KEY")))
  }

  func testCredentialInputIsExact() throws {
    let pem = KeyMaterial.pem(der: try Self.rsaPKCS1DER(), label: "RSA PRIVATE KEY")
    var body = ""
    CanonicalJSON.writeString(pem, into: &body)
    let ok = try GitHubApp.parseCredential(Data("{\"appId\":\"123456\",\"privateKeyPem\":\(body)}".utf8))
    XCTAssertEqual(ok.appId, "123456")
    XCTAssertEqual(try GitHubApp.parseCredential(GitHubApp.serialize(ok)), ok)
    for bad in ["{\"appId\":\"12a\",\"privateKeyPem\":\(body)}", "{\"appId\":123,\"privateKeyPem\":\(body)}",
                "{\"appId\":\"1\",\"privateKeyPem\":\(body),\"clientSecret\":\"x\"}", "{\"appId\":\"1\",\"privateKeyPem\":\"nope\"}", "[]"] {
      XCTAssertThrowsError(try GitHubApp.parseCredential(Data(bad.utf8)), bad)
    }
  }

  func testJWTClaimsAreShortLivedAndBackdated() throws {
    let now = Date(timeIntervalSince1970: 1_790_000_000)
    let input = GitHubApp.jwtSigningInput(appId: "4242", now: now)
    let parts = input.split(separator: ".").map(String.init)
    XCTAssertEqual(parts.count, 2)
    func decode(_ s: String) throws -> JSONValue {
      var b = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
      while b.count % 4 != 0 { b += "=" }
      return try StrictJSONParser.parse(try XCTUnwrap(Data(base64Encoded: b)))
    }
    XCTAssertEqual(try decode(parts[0]), .object([JSONMember(key: "alg", value: .string("RS256")), JSONMember(key: "typ", value: .string("JWT"))]))
    let claims = try decode(parts[1])
    XCTAssertEqual(claims["iss"], .integer(4242))
    XCTAssertEqual(claims["iat"], .integer(1_790_000_000 - 60))
    XCTAssertEqual(claims["exp"], .integer(1_790_000_000 + 540))
    XCTAssertFalse(input.contains("="))
  }

  func testTokenRequestIsOneRepoWithExactlyTheFleetPermissions() throws {
    XCTAssertEqual(String(decoding: GitHubApp.accessTokenBody(repoName: "fleet-canary"), as: UTF8.self),
                   #"{"permissions":{"checks":"read","contents":"write","metadata":"read","pull_requests":"write","statuses":"read"},"repositories":["fleet-canary"]}"#)
    XCTAssertEqual(GitHubApp.installationURL(repo: "ashlrai/fleet-canary")?.absoluteString, "https://api.github.com/repos/ashlrai/fleet-canary/installation")
    XCTAssertNil(GitHubApp.installationURL(repo: "ashlrai/../../app"))
    XCTAssertNil(GitHubApp.installationURL(repo: "ashlrai"))
    XCTAssertEqual(try GitHubApp.parseInstallationId(Data(#"{"id":98765,"account":{"login":"ashlrai"}}"#.utf8)), 98765)
    XCTAssertThrowsError(try GitHubApp.parseInstallationId(Data(#"{"message":"Not Found"}"#.utf8)))
  }

  func tokenResponse(token: String = "ghs_" + String(repeating: "A", count: 36), expires: String = "2026-09-24T13:00:00Z",
                     perms: String = #"{"checks":"read","contents":"write","metadata":"read","pull_requests":"write","statuses":"read"}"#,
                     selection: String = "selected", repos: String = #"[{"full_name":"ashlrai/fleet-canary","name":"fleet-canary"}]"#) -> Data {
    Data("{\"token\":\"\(token)\",\"expires_at\":\"\(expires)\",\"permissions\":\(perms),\"repository_selection\":\"\(selection)\",\"repositories\":\(repos)}".utf8)
  }

  func testAcceptsOnlyTheTokenThatWasAskedFor() throws {
    let now = ISOInstant.parse("2026-09-24T12:00:30.000Z")!
    let ok = try GitHubApp.parseAccessToken(tokenResponse(), repo: "ashlrai/fleet-canary", now: now)
    XCTAssertEqual(ok.expiresAt, "2026-09-24T13:00:00.000Z")
    XCTAssertTrue(ok.token.hasPrefix("ghs_"))
    // Fewer permissions than asked is fine (still a subset).
    XCTAssertNoThrow(try GitHubApp.parseAccessToken(tokenResponse(perms: #"{"contents":"write","metadata":"read"}"#), repo: "ashlrai/fleet-canary", now: now))
    let refusals: [(Data, String)] = [
      (tokenResponse(perms: #"{"contents":"write","workflows":"write"}"#), "workflows"),
      (tokenResponse(perms: #"{"administration":"read"}"#), "administration"),
      (tokenResponse(perms: #"{"checks":"write"}"#), "write on checks"),
      (tokenResponse(selection: "all"), "selected"),
      (tokenResponse(repos: #"[{"full_name":"ashlrai/other"}]"#), "exactly"),
      (tokenResponse(repos: #"[{"full_name":"ashlrai/fleet-canary"},{"full_name":"ashlrai/x"}]"#), "exactly"),
      (tokenResponse(token: "gho_" + String(repeating: "A", count: 36)), "installation token"),
      (tokenResponse(token: "ghs_short"), "installation token"),
      (tokenResponse(expires: "2026-09-24T14:30:00Z"), "hour"),
      (tokenResponse(expires: "2026-09-24T11:00:00Z"), "hour"),
    ]
    for (body, fragment) in refusals {
      XCTAssertThrowsError(try GitHubApp.parseAccessToken(body, repo: "ashlrai/fleet-canary", now: now)) { error in
        XCTAssertTrue("\(error)".contains(fragment), "\(error) should mention \(fragment)")
      }
    }
  }

  // MARK: Claude token

  func testClaudeTokenIsOneLineOfPrintableASCII() throws {
    XCTAssertEqual(try ClaudeToken.parse(Data("sk-ant-oat01-abcdefghijklmnopqrstuvwxyz\n".utf8)), "sk-ant-oat01-abcdefghijklmnopqrstuvwxyz")
    for bad in ["short", "sk-ant-oat01-abc def ghi jkl mno pqr", "sk-ant-oat01-abcdefghijklmnop\nsecond-line-secret", String(repeating: "a", count: 5000)] {
      XCTAssertThrowsError(try ClaudeToken.parse(Data(bad.utf8)), bad)
    }
  }

  // MARK: argv

  func testCommandParsingIsStrict() throws {
    XCTAssertEqual(try CustodyCLI.parse(["status"]), .status)
    XCTAssertEqual(try CustodyCLI.parse(["init"]), .initKey(rotate: false))
    XCTAssertEqual(try CustodyCLI.parse(["init", "--rotate"]), .initKey(rotate: true))
    XCTAssertEqual(try CustodyCLI.parse(["sign-grant", "-"]), .signGrant(path: nil))
    XCTAssertEqual(try CustodyCLI.parse(["sign-grant", "/tmp/g.json"]), .signGrant(path: "/tmp/g.json"))
    XCTAssertEqual(try CustodyCLI.parse(["gh-token", "--repo", "ashlrai/fleet-canary"]), .ghToken(repo: "ashlrai/fleet-canary"))
    XCTAssertEqual(try CustodyCLI.parse(["claude-token"]), .claudeToken)
    let refusals: [[String]] = [[], ["sign"], ["sign-grant"], ["sign-grant", "a", "b"], ["sign-grant", "--force"], ["status", "--json"],
                                ["gh-token", "ashlrai/x"], ["gh-token", "--repo", "x"], ["init", "--force"], ["sign-bytes", "-"]]
    for argv in refusals {
      XCTAssertThrowsError(try CustodyCLI.parse(argv), "\(argv)")
    }
  }

  func testFailureLineIsParseableJSON() throws {
    let f = CustodyFailure("refused", "not signed — \"quoted\"", exit: .refused)
    let v = try StrictJSONParser.parse(f.json)
    XCTAssertEqual(v["error"]?["code"], .string("refused"))
    XCTAssertEqual(v["error"]?["message"], .string("not signed — \"quoted\""))
  }
}
