// Encodings shared by the helper and the TypeScript side: SPKI PEM for the
// P-256 public key, the key id derived from it, and just enough DER to unwrap
// a PKCS#8 RSA key into the PKCS#1 form Security.framework imports.

import CryptoKit
import Foundation

public enum KeyMaterial {
  /// `se-p256-` + the first 16 hex digits of sha256(SPKI DER). Deterministic,
  /// so anyone holding the PEM (e.g. a reviewer of the trust-roots PR) can
  /// recompute it; matches STANDING_GRANT_PATTERNS.keyId.
  public static func keyId(spkiDER: Data) -> String {
    let hex = SHA256.hash(data: spkiDER).map { String(format: "%02x", $0) }.joined()
    return "se-p256-" + hex.prefix(16)
  }

  public static func pem(der: Data, label: String) -> String {
    let b64 = der.base64EncodedString()
    var lines: [String] = ["-----BEGIN \(label)-----"]
    var index = b64.startIndex
    while index < b64.endIndex {
      let end = b64.index(index, offsetBy: 64, limitedBy: b64.endIndex) ?? b64.endIndex
      lines.append(String(b64[index..<end]))
      index = end
    }
    lines.append("-----END \(label)-----")
    return lines.joined(separator: "\n") + "\n"
  }

  /// Decode exactly one PEM block with the given label; nil on any deviation.
  public static func der(fromPEM pem: String, label: String) -> Data? {
    let begin = "-----BEGIN \(label)-----"
    let end = "-----END \(label)-----"
    let trimmed = pem.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed.hasPrefix(begin), trimmed.hasSuffix(end) else { return nil }
    let body = trimmed.dropFirst(begin.count).dropLast(end.count)
    let b64 = body.filter { !$0.isWhitespace }
    guard !b64.isEmpty, b64.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "+" || $0 == "/" || $0 == "=") }) else {
      return nil
    }
    return Data(base64Encoded: String(b64))
  }

  public enum PrivateKeyError: Error, Equatable {
    case notPEM
    case notRSA
    case malformed
  }

  /// PKCS#1 RSAPrivateKey DER from a GitHub App key PEM. GitHub issues
  /// `RSA PRIVATE KEY` (PKCS#1); a converted `PRIVATE KEY` (PKCS#8) is unwrapped.
  public static func rsaPKCS1(fromPEM pem: String) throws -> Data {
    if let der = der(fromPEM: pem, label: "RSA PRIVATE KEY") {
      _ = try DER.sequence(der)  // must at least be a SEQUENCE
      return der
    }
    guard let der = der(fromPEM: pem, label: "PRIVATE KEY") else { throw PrivateKeyError.notPEM }
    // PrivateKeyInfo ::= SEQUENCE { version INTEGER, algorithm SEQUENCE { OID, NULL }, privateKey OCTET STRING }
    let outer = try DER.sequence(der)
    var reader = DER.Reader(outer)
    let version = try reader.next()
    guard version.tag == 0x02 else { throw PrivateKeyError.malformed }
    let algorithm = try reader.next()
    guard algorithm.tag == 0x30 else { throw PrivateKeyError.malformed }
    var algReader = DER.Reader(algorithm.content)
    let oid = try algReader.next()
    let rsaEncryption: [UInt8] = [0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x01]
    guard oid.tag == 0x06, [UInt8](oid.content) == rsaEncryption else { throw PrivateKeyError.notRSA }
    let key = try reader.next()
    guard key.tag == 0x04 else { throw PrivateKeyError.malformed }
    _ = try DER.sequence(key.content)
    return key.content
  }
}

/// Minimal DER TLV reader (definite lengths only), enough for PKCS#8.
enum DER {
  struct Element {
    let tag: UInt8
    let content: Data
  }

  struct Reader {
    private let bytes: [UInt8]
    private var index = 0
    init(_ data: Data) { bytes = [UInt8](data) }

    var isAtEnd: Bool { index == bytes.count }

    mutating func next() throws -> Element {
      guard index + 2 <= bytes.count else { throw KeyMaterial.PrivateKeyError.malformed }
      let tag = bytes[index]
      var length = Int(bytes[index + 1])
      index += 2
      if length & 0x80 != 0 {
        let count = length & 0x7F
        guard count >= 1, count <= 4, index + count <= bytes.count else { throw KeyMaterial.PrivateKeyError.malformed }
        length = 0
        for _ in 0..<count {
          length = (length << 8) | Int(bytes[index])
          index += 1
        }
      }
      guard length >= 0, index + length <= bytes.count else { throw KeyMaterial.PrivateKeyError.malformed }
      let content = Data(bytes[index..<(index + length)])
      index += length
      return Element(tag: tag, content: content)
    }
  }

  /// The content of a single top-level SEQUENCE that spans all of `data`.
  static func sequence(_ data: Data) throws -> Data {
    var reader = Reader(data)
    let element = try reader.next()
    guard element.tag == 0x30, reader.isAtEnd else { throw KeyMaterial.PrivateKeyError.malformed }
    return element.content
  }
}
