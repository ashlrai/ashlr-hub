//! Dormant native macOS launchd-broker foundations (M569).
//!
//! This module supplies authenticated frames, fd-relative/no-follow storage,
//! stopped launchd observation, a fail-closed claim-and-verify transaction
//! exercised only by this module's native tests, and an authenticated fsynced
//! recovery journal. It is intentionally not a
//! Tauri command and has no CLI, XPC listener, trust root, permit verifier,
//! launch/start/dispatch operation, or production authority. In particular,
//! `RENAME_EXCL` claim-and-verify is not the genuine kernel conditional CAS
//! required by M521; a protected broker boundary must own that later step.

use hmac::{Hmac, Mac};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fmt, io};

type HmacSha256 = Hmac<Sha256>;

const REQUEST_DOMAIN: &[u8] = b"ashlr-native-launchd-broker-v1/request\0";
const RECEIPT_DOMAIN: &[u8] = b"ashlr-native-launchd-broker-v1/receipt\0";
const JOURNAL_DOMAIN: &[u8] = b"ashlr-native-launchd-broker-v1/journal\0";
const PROTOCOL: &str = "ashlr-native-launchd-broker-v1";
const MAX_FRAME_BYTES: usize = 256 * 1024;
const MAX_PLIST_BYTES: usize = 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NativeBrokerAuthority {
    pub effect_consumer_registered: bool,
    pub permit_and_trust_roots_verified: bool,
    pub protected_xpc_boundary_verified: bool,
    pub peer_audit_token_and_code_identity_verified: bool,
    pub native_conditional_cas_verified: bool,
    pub trusted_time_verified: bool,
    pub external_monotonic_replay_verified: bool,
    pub cross_generation_exclusion_verified: bool,
    pub resident_acknowledgement_verified: bool,
    pub launch_or_start_authorized: bool,
    pub dispatch_authorized: bool,
}

pub const NATIVE_BROKER_AUTHORITY: NativeBrokerAuthority = NativeBrokerAuthority {
    effect_consumer_registered: false,
    permit_and_trust_roots_verified: false,
    protected_xpc_boundary_verified: false,
    peer_audit_token_and_code_identity_verified: false,
    native_conditional_cas_verified: false,
    trusted_time_verified: false,
    external_monotonic_replay_verified: false,
    cross_generation_exclusion_verified: false,
    resident_acknowledgement_verified: false,
    launch_or_start_authorized: false,
    dispatch_authorized: false,
};

#[derive(Debug)]
pub enum BrokerError {
    UnsupportedPlatform,
    Invalid(&'static str),
    Authentication,
    Conflict(&'static str),
    ReconciliationRequired(&'static str),
    Io(io::Error),
    Json(serde_json::Error),
}

impl fmt::Display for BrokerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedPlatform => f.write_str("native-macos-broker-unavailable"),
            Self::Invalid(reason) => write!(f, "invalid-broker-input:{reason}"),
            Self::Authentication => f.write_str("broker-authentication-failed"),
            Self::Conflict(reason) => write!(f, "broker-cas-conflict:{reason}"),
            Self::ReconciliationRequired(reason) => {
                write!(f, "broker-reconciliation-required:{reason}")
            }
            Self::Io(error) => write!(f, "broker-io:{error}"),
            Self::Json(error) => write!(f, "broker-json:{error}"),
        }
    }
}

impl std::error::Error for BrokerError {}

