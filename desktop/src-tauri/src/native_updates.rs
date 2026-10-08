//! Signed paired-update policy and private stages. Never installs or raises fleet authority.
use base64::{engine::general_purpose::STANDARD, Engine};
use minisign_verify::{PublicKey, Signature};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub const STATE_EVENT: &str = "shell-update-state";
pub const REQUEST_EVENT: &str = "shell-update";
pub const MAX_MANIFEST: usize = 64 * 1024;
pub const MAX_APP: u64 = 512 * 1024 * 1024;
pub const STAGE_RELATIVE: &str = ".ashlr/updates/staged";

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    Uncommissioned,
    Disabled,
    Checking,
    Idle,
    Available,
    Downloading,
    Staged,
    WaitingForIdle,
    WaitingForAppQuit,
    AdoptionHeld,
    Installing,
    Installed,
    Current,
    Failed,
}
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
    pub phase: Phase,
    pub enabled: bool,
    pub version: Option<String>,
    pub bytes_received: u64,
    pub bytes_total: Option<u64>,
    pub reason: Option<String>,
}
impl Default for UpdateState {
    fn default() -> Self {
        Self {
            phase: Phase::Uncommissioned,
            enabled: true,
            version: None,
            bytes_received: 0,
            bytes_total: None,
            reason: Some("uncommissioned-key".into()),
        }
    }
}
pub fn state_script(state: &UpdateState) -> String {
    format!("if (typeof window.__ASHLR_UPDATE_STATE__ === 'function') window.__ASHLR_UPDATE_STATE__({});", serde_json::to_string(state).unwrap())
}
pub fn status_request(payload: &str) -> bool {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Request {
        op: String,
    }
    serde_json::from_str::<Request>(payload)
        .ok()
        .is_some_and(|r| r.op == "status")
}
fn held(code: &str) -> String {
    code.to_string()
}
fn need(ok: bool, code: &str) -> Result<(), String> {
    if ok {
        Ok(())
    } else {
        Err(held(code))
    }
}
fn text(v: &Value) -> Result<&str, String> {
    v.as_str().ok_or_else(|| held("invalid-manifest"))
}
fn hex(v: &Value, n: usize) -> bool {
    v.as_str().is_some_and(|s| {
        s.len() == n
            && s.bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    })
}
fn positive(v: &Value) -> bool {
    v.as_u64()
        .is_some_and(|n| n > 0 && n <= 9_007_199_254_740_991)
}
fn keys(v: &Value, expected: &[&str]) -> Result<(), String> {
    need(
        v.as_object().is_some_and(|o| {
            o.len() == expected.len() && expected.iter().all(|k| o.contains_key(*k))
        }),
        "invalid-manifest",
    )
}
fn sorted(v: &mut Value) {
    match v {
        Value::Object(o) => {
            for v in o.values_mut() {
                sorted(v)
            }
            o.sort_keys()
        }
        Value::Array(a) => {
            for v in a {
                sorted(v)
            }
        }
        _ => {}
    }
}
pub fn stable_version(s: &str) -> Option<[u64; 3]> {
    if s.len() > 32 {
        return None;
    }
    let parts: Vec<_> = s.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    let mut result = [0; 3];
    for (i, p) in parts.iter().enumerate() {
        if p.is_empty()
            || (p.len() > 1 && p.starts_with('0'))
            || !p.bytes().all(|c| c.is_ascii_digit())
        {
            return None;
        }
        result[i] = p.parse().ok()?;
        if result[i] > 9_007_199_254_740_991 {
            return None;
        }
    }
    Some(result)
}
fn wrapped_lines(encoded: &str, count: usize) -> Result<Vec<String>, String> {
    need(
        !encoded.is_empty() && encoded.len() <= 8192,
        "invalid-signature",
    )?;
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| held("invalid-signature"))?;
    need(STANDARD.encode(&bytes) == encoded, "invalid-signature")?;
    let raw = String::from_utf8(bytes).map_err(|_| held("invalid-signature"))?;
    let raw = raw.strip_suffix('\n').unwrap_or(&raw);
    let lines: Vec<_> = raw.split('\n').map(str::to_string).collect();
    need(
        lines.len() == count && lines.iter().all(|l| !l.contains('\r')),
        "invalid-signature",
    )?;
    Ok(lines)
}
pub fn validate_public_key(public_key: &str) -> Result<(), String> {
    let key = wrapped_lines(public_key, 2)?;
    need(
        key[0].starts_with("untrusted comment: "),
        "invalid-signature",
    )?;
    PublicKey::decode(&key.join("\n")).map_err(|_| held("invalid-signature"))?;
    Ok(())
}
pub fn verify_minisign(bytes: &[u8], signature: &str, public_key: &str) -> Result<(), String> {
    let key = wrapped_lines(public_key, 2)?;
    let sig = wrapped_lines(signature, 4)?;
    need(
        key[0].starts_with("untrusted comment: ")
            && sig[0].starts_with("untrusted comment: ")
            && sig[2].starts_with("trusted comment: "),
        "invalid-signature",
    )?;
    let packet = STANDARD
        .decode(&sig[1])
        .map_err(|_| held("invalid-signature"))?;
    need(
        packet.len() == 74 && packet.starts_with(b"ED") && STANDARD.encode(&packet) == sig[1],
        "invalid-signature",
    )?;
    let key_packet = STANDARD
        .decode(&key[1])
        .map_err(|_| held("invalid-signature"))?;
    need(
        key_packet.len() == 42
            && key_packet.starts_with(b"Ed")
            && STANDARD.encode(&key_packet) == key[1],
        "invalid-signature",
    )?;
    let key = PublicKey::decode(&key.join("\n")).map_err(|_| held("invalid-signature"))?;
    let global = STANDARD
        .decode(&sig[3])
        .map_err(|_| held("invalid-signature"))?;
    need(
        global.len() == 64 && STANDARD.encode(&global) == sig[3],
        "invalid-signature",
    )?;
    let signature = Signature::decode(&sig.join("\n")).map_err(|_| held("invalid-signature"))?;
    key.verify(bytes, &signature, false)
        .map_err(|_| held("invalid-signature"))
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Envelope {
    pub manifest_text: String,
    pub signature: String,
}
#[derive(Clone, Debug)]
pub struct VerifiedManifest {
    value: Value,
    pub digest: String,
    pub envelope: Envelope,
}
impl VerifiedManifest {
    pub fn version(&self) -> &str {
        self.value["version"].as_str().unwrap()
    }
    pub fn app_bytes(&self) -> u64 {
        self.value["app"]["bytes"].as_u64().unwrap()
    }
    pub fn app_url(&self) -> &str {
        self.value["app"]["url"].as_str().unwrap()
    }
    pub fn app_signature(&self) -> &str {
        self.value["app"]["signature"].as_str().unwrap()
    }
    pub fn app_sha(&self) -> &str {
        self.value["app"]["sha256"].as_str().unwrap()
    }
}
pub fn parse_manifest(raw: &str, repository: &str) -> Result<Value, String> {
    parse_manifest_profile(raw, repository, 1, "@ashlr/hub", "ashlr-hub")
}

// Discovery redirects carry bytes, not trust. Only these inseparable signed
// schema/repository/package profiles can cross the product identity migration.
pub fn parse_compatible_manifest(raw: &str) -> Result<Value, String> {
    need(
        !raw.is_empty() && raw.len() <= MAX_MANIFEST && raw.is_ascii(),
        "invalid-manifest",
    )?;
    let value: Value = serde_json::from_str(raw).map_err(|_| held("invalid-manifest"))?;
    match value["schemaVersion"].as_u64() {
        Some(1) => parse_manifest_profile(raw, "ashlrai/ashlr-hub", 1, "@ashlr/hub", "ashlr-hub"),
        Some(2) => {
            parse_manifest_profile(raw, "ashlrai/phantom", 2, "@ashlr/phantom", "ashlr-phantom")
        }
        _ => Err(held("invalid-manifest")),
    }
}

fn parse_manifest_profile(
    raw: &str,
    repository: &str,
    schema: u64,
    package: &str,
    archive_prefix: &str,
) -> Result<Value, String> {
    need(
        !raw.is_empty() && raw.len() <= MAX_MANIFEST && raw.is_ascii(),
        "invalid-manifest",
    )?;
    need(
        repository == "ashlrai/ashlr-hub" || repository == "ashlrai/phantom",
        "invalid-manifest",
    )?;
    let mut m: Value = serde_json::from_str(raw).map_err(|_| held("invalid-manifest"))?;
    keys(
        &m,
        &[
            "schemaVersion",
            "kind",
            "channel",
            "platform",
            "version",
            "repository",
            "source",
            "authoritySurfaceDigest",
            "app",
            "cli",
            "qualification",
        ],
    )?;
    need(
        m["schemaVersion"].as_u64() == Some(schema)
            && m["kind"] == "phantom-paired-release"
            && m["channel"] == "stable"
            && m["platform"] == "darwin-aarch64",
        "invalid-manifest",
    )?;
    let version = text(&m["version"])?;
    need(stable_version(version).is_some(), "invalid-manifest")?;
    let r = &m["repository"];
    keys(
        r,
        &[
            "nameWithOwner",
            "repositoryId",
            "repositoryNodeId",
            "ownerId",
            "ownerLogin",
            "defaultBranch",
        ],
    )?;
    need(
        r["nameWithOwner"] == repository
            && r["repositoryId"].as_u64() == Some(1263526319)
            && r["repositoryNodeId"] == "R_kgDOS0_hrw"
            && r["ownerId"].as_u64() == Some(258113726)
            && r["ownerLogin"] == "ashlrai"
            && r["defaultBranch"] == "master",
        "invalid-manifest",
    )?;
    keys(&m["source"], &["revision", "tree"])?;
    need(
        hex(&m["source"]["revision"], 40)
            && hex(&m["source"]["tree"], 40)
            && hex(&m["authoritySurfaceDigest"], 64),
        "invalid-manifest",
    )?;
    for (kind, extra, filename, max) in [
        (
            "app",
            vec![
                "bundleIdentifier",
                "executable",
                "inventorySha256",
                "signer",
            ],
            format!("Phantom_{version}_aarch64.app.tar.gz"),
            MAX_APP,
        ),
        (
            "cli",
            vec!["packageName", "binName"],
            format!("{archive_prefix}-{version}.tgz"),
            64 * 1024 * 1024,
        ),
    ] {
        let a = &m[kind];
        let mut expected = vec!["filename", "url", "bytes", "sha256", "signature"];
        expected.extend(extra);
        keys(a, &expected)?;
        need(
            a["filename"] == filename
                && a["url"]
                    == format!(
                        "https://github.com/{repository}/releases/download/v{version}/{filename}"
                    )
                && positive(&a["bytes"])
                && a["bytes"].as_u64().unwrap() <= max
                && hex(&a["sha256"], 64),
            "invalid-manifest",
        )?;
        wrapped_lines(text(&a["signature"])?, 4)?;
    }
    let a = &m["app"];
    need(
        a["bundleIdentifier"] == "ai.ashlr.desktop"
            && a["executable"] == "ashlr-desktop"
            && hex(&a["inventorySha256"], 64)
            && a["signer"].as_str().is_some_and(|s| {
                s.len() == 40
                    && s.bytes()
                        .all(|c| c.is_ascii_digit() || (b'A'..=b'F').contains(&c))
            }),
        "invalid-manifest",
    )?;
    need(
        m["cli"]["packageName"] == package && m["cli"]["binName"] == "ashlr",
        "invalid-manifest",
    )?;
    let q = &m["qualification"];
    keys(
        q,
        &[
            "manifestSha256",
            "archiveSha256",
            "packageSha256",
            "qualificationSha256",
            "producer",
            "attestor",
            "audit",
        ],
    )?;
    need(
        [
            "manifestSha256",
            "archiveSha256",
            "packageSha256",
            "qualificationSha256",
        ]
        .iter()
        .all(|k| hex(&q[*k], 64))
            && q["packageSha256"] == m["cli"]["sha256"],
        "invalid-manifest",
    )?;
    for (kind, rev) in [
        ("producer", "eventSha"),
        ("attestor", "revision"),
        ("audit", "revision"),
    ] {
        let run = &q[kind];
        keys(run, &["runId", "runAttempt", rev])?;
        need(
            positive(&run["runId"]) && positive(&run["runAttempt"]) && hex(&run[rev], 40),
            "invalid-manifest",
        )?;
    }
    need(
        q["audit"]["revision"] == m["source"]["revision"],
        "invalid-manifest",
    )?;
    sorted(&mut m);
    need(
        serde_json::to_string(&m).unwrap() == raw,
        "invalid-manifest",
    )?;
    Ok(m)
}
pub fn verify_manifest(
    envelope: Envelope,
    key: &str,
    repository: &str,
) -> Result<VerifiedManifest, String> {
    need(
        envelope.manifest_text.len() <= MAX_MANIFEST,
        "invalid-manifest",
    )?;
    verify_minisign(envelope.manifest_text.as_bytes(), &envelope.signature, key)?;
    let value = parse_manifest(&envelope.manifest_text, repository)?;
    Ok(VerifiedManifest {
        digest: sha(envelope.manifest_text.as_bytes()),
        envelope,
        value,
    })
}
pub fn verify_compatible_manifest(
    envelope: Envelope,
    key: &str,
) -> Result<VerifiedManifest, String> {
    need(
        envelope.manifest_text.len() <= MAX_MANIFEST,
        "invalid-manifest",
    )?;
    verify_minisign(envelope.manifest_text.as_bytes(), &envelope.signature, key)?;
    let value = parse_compatible_manifest(&envelope.manifest_text)?;
    Ok(VerifiedManifest {
        digest: sha(envelope.manifest_text.as_bytes()),
        envelope,
        value,
    })
}

pub fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub fn discovery_matches(latest: &Value, manifest: &VerifiedManifest) -> bool {
    let platform = &latest["platforms"]["darwin-aarch64"];
    latest["version"].as_str() == Some(manifest.version())
        && platform["url"].as_str() == Some(manifest.app_url())
        && platform["signature"].as_str() == Some(manifest.app_signature())
}
pub fn check_app(manifest: &VerifiedManifest, bytes: &[u8], key: &str) -> Result<(), String> {
    need(
        bytes.len() as u64 == manifest.app_bytes() && sha(bytes) == manifest.app_sha(),
        "package-mismatch",
    )?;
    verify_minisign(bytes, manifest.app_signature(), key)
}
pub fn extend_download(bytes: &mut Vec<u8>, chunk: &[u8], expected: u64) -> Result<(), String> {
    need(
        expected > 0
            && expected <= MAX_APP
            && (bytes.len() as u64)
                .checked_add(chunk.len() as u64)
                .is_some_and(|n| n <= expected),
        "download-size",
    )?;
    bytes.extend_from_slice(chunk);
    Ok(())
}

fn owned_metadata(path: &Path, directory: bool) -> Result<fs::Metadata, String> {
    let m = fs::symlink_metadata(path).map_err(|_| held("unsafe-stage"))?;
    need(
        !m.file_type().is_symlink() && if directory { m.is_dir() } else { m.is_file() },
        "unsafe-stage",
    )?;
    need(
        m.uid() == unsafe { libc::geteuid() } && m.mode() & 0o077 == 0,
        "unsafe-stage",
    )?;
    Ok(m)
}
fn private_dirs(home: &Path) -> Result<PathBuf, String> {
    let mut p = home.to_path_buf();
    for piece in [".ashlr", "updates", "staged"] {
        p.push(piece);
        match fs::DirBuilder::new().mode(0o700).create(&p) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err(held("unsafe-stage")),
        }
        owned_metadata(&p, true)?;
    }
    Ok(p)
}
pub fn stage_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn random_id() -> String {
    let mut b = [0u8; 16];
    unsafe { libc::arc4random_buf(b.as_mut_ptr().cast(), b.len()) };
    b.iter().map(|b| format!("{b:02x}")).collect()
}
fn write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| held("stage-write"))?;
    f.write_all(bytes)
        .and_then(|_| f.sync_all())
        .map_err(|_| held("stage-write"))
}
pub fn persist_stage(
    home: &Path,
    manifest: &VerifiedManifest,
    bytes: &[u8],
    key: &str,
) -> Result<String, String> {
    check_app(manifest, bytes, key)?;
    let parent = private_dirs(home)?;
    let id = random_id();
    let dir = parent.join(&id);
    fs::DirBuilder::new()
        .mode(0o700)
        .create(&dir)
        .map_err(|_| held("stage-write"))?;
    write_new(
        &dir.join("manifest.json"),
        manifest.envelope.manifest_text.as_bytes(),
    )?;
    write_new(
        &dir.join("manifest.sig"),
        manifest.envelope.signature.as_bytes(),
    )?;
    write_new(&dir.join("app.tar.gz"), bytes)?;
    fs::File::open(&dir)
        .and_then(|f| f.sync_all())
        .map_err(|_| held("stage-write"))?;
    fs::File::open(&parent)
        .and_then(|f| f.sync_all())
        .map_err(|_| held("stage-write"))?;
    Ok(id)
}
fn read_private(path: &Path, max: u64) -> Result<Vec<u8>, String> {
    let before = owned_metadata(path, false)?;
    need(before.nlink() == 1, "unsafe-stage")?;
    need(before.len() <= max, "unsafe-stage")?;
    let mut f = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| held("unsafe-stage"))?;
    let opened = f.metadata().map_err(|_| held("unsafe-stage"))?;
    need(
        opened.dev() == before.dev() && opened.ino() == before.ino(),
        "unsafe-stage",
    )?;
    let mut b = Vec::new();
    Read::by_ref(&mut f)
        .take(max + 1)
        .read_to_end(&mut b)
        .map_err(|_| held("unsafe-stage"))?;
    let after = f.metadata().map_err(|_| held("unsafe-stage"))?;
    let named = owned_metadata(path, false)?;
    need(
        named.dev() == after.dev()
            && named.ino() == after.ino()
            && named.nlink() == 1
            && named.len() == after.len()
            && named.ctime() == after.ctime()
            && named.ctime_nsec() == after.ctime_nsec(),
        "unsafe-stage",
    )?;
    need(
        b.len() as u64 <= max
            && opened.len() == after.len()
            && opened.mtime() == after.mtime()
            && opened.mtime_nsec() == after.mtime_nsec()
            && opened.ctime() == after.ctime()
            && opened.ctime_nsec() == after.ctime_nsec(),
        "unsafe-stage",
    )?;
    Ok(b)
}
pub fn reload_stage(
    home: &Path,
    id: &str,
    key: &str,
    repository: &str,
) -> Result<VerifiedManifest, String> {
    reload_stage_with_verifier(home, id, key, |envelope| {
        verify_manifest(envelope, key, repository)
    })
}

