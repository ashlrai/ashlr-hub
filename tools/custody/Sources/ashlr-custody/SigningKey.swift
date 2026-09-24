// The Secure Enclave signing key and the Touch ID gate in front of it.
//
// Key: SecureEnclave.P256 with [.privateKeyUsage, .userPresence]. The private
// key never exists outside the Secure Enclave; what is stored on disk is an
// SEP-encrypted blob that only this Mac's Secure Enclave can use, and only
// after Touch ID or the login password. There is no signing path without
// presence: every signature means Mason physically approved it.

import CryptoKit
import CustodyCore
import Foundation
import LocalAuthentication
import Security

struct KeyRecord {
  let keyId: String
  let publicKeyPEM: String
  let blobURL: URL
}

enum KeyStore {
  static let blobName = "signing-key.blob"
  static let metaName = "signing-key.json"

  /// Mason's home from the password database — never $HOME, which any caller
  /// could point at a directory of its own choosing.
  static func homeDirectory() throws -> URL {
    guard let entry = getpwuid(getuid()), let dir = entry.pointee.pw_dir else {
      throw CustodyFailure("internal", "cannot resolve the home directory of this user", exit: .internalError)
    }
    return URL(fileURLWithPath: String(cString: dir), isDirectory: true)
  }

  /// ~/Library/Application Support/ashlr-custody — every autonomous sandbox
  /// profile denies reading it (src/core/sandbox/confine.ts).
  static func dataDirectory() throws -> URL {
    try homeDirectory().appendingPathComponent("Library/Application Support/ashlr-custody", isDirectory: true)
  }

  /// Refuse a symlink, a foreign owner or group/other access on the custody
  /// directory and its files: the blob is useless without the Secure Enclave,
  /// but a swapped blob would make Mason sign with a key nobody trusts.
  static func checkPrivate(_ url: URL, directory: Bool) throws {
    var st = stat()
    guard lstat(url.path, &st) == 0 else {
      throw CustodyFailure("key-missing", "no custody key at \(url.lastPathComponent); run `ashlr-custody init`", exit: .missing)
    }
    let isDir = (st.st_mode & S_IFMT) == S_IFDIR
    let isReg = (st.st_mode & S_IFMT) == S_IFREG
    if (directory && !isDir) || (!directory && !isReg) || st.st_uid != getuid() || (st.st_mode & 0o077) != 0 {
      throw CustodyFailure("keystore", "\(url.path) must be a private (0700/0600) \(directory ? "directory" : "file") owned by you and not a symlink", exit: .keystore)
    }
  }

  static func load() throws -> KeyRecord? {
    let dir = try dataDirectory()
    let meta = dir.appendingPathComponent(metaName)
    let blob = dir.appendingPathComponent(blobName)
    if !FileManager.default.fileExists(atPath: meta.path) && !FileManager.default.fileExists(atPath: blob.path) {
      return nil
    }
    try checkPrivate(dir, directory: true)
    try checkPrivate(meta, directory: false)
    try checkPrivate(blob, directory: false)
    let data = try Data(contentsOf: meta)
    let value: JSONValue
    do { value = try StrictJSONParser.parse(data, maxBytes: 16 * 1024) } catch {
      throw CustodyFailure("keystore", "\(metaName) is not valid JSON", exit: .keystore)
    }
    guard let keyId = value["keyId"]?.stringValue, let pem = value["publicKeyPem"]?.stringValue,
          let der = KeyMaterial.der(fromPEM: pem, label: "PUBLIC KEY"),
          (try? P256.Signing.PublicKey(derRepresentation: der)) != nil,
          KeyMaterial.keyId(spkiDER: der) == keyId else {
      throw CustodyFailure("keystore", "\(metaName) does not describe a valid P-256 key", exit: .keystore)
    }
    return KeyRecord(keyId: keyId, publicKeyPEM: pem, blobURL: blob)
  }

  /// Write the new key; a rotated key's files are kept (renamed), never deleted.
  static func save(key: SecureEnclave.P256.Signing.PrivateKey, rotate: Bool) throws -> KeyRecord {
    let dir = try dataDirectory()
    let fm = FileManager.default
    if !fm.fileExists(atPath: dir.path) {
      try fm.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    }
    try checkPrivate(dir, directory: true)
    let blob = dir.appendingPathComponent(blobName)
    let meta = dir.appendingPathComponent(metaName)
    if rotate {
      let stamp = ISOInstant.format(Date()).replacingOccurrences(of: ":", with: "")
      for url in [blob, meta] where fm.fileExists(atPath: url.path) {
        try fm.moveItem(at: url, to: dir.appendingPathComponent("\(url.lastPathComponent).retired-\(stamp)"))
      }
    }
    let spki = key.publicKey.derRepresentation
    let pem = KeyMaterial.pem(der: spki, label: "PUBLIC KEY")
    let keyId = KeyMaterial.keyId(spkiDER: spki)
    var line = JSONLine()
    line.integer("v", 1)
    line.string("keyId", keyId)
    line.string("publicKeyPem", pem)
    line.string("createdAt", ISOInstant.format(Date()))
    try writePrivate(key.dataRepresentation, to: blob)
    try writePrivate(Data((line.text + "\n").utf8), to: meta)
    return KeyRecord(keyId: keyId, publicKeyPEM: pem, blobURL: blob)
  }