impl From<io::Error> for BrokerError {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<serde_json::Error> for BrokerError {
    fn from(value: serde_json::Error) -> Self {
        Self::Json(value)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ObjectIdentity {
    pub device: String,
    pub inode: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PointerObservation {
    pub identity: ObjectIdentity,
    pub owner_uid: u32,
    pub raw_target: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlistObservation {
    pub identity: ObjectIdentity,
    pub owner_uid: u32,
    pub mode: u32,
    pub byte_length: u64,
    pub sha256: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LaunchdStoppedObservation {
    pub uid: u32,
    pub label: String,
    pub loaded: bool,
    pub disabled: bool,
    pub job_generation: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BrokerRequest {
    pub protocol: String,
    pub transaction_id: String,
    pub nonce: String,
    pub untrusted_permit_sha256: String,
    pub request_sequence: u64,
    pub pointer_parent: String,
    pub plist_parent: String,
    pub journal_parent: String,
    pub pointer_name: String,
    pub plist_name: String,
    pub candidate_pointer_target: String,
    pub candidate_plist_sha256: String,
    pub expected_pointer: PointerObservation,
    pub expected_plist: PlistObservation,
    pub stopped: LaunchdStoppedObservation,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BrokerReceipt {
    pub protocol: String,
    pub transaction_id: String,
    pub request_sha256: String,
    pub outcome: String,
    pub pointer: PointerObservation,
    pub plist: PlistObservation,
    pub stopped: LaunchdStoppedObservation,
    pub service_started: bool,
    pub service_enabled: bool,
    pub dispatch_authorized: bool,
    pub provider_effects_unblocked: bool,
    pub protected_broker_verified: bool,
    pub native_conditional_cas_verified: bool,
    pub external_replay_consumed: bool,
    pub activation_authorized: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Authenticated<T> {
    payload: T,
    mac_hex: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum RecoveryOutcome {
    Committed(Box<BrokerReceipt>),
    RolledBack,
}

struct BrokerKeys<'a> {
    request_verification: &'a [u8],
    journal_authentication: &'a [u8],
    receipt_authentication: &'a [u8],
}

impl BrokerKeys<'_> {
    fn validate(&self) -> Result<(), BrokerError> {
        require_key(self.request_verification)?;
        require_key(self.journal_authentication)?;
        require_key(self.receipt_authentication)?;
        if constant_time_eq(self.request_verification, self.journal_authentication)
            || constant_time_eq(self.request_verification, self.receipt_authentication)
            || constant_time_eq(self.journal_authentication, self.receipt_authentication)
        {
            return Err(BrokerError::Invalid("broker-keys-must-be-domain-separated"));
        }
        Ok(())
    }
}

pub fn encode_authenticated_request(
    request: &BrokerRequest,
    key: &[u8],
) -> Result<Vec<u8>, BrokerError> {
    validate_request(request)?;
    encode_authenticated(request, key, REQUEST_DOMAIN)
}

pub fn decode_authenticated_request(
    frame: &[u8],
    key: &[u8],
) -> Result<BrokerRequest, BrokerError> {
    let request = decode_authenticated(frame, key, REQUEST_DOMAIN)?;
    validate_request(&request)?;
    Ok(request)
}

fn encode_authenticated_receipt(
    receipt: &BrokerReceipt,
    key: &[u8],
) -> Result<Vec<u8>, BrokerError> {
    encode_authenticated(receipt, key, RECEIPT_DOMAIN)
}

pub fn decode_authenticated_receipt(
    frame: &[u8],
    key: &[u8],
) -> Result<BrokerReceipt, BrokerError> {
    let receipt = decode_authenticated(frame, key, RECEIPT_DOMAIN)?;
    validate_receipt(&receipt)?;
    Ok(receipt)
}

fn validate_receipt(receipt: &BrokerReceipt) -> Result<(), BrokerError> {
    if receipt.protocol != PROTOCOL
        || receipt.outcome != "foundation-claim-and-verify-only"
        || receipt.service_started
        || receipt.service_enabled
        || receipt.dispatch_authorized
        || receipt.provider_effects_unblocked
        || receipt.protected_broker_verified
        || receipt.native_conditional_cas_verified
        || receipt.external_replay_consumed
        || receipt.activation_authorized
        || receipt.stopped.loaded
        || receipt.stopped.job_generation.is_some()
    {
        return Err(BrokerError::Invalid("receipt-authority"));
    }
    validate_token(&receipt.transaction_id, 32, 64, true)?;
    validate_sha256(&receipt.request_sha256)?;
    validate_object_identity(&receipt.pointer.identity)?;
    validate_object_identity(&receipt.plist.identity)?;
    validate_target(&receipt.pointer.raw_target)?;
    validate_sha256(&receipt.plist.sha256)?;
    if receipt.stopped.label != "ai.ashlr.daemon"
        || receipt.pointer.owner_uid != receipt.stopped.uid
        || receipt.plist.owner_uid != receipt.stopped.uid
        || receipt.pointer.identity == receipt.plist.identity
        || receipt.plist.mode != 0o600
        || receipt.plist.byte_length > MAX_PLIST_BYTES as u64
    {
        return Err(BrokerError::Invalid("receipt-semantics"));
    }
    Ok(())
}

fn validate_object_identity(identity: &ObjectIdentity) -> Result<(), BrokerError> {
    for value in [&identity.device, &identity.inode] {
        let parsed = value
            .parse::<u64>()
            .map_err(|_| BrokerError::Invalid("object-identity"))?;
        if parsed == 0 || parsed.to_string() != *value {
            return Err(BrokerError::Invalid("object-identity"));
        }
    }
    Ok(())
}

fn encode_authenticated<T: Clone + Serialize>(
    payload: &T,
    key: &[u8],
    domain: &[u8],
) -> Result<Vec<u8>, BrokerError> {
    require_key(key)?;
    let payload_bytes = serde_json::to_vec(payload)?;
    let envelope = Authenticated {
        payload: payload.clone(),
        mac_hex: mac_hex(key, domain, &payload_bytes)?,
    };
    let mut bytes = serde_json::to_vec(&envelope)?;
    bytes.push(b'\n');
    if bytes.len() > MAX_FRAME_BYTES {
        return Err(BrokerError::Invalid("frame-too-large"));
    }
    Ok(bytes)
}

fn decode_authenticated<T: Clone + DeserializeOwned + Serialize>(
    frame: &[u8],
    key: &[u8],
    domain: &[u8],
) -> Result<T, BrokerError> {
    require_key(key)?;
    if frame.len() > MAX_FRAME_BYTES || frame.last() != Some(&b'\n') {
        return Err(BrokerError::Invalid("non-canonical-frame"));
    }
    let envelope: Authenticated<T> = serde_json::from_slice(&frame[..frame.len() - 1])?;
    let canonical = encode_authenticated(&envelope.payload, key, domain)?;
    if !constant_time_eq(&canonical, frame) {
        return Err(BrokerError::Authentication);
    }
    Ok(envelope.payload)
}

fn require_key(key: &[u8]) -> Result<(), BrokerError> {
    if key.len() != 32 {
        return Err(BrokerError::Invalid("key-must-be-32-bytes"));
    }
    Ok(())
}

fn mac_hex(key: &[u8], domain: &[u8], bytes: &[u8]) -> Result<String, BrokerError> {
    let mut mac = HmacSha256::new_from_slice(key).map_err(|_| BrokerError::Authentication)?;
    mac.update(domain);
    mac.update(bytes);
    Ok(hex_lower(&mac.finalize().into_bytes()))
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex_lower(&Sha256::digest(bytes))
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    let mut difference = left.len() ^ right.len();
    let maximum = left.len().max(right.len());
    for index in 0..maximum {
        let left_byte = left.get(index).copied().unwrap_or(0);
        let right_byte = right.get(index).copied().unwrap_or(0);
        difference |= usize::from(left_byte ^ right_byte);
    }
    difference == 0
}

fn validate_request(request: &BrokerRequest) -> Result<(), BrokerError> {
    if request.protocol != PROTOCOL {
        return Err(BrokerError::Invalid("protocol"));
    }
    validate_token(&request.transaction_id, 32, 64, true)?;
    validate_token(&request.nonce, 32, 128, false)?;
    validate_sha256(&request.untrusted_permit_sha256)?;
    validate_sha256(&request.candidate_plist_sha256)?;
    validate_absolute_path(&request.pointer_parent)?;
    validate_absolute_path(&request.plist_parent)?;
    validate_absolute_path(&request.journal_parent)?;
    if request.pointer_parent == request.plist_parent
        || request.pointer_parent == request.journal_parent
        || request.plist_parent == request.journal_parent
    {
        return Err(BrokerError::Invalid("custody-roots-must-be-distinct"));
    }
    validate_name(&request.pointer_name)?;
    validate_name(&request.plist_name)?;
    validate_target(&request.candidate_pointer_target)?;
    validate_target(&request.expected_pointer.raw_target)?;
    validate_sha256(&request.expected_plist.sha256)?;
    if request.stopped.loaded || request.stopped.job_generation.is_some() {
        return Err(BrokerError::Invalid("launchd-must-be-exactly-unloaded"));
    }
    if request.stopped.label != "ai.ashlr.daemon" {
        return Err(BrokerError::Invalid("launchd-label"));
    }
    if request.request_sequence > 9_007_199_254_740_991 {
        return Err(BrokerError::Invalid("request-sequence-not-json-safe"));
    }
    Ok(())
}

fn validate_absolute_path(value: &str) -> Result<(), BrokerError> {
    if value.is_empty()
        || value.len() > 4096
        || !value.starts_with('/')
        || value.as_bytes().contains(&0)
        || value
            .split('/')
            .any(|component| matches!(component, "." | ".."))
    {
        return Err(BrokerError::Invalid("absolute-path"));
    }
    Ok(())
}

fn validate_token(
    value: &str,
    minimum: usize,
    maximum: usize,
    lowercase_hex_only: bool,
) -> Result<(), BrokerError> {
    let valid = value.len() >= minimum
        && value.len() <= maximum
        && value.bytes().all(|byte| {
            if lowercase_hex_only {
                byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
            } else {
                byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')
            }
        });
    if !valid {
        return Err(BrokerError::Invalid("token"));
    }
    Ok(())
}

fn validate_sha256(value: &str) -> Result<(), BrokerError> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(BrokerError::Invalid("sha256"));
    }
    Ok(())
}

fn validate_name(value: &str) -> Result<(), BrokerError> {
    if value.is_empty()
        || value.len() > 255
        || value == "."
        || value == ".."
        || value.as_bytes().contains(&b'/')
        || value.as_bytes().contains(&0)
    {
        return Err(BrokerError::Invalid("unsafe-relative-name"));
    }
    Ok(())
}

fn validate_target(value: &str) -> Result<(), BrokerError> {
    let revision = value.strip_prefix("releases/");
    if value.len() != 49
        || !matches!(revision, Some(revision) if revision.len() == 40
            && revision.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
    {
        return Err(BrokerError::Invalid("unsafe-pointer-target"));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use std::{
        ffi::{CStr, CString, OsStr},
        fs::File,
        io::{Read, Write},
        mem::MaybeUninit,
        os::{
            fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
            unix::ffi::OsStrExt,
        },
        path::{Component, Path},
        process::{Command, Stdio},
        thread,
        time::{Duration, Instant},
    };

    const MAX_LAUNCHCTL_BYTES: usize = 64 * 1024;
    const LAUNCHCTL_TIMEOUT: Duration = Duration::from_secs(5);
    const JOURNAL_PHASES: usize = 9;

    type StagingHook<'a> =
        dyn FnMut(&CustodyRoot, &str, &CustodyRoot, &str) -> Result<(), BrokerError> + 'a;

    #[derive(Debug)]
    pub struct CustodyRoot {
        directory: OwnedFd,
        canonical_path: String,
        identity: ObjectIdentity,
    }

    struct LifecycleLease {
        _file: File,
        identity: ObjectIdentity,
    }

    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct JournalIntent {
        request_sha256: String,
        transaction_id: String,
        pointer_parent: String,
        plist_parent: String,
        journal_parent: String,
        pointer_root_identity: ObjectIdentity,
        plist_root_identity: ObjectIdentity,
        journal_root_identity: ObjectIdentity,
        pointer_lease_identity: ObjectIdentity,
        plist_lease_identity: ObjectIdentity,
        journal_lease_identity: ObjectIdentity,
        active_marker: PlistObservation,
        pointer_name: String,
        plist_name: String,
        pointer_temp: String,
        pointer_backup: String,
        plist_temp: String,
        plist_backup: String,
        expected_pointer: PointerObservation,
        expected_plist: PlistObservation,
        candidate_pointer_target: String,
        candidate_plist_sha256: String,
        stopped: LaunchdStoppedObservation,
    }

    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "kebab-case")]
    enum JournalPhase {
        Intent,
        Staged,
        PointerClaimed,
        PointerInstalled,
        PlistClaimed,
        PlistInstalled,
        ReceiptPersisted,
        Committed,
        RolledBack,
    }

    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct JournalRecord {
        protocol: String,
        transaction_id: String,
        sequence: u8,
        phase: JournalPhase,
        predecessor_sha256: Option<String>,
        intent: JournalIntent,
        staged_pointer: Option<PointerObservation>,
        staged_plist: Option<PlistObservation>,
    }

    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct ActiveTransaction {
        protocol: String,
        transaction_id: String,
    }

    impl CustodyRoot {
        pub fn open(path: &Path) -> Result<Self, BrokerError> {
            Self::open_with_policy(path, false)
        }

        fn open_private(path: &Path) -> Result<Self, BrokerError> {
            Self::open_with_policy(path, true)
        }

        fn open_with_policy(path: &Path, require_private: bool) -> Result<Self, BrokerError> {
            if !path.is_absolute() {
                return Err(BrokerError::Invalid("custody-root-must-be-absolute"));
            }
            let supplied = path
                .to_str()
                .ok_or(BrokerError::Invalid("custody-root-must-be-utf8"))?;
            let mut spelling = String::new();
            let mut directory = open_directory(c"/")?;
            for component in path.components() {
                match component {
                    Component::RootDir => {}
                    Component::Normal(name) => {
                        spelling.push('/');
                        spelling.push_str(
                            name.to_str()
                                .ok_or(BrokerError::Invalid("custody-root-must-be-utf8"))?,
                        );
                        let name = cstring(name)?;
                        directory = openat_directory(directory.as_raw_fd(), &name)?;
                    }
                    _ => return Err(BrokerError::Invalid("custody-root-components")),
                }
            }
            if spelling.is_empty() {
                spelling.push('/');
            }
            if supplied != spelling {
                return Err(BrokerError::Invalid("custody-root-non-canonical-spelling"));
            }
            let stat = fstat(directory.as_raw_fd())?;
            let mode = stat.st_mode & 0o777;
            if stat.st_uid != unsafe { libc::geteuid() }
                || (mode & 0o022) != 0
                || (mode & 0o700) != 0o700
                || (require_private && mode != 0o700)
            {
                return Err(BrokerError::Invalid("custody-root-not-private-owned"));
            }
            Ok(Self {
                directory,
                canonical_path: spelling,
                identity: identity(&stat),
            })
        }

        pub fn canonical_path(&self) -> &str {
            &self.canonical_path
        }

        pub fn identity(&self) -> &ObjectIdentity {
            &self.identity
        }

        pub fn observe_pointer(&self, name: &str) -> Result<PointerObservation, BrokerError> {
            validate_name(name)?;
            let name = CString::new(name).map_err(|_| BrokerError::Invalid("pointer-name"))?;
            let stat = fstatat_nofollow(self.directory.as_raw_fd(), &name)?;
            if (stat.st_mode & libc::S_IFMT) != libc::S_IFLNK {
                return Err(BrokerError::Conflict("pointer-is-not-symlink"));
            }
            if stat.st_uid != unsafe { libc::geteuid() } {
                return Err(BrokerError::Conflict("pointer-owner-mismatch"));
            }
            let mut buffer = vec![0_u8; 4097];
            let length = unsafe {
                libc::readlinkat(
                    self.directory.as_raw_fd(),
                    name.as_ptr(),
                    buffer.as_mut_ptr().cast(),
                    buffer.len(),
                )
            };
            if length < 0 {
                return Err(io::Error::last_os_error().into());
            }
            let length = length as usize;
            if length == 0 || length > 4096 || length == buffer.len() {
                return Err(BrokerError::Invalid("pointer-target-length"));
            }
            buffer.truncate(length);
            let raw_target = String::from_utf8(buffer)
                .map_err(|_| BrokerError::Invalid("pointer-target-utf8"))?;
            let after = fstatat_nofollow(self.directory.as_raw_fd(), &name)?;
            if identity(&stat) != identity(&after)
                || (after.st_mode & libc::S_IFMT) != libc::S_IFLNK
                || stat.st_uid != after.st_uid
            {
                return Err(BrokerError::Conflict("pointer-changed-during-read"));
            }
            Ok(PointerObservation {
                identity: identity(&after),
                owner_uid: after.st_uid,
                raw_target,
            })
        }

        pub fn observe_plist(&self, name: &str) -> Result<PlistObservation, BrokerError> {
            validate_name(name)?;
            let name = CString::new(name).map_err(|_| BrokerError::Invalid("plist-name"))?;
            let fd = openat_file_read(self.directory.as_raw_fd(), &name)?;
            let before = fstat(fd.as_raw_fd())?;
            if (before.st_mode & libc::S_IFMT) != libc::S_IFREG
                || before.st_nlink != 1
                || before.st_uid != unsafe { libc::geteuid() }
                || (before.st_mode & 0o022) != 0
                || before.st_size < 0
                || before.st_size as usize > MAX_PLIST_BYTES
            {
                return Err(BrokerError::Conflict("plist-not-bounded-single-link-file"));
            }
            let mut file = File::from(fd);
            let mut bytes = Vec::with_capacity(before.st_size as usize);
            Read::by_ref(&mut file)
                .take((MAX_PLIST_BYTES + 1) as u64)
                .read_to_end(&mut bytes)?;
            if bytes.len() > MAX_PLIST_BYTES {
                return Err(BrokerError::Invalid("plist-too-large"));
            }
            let after = fstat(file.as_raw_fd())?;
            if identity(&before) != identity(&after)
                || before.st_size != after.st_size
                || after.st_nlink != 1
                || before.st_uid != after.st_uid
                || (before.st_mode & 0o777) != (after.st_mode & 0o777)
                || before.st_mtime != after.st_mtime
                || before.st_mtime_nsec != after.st_mtime_nsec
                || before.st_ctime != after.st_ctime
                || before.st_ctime_nsec != after.st_ctime_nsec
            {
                return Err(BrokerError::Conflict("plist-changed-during-read"));
            }
            Ok(PlistObservation {
                identity: identity(&after),
                owner_uid: after.st_uid,
                mode: u32::from(after.st_mode & 0o777),
                byte_length: bytes.len() as u64,
                sha256: sha256_hex(&bytes),
            })
        }

        fn create_symlink(&self, name: &str, target: &str) -> Result<(), BrokerError> {
            validate_name(name)?;
            validate_target(target)?;
            let name = CString::new(name).map_err(|_| BrokerError::Invalid("symlink-name"))?;
            let target =
                CString::new(target).map_err(|_| BrokerError::Invalid("symlink-target"))?;
            let result = unsafe {
                libc::symlinkat(target.as_ptr(), self.directory.as_raw_fd(), name.as_ptr())
            };
            if result != 0 {
                return Err(io::Error::last_os_error().into());
            }
            self.fsync()
        }

        fn create_file(&self, name: &str, bytes: &[u8]) -> Result<(), BrokerError> {
            validate_name(name)?;
            if bytes.len() > MAX_FRAME_BYTES.max(MAX_PLIST_BYTES) {
                return Err(BrokerError::Invalid("file-too-large"));
            }
            let name = CString::new(name).map_err(|_| BrokerError::Invalid("file-name"))?;
            let fd = openat_file_create(self.directory.as_raw_fd(), &name)?;
            let mut file = File::from(fd);
            file.write_all(bytes)?;
            file.sync_all()?;
            drop(file);
            self.fsync()
        }

        fn acquire_lifecycle_lease(&self) -> Result<LifecycleLease, BrokerError> {
            let name = c".ashlr-m569-lifecycle.lock";
            let fd = openat_file_read_write_create(self.directory.as_raw_fd(), name)?;
            let stat = fstat(fd.as_raw_fd())?;
            if (stat.st_mode & libc::S_IFMT) != libc::S_IFREG
                || stat.st_nlink != 1
                || stat.st_uid != unsafe { libc::geteuid() }
                || (stat.st_mode & 0o777) != 0o600
            {
                return Err(BrokerError::Conflict("lifecycle-lock-unsafe"));
            }
            if unsafe { libc::flock(fd.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() == Some(libc::EWOULDBLOCK)
                    || error.raw_os_error() == Some(libc::EAGAIN)
                {
                    return Err(BrokerError::Conflict("lifecycle-lock-busy"));
                }
                return Err(error.into());
            }
            Ok(LifecycleLease {
                _file: File::from(fd),
                identity: identity(&stat),
            })
        }

        fn create_file_atomic_exclusive(
            &self,
            name: &str,
            bytes: &[u8],
        ) -> Result<(), BrokerError> {
            let pending = pending_name(name)?;
            self.create_file(&pending, bytes)?;
            self.rename_exclusive(&pending, name)
        }

        fn read_file(&self, name: &str, limit: usize) -> Result<Vec<u8>, BrokerError> {
            validate_name(name)?;
            let name = CString::new(name).map_err(|_| BrokerError::Invalid("file-name"))?;
            let fd = openat_file_read(self.directory.as_raw_fd(), &name)?;
            let stat = fstat(fd.as_raw_fd())?;
            if (stat.st_mode & libc::S_IFMT) != libc::S_IFREG
                || stat.st_nlink != 1
                || stat.st_uid != unsafe { libc::geteuid() }
                || (stat.st_mode & 0o777) != 0o600
                || stat.st_size < 0
                || stat.st_size as usize > limit
            {
                return Err(BrokerError::Conflict(
                    "journal-not-bounded-single-link-file",
                ));
            }
            let mut file = File::from(fd);
            let mut bytes = Vec::with_capacity(stat.st_size as usize);
            Read::by_ref(&mut file)
                .take((limit + 1) as u64)
                .read_to_end(&mut bytes)?;
            if bytes.len() > limit {
                return Err(BrokerError::Invalid("journal-too-large"));
            }
            let after = fstat(file.as_raw_fd())?;
            if identity(&stat) != identity(&after)
                || stat.st_size != after.st_size
                || stat.st_uid != after.st_uid
                || (stat.st_mode & 0o777) != (after.st_mode & 0o777)
                || stat.st_mtime != after.st_mtime
                || stat.st_mtime_nsec != after.st_mtime_nsec
                || stat.st_ctime != after.st_ctime
                || stat.st_ctime_nsec != after.st_ctime_nsec
            {
                return Err(BrokerError::Conflict("journal-changed-during-read"));
            }
            Ok(bytes)
        }

        fn rename_exclusive(&self, from: &str, to: &str) -> Result<(), BrokerError> {
            validate_name(from)?;
            validate_name(to)?;
            let from = CString::new(from).map_err(|_| BrokerError::Invalid("rename-from"))?;
            let to = CString::new(to).map_err(|_| BrokerError::Invalid("rename-to"))?;
            let result = unsafe {
                libc::renameatx_np(
                    self.directory.as_raw_fd(),
                    from.as_ptr(),
                    self.directory.as_raw_fd(),
                    to.as_ptr(),
                    libc::RENAME_EXCL,
                )
            };
            if result != 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() == Some(libc::EEXIST)
                    || error.raw_os_error() == Some(libc::ENOENT)
                {
                    return Err(BrokerError::Conflict("exclusive-rename-precondition"));
                }
                return Err(error.into());
            }
            self.fsync()
        }

        fn unlink_exact_pointer(
            &self,
            name: &str,
            expected: &PointerObservation,
        ) -> Result<(), BrokerError> {
            if self.observe_pointer(name)? != *expected {
                return Err(BrokerError::ReconciliationRequired(
                    "pointer-identity-drift",
                ));
            }
            self.unlink(name)
        }

        fn unlink_exact_plist(
            &self,
            name: &str,
            expected: &PlistObservation,
        ) -> Result<(), BrokerError> {
            if self.observe_plist(name)? != *expected {
                return Err(BrokerError::ReconciliationRequired("plist-identity-drift"));
            }
            self.unlink(name)
        }

        fn unlink(&self, name: &str) -> Result<(), BrokerError> {
            validate_name(name)?;
            let name = CString::new(name).map_err(|_| BrokerError::Invalid("unlink-name"))?;
            if unsafe { libc::unlinkat(self.directory.as_raw_fd(), name.as_ptr(), 0) } != 0 {
                return Err(io::Error::last_os_error().into());
            }
            self.fsync()
        }

        fn exists(&self, name: &str) -> Result<bool, BrokerError> {
            validate_name(name)?;
            let name = CString::new(name).map_err(|_| BrokerError::Invalid("exists-name"))?;
            match fstatat_nofollow(self.directory.as_raw_fd(), &name) {
                Ok(_) => Ok(true),
                Err(BrokerError::Io(error)) if error.raw_os_error() == Some(libc::ENOENT) => {
                    Ok(false)
                }
                Err(error) => Err(error),
            }
        }

        fn fsync(&self) -> Result<(), BrokerError> {
            if unsafe { libc::fsync(self.directory.as_raw_fd()) } != 0 {
                return Err(io::Error::last_os_error().into());
            }
            Ok(())
        }
    }

    pub fn observe_launchd_stopped(
        uid: u32,
        label: &str,
    ) -> Result<LaunchdStoppedObservation, BrokerError> {
        if uid != unsafe { libc::geteuid() } || label != "ai.ashlr.daemon" {
            return Err(BrokerError::Invalid("launchd-scope"));
        }
        let domain = format!("gui/{uid}");
        let print = run_launchctl(&["print", &format!("{domain}/{label}")])?;
        if !is_exactly_absent(&print, uid, label) {
            return Err(BrokerError::Conflict(
                "launchd-service-not-exactly-unloaded",
            ));
        }
        let disabled = run_launchctl(&["print-disabled", &domain])?;
        if disabled.status != 0 || !disabled.stderr.trim().is_empty() {
            return Err(BrokerError::Conflict("launchd-disabled-state-unavailable"));
        }
        let disabled = parse_disabled_state(&disabled.stdout, label)?;
        let confirm = run_launchctl(&["print", &format!("{domain}/{label}")])?;
        if !is_exactly_absent(&confirm, uid, label) {
            return Err(BrokerError::Conflict(
                "launchd-service-raced-stopped-observation",
            ));
        }
        Ok(LaunchdStoppedObservation {
            uid,
            label: label.to_owned(),
            loaded: false,
            disabled,
            job_generation: None,
        })
    }

    struct CommandOutput {
        status: i32,
        stdout: String,
        stderr: String,
    }

    fn is_exactly_absent(output: &CommandOutput, uid: u32, label: &str) -> bool {
        if output.status != 113
            || !output.stdout.is_empty()
            || output.stderr.as_bytes().contains(&0)
        {
            return false;
        }
        let normalized = output.stderr.replace("\r\n", "\n");
        if normalized.contains('\r') {
            return false;
        }
        let normalized = normalized.strip_suffix('\n').unwrap_or(&normalized);
        let exact = format!("Could not find service \"{label}\" in domain for user gui: {uid}");
        normalized == exact || normalized == format!("Bad request.\n{exact}")
    }

    fn run_launchctl(arguments: &[&str]) -> Result<CommandOutput, BrokerError> {
        let mut child = Command::new("/bin/launchctl")
            .args(arguments)
            .env_clear()
            .env("LC_ALL", "C")
            .env("LANG", "C")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        let stdout = child
            .stdout
            .take()
            .ok_or(BrokerError::Invalid("launchctl-stdout"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or(BrokerError::Invalid("launchctl-stderr"))?;
        let stdout_reader = thread::spawn(move || read_bounded(stdout, MAX_LAUNCHCTL_BYTES));
        let stderr_reader = thread::spawn(move || read_bounded(stderr, MAX_LAUNCHCTL_BYTES));
        let deadline = Instant::now() + LAUNCHCTL_TIMEOUT;
        let status = loop {
            if let Some(status) = child.try_wait()? {
                break status.code().unwrap_or(-1);
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                return Err(BrokerError::Conflict("launchctl-timeout"));
            }
            thread::sleep(Duration::from_millis(10));
        };
        let stdout = stdout_reader
            .join()
            .map_err(|_| BrokerError::Conflict("launchctl-reader-panicked"))??;
        let stderr = stderr_reader
            .join()
            .map_err(|_| BrokerError::Conflict("launchctl-reader-panicked"))??;
        Ok(CommandOutput {
            status,
            stdout,
            stderr,
        })
    }

    fn read_bounded(reader: impl Read, limit: usize) -> Result<String, BrokerError> {
        let mut output = Vec::new();
        reader.take((limit + 1) as u64).read_to_end(&mut output)?;
        if output.len() > limit {
            return Err(BrokerError::Conflict("launchctl-output-too-large"));
        }
        String::from_utf8(output).map_err(|_| BrokerError::Invalid("launchctl-output-utf8"))
    }

    fn parse_disabled_state(stdout: &str, label: &str) -> Result<bool, BrokerError> {
        let marker = format!("\"{label}\"");
        let matches: Vec<&str> = stdout
            .lines()
            .filter(|line| line.contains(&marker))
            .collect();
        if matches.len() != 1 {
            return Err(BrokerError::Conflict("launchd-disabled-state-ambiguous"));
        }
        let line = matches[0].trim();
        if line == format!("{marker} => disabled") {
            Ok(true)
        } else if line == format!("{marker} => enabled") {
            Ok(false)
        } else {
            Err(BrokerError::Conflict("launchd-disabled-state-invalid"))
        }
    }

    #[allow(dead_code)]
    fn run_claim_and_verify_foundation_with_native_stopped_guard(
        authenticated_request: &[u8],
        keys: &BrokerKeys<'_>,
        candidate_plist: &[u8],
    ) -> Result<Vec<u8>, BrokerError> {
        let request =
            decode_authenticated_request(authenticated_request, keys.request_verification)?;
        let mut observer =
            |_: u32, _: &str| observe_launchd_stopped(request.stopped.uid, &request.stopped.label);
        let mut after_staging_create = |_: &CustodyRoot, _: &str, _: &CustodyRoot, _: &str| Ok(());
        run_claim_and_verify_foundation_inner(
            authenticated_request,
            keys,
            candidate_plist,
            None,
            &mut observer,
            &mut after_staging_create,
        )
    }

    fn run_claim_and_verify_foundation_inner(
        authenticated_request: &[u8],
        keys: &BrokerKeys<'_>,
        candidate_plist: &[u8],
        crash_after: Option<u8>,
        observe_stopped: &mut dyn FnMut(
            u32,
            &str,
        ) -> Result<LaunchdStoppedObservation, BrokerError>,
        after_staging_create: &mut StagingHook<'_>,
    ) -> Result<Vec<u8>, BrokerError> {
        keys.validate()?;
        let request =
            decode_authenticated_request(authenticated_request, keys.request_verification)?;
        if sha256_hex(candidate_plist) != request.candidate_plist_sha256 {
            return Err(BrokerError::Invalid("candidate-plist-digest"));
        }
        if request.stopped.loaded || request.stopped.job_generation.is_some() {
            return Err(BrokerError::Invalid("launchd-not-stopped"));
        }
        if observe_stopped(request.stopped.uid, &request.stopped.label)? != request.stopped {
            return Err(BrokerError::Conflict("launchd-pre-state-mismatch"));
        }
        let pointer_root = CustodyRoot::open(Path::new(&request.pointer_parent))?;
        let plist_root = CustodyRoot::open(Path::new(&request.plist_parent))?;
        let journal_root = CustodyRoot::open_private(Path::new(&request.journal_parent))?;
        if pointer_root.canonical_path() != request.pointer_parent
            || plist_root.canonical_path() != request.plist_parent
            || journal_root.canonical_path() != request.journal_parent
        {
            return Err(BrokerError::Invalid("custody-root-spelling"));
        }
        if pointer_root.identity() == plist_root.identity()
            || pointer_root.identity() == journal_root.identity()
            || plist_root.identity() == journal_root.identity()
        {
            return Err(BrokerError::Conflict("custody-root-identity-alias"));
        }
        if journal_root.exists("runtime-activation-stopped-consumer.journal.json")? {
            return Err(BrokerError::ReconciliationRequired(
                "legacy-stopped-selection-journal-present",
            ));
        }
        // Non-blocking leases avoid deadlock if malformed requests reverse role
        // ordering: one contender refuses and releases all leases it acquired.
        let pointer_lease = pointer_root.acquire_lifecycle_lease()?;
        let plist_lease = plist_root.acquire_lifecycle_lease()?;
        let journal_lease = journal_root.acquire_lifecycle_lease()?;
        let prefix = format!(".ashlr-m569-{}", request.transaction_id);
        if transaction_artifact_exists(
            &pointer_root,
            &plist_root,
            &journal_root,
            &request.transaction_id,
            &prefix,
        )? {
            return Err(BrokerError::ReconciliationRequired(
                "transaction-id-artifact-present",
            ));
        }
        if pointer_root.observe_pointer(&request.pointer_name)? != request.expected_pointer
            || plist_root.observe_plist(&request.plist_name)? != request.expected_plist
        {
            return Err(BrokerError::Conflict("initial-state"));
        }
        let active = ActiveTransaction {
            protocol: PROTOCOL.to_owned(),
            transaction_id: request.transaction_id.clone(),
        };
        let active_frame =
            encode_authenticated(&active, keys.journal_authentication, JOURNAL_DOMAIN)?;
        let active_name = active_name();
        if journal_root.exists(active_name)? || journal_root.exists(&pending_name(active_name)?)? {
            return Err(BrokerError::ReconciliationRequired(
                "unfinished-native-selection-present",
            ));
        }
        journal_root.create_file_atomic_exclusive(active_name, &active_frame)?;
        let active_marker = journal_root.observe_plist(active_name)?;
        injected(crash_after, 9)?;
        let request_sha256 = sha256_hex(authenticated_request);
        let intent = JournalIntent {
            request_sha256,
            transaction_id: request.transaction_id.clone(),
            pointer_parent: request.pointer_parent.clone(),
            plist_parent: request.plist_parent.clone(),
            journal_parent: request.journal_parent.clone(),
            pointer_root_identity: pointer_root.identity().clone(),
            plist_root_identity: plist_root.identity().clone(),
            journal_root_identity: journal_root.identity().clone(),
            pointer_lease_identity: pointer_lease.identity.clone(),
            plist_lease_identity: plist_lease.identity.clone(),
            journal_lease_identity: journal_lease.identity.clone(),
            active_marker,
            pointer_name: request.pointer_name.clone(),
            plist_name: request.plist_name.clone(),
            pointer_temp: format!("{prefix}-pointer-new"),
            pointer_backup: format!("{prefix}-pointer-old"),
            plist_temp: format!("{prefix}-plist-new"),
            plist_backup: format!("{prefix}-plist-old"),
            expected_pointer: request.expected_pointer.clone(),
            expected_plist: request.expected_plist.clone(),
            candidate_pointer_target: request.candidate_pointer_target.clone(),
            candidate_plist_sha256: request.candidate_plist_sha256.clone(),
            stopped: request.stopped.clone(),
        };
        let mut record = JournalRecord {
            protocol: PROTOCOL.to_owned(),
            transaction_id: intent.transaction_id.clone(),
            sequence: 0,
            phase: JournalPhase::Intent,
            predecessor_sha256: None,
            intent,
            staged_pointer: None,
            staged_plist: None,
        };
        write_journal(&journal_root, &record, keys.journal_authentication)?;
        injected(crash_after, 0)?;

        pointer_root.create_symlink(
            &record.intent.pointer_temp,
            &record.intent.candidate_pointer_target,
        )?;
        plist_root.create_file(&record.intent.plist_temp, candidate_plist)?;
        after_staging_create(
            &pointer_root,
            &record.intent.pointer_temp,
            &plist_root,
            &record.intent.plist_temp,
        )?;
        let predecessor = journal_digest(&record)?;
        let staged_pointer = pointer_root.observe_pointer(&record.intent.pointer_temp)?;
        if staged_pointer.raw_target != record.intent.candidate_pointer_target {
            return Err(BrokerError::Conflict("staged-pointer-candidate-mismatch"));
        }
        let staged_plist = plist_root.observe_plist(&record.intent.plist_temp)?;
        if staged_plist.sha256 != record.intent.candidate_plist_sha256
            || staged_plist.byte_length != candidate_plist.len() as u64
            || staged_plist.mode != 0o600
        {
            return Err(BrokerError::Conflict("staged-plist-candidate-mismatch"));
        }
        record.staged_pointer = Some(staged_pointer);
        record.staged_plist = Some(staged_plist);
        record.sequence = 1;
        record.phase = JournalPhase::Staged;
        record.predecessor_sha256 = Some(predecessor);
        write_journal(&journal_root, &record, keys.journal_authentication)?;
        injected(crash_after, 1)?;
        if observe_stopped(request.stopped.uid, &request.stopped.label)? != request.stopped {
            return Err(BrokerError::Conflict("launchd-pre-mutation-state-mismatch"));
        }

        pointer_root
            .rename_exclusive(&record.intent.pointer_name, &record.intent.pointer_backup)?;
        if pointer_root.observe_pointer(&record.intent.pointer_backup)?
            != record.intent.expected_pointer
        {
            return Err(BrokerError::ReconciliationRequired(
                "claimed-pointer-mismatch",
            ));
        }
        injected(crash_after, 2)?;
        advance(
            &journal_root,
            &mut record,
            JournalPhase::PointerClaimed,
            keys.journal_authentication,
        )?;
        pointer_root.rename_exclusive(&record.intent.pointer_temp, &record.intent.pointer_name)?;
        let staged_pointer =
            record
                .staged_pointer
                .as_ref()
                .ok_or(BrokerError::ReconciliationRequired(
                    "staged-pointer-observation-missing",
                ))?;
        if pointer_root.observe_pointer(&record.intent.pointer_name)? != *staged_pointer {
            return Err(BrokerError::ReconciliationRequired(
                "installed-pointer-mismatch",
            ));
        }
        advance(
            &journal_root,
            &mut record,
            JournalPhase::PointerInstalled,
            keys.journal_authentication,
        )?;
        injected(crash_after, 3)?;

        plist_root.rename_exclusive(&record.intent.plist_name, &record.intent.plist_backup)?;
        if plist_root.observe_plist(&record.intent.plist_backup)? != record.intent.expected_plist {
            return Err(BrokerError::ReconciliationRequired(
                "claimed-plist-mismatch",
            ));
        }
        injected(crash_after, 4)?;
        advance(
            &journal_root,
            &mut record,
            JournalPhase::PlistClaimed,
            keys.journal_authentication,
        )?;
        plist_root.rename_exclusive(&record.intent.plist_temp, &record.intent.plist_name)?;
        let staged_plist =
            record
                .staged_plist
                .as_ref()
                .ok_or(BrokerError::ReconciliationRequired(
                    "staged-plist-observation-missing",
                ))?;
        if plist_root.observe_plist(&record.intent.plist_name)? != *staged_plist {
            return Err(BrokerError::ReconciliationRequired(
                "installed-plist-mismatch",
            ));
        }
        advance(
            &journal_root,
            &mut record,
            JournalPhase::PlistInstalled,
            keys.journal_authentication,
        )?;
        injected(crash_after, 5)?;
        verify_new_state(&pointer_root, &plist_root, &record)?;
        if observe_stopped(request.stopped.uid, &request.stopped.label)? != request.stopped {
            return Err(BrokerError::ReconciliationRequired(
                "launchd-post-state-mismatch",
            ));
        }
        let receipt = receipt_from_record(&record, "foundation-claim-and-verify-only")?;
        let frame = encode_authenticated_receipt(&receipt, keys.receipt_authentication)?;
        let receipt_name = receipt_name(&record.intent.transaction_id);
        journal_root.create_file_atomic_exclusive(&receipt_name, &frame)?;
        injected(crash_after, 6)?;
        advance(
            &journal_root,
            &mut record,
            JournalPhase::ReceiptPersisted,
            keys.journal_authentication,
        )?;
        injected(crash_after, 7)?;
        if observe_stopped(request.stopped.uid, &request.stopped.label)? != request.stopped {
            return Err(BrokerError::ReconciliationRequired(
                "launchd-receipt-state-mismatch",
            ));
        }
        advance(
            &journal_root,
            &mut record,
            JournalPhase::Committed,
            keys.journal_authentication,
        )?;
        injected(crash_after, 8)?;
        remove_active_marker(&journal_root, &record)?;
        Ok(frame)
    }

    #[allow(dead_code)]
    fn recover_claim_and_verify_foundation_with_native_stopped_guard(
        journal_parent: &Path,
        transaction_id: &str,
        keys: &BrokerKeys<'_>,
    ) -> Result<RecoveryOutcome, BrokerError> {
        let mut observer = |uid: u32, label: &str| observe_launchd_stopped(uid, label);
        recover_claim_and_verify_foundation_inner(
            journal_parent,
            transaction_id,
            keys,
            &mut observer,
        )
    }

    fn recover_claim_and_verify_foundation_inner(
        journal_parent: &Path,
        transaction_id: &str,
        keys: &BrokerKeys<'_>,
        observe_stopped: &mut dyn FnMut(
            u32,
            &str,
        ) -> Result<LaunchdStoppedObservation, BrokerError>,
    ) -> Result<RecoveryOutcome, BrokerError> {
        keys.validate()?;
        validate_token(transaction_id, 32, 64, true)?;
        let journal_root = CustodyRoot::open_private(journal_parent)?;
        let journal_lease = journal_root.acquire_lifecycle_lease()?;
        let active = read_active_marker(&journal_root, keys.journal_authentication)?;
        let phase_zero = journal_name(transaction_id, 0);
        if !journal_root.exists(&phase_zero)?
            && !journal_root.exists(&pending_name(&phase_zero)?)?
        {
            if later_transaction_artifact_exists(&journal_root, transaction_id)? {
                return Err(BrokerError::ReconciliationRequired(
                    "phase-zero-missing-with-later-artifact",
                ));
            }
            if let Some((active, observation)) = active.as_ref() {
                if active.transaction_id != transaction_id {
                    return Err(BrokerError::ReconciliationRequired(
                        "different-native-selection-is-active",
                    ));
                }
                journal_root.unlink_exact_plist(active_name(), observation)?;
                return Ok(RecoveryOutcome::RolledBack);
            }
            return Err(BrokerError::Conflict("journal-missing"));
        }
        let mut record =
            read_latest_journal(&journal_root, transaction_id, keys.journal_authentication)?;
        if record.intent.journal_parent != journal_root.canonical_path() {
            return Err(BrokerError::Authentication);
        }
        if let Some((active, observation)) = active.as_ref() {
            if active.transaction_id != transaction_id
                || observation != &record.intent.active_marker
            {
                return Err(BrokerError::ReconciliationRequired(
                    "different-native-selection-is-active",
                ));
            }
        } else if !matches!(
            record.phase,
            JournalPhase::Committed | JournalPhase::RolledBack
        ) {
            return Err(BrokerError::ReconciliationRequired(
                "active-transaction-marker-missing",
            ));
        }
        let pointer_root = CustodyRoot::open(Path::new(&record.intent.pointer_parent))?;
        let plist_root = CustodyRoot::open(Path::new(&record.intent.plist_parent))?;
        let pointer_lease = pointer_root.acquire_lifecycle_lease()?;
        let plist_lease = plist_root.acquire_lifecycle_lease()?;
        if pointer_root.identity() != &record.intent.pointer_root_identity
            || plist_root.identity() != &record.intent.plist_root_identity
            || journal_root.identity() != &record.intent.journal_root_identity
            || pointer_lease.identity != record.intent.pointer_lease_identity
            || plist_lease.identity != record.intent.plist_lease_identity
            || journal_lease.identity != record.intent.journal_lease_identity
        {
            return Err(BrokerError::ReconciliationRequired("custody-root-rebound"));
        }
        if observe_stopped(record.intent.stopped.uid, &record.intent.stopped.label)?
            != record.intent.stopped
        {
            return Err(BrokerError::ReconciliationRequired(
                "launchd-recovery-state-mismatch",
            ));
        }
        if record.phase == JournalPhase::PlistInstalled
            && receipt_artifact_exists(&journal_root, transaction_id)?
        {
            verify_new_state(&pointer_root, &plist_root, &record)?;
            let receipt = read_exact_receipt(&journal_root, &record, keys.receipt_authentication)?;
            advance(
                &journal_root,
                &mut record,
                JournalPhase::ReceiptPersisted,
                keys.journal_authentication,
            )?;
            advance(
                &journal_root,
                &mut record,
                JournalPhase::Committed,
                keys.journal_authentication,
            )?;
            if observe_stopped(record.intent.stopped.uid, &record.intent.stopped.label)?
                != record.intent.stopped
            {
                return Err(BrokerError::ReconciliationRequired(
                    "launchd-recovery-settlement-raced",
                ));
            }
            remove_active_marker(&journal_root, &record)?;
            return Ok(RecoveryOutcome::Committed(Box::new(receipt)));
        }
        if matches!(
            record.phase,
            JournalPhase::ReceiptPersisted | JournalPhase::Committed
        ) {
            verify_new_state(&pointer_root, &plist_root, &record)?;
            let receipt = read_exact_receipt(&journal_root, &record, keys.receipt_authentication)?;
            if record.phase == JournalPhase::ReceiptPersisted {
                advance(
                    &journal_root,
                    &mut record,
                    JournalPhase::Committed,
                    keys.journal_authentication,
                )?;
            }
            if observe_stopped(record.intent.stopped.uid, &record.intent.stopped.label)?
                != record.intent.stopped
            {
                return Err(BrokerError::ReconciliationRequired(
                    "launchd-recovery-settlement-raced",
                ));
            }
            remove_active_marker(&journal_root, &record)?;
            return Ok(RecoveryOutcome::Committed(Box::new(receipt)));
        }
        if record.phase == JournalPhase::RolledBack {
            verify_old_state(&pointer_root, &plist_root, &record)?;
            if observe_stopped(record.intent.stopped.uid, &record.intent.stopped.label)?
                != record.intent.stopped
            {
                return Err(BrokerError::ReconciliationRequired(
                    "launchd-rollback-state-raced",
                ));
            }
            remove_active_marker(&journal_root, &record)?;
            return Ok(RecoveryOutcome::RolledBack);
        }
        rollback_pointer(&pointer_root, &record)?;
        rollback_plist(&plist_root, &record)?;
        remove_exact_temp_objects(&pointer_root, &plist_root, &record)?;
        verify_old_state(&pointer_root, &plist_root, &record)?;
        advance(
            &journal_root,
            &mut record,
            JournalPhase::RolledBack,
            keys.journal_authentication,
        )?;
        if observe_stopped(record.intent.stopped.uid, &record.intent.stopped.label)?
            != record.intent.stopped
        {
            return Err(BrokerError::ReconciliationRequired(
                "launchd-rollback-state-raced",
            ));
        }
        remove_active_marker(&journal_root, &record)?;
        Ok(RecoveryOutcome::RolledBack)
    }

    fn verify_new_state(
        pointer_root: &CustodyRoot,
        plist_root: &CustodyRoot,
        record: &JournalRecord,
    ) -> Result<(), BrokerError> {
        let expected_pointer =
            record
                .staged_pointer
                .as_ref()
                .ok_or(BrokerError::ReconciliationRequired(
                    "committed-pointer-missing",
                ))?;
        let expected_plist =
            record
                .staged_plist
                .as_ref()
                .ok_or(BrokerError::ReconciliationRequired(
                    "committed-plist-missing",
                ))?;
        if pointer_root.observe_pointer(&record.intent.pointer_name)? != *expected_pointer
            || plist_root.observe_plist(&record.intent.plist_name)? != *expected_plist
        {
            return Err(BrokerError::ReconciliationRequired("committed-state-drift"));
        }
        Ok(())
    }

    fn verify_old_state(
        pointer_root: &CustodyRoot,
        plist_root: &CustodyRoot,
        record: &JournalRecord,
    ) -> Result<(), BrokerError> {
        if pointer_root.observe_pointer(&record.intent.pointer_name)?
            != record.intent.expected_pointer
            || plist_root.observe_plist(&record.intent.plist_name)? != record.intent.expected_plist
        {
            return Err(BrokerError::ReconciliationRequired("rollback-state-drift"));
        }
        Ok(())
    }

    fn rollback_pointer(root: &CustodyRoot, record: &JournalRecord) -> Result<(), BrokerError> {
        let intent = &record.intent;
        let current_exists = root.exists(&intent.pointer_name)?;
        let backup_exists = root.exists(&intent.pointer_backup)?;
        if backup_exists {
            if root.observe_pointer(&intent.pointer_backup)? != intent.expected_pointer {
                return Err(BrokerError::ReconciliationRequired("pointer-backup-drift"));
            }
            if current_exists {
                let current = root.observe_pointer(&intent.pointer_name)?;
                if Some(&current) != record.staged_pointer.as_ref() {
                    return Err(BrokerError::ReconciliationRequired("pointer-current-drift"));
                }
                root.unlink_exact_pointer(&intent.pointer_name, &current)?;
            }
            root.rename_exclusive(&intent.pointer_backup, &intent.pointer_name)?;
        } else if !current_exists
            || root.observe_pointer(&intent.pointer_name)? != intent.expected_pointer
        {
            return Err(BrokerError::ReconciliationRequired(
                "pointer-old-state-unavailable",
            ));
        }
        Ok(())
    }

    fn rollback_plist(root: &CustodyRoot, record: &JournalRecord) -> Result<(), BrokerError> {
        let intent = &record.intent;
        let current_exists = root.exists(&intent.plist_name)?;
        let backup_exists = root.exists(&intent.plist_backup)?;
        if backup_exists {
            if root.observe_plist(&intent.plist_backup)? != intent.expected_plist {
                return Err(BrokerError::ReconciliationRequired("plist-backup-drift"));
            }
            if current_exists {
                let current = root.observe_plist(&intent.plist_name)?;
                if Some(&current) != record.staged_plist.as_ref() {
                    return Err(BrokerError::ReconciliationRequired("plist-current-drift"));
                }
                root.unlink_exact_plist(&intent.plist_name, &current)?;
            }
            root.rename_exclusive(&intent.plist_backup, &intent.plist_name)?;
        } else if !current_exists
            || root.observe_plist(&intent.plist_name)? != intent.expected_plist
        {
            return Err(BrokerError::ReconciliationRequired(
                "plist-old-state-unavailable",
            ));
        }
        Ok(())
    }

    fn remove_exact_temp_objects(
        pointer_root: &CustodyRoot,
        plist_root: &CustodyRoot,
        record: &JournalRecord,
    ) -> Result<(), BrokerError> {
        if pointer_root.exists(&record.intent.pointer_temp)? {
            let observed = pointer_root.observe_pointer(&record.intent.pointer_temp)?;
            if Some(&observed) != record.staged_pointer.as_ref() {
                return Err(BrokerError::ReconciliationRequired("pointer-temp-drift"));
            }
            pointer_root.unlink_exact_pointer(&record.intent.pointer_temp, &observed)?;
        }
        if plist_root.exists(&record.intent.plist_temp)? {
            let observed = plist_root.observe_plist(&record.intent.plist_temp)?;
            if Some(&observed) != record.staged_plist.as_ref() {
                return Err(BrokerError::ReconciliationRequired("plist-temp-drift"));
            }
            plist_root.unlink_exact_plist(&record.intent.plist_temp, &observed)?;
        }
        Ok(())
    }

    fn receipt_from_record(
        record: &JournalRecord,
        outcome: &str,
    ) -> Result<BrokerReceipt, BrokerError> {
        Ok(BrokerReceipt {
            protocol: PROTOCOL.to_owned(),
            transaction_id: record.intent.transaction_id.clone(),
            request_sha256: record.intent.request_sha256.clone(),
            outcome: outcome.to_owned(),
            pointer: record
                .staged_pointer
                .clone()
                .ok_or(BrokerError::ReconciliationRequired(
                    "receipt-pointer-missing",
                ))?,
            plist: record
                .staged_plist
                .clone()
                .ok_or(BrokerError::ReconciliationRequired("receipt-plist-missing"))?,
            stopped: record.intent.stopped.clone(),
            service_started: false,
            service_enabled: false,
            dispatch_authorized: false,
            provider_effects_unblocked: false,
            protected_broker_verified: false,
            native_conditional_cas_verified: false,
            external_replay_consumed: false,
            activation_authorized: false,
        })
    }

    fn receipt_name(transaction_id: &str) -> String {
        format!(".ashlr-m569-{transaction_id}-receipt.json")
    }

    fn active_name() -> &'static str {
        ".ashlr-m569-active.json"
    }

    fn read_active_marker(
        root: &CustodyRoot,
        key: &[u8],
    ) -> Result<Option<(ActiveTransaction, PlistObservation)>, BrokerError> {
        let name = active_name();
        let pending = pending_name(name)?;
        if root.exists(&pending)? {
            if root.exists(name)? {
                return Err(BrokerError::ReconciliationRequired(
                    "active-final-and-pending-conflict",
                ));
            }
            let bytes = root.read_file(&pending, MAX_FRAME_BYTES)?;
            let active: ActiveTransaction = decode_authenticated(&bytes, key, JOURNAL_DOMAIN)?;
            if active.protocol != PROTOCOL {
                return Err(BrokerError::Authentication);
            }
            root.rename_exclusive(&pending, name)?;
        }
        if !root.exists(name)? {
            return Ok(None);
        }
        let bytes = root.read_file(name, MAX_FRAME_BYTES)?;
        let active: ActiveTransaction = decode_authenticated(&bytes, key, JOURNAL_DOMAIN)?;
        if active.protocol != PROTOCOL {
            return Err(BrokerError::Authentication);
        }
        Ok(Some((active, root.observe_plist(name)?)))
    }

    fn remove_active_marker(root: &CustodyRoot, record: &JournalRecord) -> Result<(), BrokerError> {
        if !root.exists(active_name())? {
            return Ok(());
        }
        root.unlink_exact_plist(active_name(), &record.intent.active_marker)
    }

    fn receipt_artifact_exists(
        root: &CustodyRoot,
        transaction_id: &str,
    ) -> Result<bool, BrokerError> {
        let name = receipt_name(transaction_id);
        Ok(root.exists(&name)? || root.exists(&pending_name(&name)?)?)
    }

    fn transaction_artifact_exists(
        pointer_root: &CustodyRoot,
        plist_root: &CustodyRoot,
        journal_root: &CustodyRoot,
        transaction_id: &str,
        prefix: &str,
    ) -> Result<bool, BrokerError> {
        for name in [
            format!("{prefix}-pointer-new"),
            format!("{prefix}-pointer-old"),
        ] {
            if pointer_root.exists(&name)? {
                return Ok(true);
            }
        }
        for name in [format!("{prefix}-plist-new"), format!("{prefix}-plist-old")] {
            if plist_root.exists(&name)? {
                return Ok(true);
            }
        }
        for sequence in 0..=99 {
            let name = journal_name(transaction_id, sequence);
            if journal_root.exists(&name)? || journal_root.exists(&pending_name(&name)?)? {
                return Ok(true);
            }
        }
        receipt_artifact_exists(journal_root, transaction_id)
    }

    fn later_transaction_artifact_exists(
        root: &CustodyRoot,
        transaction_id: &str,
    ) -> Result<bool, BrokerError> {
        for sequence in 1..=99 {
            let name = journal_name(transaction_id, sequence);
            if root.exists(&name)? || root.exists(&pending_name(&name)?)? {
                return Ok(true);
            }
        }
        receipt_artifact_exists(root, transaction_id)
    }

    fn read_exact_receipt(
        root: &CustodyRoot,
        record: &JournalRecord,
        key: &[u8],
    ) -> Result<BrokerReceipt, BrokerError> {
        let name = receipt_name(&record.intent.transaction_id);
        let pending = pending_name(&name)?;
        if root.exists(&pending)? {
            if root.exists(&name)? {
                return Err(BrokerError::ReconciliationRequired(
                    "receipt-final-and-pending-conflict",
                ));
            }
            let bytes = root.read_file(&pending, MAX_FRAME_BYTES)?;
            let observed = decode_authenticated_receipt(&bytes, key)?;
            if observed != receipt_from_record(record, "foundation-claim-and-verify-only")? {
                return Err(BrokerError::Authentication);
            }
            root.rename_exclusive(&pending, &name)?;
        }
        let bytes = root.read_file(&name, MAX_FRAME_BYTES)?;
        let observed = decode_authenticated_receipt(&bytes, key)?;
        if observed != receipt_from_record(record, "foundation-claim-and-verify-only")? {
            return Err(BrokerError::Authentication);
        }
        Ok(observed)
    }

    fn advance(
        root: &CustodyRoot,
        record: &mut JournalRecord,
        phase: JournalPhase,
        key: &[u8],
    ) -> Result<(), BrokerError> {
        let predecessor = journal_digest(record)?;
        record.sequence = record
            .sequence
            .checked_add(1)
            .ok_or(BrokerError::Invalid("journal-sequence"))?;
        record.phase = phase;
        record.predecessor_sha256 = Some(predecessor);
        write_journal(root, record, key)
    }

    fn journal_name(transaction_id: &str, sequence: u8) -> String {
        format!(".ashlr-m569-{transaction_id}-phase-{sequence:02}.json")
    }

    fn pending_name(name: &str) -> Result<String, BrokerError> {
        let pending = format!("{name}.pending");
        validate_name(&pending)?;
        Ok(pending)
    }

    fn write_journal(
        root: &CustodyRoot,
        record: &JournalRecord,
        key: &[u8],
    ) -> Result<(), BrokerError> {
        require_key(key)?;
        let payload = serde_json::to_vec(record)?;
        let authenticated = Authenticated {
            payload: record.clone(),
            mac_hex: mac_hex(key, JOURNAL_DOMAIN, &payload)?,
        };
        let mut bytes = serde_json::to_vec(&authenticated)?;
        bytes.push(b'\n');
        root.create_file_atomic_exclusive(
            &journal_name(&record.transaction_id, record.sequence),
            &bytes,
        )
    }

    fn read_latest_journal(
        root: &CustodyRoot,
        transaction_id: &str,
        key: &[u8],
    ) -> Result<JournalRecord, BrokerError> {
        let mut latest: Option<JournalRecord> = None;
        let mut gap = false;
        for sequence in 0..JOURNAL_PHASES {
            let name = journal_name(transaction_id, sequence as u8);
            settle_pending_journal(root, &name, transaction_id, sequence as u8, key)?;
            if !root.exists(&name)? {
                gap = true;
                continue;
            }
            if gap {
                return Err(BrokerError::ReconciliationRequired("journal-sequence-gap"));
            }
            let bytes = root.read_file(&name, MAX_FRAME_BYTES)?;
            let record: JournalRecord = decode_authenticated(&bytes, key, JOURNAL_DOMAIN)?;
            if record.protocol != PROTOCOL
                || record.transaction_id != transaction_id
                || record.sequence != sequence as u8
            {
                return Err(BrokerError::Authentication);
            }
            if let Some(previous) = latest.as_ref() {
                if record.predecessor_sha256.as_deref() != Some(&journal_digest(previous)?) {
                    return Err(BrokerError::Authentication);
                }
                if !valid_phase_transition(&previous.phase, &record.phase) {
                    return Err(BrokerError::Authentication);
                }
            } else if record.predecessor_sha256.is_some() || record.phase != JournalPhase::Intent {
                return Err(BrokerError::Authentication);
            }
            latest = Some(record);
        }
        for sequence in JOURNAL_PHASES..=99 {
            let name = journal_name(transaction_id, sequence as u8);
            if root.exists(&name)? || root.exists(&pending_name(&name)?)? {
                return Err(BrokerError::ReconciliationRequired("journal-sequence-tail"));
            }
        }
        latest.ok_or(BrokerError::Conflict("journal-missing"))
    }

    fn settle_pending_journal(
        root: &CustodyRoot,
        final_name: &str,
        transaction_id: &str,
        sequence: u8,
        key: &[u8],
    ) -> Result<(), BrokerError> {
        let pending = pending_name(final_name)?;
        if !root.exists(&pending)? {
            return Ok(());
        }
        if root.exists(final_name)? {
            return Err(BrokerError::ReconciliationRequired(
                "journal-final-and-pending-conflict",
            ));
        }
        let bytes = root.read_file(&pending, MAX_FRAME_BYTES)?;
        let record: JournalRecord = decode_authenticated(&bytes, key, JOURNAL_DOMAIN)?;
        if record.transaction_id != transaction_id || record.sequence != sequence {
            return Err(BrokerError::Authentication);
        }
        root.rename_exclusive(&pending, final_name)
    }

    fn valid_phase_transition(previous: &JournalPhase, current: &JournalPhase) -> bool {
        matches!(
            (previous, current),
            (JournalPhase::Intent, JournalPhase::Staged)
                | (JournalPhase::Staged, JournalPhase::PointerClaimed)
                | (JournalPhase::PointerClaimed, JournalPhase::PointerInstalled)
                | (JournalPhase::PointerInstalled, JournalPhase::PlistClaimed)
                | (JournalPhase::PlistClaimed, JournalPhase::PlistInstalled)
                | (JournalPhase::PlistInstalled, JournalPhase::ReceiptPersisted)
                | (JournalPhase::ReceiptPersisted, JournalPhase::Committed)
                | (JournalPhase::Intent, JournalPhase::RolledBack)
                | (JournalPhase::Staged, JournalPhase::RolledBack)
                | (JournalPhase::PointerClaimed, JournalPhase::RolledBack)
                | (JournalPhase::PointerInstalled, JournalPhase::RolledBack)
                | (JournalPhase::PlistClaimed, JournalPhase::RolledBack)
                | (JournalPhase::PlistInstalled, JournalPhase::RolledBack)
        )
    }

    fn journal_digest(record: &JournalRecord) -> Result<String, BrokerError> {
        Ok(sha256_hex(&serde_json::to_vec(record)?))
    }

    fn injected(crash_after: Option<u8>, point: u8) -> Result<(), BrokerError> {
        if crash_after == Some(point) {
            return Err(BrokerError::Conflict("injected-crash"));
        }
        Ok(())
    }

    fn identity(stat: &libc::stat) -> ObjectIdentity {
        ObjectIdentity {
            device: stat.st_dev.to_string(),
            inode: stat.st_ino.to_string(),
        }
    }

    fn cstring(value: &OsStr) -> Result<CString, BrokerError> {
        CString::new(value.as_bytes()).map_err(|_| BrokerError::Invalid("path-nul"))
    }

    fn open_directory(path: &CStr) -> Result<OwnedFd, BrokerError> {
        let fd = unsafe {
            libc::open(
                path.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        owned_fd(fd)
    }

    fn openat_directory(parent: RawFd, name: &CStr) -> Result<OwnedFd, BrokerError> {
        let fd = unsafe {
            libc::openat(
                parent,
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        owned_fd(fd)
    }

    fn openat_file_read(parent: RawFd, name: &CStr) -> Result<OwnedFd, BrokerError> {
        let fd = unsafe {
            libc::openat(
                parent,
                name.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        owned_fd(fd)
    }

    fn openat_file_create(parent: RawFd, name: &CStr) -> Result<OwnedFd, BrokerError> {
        let fd = unsafe {
            libc::openat(
                parent,
                name.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0o600,
            )
        };
        owned_fd(fd)
    }

    fn openat_file_read_write_create(parent: RawFd, name: &CStr) -> Result<OwnedFd, BrokerError> {
        let fd = unsafe {
            libc::openat(
                parent,
                name.as_ptr(),
                libc::O_RDWR | libc::O_CREAT | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0o600,
            )
        };
        owned_fd(fd)
    }

    fn owned_fd(fd: RawFd) -> Result<OwnedFd, BrokerError> {
        if fd < 0 {
            Err(io::Error::last_os_error().into())
        } else {
            Ok(unsafe { OwnedFd::from_raw_fd(fd) })
        }
    }

    fn fstat(fd: RawFd) -> Result<libc::stat, BrokerError> {
        let mut stat = MaybeUninit::<libc::stat>::uninit();
        if unsafe { libc::fstat(fd, stat.as_mut_ptr()) } != 0 {
            return Err(io::Error::last_os_error().into());
        }
        Ok(unsafe { stat.assume_init() })
    }

    fn fstatat_nofollow(parent: RawFd, name: &CStr) -> Result<libc::stat, BrokerError> {
        let mut stat = MaybeUninit::<libc::stat>::uninit();
        if unsafe {
            libc::fstatat(
                parent,
                name.as_ptr(),
                stat.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        } != 0
        {
            return Err(io::Error::last_os_error().into());
        }
        Ok(unsafe { stat.assume_init() })
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::{
            fs,
            os::unix::fs::{symlink, PermissionsExt},
            path::PathBuf,
        };

        const REQUEST_KEY: [u8; 32] = [0x5a; 32];
        const JOURNAL_KEY: [u8; 32] = [0x6b; 32];
        const RECEIPT_KEY: [u8; 32] = [0x7c; 32];
        const OLD_PLIST: &[u8] = b"<?xml version=\"1.0\"?><plist><string>old</string></plist>";
        const NEW_PLIST: &[u8] = b"<?xml version=\"1.0\"?><plist><string>new</string></plist>";

        struct Fixture {
            path: PathBuf,
            pointer_root: CustodyRoot,
            plist_root: CustodyRoot,
            request: BrokerRequest,
            frame: Vec<u8>,
        }

        impl Fixture {
            fn new(suffix: &str) -> Self {
                let requested_path = std::env::temp_dir().join(format!(
                    "ashlr-m569-{}-{}-{suffix}",
                    std::process::id(),
                    std::thread::current().name().unwrap_or("test")
                ));
                let _ = fs::remove_dir_all(&requested_path);
                fs::create_dir(&requested_path).unwrap();
                let path = fs::canonicalize(&requested_path).unwrap();
                fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
                let pointer_path = path.join("pointer");
                let plist_path = path.join("plist");
                let journal_path = path.join("journal");
                for directory in [&pointer_path, &plist_path, &journal_path] {
                    fs::create_dir(directory).unwrap();
                    fs::set_permissions(directory, fs::Permissions::from_mode(0o700)).unwrap();
                }
                symlink(
                    format!("releases/{}", "1".repeat(40)),
                    pointer_path.join("current"),
                )
                .unwrap();
                fs::write(plist_path.join("daemon.plist"), OLD_PLIST).unwrap();
                let pointer_root = CustodyRoot::open(&pointer_path).unwrap();
                let plist_root = CustodyRoot::open(&plist_path).unwrap();
                let request = BrokerRequest {
                    protocol: PROTOCOL.to_owned(),
                    transaction_id: sha256_hex(suffix.as_bytes()),
                    nonce: format!("nonce-{suffix}-012345678901234567890123456789"),
                    untrusted_permit_sha256: sha256_hex(b"permit"),
                    request_sequence: 7,
                    pointer_parent: pointer_path.to_string_lossy().into_owned(),
                    plist_parent: plist_path.to_string_lossy().into_owned(),
                    journal_parent: journal_path.to_string_lossy().into_owned(),
                    pointer_name: "current".to_owned(),
                    plist_name: "daemon.plist".to_owned(),
                    candidate_pointer_target: format!("releases/{}", "2".repeat(40)),
                    candidate_plist_sha256: sha256_hex(NEW_PLIST),
                    expected_pointer: pointer_root.observe_pointer("current").unwrap(),
                    expected_plist: plist_root.observe_plist("daemon.plist").unwrap(),
                    stopped: LaunchdStoppedObservation {
                        uid: unsafe { libc::geteuid() },
                        label: "ai.ashlr.daemon".to_owned(),
                        loaded: false,
                        disabled: true,
                        job_generation: None,
                    },
                };
                let frame = encode_authenticated_request(&request, &REQUEST_KEY).unwrap();
                Self {
                    path,
                    pointer_root,
                    plist_root,
                    request,
                    frame,
                }
            }
        }

        impl Drop for Fixture {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.path);
            }
        }

        fn keys() -> BrokerKeys<'static> {
            BrokerKeys {
                request_verification: &REQUEST_KEY,
                journal_authentication: &JOURNAL_KEY,
                receipt_authentication: &RECEIPT_KEY,
            }
        }

        fn execute_fixture(
            fixture: &Fixture,
            crash_after: Option<u8>,
        ) -> Result<Vec<u8>, BrokerError> {
            let mut after_staging_create =
                |_: &CustodyRoot, _: &str, _: &CustodyRoot, _: &str| Ok(());
            execute_fixture_with_staging_hook(fixture, crash_after, &mut after_staging_create)
        }

        fn execute_fixture_with_staging_hook(
            fixture: &Fixture,
            crash_after: Option<u8>,
            after_staging_create: &mut StagingHook<'_>,
        ) -> Result<Vec<u8>, BrokerError> {
            let stopped = fixture.request.stopped.clone();
            let mut observer = move |_: u32, _: &str| Ok(stopped.clone());
            run_claim_and_verify_foundation_inner(
                &fixture.frame,
                &keys(),
                NEW_PLIST,
                crash_after,
                &mut observer,
                after_staging_create,
            )
        }

        fn recover_fixture(fixture: &Fixture) -> Result<RecoveryOutcome, BrokerError> {
            let stopped = fixture.request.stopped.clone();
            let mut observer = move |_: u32, _: &str| Ok(stopped.clone());
            recover_claim_and_verify_foundation_inner(
                Path::new(&fixture.request.journal_parent),
                &fixture.request.transaction_id,
                &keys(),
                &mut observer,
            )
        }

        #[test]
        fn executes_exact_stopped_selection_and_emits_non_authorizing_receipt() {
            let fixture = Fixture::new("success");
            let receipt_frame = execute_fixture(&fixture, None).unwrap();
            let receipt = decode_authenticated_receipt(&receipt_frame, &RECEIPT_KEY).unwrap();
            assert_eq!(receipt.outcome, "foundation-claim-and-verify-only");
            assert!(!receipt.service_started);
            assert!(!receipt.service_enabled);
            assert!(!receipt.dispatch_authorized);
            assert!(!receipt.provider_effects_unblocked);
            assert!(!receipt.protected_broker_verified);
            assert!(!receipt.native_conditional_cas_verified);
            assert!(!receipt.external_replay_consumed);
            assert!(!receipt.activation_authorized);
            assert_eq!(
                fixture
                    .pointer_root
                    .observe_pointer("current")
                    .unwrap()
                    .raw_target,
                format!("releases/{}", "2".repeat(40))
            );
            assert_eq!(
                fixture
                    .plist_root
                    .observe_plist("daemon.plist")
                    .unwrap()
                    .sha256,
                sha256_hex(NEW_PLIST)
            );
        }

        #[test]
        fn completed_or_rolled_back_transaction_id_cannot_create_a_fresh_active_marker() {
            let completed = Fixture::new("completed-id-reuse");
            execute_fixture(&completed, None).unwrap();
            assert!(!Path::new(&completed.request.journal_parent)
                .join(active_name())
                .exists());
            assert!(matches!(
                execute_fixture(&completed, None),
                Err(BrokerError::ReconciliationRequired(
                    "transaction-id-artifact-present"
                ))
            ));
            assert!(!Path::new(&completed.request.journal_parent)
                .join(active_name())
                .exists());

            let rolled_back = Fixture::new("rolled-back-id-reuse");
            assert!(execute_fixture(&rolled_back, Some(0)).is_err());
            assert_eq!(
                recover_fixture(&rolled_back).unwrap(),
                RecoveryOutcome::RolledBack
            );
            assert!(matches!(
                execute_fixture(&rolled_back, None),
                Err(BrokerError::ReconciliationRequired(
                    "transaction-id-artifact-present"
                ))
            ));
            assert!(!Path::new(&rolled_back.request.journal_parent)
                .join(active_name())
                .exists());
        }

        #[test]
        fn every_uncommitted_crash_point_recovers_exact_old_state() {
            for point in 0..=5 {
                let fixture = Fixture::new(&format!("crash-{point}"));
                let result = execute_fixture(&fixture, Some(point));
                assert!(matches!(
                    result,
                    Err(BrokerError::Conflict("injected-crash"))
                ));
                assert_eq!(
                    recover_fixture(&fixture).unwrap(),
                    RecoveryOutcome::RolledBack
                );
                assert_eq!(
                    fixture.pointer_root.observe_pointer("current").unwrap(),
                    fixture.request.expected_pointer
                );
                assert_eq!(
                    fixture.plist_root.observe_plist("daemon.plist").unwrap(),
                    fixture.request.expected_plist
                );
            }
        }

        #[test]
        fn crash_after_active_marker_before_intent_clears_only_exact_marker() {
            let fixture = Fixture::new("active-before-intent");
            assert!(matches!(
                execute_fixture(&fixture, Some(9)),
                Err(BrokerError::Conflict("injected-crash"))
            ));
            assert_eq!(
                recover_fixture(&fixture).unwrap(),
                RecoveryOutcome::RolledBack
            );
            assert_eq!(
                fixture.pointer_root.observe_pointer("current").unwrap(),
                fixture.request.expected_pointer
            );
            assert_eq!(
                fixture.plist_root.observe_plist("daemon.plist").unwrap(),
                fixture.request.expected_plist
            );
        }

        #[test]
        fn missing_phase_zero_with_later_artifact_never_clears_active_marker() {
            let later_phase = Fixture::new("missing-intent-later-phase");
            assert!(execute_fixture(&later_phase, Some(1)).is_err());
            let later_journal = Path::new(&later_phase.request.journal_parent);
            fs::remove_file(
                later_journal.join(journal_name(&later_phase.request.transaction_id, 0)),
            )
            .unwrap();
            assert!(matches!(
                recover_fixture(&later_phase),
                Err(BrokerError::ReconciliationRequired(
                    "phase-zero-missing-with-later-artifact"
                ))
            ));
            assert!(later_journal.join(active_name()).exists());

            let receipt = Fixture::new("missing-intent-receipt");
            assert!(execute_fixture(&receipt, Some(0)).is_err());
            let receipt_journal = Path::new(&receipt.request.journal_parent);
            fs::remove_file(receipt_journal.join(journal_name(&receipt.request.transaction_id, 0)))
                .unwrap();
            fs::write(
                receipt_journal.join(receipt_name(&receipt.request.transaction_id)),
                b"partial receipt",
            )
            .unwrap();
            assert!(matches!(
                recover_fixture(&receipt),
                Err(BrokerError::ReconciliationRequired(
                    "phase-zero-missing-with-later-artifact"
                ))
            ));
            assert!(receipt_journal.join(active_name()).exists());
        }

        #[test]
        fn unjournaled_staging_identity_is_retained_for_reconciliation() {
            let fixture = Fixture::new("unjournaled-staging");
            assert!(execute_fixture(&fixture, Some(0)).is_err());
            let temp_name = format!(".ashlr-m569-{}-pointer-new", fixture.request.transaction_id);
            let temp_path = Path::new(&fixture.request.pointer_parent).join(&temp_name);
            symlink(&fixture.request.candidate_pointer_target, &temp_path).unwrap();
            assert!(matches!(
                recover_fixture(&fixture),
                Err(BrokerError::ReconciliationRequired("pointer-temp-drift"))
            ));
            assert!(fs::symlink_metadata(&temp_path).is_ok());
        }

        #[test]
        fn committed_recovery_settles_exact_new_state() {
            let fixture = Fixture::new("committed-recovery");
            execute_fixture(&fixture, None).unwrap();
            assert!(matches!(
                recover_fixture(&fixture).unwrap(),
                RecoveryOutcome::Committed(_)
            ));
        }

        #[test]
        fn receipt_and_commit_crash_points_settle_exact_committed_state() {
            for point in 6..=8 {
                let fixture = Fixture::new(&format!("commit-crash-{point}"));
                assert!(matches!(
                    execute_fixture(&fixture, Some(point)),
                    Err(BrokerError::Conflict("injected-crash"))
                ));
                assert!(matches!(
                    recover_fixture(&fixture).unwrap(),
                    RecoveryOutcome::Committed(_)
                ));
                assert_eq!(
                    fixture
                        .pointer_root
                        .observe_pointer("current")
                        .unwrap()
                        .raw_target,
                    format!("releases/{}", "2".repeat(40))
                );
                assert_eq!(
                    fixture
                        .plist_root
                        .observe_plist("daemon.plist")
                        .unwrap()
                        .sha256,
                    sha256_hex(NEW_PLIST)
                );
            }
        }

        #[test]
        fn rolled_back_recovery_is_terminal_and_idempotent() {
            let fixture = Fixture::new("idempotent-rollback");
            assert!(execute_fixture(&fixture, Some(3)).is_err());
            assert_eq!(
                recover_fixture(&fixture).unwrap(),
                RecoveryOutcome::RolledBack
            );
            assert_eq!(
                recover_fixture(&fixture).unwrap(),
                RecoveryOutcome::RolledBack
            );
        }

        #[test]
        fn complete_pending_phase_is_settled_but_partial_phase_is_retained() {
            let fixture = Fixture::new("pending-phase");
            assert!(execute_fixture(&fixture, Some(3)).is_err());
            let journal_root = Path::new(&fixture.request.journal_parent);
            let final_name = journal_name(&fixture.request.transaction_id, 3);
            fs::rename(
                journal_root.join(&final_name),
                journal_root.join(pending_name(&final_name).unwrap()),
            )
            .unwrap();
            assert_eq!(
                recover_fixture(&fixture).unwrap(),
                RecoveryOutcome::RolledBack
            );

            let partial = Fixture::new("partial-phase");
            assert!(execute_fixture(&partial, Some(2)).is_err());
            let phase = journal_name(&partial.request.transaction_id, 2);
            let pending = pending_name(&phase).unwrap();
            fs::write(
                Path::new(&partial.request.journal_parent).join(&pending),
                b"{",
            )
            .unwrap();
            assert!(recover_fixture(&partial).is_err());
            assert!(Path::new(&partial.request.journal_parent)
                .join(&pending)
                .exists());
        }

        #[test]
        fn journal_gap_and_rebound_root_require_reconciliation() {
            let gap = Fixture::new("journal-gap");
            assert!(execute_fixture(&gap, Some(3)).is_err());
            let journal_root = Path::new(&gap.request.journal_parent);
            fs::rename(
                journal_root.join(journal_name(&gap.request.transaction_id, 1)),
                journal_root.join("held-phase.json"),
            )
            .unwrap();
            assert!(matches!(
                recover_fixture(&gap),
                Err(BrokerError::ReconciliationRequired("journal-sequence-gap"))
            ));

            let tail = Fixture::new("journal-tail");
            assert!(execute_fixture(&tail, Some(0)).is_err());
            fs::write(
                Path::new(&tail.request.journal_parent)
                    .join(journal_name(&tail.request.transaction_id, 99)),
                b"tail",
            )
            .unwrap();
            assert!(matches!(
                recover_fixture(&tail),
                Err(BrokerError::ReconciliationRequired("journal-sequence-tail"))
            ));

            let rebound = Fixture::new("root-rebound");
            assert!(execute_fixture(&rebound, Some(3)).is_err());
            let pointer_path = Path::new(&rebound.request.pointer_parent);
            let displaced = rebound.path.join("pointer-displaced");
            fs::rename(pointer_path, &displaced).unwrap();
            fs::create_dir(pointer_path).unwrap();
            fs::set_permissions(pointer_path, fs::Permissions::from_mode(0o700)).unwrap();
            symlink(
                format!("releases/{}", "1".repeat(40)),
                pointer_path.join("current"),
            )
            .unwrap();
            assert!(matches!(
                recover_fixture(&rebound),
                Err(BrokerError::ReconciliationRequired("custody-root-rebound"))
            ));
        }

        #[test]
        fn lifecycle_lock_and_legacy_journal_fail_closed_before_mutation() {
            let locked = Fixture::new("lifecycle-locked");
            let journal_root =
                CustodyRoot::open_private(Path::new(&locked.request.journal_parent)).unwrap();
            let _lease = journal_root.acquire_lifecycle_lease().unwrap();
            assert!(matches!(
                execute_fixture(&locked, None),
                Err(BrokerError::Conflict("lifecycle-lock-busy"))
            ));
            assert_eq!(
                locked.pointer_root.observe_pointer("current").unwrap(),
                locked.request.expected_pointer
            );

            let legacy = Fixture::new("legacy-journal");
            fs::write(
                Path::new(&legacy.request.journal_parent)
                    .join("runtime-activation-stopped-consumer.journal.json"),
                b"legacy",
            )
            .unwrap();
            assert!(matches!(
                execute_fixture(&legacy, None),
                Err(BrokerError::ReconciliationRequired(
                    "legacy-stopped-selection-journal-present"
                ))
            ));
        }

        #[test]
        fn recovery_never_deletes_a_rebound_temp_even_with_same_target() {
            let fixture = Fixture::new("temp-rebound");
            assert!(execute_fixture(&fixture, Some(1)).is_err());
            let temp_name = format!(".ashlr-m569-{}-pointer-new", fixture.request.transaction_id);
            let temp_path = Path::new(&fixture.request.pointer_parent).join(&temp_name);
            fs::remove_file(&temp_path).unwrap();
            symlink(&fixture.request.candidate_pointer_target, &temp_path).unwrap();
            assert!(matches!(
                recover_fixture(&fixture),
                Err(BrokerError::ReconciliationRequired("pointer-temp-drift"))
            ));
            assert!(temp_path.exists() || fs::symlink_metadata(&temp_path).is_ok());
        }

        #[test]
        fn missing_active_marker_retains_nonterminal_transaction() {
            let fixture = Fixture::new("missing-active");
            assert!(execute_fixture(&fixture, Some(3)).is_err());
            fs::remove_file(Path::new(&fixture.request.journal_parent).join(active_name()))
                .unwrap();
            assert!(matches!(
                recover_fixture(&fixture),
                Err(BrokerError::ReconciliationRequired(
                    "active-transaction-marker-missing"
                ))
            ));
            assert_eq!(
                fixture
                    .pointer_root
                    .observe_pointer("current")
                    .unwrap()
                    .raw_target,
                format!("releases/{}", "2".repeat(40))
            );
        }

        #[test]
        fn launchd_parser_rejects_ambiguous_or_malformed_disabled_state() {
            assert!(
                parse_disabled_state("\"ai.ashlr.daemon\" => disabled\n", "ai.ashlr.daemon")
                    .unwrap()
            );
            assert!(!parse_disabled_state(
                "disabled services = {\n\t\"ai.ashlr.daemon\" => enabled\n}\n",
                "ai.ashlr.daemon"
            )
            .unwrap());
            assert!(parse_disabled_state(
                "\"ai.ashlr.daemon\" => disabled\n\"ai.ashlr.daemon\" => enabled\n",
                "ai.ashlr.daemon"
            )
            .is_err());
            assert!(
                parse_disabled_state("\"ai.ashlr.daemon\" => maybe\n", "ai.ashlr.daemon").is_err()
            );
            assert!(parse_disabled_state(
                "\"ai.ashlr.daemon\" => disabled trailing\n",
                "ai.ashlr.daemon"
            )
            .is_err());
            let exact = "Could not find service \"ai.ashlr.daemon\" in domain for user gui: 501";
            assert!(is_exactly_absent(
                &CommandOutput {
                    status: 113,
                    stdout: String::new(),
                    stderr: format!("Bad request.\r\n{exact}\r\n"),
                },
                501,
                "ai.ashlr.daemon"
            ));
            for output in [
                CommandOutput {
                    status: 1,
                    stdout: String::new(),
                    stderr: exact.to_owned(),
                },
                CommandOutput {
                    status: 113,
                    stdout: "unexpected output".to_owned(),
                    stderr: exact.to_owned(),
                },
                CommandOutput {
                    status: 113,
                    stdout: String::new(),
                    stderr: format!("Bad request.\n{exact}\nOperation not permitted"),
                },
                CommandOutput {
                    status: 113,
                    stdout: String::new(),
                    stderr: format!("fatal: {exact}"),
                },
                CommandOutput {
                    status: 113,
                    stdout: String::new(),
                    stderr: format!("{exact}\n\n"),
                },
                CommandOutput {
                    status: 113,
                    stdout: String::new(),
                    stderr: "Could not find service \"other\" in domain for user gui: 501\n"
                        .to_owned(),
                },
                CommandOutput {
                    status: 113,
                    stdout: String::new(),
                    stderr:
                        "Could not find service \"ai.ashlr.daemon\" in domain for user gui: 502\n"
                            .to_owned(),
                },
            ] {
                assert!(!is_exactly_absent(&output, 501, "ai.ashlr.daemon"));
            }
        }

        #[test]
        fn refuses_symlinked_custody_component_and_symlinked_plist() {
            let outer = Fixture::new("symlink-root");
            let link = outer.path.with_extension("link");
            let _ = fs::remove_file(&link);
            symlink(&outer.path, &link).unwrap();
            assert!(CustodyRoot::open(&link).is_err());
            let _ = fs::remove_file(&link);

            let fixture = Fixture::new("symlink-plist");
            fs::remove_file(Path::new(&fixture.request.plist_parent).join("daemon.plist")).unwrap();
            symlink(
                "other.plist",
                Path::new(&fixture.request.plist_parent).join("daemon.plist"),
            )
            .unwrap();
            assert!(fixture.plist_root.observe_plist("daemon.plist").is_err());
            assert!(
                CustodyRoot::open(Path::new(&format!("{}/", fixture.request.pointer_parent)))
                    .is_err()
            );
        }

        #[test]
        fn raced_pointer_identity_never_installs_candidate() {
            let fixture = Fixture::new("pointer-race");
            fs::remove_file(Path::new(&fixture.request.pointer_parent).join("current")).unwrap();
            symlink(
                format!("releases/{}", "3".repeat(40)),
                Path::new(&fixture.request.pointer_parent).join("current"),
            )
            .unwrap();
            assert!(matches!(
                execute_fixture(&fixture, None),
                Err(BrokerError::Conflict("initial-state"))
            ));
            assert_eq!(
                fixture
                    .pointer_root
                    .observe_pointer("current")
                    .unwrap()
                    .raw_target,
                format!("releases/{}", "3".repeat(40))
            );
        }

        #[test]
        fn substituted_staged_pointer_never_mutates_selected_state() {
            let fixture = Fixture::new("staged-pointer-race");
            let mut replace_pointer =
                |pointer_root: &CustodyRoot, pointer_temp: &str, _: &CustodyRoot, _: &str| {
                    let temp = Path::new(pointer_root.canonical_path()).join(pointer_temp);
                    fs::remove_file(&temp)?;
                    symlink(format!("releases/{}", "3".repeat(40)), temp)?;
                    Ok(())
                };
            assert!(matches!(
                execute_fixture_with_staging_hook(&fixture, None, &mut replace_pointer),
                Err(BrokerError::Conflict("staged-pointer-candidate-mismatch"))
            ));
            assert_eq!(
                fixture.pointer_root.observe_pointer("current").unwrap(),
                fixture.request.expected_pointer
            );
            assert_eq!(
                fixture.plist_root.observe_plist("daemon.plist").unwrap(),
                fixture.request.expected_plist
            );
        }

        #[test]
        fn substituted_staged_plist_never_mutates_selected_state() {
            let fixture = Fixture::new("staged-plist-race");
            let mut replace_plist =
                |_: &CustodyRoot, _: &str, plist_root: &CustodyRoot, plist_temp: &str| {
                    let temp = Path::new(plist_root.canonical_path()).join(plist_temp);
                    fs::remove_file(&temp)?;
                    fs::write(&temp, b"attacker-controlled plist")?;
                    fs::set_permissions(&temp, fs::Permissions::from_mode(0o600))?;
                    Ok(())
                };
            assert!(matches!(
                execute_fixture_with_staging_hook(&fixture, None, &mut replace_plist),
                Err(BrokerError::Conflict("staged-plist-candidate-mismatch"))
            ));
            assert_eq!(
                fixture.pointer_root.observe_pointer("current").unwrap(),
                fixture.request.expected_pointer
            );
            assert_eq!(
                fixture.plist_root.observe_plist("daemon.plist").unwrap(),
                fixture.request.expected_plist
            );
        }

        #[test]
        fn launchd_state_change_before_selection_mutation_preserves_old_state() {
            let fixture = Fixture::new("launchd-pre-mutation-race");
            let stopped = fixture.request.stopped.clone();
            let mut observations = 0_u8;
            let mut observer = |_: u32, _: &str| {
                observations += 1;
                let mut observed = stopped.clone();
                if observations == 2 {
                    observed.loaded = true;
                    observed.disabled = false;
                }
                Ok(observed)
            };
            let mut after_staging_create =
                |_: &CustodyRoot, _: &str, _: &CustodyRoot, _: &str| Ok(());
            assert!(matches!(
                run_claim_and_verify_foundation_inner(
                    &fixture.frame,
                    &keys(),
                    NEW_PLIST,
                    None,
                    &mut observer,
                    &mut after_staging_create,
                ),
                Err(BrokerError::Conflict("launchd-pre-mutation-state-mismatch"))
            ));
            assert_eq!(
                fixture.pointer_root.observe_pointer("current").unwrap(),
                fixture.request.expected_pointer
            );
            assert_eq!(
                fixture.plist_root.observe_plist("daemon.plist").unwrap(),
                fixture.request.expected_plist
            );
            assert_eq!(
                recover_fixture(&fixture).unwrap(),
                RecoveryOutcome::RolledBack
            );
        }

        #[test]
        fn tampered_journal_fails_closed_without_rollback_mutation() {
            let fixture = Fixture::new("journal-tamper");
            let result = execute_fixture(&fixture, Some(3));
            assert!(result.is_err());
            let journal = Path::new(&fixture.request.journal_parent)
                .join(journal_name(&fixture.request.transaction_id, 0));
            let mut bytes = fs::read(&journal).unwrap();
            bytes[10] ^= 1;
            fs::write(&journal, bytes).unwrap();
            assert!(matches!(
                recover_fixture(&fixture),
                Err(BrokerError::Authentication) | Err(BrokerError::Json(_))
            ));
            assert_eq!(
                fixture
                    .pointer_root
                    .observe_pointer("current")
                    .unwrap()
                    .raw_target,
                format!("releases/{}", "2".repeat(40))
            );
        }
    }
}

#[cfg(target_os = "macos")]
pub use macos::{observe_launchd_stopped, CustodyRoot};

#[cfg(not(target_os = "macos"))]
pub fn observe_launchd_stopped(
    _uid: u32,
    _label: &str,
) -> Result<LaunchdStoppedObservation, BrokerError> {
    Err(BrokerError::UnsupportedPlatform)
}

#[cfg(test)]
mod protocol_tests {
    use super::*;

    fn request() -> BrokerRequest {
        BrokerRequest {
            protocol: PROTOCOL.to_owned(),
            transaction_id: "a".repeat(64),
            nonce: "nonce_012345678901234567890123456789".to_owned(),
            untrusted_permit_sha256: "b".repeat(64),
            request_sequence: 1,
            pointer_parent: "/private/var/db/ashlr/pointer".to_owned(),
            plist_parent: "/Users/test/Library/LaunchAgents".to_owned(),
            journal_parent: "/private/var/db/ashlr/journal".to_owned(),
            pointer_name: "current".to_owned(),
            plist_name: "ai.ashlr.daemon.plist".to_owned(),
            candidate_pointer_target: format!("releases/{}", "2".repeat(40)),
            candidate_plist_sha256: "c".repeat(64),
            expected_pointer: PointerObservation {
                identity: ObjectIdentity {
                    device: "1".to_owned(),
                    inode: "2".to_owned(),
                },
                owner_uid: 501,
                raw_target: format!("releases/{}", "1".repeat(40)),
            },
            expected_plist: PlistObservation {
                identity: ObjectIdentity {
                    device: "1".to_owned(),
                    inode: "3".to_owned(),
                },
                owner_uid: 501,
                mode: 0o600,
                byte_length: 100,
                sha256: "d".repeat(64),
            },
            stopped: LaunchdStoppedObservation {
                uid: 501,
                label: "ai.ashlr.daemon".to_owned(),
                loaded: false,
                disabled: true,
                job_generation: None,
            },
        }
    }

    #[test]
    fn authenticated_request_requires_exact_canonical_frame_and_key() {
        let key = [7_u8; 32];
        let frame = encode_authenticated_request(&request(), &key).unwrap();
        assert_eq!(
            decode_authenticated_request(&frame, &key).unwrap(),
            request()
        );
        let mut tampered = frame.clone();
        tampered[20] ^= 1;
        assert!(decode_authenticated_request(&tampered, &key).is_err());
        let mut trailing = frame.clone();
        trailing.push(b'\n');
        assert!(decode_authenticated_request(&trailing, &key).is_err());
        assert!(encode_authenticated_request(&request(), &[1_u8; 31]).is_err());
    }

    #[test]
    fn authenticated_request_rejects_unknown_and_duplicate_fields() {
        let key = [7_u8; 32];
        let frame = encode_authenticated_request(&request(), &key).unwrap();
        let text = String::from_utf8(frame).unwrap();
        let unknown = text.replacen("\"payload\":{", "\"payload\":{\"unknown\":true,", 1);
        assert!(decode_authenticated_request(unknown.as_bytes(), &key).is_err());
        let duplicate = text.replacen(
            "\"protocol\":\"ashlr-native-launchd-broker-v1\"",
            "\"protocol\":\"ashlr-native-launchd-broker-v1\",\"protocol\":\"ashlr-native-launchd-broker-v1\"",
            1,
        );
        assert!(decode_authenticated_request(duplicate.as_bytes(), &key).is_err());
    }

    #[test]
    fn broker_keys_must_be_distinct_and_authority_is_frozen_false() {
        let one = [1_u8; 32];
        let two = [2_u8; 32];
        let reused = BrokerKeys {
            request_verification: &one,
            journal_authentication: &one,
            receipt_authentication: &two,
        };
        assert!(reused.validate().is_err());
        assert_eq!(
            NATIVE_BROKER_AUTHORITY,
            NativeBrokerAuthority {
                effect_consumer_registered: false,
                permit_and_trust_roots_verified: false,
                protected_xpc_boundary_verified: false,
                peer_audit_token_and_code_identity_verified: false,
                native_conditional_cas_verified: false,
                trusted_time_verified: false,
                external_monotonic_replay_verified: false,
                cross_generation_exclusion_verified: false,
                resident_acknowledgement_verified: false,
                launch_or_start_authorized: false,
                dispatch_authorized: false,
            }
        );
    }

    #[test]
    fn request_requires_three_distinct_custody_roots() {
        let mut aliased = request();
        aliased.journal_parent = aliased.pointer_parent.clone();
        assert!(matches!(
            encode_authenticated_request(&aliased, &[7_u8; 32]),
            Err(BrokerError::Invalid("custody-roots-must-be-distinct"))
        ));
    }

    #[test]
    fn receipt_decoder_rejects_any_claimed_authority() {
        let key = [9_u8; 32];
        let request = request();
        let mut receipt = BrokerReceipt {
            protocol: PROTOCOL.to_owned(),
            transaction_id: request.transaction_id,
            request_sha256: "e".repeat(64),
            outcome: "foundation-claim-and-verify-only".to_owned(),
            pointer: request.expected_pointer,
            plist: request.expected_plist,
            stopped: request.stopped,
            service_started: false,
            service_enabled: false,
            dispatch_authorized: false,
            provider_effects_unblocked: false,
            protected_broker_verified: false,
            native_conditional_cas_verified: true,
            external_replay_consumed: false,
            activation_authorized: false,
        };
        let frame = encode_authenticated_receipt(&receipt, &key).unwrap();
        assert!(matches!(
            decode_authenticated_receipt(&frame, &key),
            Err(BrokerError::Invalid("receipt-authority"))
        ));

        receipt.native_conditional_cas_verified = false;
        receipt.pointer.owner_uid += 1;
        let frame = encode_authenticated_receipt(&receipt, &key).unwrap();
        assert!(matches!(
            decode_authenticated_receipt(&frame, &key),
            Err(BrokerError::Invalid("receipt-semantics"))
        ));

        receipt.pointer.owner_uid = receipt.stopped.uid;
        receipt.pointer.identity.inode = "03".to_owned();
        let frame = encode_authenticated_receipt(&receipt, &key).unwrap();
        assert!(matches!(
            decode_authenticated_receipt(&frame, &key),
            Err(BrokerError::Invalid("object-identity"))
        ));
    }

    #[test]
    fn request_frame_has_stable_cross_language_fingerprint() {
        let key = [7_u8; 32];
        let frame = encode_authenticated_request(&request(), &key).unwrap();
        assert_eq!(
            sha256_hex(&frame),
            "81e10c4f0f6b394ab355f42f999ae912faa48fc5fda5d8cf441e20a94d73474b"
        );
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn non_macos_adapter_is_fail_closed() {
        assert!(matches!(
            observe_launchd_stopped(501, "ai.ashlr.daemon"),
            Err(BrokerError::UnsupportedPlatform)
        ));
    }
}
