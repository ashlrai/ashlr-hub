// A small, strict JSON reader and the canonical writer that must produce the
// exact bytes of canonicalizeDaemonActivationValue() in
// src/core/daemon/activation-permit.ts.
//
// WHY not JSONSerialization: it silently keeps the last of two duplicate keys,
// turns integers into doubles past 2^53, and cannot tell `true` from `1`
// without CoreFoundation type tests. What the helper signs must be exactly
// what was parsed and shown to Mason, so the parser refuses anything
// ambiguous instead of guessing.

import Foundation

public struct JSONMember: Equatable, Sendable {
  public let key: String
  public let value: JSONValue
  public init(key: String, value: JSONValue) {
    self.key = key
    self.value = value
  }
}

public indirect enum JSONValue: Equatable, Sendable {
  /// Members in input order; the parser rejects duplicate keys.
  case object([JSONMember])
  case array([JSONValue])
  case string(String)
  /// Any JSON number written without a fraction or exponent that fits Int64.
  case integer(Int64)
  /// Any other JSON number (only accepted where a caller allows it — never in a grant).
  case number(Double)
  case bool(Bool)
  case null

  public subscript(key: String) -> JSONValue? {
    guard case let .object(members) = self else { return nil }
    return members.first(where: { $0.key == key })?.value
  }

  public var objectMembers: [JSONMember]? {
    if case let .object(members) = self { return members }
    return nil
  }

  public var stringValue: String? {
    if case let .string(s) = self { return s }
    return nil
  }

  public var integerValue: Int64? {
    if case let .integer(n) = self { return n }
    return nil
  }

  public var boolValue: Bool? {
    if case let .bool(b) = self { return b }
    return nil
  }

  public var arrayValue: [JSONValue]? {
    if case let .array(a) = self { return a }
    return nil
  }
}

public struct JSONParseError: Error, Equatable, CustomStringConvertible {
  public let offset: Int
  public let reason: String
  public var description: String { "invalid JSON at byte \(offset): \(reason)" }
}

public struct StrictJSONParser {
  /// Hard input bound: a StandingGrantV1 at the ceilings is ~12 KiB.
  public static let defaultMaxBytes = 256 * 1024
  public static let defaultMaxDepth = 32

  private let bytes: [UInt8]
  private var index = 0
  private let maxDepth: Int

  private init(bytes: [UInt8], maxDepth: Int) {
    self.bytes = bytes
    self.maxDepth = maxDepth
  }

  /// Parse one JSON value spanning the whole input (surrounding whitespace allowed).
  public static func parse(_ data: Data, maxBytes: Int = defaultMaxBytes, maxDepth: Int = defaultMaxDepth) throws -> JSONValue {
    if data.count > maxBytes {
      throw JSONParseError(offset: 0, reason: "input is \(data.count) bytes; the limit is \(maxBytes)")
    }
    var parser = StrictJSONParser(bytes: [UInt8](data), maxDepth: maxDepth)
    parser.skipWhitespace()
    let value = try parser.parseValue(depth: 0)
    parser.skipWhitespace()
    if parser.index != parser.bytes.count {
      throw JSONParseError(offset: parser.index, reason: "trailing content after the JSON value")
    }
    return value
  }

  public static func parse(_ text: String, maxBytes: Int = defaultMaxBytes, maxDepth: Int = defaultMaxDepth) throws -> JSONValue {
    try parse(Data(text.utf8), maxBytes: maxBytes, maxDepth: maxDepth)
  }

  private func fail(_ reason: String) -> JSONParseError {
    JSONParseError(offset: index, reason: reason)
  }

  private mutating func skipWhitespace() {
    while index < bytes.count {
      switch bytes[index] {
      case 0x20, 0x09, 0x0A, 0x0D: index += 1
      default: return
      }
    }
  }

  private mutating func parseValue(depth: Int) throws -> JSONValue {
    guard depth <= maxDepth else { throw fail("nesting deeper than \(maxDepth)") }
    guard index < bytes.count else { throw fail("unexpected end of input") }
    switch bytes[index] {
    case UInt8(ascii: "{"): return try parseObject(depth: depth)
    case UInt8(ascii: "["): return try parseArray(depth: depth)
    case UInt8(ascii: "\""): return .string(try parseString())
    case UInt8(ascii: "t"): try expectLiteral("true"); return .bool(true)
    case UInt8(ascii: "f"): try expectLiteral("false"); return .bool(false)
    case UInt8(ascii: "n"): try expectLiteral("null"); return .null
    case UInt8(ascii: "-"), UInt8(ascii: "0")...UInt8(ascii: "9"): return try parseNumber()
    default: throw fail("unexpected character")
    }
  }

