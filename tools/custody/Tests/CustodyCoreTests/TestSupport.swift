import Foundation
import XCTest
@testable import CustodyCore

enum PathPart {
  case key(String)
  case index(Int)
}

extension JSONValue {
  /// Copy with the value at `path` replaced (or removed when `with` is nil).
  func replacing(_ path: [PathPart], with newValue: JSONValue?) -> JSONValue {
    guard let head = path.first else { return newValue ?? .null }
    let tail = Array(path.dropFirst())
    switch (self, head) {
    case let (.object(members), .key(k)):
      var out: [JSONMember] = []
      var found = false
      for m in members {
        if m.key == k {
          found = true
          if tail.isEmpty {
            if let newValue { out.append(JSONMember(key: k, value: newValue)) }
          } else {
            out.append(JSONMember(key: k, value: m.value.replacing(tail, with: newValue)))
          }
        } else {
          out.append(m)
        }
      }
      if !found, tail.isEmpty, let newValue { out.append(JSONMember(key: k, value: newValue)) }
      return .object(out)
    case let (.array(items), .index(i)):
      var copy = items
      if tail.isEmpty {
        if let newValue { copy[i] = newValue } else { copy.remove(at: i) }
      } else {
        copy[i] = items[i].replacing(tail, with: newValue)
      }
      return .array(copy)
    default:
      return self
    }
  }
}

struct GrantFixture {
  let payload: JSONValue
  let canonical: String
  let digest: String
  let nodePublicKeyPEM: String
  let nodeSignature: String
  let swiftPublicKeyPEM: String
  let swiftKeyId: String
  let swiftSignature: String

  static func load() throws -> GrantFixture {
    let url = try XCTUnwrap(Bundle.module.url(forResource: "standing-grant-fixture", withExtension: "json", subdirectory: "Fixtures"))
    let root = try StrictJSONParser.parse(Data(contentsOf: url))
    func s(_ v: JSONValue?) throws -> String { try XCTUnwrap(v?.stringValue) }
    return GrantFixture(
      payload: try XCTUnwrap(root["payload"]),
      canonical: try s(root["canonical"]),
      digest: try s(root["digest"]),
      nodePublicKeyPEM: try s(root["nodeSigned"]?["publicKeyPem"]),
      nodeSignature: try s(root["nodeSigned"]?["signature"]),
      swiftPublicKeyPEM: try s(root["swiftSigned"]?["publicKeyPem"]),
      swiftKeyId: try s(root["swiftSigned"]?["keyId"]),
      swiftSignature: try s(root["swiftSigned"]?["signature"])
    )
  }
}

/// Inside the fixture's validity window (issued 12:00, expires +30 d).
let fixtureNow = ISOInstant.parse("2026-09-24T12:05:00.000Z")!
let fixtureContext = GrantValidationContext(now: fixtureNow)

func assertRefused(_ value: JSONValue, path expectedPath: String, file: StaticString = #filePath, line: UInt = #line) {
  do {
    _ = try StandingGrantValidator.validate(value, context: fixtureContext)
    XCTFail("expected a refusal at \(expectedPath)", file: file, line: line)
  } catch let refusal as GrantRefusal {
    XCTAssertEqual(refusal.path, expectedPath, "\(refusal)", file: file, line: line)
  } catch {
    XCTFail("unexpected error \(error)", file: file, line: line)
  }
}