pub fn reload_compatible_stage(
    home: &Path,
    id: &str,
    key: &str,
) -> Result<VerifiedManifest, String> {
    reload_stage_with_verifier(home, id, key, |envelope| {
        verify_compatible_manifest(envelope, key)
    })
}

fn reload_stage_with_verifier(
    home: &Path,
    id: &str,
    key: &str,
    verify: impl FnOnce(Envelope) -> Result<VerifiedManifest, String>,
) -> Result<VerifiedManifest, String> {
    need(stage_id(id), "unsafe-stage")?;
    let mut parent = home.to_path_buf();
    for part in [".ashlr", "updates", "staged", id] {
        parent.push(part);
        owned_metadata(&parent, true)?;
    }
    let raw = String::from_utf8(read_private(
        &parent.join("manifest.json"),
        MAX_MANIFEST as u64,
    )?)
    .map_err(|_| held("invalid-manifest"))?;
    let sig = String::from_utf8(read_private(&parent.join("manifest.sig"), 8192)?)
        .map_err(|_| held("invalid-signature"))?;
    let m = verify(Envelope {
        manifest_text: raw,
        signature: sig,
    })?;
    let bytes = read_private(&parent.join("app.tar.gz"), m.app_bytes())?;
    check_app(&m, &bytes, key)?;
    Ok(m)
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StagePointer {
    stage_id: String,
}
pub fn remember_stage(home: &Path, id: &str) -> Result<(), String> {
    need(stage_id(id), "unsafe-stage")?;
    private_dirs(home)?;
    let parent = home.join(".ashlr/updates");
    let path = parent.join("native-stage.json");
    match fs::symlink_metadata(&path) {
        Ok(_) => {
            owned_metadata(&path, false)?;
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(held("unsafe-stage")),
    }
    let temporary = parent.join(format!("native-stage-{}.tmp", random_id()));
    write_new(
        &temporary,
        &serde_json::to_vec(&StagePointer {
            stage_id: id.to_owned(),
        })
        .unwrap(),
    )?;
    let result = fs::rename(&temporary, &path)
        .and_then(|_| fs::File::open(&parent)?.sync_all())
        .map_err(|_| held("stage-write"));
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}
pub fn remembered_stage(home: &Path) -> Result<Option<String>, String> {
    let path = home.join(".ashlr/updates/native-stage.json");
    match fs::symlink_metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(held("unsafe-stage")),
        Ok(_) => {}
    }
    let mut p = home.to_path_buf();
    for part in [".ashlr", "updates"] {
        p.push(part);
        owned_metadata(&p, true)?;
    }
    let pointer: StagePointer =
        serde_json::from_slice(&read_private(&path, 1024)?).map_err(|_| held("unsafe-stage"))?;
    need(stage_id(&pointer.stage_id), "unsafe-stage")?;
    Ok(Some(pointer.stage_id))
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostResult {
    pub schema: String,
    pub state: String,
    pub version: Option<String>,
    pub reason: Option<String>,
    pub requires_reapproval: bool,
}
const HOST_REASONS: &[&str] = &[
    "app-inventory-mismatch",
    "app-source-unverified",
    "applied",
    "artifact-mismatch",
    "artifact-size-refused",
    "authority-changed",
    "authority-reapproval-required",
    "candidate-not-newer",
    "candidate-surface-unverified",
    "current-or-stage-changed",
    "current-version-unverified",
    "download-failed",
    "download-origin-refused",
    "grant-unavailable",
    "incomplete-app-archive",
    "installation-recovery-required",
    "installed-app-unavailable",
    "installed-app-unverified",
    "installed-current-unverified",
    "candidate-identity-regression",
    "invalid-stage",
    "native-parent-changed-or-unknown",
    "native-parent-proof-timeout",
    "native-parent-still-running",
    "native-parent-unverified",
    "operator-restart-required",
    "package-archive-refused",
    "pointer-recovery-unknown",
    "result-persistence-unknown",
    "running-current-mismatch",
    "stage-changed",
    "stop-required",
    "trust-not-commissioned",
    "unknown",
    "unsafe-app-archive",
    "unsafe-installation-path",
    "unsafe-stage",
    "unsupported-installed-runtime",
    "update-attempt-already-recorded",
    "update-result-unverified",
    "update-unavailable",
    "verification-failed",
    "work-active-or-unknown",
];
pub fn host_result(raw: &str, version: &str) -> Result<HostResult, String> {
    need(
        raw.len() <= 64 * 1024 && raw.trim().starts_with('{') && raw.trim().ends_with('}'),
        "host-status-unavailable",
    )?;
    let r: HostResult =
        serde_json::from_str(raw.trim()).map_err(|_| held("host-status-unavailable"))?;
    need(
        r.schema == "phantom-desktop-update-result/v1"
            && [
                "ready",
                "blocked",
                "waiting-native-exit",
                "applied",
                "rollback-held",
                "rolled-back",
            ]
            .contains(&r.state.as_str())
            && r.version.as_deref() == Some(version)
            && r.reason
                .as_ref()
                .map_or(true, |s| HOST_REASONS.contains(&s.as_str()))
            && (r.state != "ready" && r.state != "waiting-native-exit"
                || (!r.requires_reapproval && r.reason.is_none())),
        "host-status-unavailable",
    )?;
    Ok(r)
}
pub fn ready_to_handoff(result: &HostResult) -> bool {
    result.state == "ready" && !result.requires_reapproval && result.reason.is_none()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Value {
        serde_json::from_str(include_str!(
            "../../../test/fixtures/desktop-update-tauri.json"
        ))
        .unwrap()
    }
    #[test]
    fn real_tauri_modern_signature_is_interoperable() {
        let f = fixture();
        verify_minisign(
            f["data"].as_str().unwrap().as_bytes(),
            f["signature"].as_str().unwrap(),
            f["publicKey"].as_str().unwrap(),
        )
        .unwrap();
        assert!(verify_minisign(
            b"changed",
            f["signature"].as_str().unwrap(),
            f["publicKey"].as_str().unwrap()
        )
        .is_err());
    }
    #[test]
    fn modern_signature_requires_authenticated_comment() {
        let f = fixture();
        let raw =
            String::from_utf8(STANDARD.decode(f["signature"].as_str().unwrap()).unwrap()).unwrap();
        let changed = raw.replace("trusted comment: ", "trusted comment: altered ");
        assert!(verify_minisign(
            f["data"].as_str().unwrap().as_bytes(),
            &STANDARD.encode(changed),
            f["publicKey"].as_str().unwrap()
        )
        .is_err());
    }
    #[test]
    fn bound_rejects_overflow_without_appending() {
        let mut b = vec![1, 2];
        extend_download(&mut b, &[3], 3).unwrap();
        assert!(extend_download(&mut b, &[4], 3).is_err());
        assert_eq!(b, vec![1, 2, 3]);
        assert!(extend_download(&mut b, &[], MAX_APP + 1).is_err());
    }
    #[test]
    fn only_fixed_status_request_is_allowed() {
        assert!(status_request(r#"{"op":"status"}"#));
        for raw in [
            r#"{"op":"install"}"#,
            r#"{"op":"status","stage":"abc"}"#,
            "null",
            "[]",
        ] {
            assert!(!status_request(raw));
        }
    }
    #[test]
    fn host_ack_cannot_claim_success_or_new_authority() {
        let good = r#"{"schema":"phantom-desktop-update-result/v1","state":"waiting-native-exit","version":"3.25.2","reason":null,"requiresReapproval":false}"#;
        assert_eq!(
            host_result(good, "3.25.2").unwrap().state,
            "waiting-native-exit"
        );
        assert!(!ready_to_handoff(&host_result(good, "3.25.2").unwrap()));
        assert!(host_result(&good.replace("false", "true"), "3.25.2").is_err());
        assert!(host_result(good, "3.25.3").is_err());
        assert!(host_result(&good.replace("null", r#""private error""#), "3.25.2").is_err());
        let regression = good
            .replace("waiting-native-exit", "held")
            .replace("null", r#""candidate-identity-regression""#);
        let result = host_result(&regression, "3.25.2").unwrap();
        assert_eq!(
            result.reason.as_deref(),
            Some("candidate-identity-regression")
        );
        assert!(!ready_to_handoff(&result));
    }
    #[test]
    fn stage_ids_and_versions_are_closed() {
        assert!(stage_id(&"a".repeat(32)));
        for id in ["../escape", "A0000000000000000000000000000000", ""] {
            assert!(!stage_id(id));
        }
        assert_eq!(stable_version("3.25.2"), Some([3, 25, 2]));
        for v in [
            "3.25.2-beta",
            "03.25.2",
            "3.25",
            "3.25.2.0",
            "9007199254740992.1.1",
        ] {
            assert_eq!(stable_version(v), None);
        }
    }
    #[test]
    fn state_never_exposes_stage_or_path() {
        let s = UpdateState::default();
        let raw = serde_json::to_value(&s).unwrap();
        assert_eq!(raw.as_object().unwrap().len(), 6);
        assert!(state_script(&s).contains("__ASHLR_UPDATE_STATE__"));
        assert!(!state_script(&s).contains("staged/"));
    }
    fn canonical(mut v: Value) -> String {
        sorted(&mut v);
        serde_json::to_string(&v).unwrap()
    }
    fn manifest_fixture() -> Value {
        let f = fixture();
        let sig = f["signature"].as_str().unwrap();
        let h = "a".repeat(64);
        let rev = "b".repeat(40);
        let repo = "ashlrai/ashlr-hub";
        let v = "3.25.2";
        serde_json::json!({"schemaVersion":1,"kind":"phantom-paired-release","channel":"stable","platform":"darwin-aarch64","version":v,
      "repository":{"nameWithOwner":repo,"repositoryId":1263526319u64,"repositoryNodeId":"R_kgDOS0_hrw","ownerId":258113726,"ownerLogin":"ashlrai","defaultBranch":"master"},
      "source":{"revision":rev,"tree":"c".repeat(40)},"authoritySurfaceDigest":h,
      "app":{"filename":format!("Phantom_{v}_aarch64.app.tar.gz"),"url":format!("https://github.com/{repo}/releases/download/v{v}/Phantom_{v}_aarch64.app.tar.gz"),"bytes":42,"sha256":h,"signature":sig,"bundleIdentifier":"ai.ashlr.desktop","executable":"ashlr-desktop","inventorySha256":h,"signer":"D".repeat(40)},
      "cli":{"filename":format!("ashlr-hub-{v}.tgz"),"url":format!("https://github.com/{repo}/releases/download/v{v}/ashlr-hub-{v}.tgz"),"bytes":42,"sha256":h,"signature":sig,"packageName":"@ashlr/hub","binName":"ashlr"},
      "qualification":{"manifestSha256":h,"archiveSha256":h,"packageSha256":h,"qualificationSha256":h,"producer":{"runId":1,"runAttempt":1,"eventSha":rev},"attestor":{"runId":2,"runAttempt":1,"revision":rev},"audit":{"runId":3,"runAttempt":1,"revision":rev}}})
    }
    #[test]
    fn compatible_profiles_reject_every_mixed_identity_tuple() {
        for schema in [1, 2] {
            for repository in ["ashlrai/ashlr-hub", "ashlrai/phantom"] {
                for package in ["@ashlr/hub", "@ashlr/phantom"] {
                    for prefix in ["ashlr-hub", "ashlr-phantom"] {
                        let mut m = manifest_fixture();
                        m["schemaVersion"] = serde_json::json!(schema);
                        m["repository"]["nameWithOwner"] = serde_json::json!(repository);
                        m["cli"]["packageName"] = serde_json::json!(package);
                        m["cli"]["filename"] = serde_json::json!(format!("{prefix}-3.25.2.tgz"));
                        for kind in ["app", "cli"] {
                            m[kind]["url"] = serde_json::json!(format!(
                                "https://github.com/{repository}/releases/download/v3.25.2/{}",
                                m[kind]["filename"].as_str().unwrap()
                            ));
                        }
                        let expected = (schema == 1
                            && repository == "ashlrai/ashlr-hub"
                            && package == "@ashlr/hub"
                            && prefix == "ashlr-hub")
                            || (schema == 2
                                && repository == "ashlrai/phantom"
                                && package == "@ashlr/phantom"
                                && prefix == "ashlr-phantom");
                        let raw = canonical(m);
                        assert_eq!(parse_compatible_manifest(&raw).is_ok(), expected);
                        if schema == 2 {
                            assert!(parse_manifest(&raw, repository).is_err());
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn compatible_profiles_preserve_closed_fields_and_original_bytes() {
        let m = manifest_fixture();
        let raw = canonical(m.clone());
        assert_eq!(
            parse_compatible_manifest(&raw).unwrap(),
            parse_manifest(&raw, "ashlrai/ashlr-hub").unwrap()
        );
        for (pointer, value) in [
            ("/schemaVersion", serde_json::json!(3)),
            (
                "/repository/nameWithOwner",
                serde_json::json!("attacker/phantom"),
            ),
            ("/repository/repositoryId", serde_json::json!(1)),
            ("/repository/repositoryNodeId", serde_json::json!("R_other")),
            ("/repository/ownerId", serde_json::json!(1)),
            ("/repository/ownerLogin", serde_json::json!("attacker")),
            ("/repository/defaultBranch", serde_json::json!("other")),
            ("/cli/binName", serde_json::json!("phm")),
            ("/channel", serde_json::json!("preview")),
            ("/platform", serde_json::json!("darwin-x86_64")),
        ] {
            let mut changed = m.clone();
            *changed.pointer_mut(pointer).unwrap() = value;
            assert!(parse_compatible_manifest(&canonical(changed)).is_err());
        }
        let mut extra = m;
        extra["profile"] = serde_json::json!("canonical");
        assert!(parse_compatible_manifest(&canonical(extra)).is_err());
        assert!(parse_compatible_manifest(&(raw.clone() + "\n")).is_err());
        assert!(parse_compatible_manifest(&raw.replacen("{", "{\"schemaVersion\":1,", 1)).is_err());
    }

    #[test]
    fn manifest_is_closed_canonical_exact_repository_and_source() {
        let m = manifest_fixture();
        let raw = canonical(m.clone());
        parse_manifest(&raw, "ashlrai/ashlr-hub").unwrap();
        assert!(parse_manifest(&raw, "ashlrai/phantom").is_err());
        for (pointer, value) in [
            ("/repository/repositoryId", serde_json::json!(1)),
            ("/platform", serde_json::json!("darwin-x86_64")),
            ("/app/bytes", serde_json::json!(MAX_APP + 1)),
            (
                "/qualification/audit/revision",
                serde_json::json!("d".repeat(40)),
            ),
            ("/cli/url", serde_json::json!("https://evil.test/cli.tgz")),
        ] {
            let mut changed = m.clone();
            *changed.pointer_mut(pointer).unwrap() = value;
            assert!(parse_manifest(&canonical(changed), "ashlrai/ashlr-hub").is_err());
        }
        assert!(parse_manifest(&(raw.clone() + "\n"), "ashlrai/ashlr-hub").is_err());
        let duplicate = raw.replacen("{", "{\"schemaVersion\":1,", 1);
        assert!(parse_manifest(&duplicate, "ashlrai/ashlr-hub").is_err());
        let mut extra = m;
        extra["token"] = serde_json::json!("secret");
        assert!(parse_manifest(&canonical(extra), "ashlrai/ashlr-hub").is_err());
    }
    #[test]
    fn public_key_placeholder_and_signature_legacy_are_refused() {
        assert!(validate_public_key("PLACEHOLDER").is_err());
        let f = fixture();
        let lines = wrapped_lines(f["signature"].as_str().unwrap(), 4).unwrap();
        let mut packet = STANDARD.decode(&lines[1]).unwrap();
        packet[1] = b'd';
        let mut changed = lines;
        changed[1] = STANDARD.encode(packet);
        assert!(verify_minisign(
            f["data"].as_str().unwrap().as_bytes(),
            &STANDARD.encode(changed.join("\n")),
            f["publicKey"].as_str().unwrap()
        )
        .is_err());
    }
    #[test]
    fn private_stage_pointer_is_not_authority_and_rejects_symlinks() {
        let p = std::env::temp_dir().join(format!("phantom-update-test-{}", random_id()));
        fs::DirBuilder::new().mode(0o700).create(&p).unwrap();
        assert_eq!(remembered_stage(&p).unwrap(), None);
        remember_stage(&p, &"a".repeat(32)).unwrap();
        assert_eq!(remembered_stage(&p).unwrap(), Some("a".repeat(32)));
        assert!(reload_stage(&p, &"a".repeat(32), "invalid", "ashlrai/ashlr-hub").is_err());
        let pointer = p.join(".ashlr/updates/native-stage.json");
        fs::remove_file(&pointer).unwrap();
        std::os::unix::fs::symlink("/etc/passwd", &pointer).unwrap();
        assert!(remembered_stage(&p).is_err());
        assert!(remember_stage(&p, &"b".repeat(32)).is_err());
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn actual_test_only_signed_paired_stage_round_trips_and_detects_corruption() {
        let f: Value = serde_json::from_str(include_str!(
            "../../../test/fixtures/desktop-update-paired-tauri.json"
        ))
        .unwrap();
        let key = f["publicKey"].as_str().unwrap();
        let envelope: Envelope = serde_json::from_value(f["envelope"].clone()).unwrap();
        let manifest = verify_manifest(envelope, key, "ashlrai/ashlr-hub").unwrap();
        let app = STANDARD.decode(f["appBase64"].as_str().unwrap()).unwrap();
        let home = std::env::temp_dir().join(format!("phantom-signed-stage-test-{}", random_id()));
        fs::DirBuilder::new().mode(0o700).create(&home).unwrap();
        let id = persist_stage(&home, &manifest, &app, key).unwrap();
        remember_stage(&home, &id).unwrap();
        let loaded = reload_stage(&home, &id, key, "ashlrai/ashlr-hub").unwrap();
        assert_eq!(loaded.digest, manifest.digest);
        let app_path = home.join(STAGE_RELATIVE).join(&id).join("app.tar.gz");
        fs::write(&app_path, b"corrupt").unwrap();
        assert!(reload_stage(&home, &id, key, "ashlrai/ashlr-hub").is_err());
        fs::remove_dir_all(home).unwrap();
    }
    #[test]
    fn signature_binds_original_manifest_bytes_before_schema_parse() {
        let f: Value = serde_json::from_str(include_str!(
            "../../../test/fixtures/desktop-update-paired-tauri.json"
        ))
        .unwrap();
        let mut e: Envelope = serde_json::from_value(f["envelope"].clone()).unwrap();
        e.manifest_text.push(' ');
        assert!(verify_manifest(e, f["publicKey"].as_str().unwrap(), "ashlrai/ashlr-hub").is_err());
    }

    #[test]
    fn genuine_signed_profiles_reload_and_bind_discovery_without_endpoint_authority() {
        for raw in [
            include_str!("../../../test/fixtures/desktop-update-paired-tauri.json"),
            include_str!("../../../test/fixtures/desktop-update-paired-phantom-tauri.json"),
        ] {
            let f: Value = serde_json::from_str(raw).unwrap();
            let key = f["publicKey"].as_str().unwrap();
            let envelope: Envelope = serde_json::from_value(f["envelope"].clone()).unwrap();
            let manifest = verify_compatible_manifest(envelope.clone(), key).unwrap();
            let app = STANDARD.decode(f["appBase64"].as_str().unwrap()).unwrap();
            let home =
                std::env::temp_dir().join(format!("phantom-compatible-stage-test-{}", random_id()));
            fs::DirBuilder::new().mode(0o700).create(&home).unwrap();
            let id = persist_stage(&home, &manifest, &app, key).unwrap();
            let loaded = reload_compatible_stage(&home, &id, key).unwrap();
            assert_eq!(loaded.digest, manifest.digest);
            let discovery = serde_json::json!({"version":manifest.version(), "platforms":{"darwin-aarch64":{"url":manifest.app_url(), "signature":manifest.app_signature()}}});
            assert!(discovery_matches(&discovery, &manifest));
            for pointer in [
                "/version",
                "/platforms/darwin-aarch64/url",
                "/platforms/darwin-aarch64/signature",
            ] {
                let mut changed = discovery.clone();
                *changed.pointer_mut(pointer).unwrap() = serde_json::json!("different");
                assert!(!discovery_matches(&changed, &manifest));
            }
            let mut changed = envelope;
            changed.manifest_text.push(' ');
            assert_eq!(
                verify_compatible_manifest(changed, key).unwrap_err(),
                held("invalid-signature")
            );
            if manifest.value["schemaVersion"] == 2 {
                assert!(reload_stage(&home, &id, key, "ashlrai/phantom").is_err());
            }
            fs::write(
                home.join(STAGE_RELATIVE).join(&id).join("app.tar.gz"),
                b"corrupt",
            )
            .unwrap();
            assert!(reload_compatible_stage(&home, &id, key).is_err());
            fs::remove_dir_all(home).unwrap();
        }
    }
}