  private mutating func expectLiteral(_ literal: String) throws {
    let utf8 = Array(literal.utf8)
    guard index + utf8.count <= bytes.count, Array(bytes[index..<(index + utf8.count)]) == utf8 else {
      throw fail("invalid literal")
    }
    index += utf8.count
  }

  private mutating func parseObject(depth: Int) throws -> JSONValue {
    index += 1  // {
    var members: [JSONMember] = []
    var seen = Set<String>()
    skipWhitespace()
    if index < bytes.count, bytes[index] == UInt8(ascii: "}") {
      index += 1
      return .object(members)
    }
    while true {
      skipWhitespace()
      guard index < bytes.count, bytes[index] == UInt8(ascii: "\"") else { throw fail("expected an object key") }
      let key = try parseString()
      if seen.contains(key) { throw fail("duplicate key \"\(key)\"") }
      seen.insert(key)
      skipWhitespace()
      guard index < bytes.count, bytes[index] == UInt8(ascii: ":") else { throw fail("expected ':'") }
      index += 1
      skipWhitespace()
      let value = try parseValue(depth: depth + 1)
      members.append(JSONMember(key: key, value: value))
      skipWhitespace()
      guard index < bytes.count else { throw fail("unterminated object") }
      if bytes[index] == UInt8(ascii: ",") {
        index += 1
        continue
      }
      if bytes[index] == UInt8(ascii: "}") {
        index += 1
        return .object(members)
      }
      throw fail("expected ',' or '}'")
    }
  }

  private mutating func parseArray(depth: Int) throws -> JSONValue {
    index += 1  // [
    var items: [JSONValue] = []
    skipWhitespace()
    if index < bytes.count, bytes[index] == UInt8(ascii: "]") {
      index += 1
      return .array(items)
    }
    while true {
      skipWhitespace()
      items.append(try parseValue(depth: depth + 1))
      skipWhitespace()
      guard index < bytes.count else { throw fail("unterminated array") }
      if bytes[index] == UInt8(ascii: ",") {
        index += 1
        continue
      }
      if bytes[index] == UInt8(ascii: "]") {
        index += 1
        return .array(items)
      }
      throw fail("expected ',' or ']'")
    }
  }

  private mutating func parseHex4() throws -> UInt16 {
    guard index + 4 <= bytes.count else { throw fail("truncated \\u escape") }
    var value: UInt16 = 0
    for _ in 0..<4 {
      let c = bytes[index]
      let digit: UInt16
      switch c {
      case UInt8(ascii: "0")...UInt8(ascii: "9"): digit = UInt16(c - UInt8(ascii: "0"))
      case UInt8(ascii: "a")...UInt8(ascii: "f"): digit = UInt16(c - UInt8(ascii: "a") + 10)
      case UInt8(ascii: "A")...UInt8(ascii: "F"): digit = UInt16(c - UInt8(ascii: "A") + 10)
      default: throw fail("invalid \\u escape")
      }
      value = value * 16 + digit
      index += 1
    }
    return value
  }

  private mutating func parseString() throws -> String {
    index += 1  // opening quote
    var scalars = String.UnicodeScalarView()
    var raw: [UInt8] = []  // pending UTF-8 run, validated when flushed
    func flush() throws {
      if raw.isEmpty { return }
      guard let s = String(bytes: raw, encoding: .utf8) else {
        throw JSONParseError(offset: index, reason: "invalid UTF-8 in string")
      }
      scalars.append(contentsOf: s.unicodeScalars)
      raw.removeAll(keepingCapacity: true)
    }
    while true {
      guard index < bytes.count else { throw fail("unterminated string") }
      let c = bytes[index]
      if c == UInt8(ascii: "\"") {
        index += 1
        try flush()
        return String(scalars)
      }
      if c < 0x20 { throw fail("unescaped control character in string") }
      if c != UInt8(ascii: "\\") {
        raw.append(c)
        index += 1
        continue
      }
      try flush()
      index += 1
      guard index < bytes.count else { throw fail("truncated escape") }
      let e = bytes[index]
      index += 1
      switch e {
      case UInt8(ascii: "\""): scalars.append("\"")
      case UInt8(ascii: "\\"): scalars.append("\\")
      case UInt8(ascii: "/"): scalars.append("/")
      case UInt8(ascii: "b"): scalars.append("\u{08}")
      case UInt8(ascii: "f"): scalars.append("\u{0C}")
      case UInt8(ascii: "n"): scalars.append("\n")
      case UInt8(ascii: "r"): scalars.append("\r")
      case UInt8(ascii: "t"): scalars.append("\t")
      case UInt8(ascii: "u"):
        let unit = try parseHex4()
        if (0xD800...0xDBFF).contains(unit) {
          guard index + 6 <= bytes.count, bytes[index] == UInt8(ascii: "\\"), bytes[index + 1] == UInt8(ascii: "u") else {
            throw fail("lone high surrogate")
          }
          index += 2
          let low = try parseHex4()
          guard (0xDC00...0xDFFF).contains(low) else { throw fail("invalid surrogate pair") }
          let code = 0x10000 + ((UInt32(unit) - 0xD800) << 10) + (UInt32(low) - 0xDC00)
          guard let scalar = Unicode.Scalar(code) else { throw fail("invalid code point") }
          scalars.append(scalar)
        } else if (0xDC00...0xDFFF).contains(unit) {
          throw fail("lone low surrogate")
        } else {
          guard let scalar = Unicode.Scalar(unit) else { throw fail("invalid code point") }
          scalars.append(scalar)
        }
      default:
        throw fail("invalid escape")
      }
    }
  }