  /// O_EXCL temp file (0600, no symlink following) + fsync + rename.
  static func writePrivate(_ data: Data, to url: URL) throws {
    let tmp = url.deletingLastPathComponent().appendingPathComponent(".\(url.lastPathComponent).\(getpid()).tmp")
    let fd = open(tmp.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
    guard fd >= 0 else { throw CustodyFailure("keystore", "cannot create \(tmp.lastPathComponent)", exit: .keystore) }
    var ok = data.withUnsafeBytes { raw -> Bool in
      var offset = 0
      while offset < raw.count {
        let n = write(fd, raw.baseAddress!.advanced(by: offset), raw.count - offset)
        if n <= 0 { return false }
        offset += n
      }
      return true
    }
    ok = ok && fsync(fd) == 0
    close(fd)
    guard ok, rename(tmp.path, url.path) == 0 else {
      unlink(tmp.path)
      throw CustodyFailure("keystore", "cannot write \(url.lastPathComponent)", exit: .keystore)
    }
  }
}

enum Presence {
  /// Evaluate device-owner authentication (Touch ID, or the login password)
  /// with the helper's own text. The evaluated context is then handed to the
  /// Secure Enclave, which accepts it for the key's .userPresence constraint.
  static func authenticate(reason: String) throws -> LAContext {
    let context = LAContext()
    context.localizedCancelTitle = "Cancel"
    var canError: NSError?
    guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &canError) else {
      throw CustodyFailure("auth-failed", "this Mac cannot ask for Touch ID or the login password right now", exit: .auth)
    }
    let done = DispatchSemaphore(value: 0)
    var outcome: Result<Void, Error> = .success(())
    context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { success, error in
      if !success { outcome = .failure(error ?? CustodyFailure("auth-failed", "authentication failed", exit: .auth)) }
      done.signal()
    }
    done.wait()
    if case let .failure(error) = outcome {
      let code = (error as? LAError)?.code
      switch code {
      case .userCancel?, .systemCancel?, .appCancel?:
        throw CustodyFailure("auth-cancelled", "Touch ID was cancelled; nothing was signed", exit: .auth)
      default:
        throw CustodyFailure("auth-failed", "Touch ID did not succeed; nothing was signed", exit: .auth)
      }
    }
    return context
  }
}

enum EnclaveKey {
  static func create(context: LAContext) throws -> SecureEnclave.P256.Signing.PrivateKey {
    guard SecureEnclave.isAvailable else {
      throw CustodyFailure("secure-enclave", "this Mac has no Secure Enclave", exit: .keystore)
    }
    var error: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
                                                        [.privateKeyUsage, .userPresence], &error) else {
      throw CustodyFailure("secure-enclave", "cannot build the key's access control", exit: .keystore)
    }
    do {
      return try SecureEnclave.P256.Signing.PrivateKey(accessControl: access, authenticationContext: context)
    } catch {
      throw CustodyFailure("secure-enclave", "the Secure Enclave refused to create the key", exit: .keystore)
    }
  }

  /// Sign with the stored key under an already-evaluated context, then check
  /// the signature against the recorded public key before anyone sees it.
  static func sign(_ message: Data, record: KeyRecord, context: LAContext) throws -> Data {
    let blob: Data
    do { blob = try Data(contentsOf: record.blobURL) } catch {
      throw CustodyFailure("keystore", "cannot read the key blob", exit: .keystore)
    }
    let key: SecureEnclave.P256.Signing.PrivateKey
    do {
      key = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: blob, authenticationContext: context)
    } catch {
      throw CustodyFailure("secure-enclave", "this Mac's Secure Enclave cannot use the stored key", exit: .keystore)
    }
    guard KeyMaterial.pem(der: key.publicKey.derRepresentation, label: "PUBLIC KEY") == record.publicKeyPEM else {
      throw CustodyFailure("keystore", "the key blob does not match signing-key.json", exit: .keystore)
    }
    let signature: P256.Signing.ECDSASignature
    do { signature = try key.signature(for: message) } catch {
      throw CustodyFailure("auth-failed", "the Secure Enclave did not sign (authentication required)", exit: .auth)
    }
    guard key.publicKey.isValidSignature(signature, for: message) else {
      throw CustodyFailure("secure-enclave", "the Secure Enclave produced a signature that does not verify", exit: .keystore)
    }
    return signature.rawRepresentation
  }
}
