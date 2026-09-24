import XCTest
@testable import CustodyCore

final class StrictJSONTests: XCTestCase {
  func testParsesNestedValuesInOrder() throws {
    let v = try StrictJSONParser.parse(#" {"b": [1, true, null, "x\/y\u00e9"], "a": {"c": -2}} "#)
    XCTAssertEqual(v.objectMembers?.map(\.key), ["b", "a"])
    XCTAssertEqual(v["b"], .array([.integer(1), .bool(true), .null, .string("x/yé")]))
    XCTAssertEqual(v["a"]?["c"], .integer(-2))
  }

  func testRefusesDuplicateKeys() {
    XCTAssertThrowsError(try StrictJSONParser.parse(#"{"a":1,"a":2}"#)) { error in
      XCTAssertTrue("\(error)".contains("duplicate key"))
    }
    XCTAssertThrowsError(try StrictJSONParser.parse(#"{"o":{"k":1,"k":1}}"#))
  }

  func testRefusesMalformedInput() {
    for bad in [#"{"a":1} x"#, "{\"a\":01}", "{\"a\":1.}", "{\"a\":\"\u{01}\"}", "{\"a\":\"\\q\"}", "{\"a\":tru}",
                "{\"a\":\"\\ud800\"}", "[1,]", "{,}", "", "{\"a\":1", "\"x"] {
      XCTAssertThrowsError(try StrictJSONParser.parse(bad), "should refuse \(bad)")
    }
  }

  func testNumbersKeepIntegersExact() throws {
    XCTAssertEqual(try StrictJSONParser.parse("9007199254740993"), .integer(9_007_199_254_740_993))
    XCTAssertEqual(try StrictJSONParser.parse("1.5"), .number(1.5))
    XCTAssertEqual(try StrictJSONParser.parse("1e3"), .number(1000))
    if case .integer = try StrictJSONParser.parse("99999999999999999999") { XCTFail("overflow must not be an integer") }
  }

  func testLimitsSizeAndDepth() {
    XCTAssertThrowsError(try StrictJSONParser.parse(String(repeating: " ", count: 300_000) + "1"))
    let deep = String(repeating: "[", count: 40) + String(repeating: "]", count: 40)
    XCTAssertThrowsError(try StrictJSONParser.parse(deep))
    XCTAssertNoThrow(try StrictJSONParser.parse(String(repeating: "[", count: 30) + String(repeating: "]", count: 30)))
  }

  func testCanonicalMatchesJSONStringifyEscaping() throws {
    let v = JSONValue.object([
      JSONMember(key: "z", value: .string("a\"b\\c/d\n\t\u{01}\u{1f}é")),
      JSONMember(key: "B", value: .integer(0)),
      JSONMember(key: "a", value: .array([.bool(false), .null])),
    ])
    // JSON.stringify: '/' and non-ASCII stay literal; \u001f lowercase hex; keys by UTF-16 ('B' < 'a' < 'z').
    XCTAssertEqual(try CanonicalJSON.encode(v), "{\"B\":0,\"a\":[false,null],\"z\":\"a\\\"b\\\\c/d\\n\\t\\u0001\\u001fé\"}")
    XCTAssertThrowsError(try CanonicalJSON.encode(.number(1.5)))
  }

  func testUTF16KeyOrderDiffersFromScalarOrder() throws {
    // U+FF21 (UTF-16 0xFF21) sorts before U+1F600 (surrogates 0xD83D…) by
    // scalar value but AFTER it by UTF-16 code unit, which is what JS uses.
    let v = JSONValue.object([
      JSONMember(key: "\u{FF21}", value: .integer(1)),
      JSONMember(key: "\u{1F600}", value: .integer(2)),
    ])
    XCTAssertEqual(try CanonicalJSON.encode(v), "{\"\u{1F600}\":2,\"\u{FF21}\":1}")
  }
}