  private mutating func parseNumber() throws -> JSONValue {
    let start = index
    var isInteger = true
    if bytes[index] == UInt8(ascii: "-") { index += 1 }
    guard index < bytes.count else { throw fail("truncated number") }
    if bytes[index] == UInt8(ascii: "0") {
      index += 1
      if index < bytes.count, (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(bytes[index]) {
        throw fail("leading zero in number")
      }
    } else if (UInt8(ascii: "1")...UInt8(ascii: "9")).contains(bytes[index]) {
      while index < bytes.count, (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(bytes[index]) { index += 1 }
    } else {
      throw fail("invalid number")
    }
    if index < bytes.count, bytes[index] == UInt8(ascii: ".") {
      isInteger = false
      index += 1
      let digitsStart = index
      while index < bytes.count, (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(bytes[index]) { index += 1 }
      if index == digitsStart { throw fail("missing fraction digits") }
    }
    if index < bytes.count, bytes[index] == UInt8(ascii: "e") || bytes[index] == UInt8(ascii: "E") {
      isInteger = false
      index += 1
      if index < bytes.count, bytes[index] == UInt8(ascii: "+") || bytes[index] == UInt8(ascii: "-") { index += 1 }
      let digitsStart = index
      while index < bytes.count, (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(bytes[index]) { index += 1 }
      if index == digitsStart { throw fail("missing exponent digits") }
    }
    let text = String(decoding: bytes[start..<index], as: UTF8.self)
    if isInteger, let n = Int64(text) {
      return .integer(n)
    }
    guard let d = Double(text), d.isFinite else { throw fail("number out of range") }
    return .number(d)
  }
}

public struct CanonicalJSONError: Error, Equatable, CustomStringConvertible {
  public let reason: String
  public var description: String { "cannot canonicalize: \(reason)" }
}

public enum CanonicalJSON {
  /// Byte-identical to canonicalizeDaemonActivationValue(): keys sorted by
  /// UTF-16 code unit, no whitespace, strings escaped exactly as
  /// JSON.stringify escapes them. Non-integer numbers are refused (no grant
  /// contains one, and JavaScript's shortest-round-trip float printing is
  /// not worth reproducing for a value that must never be signed).
  public static func encode(_ value: JSONValue) throws -> String {
    var out = ""
    try write(value, into: &out)
    return out
  }

  private static func write(_ value: JSONValue, into out: inout String) throws {
    switch value {
    case .null: out += "null"
    case let .bool(b): out += b ? "true" : "false"
    case let .integer(n): out += String(n)
    case .number: throw CanonicalJSONError(reason: "non-integer numbers are not signable")
    case let .string(s): writeString(s, into: &out)
    case let .array(items):
      out += "["
      for (i, item) in items.enumerated() {
        if i > 0 { out += "," }
        try write(item, into: &out)
      }
      out += "]"
    case let .object(members):
      out += "{"
      let sorted = members.sorted { lessByUTF16($0.key, $1.key) }
      for (i, member) in sorted.enumerated() {
        if i > 0 { out += "," }
        writeString(member.key, into: &out)
        out += ":"
        try write(member.value, into: &out)
      }
      out += "}"
    }
  }

  /// JavaScript's default sort compares strings by UTF-16 code units.
  static func lessByUTF16(_ a: String, _ b: String) -> Bool {
    a.utf16.lexicographicallyPrecedes(b.utf16)
  }

  /// JSON.stringify's string escaping (ECMA-262 QuoteJSONString).
  static func writeString(_ s: String, into out: inout String) {
    out += "\""
    for scalar in s.unicodeScalars {
      switch scalar {
      case "\"": out += "\\\""
      case "\\": out += "\\\\"
      case "\u{08}": out += "\\b"
      case "\u{0C}": out += "\\f"
      case "\n": out += "\\n"
      case "\r": out += "\\r"
      case "\t": out += "\\t"
      default:
        if scalar.value < 0x20 {
          out += String(format: "\\u%04x", scalar.value)
        } else {
          out.unicodeScalars.append(scalar)
        }
      }
    }
    out += "\""
  }
}
