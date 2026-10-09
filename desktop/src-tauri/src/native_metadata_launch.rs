//! Closed metadata child entry. No GUI, credential lookup or provider selection.
//! The parent admits the current account only after durable child registration.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    ffi::CString,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::{
        fs::{FileTypeExt, MetadataExt, OpenOptionsExt},
        io::FromRawFd,
    },
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

pub const FLAG: &str = "--_phantom-native-metadata-launch";
pub const TICKET_ENV: &str = "PHANTOM_NATIVE_METADATA_TICKET";
const LIMIT: usize = 4096;
type Result<T> = std::result::Result<T, ()>;
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Stamp {
    pub dev: String,
    pub ino: String,
    pub size: String,
    #[serde(rename = "mtimeNs")]
    pub mtime_ns: String,
    #[serde(rename = "ctimeNs")]
    pub ctime_ns: String,
    pub mode: String,
    pub uid: String,
    pub nlink: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Image {
    pub path: String,
    pub sha256: String,
    pub stamp: Stamp,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Owner {
    pub token: String,
    pub pid: i32,
    #[serde(rename = "startRef")]
    pub start_ref: String,
    #[serde(rename = "startRefSource")]
    pub start_ref_source: String,
    pub dev: String,
    pub ino: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Pending {
    pub dev: String,
    pub ino: String,
    #[serde(rename = "bytesDigest")]
    pub bytes_digest: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Boot {
    #[serde(rename = "bootId")]
    pub boot_id: String,
    #[serde(rename = "machineDigest")]
    pub machine_digest: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Root {
    pub dev: String,
    pub ino: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Parent {
    pub pid: i32,
    #[serde(rename = "startRef")]
    pub start_ref: String,
    pub executable: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Ticket {
    #[serde(rename = "schemaVersion")]
    pub schema_version: u32,
    pub scope: String,
    pub id: String,
    pub owner: Owner,
    pub pending: Pending,
    #[serde(rename = "bootIdentity")]
    pub boot_identity: Boot,
    pub root: Root,
    pub host: Image,
    pub parent: Parent,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Reservation {
    id: String,
    phase: String,
    pgid: Option<i32>,
    #[serde(rename = "launchId")]
    launch_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Activity {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    #[serde(rename = "ownerToken")]
    owner_token: String,
    #[serde(rename = "markerDigest")]
    marker_digest: String,
    pending: Root,
    sequence: u64,
    reservations: Vec<Reservation>,
    #[serde(rename = "ownerIdentity")]
    owner_identity: Owner,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Lock {
    token: String,
    pid: i32,
    #[serde(rename = "startRef")]
    start_ref: String,
    #[serde(rename = "startRefSource")]
    start_ref_source: String,
    #[serde(rename = "startRefVerified")]
    start_ref_verified: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Go {
    #[serde(rename = "ticketDigest")]
    ticket_digest: String,
    pid: i32,
    argv: Vec<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Registration<'a> {
    schema_version: u32,
    scope: &'a str,
    ticket_digest: &'a str,
    pid: i32,
    pgid: i32,
    start_ref: String,
    start_ref_source: &'a str,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NotStarted<'a> {
    schema_version: u32,
    scope: &'a str,
    ticket_digest: &'a str,
    registration_digest: &'a str,
}
fn need(v: bool) -> Result<()> {
    if v {
        Ok(())
    } else {
        Err(())
    }
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn hex(s: &str, n: usize) -> bool {
    s.len() == n
        && s.bytes()
            .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v))
}
fn uuid(s: &str) -> bool {
    s.len() == 36
        && s.bytes().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == b'-'
            } else {
                c.is_ascii_digit() || (b'a'..=b'f').contains(&c)
            }
        })
}
fn decimal(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 24
        && s.bytes().all(|v| v.is_ascii_digit())
        && (s.len() == 1 || !s.starts_with('0'))
}
fn stamp(m: &fs::Metadata) -> Stamp {
    Stamp {
        dev: m.dev().to_string(),
        ino: m.ino().to_string(),
        size: m.size().to_string(),
        mtime_ns: (i128::from(m.mtime()) * 1_000_000_000 + i128::from(m.mtime_nsec())).to_string(),
        ctime_ns: (i128::from(m.ctime()) * 1_000_000_000 + i128::from(m.ctime_nsec())).to_string(),
        mode: m.mode().to_string(),
        uid: m.uid().to_string(),
        nlink: m.nlink().to_string(),
    }
}
fn private_directory(p: &Path) -> Result<fs::Metadata> {
    let m = fs::symlink_metadata(p).map_err(|_| ())?;
    need(
        m.is_dir()
            && m.uid() == unsafe { libc::getuid() }
            && m.mode() & 0o777 == 0o700
            && fs::canonicalize(p).map_err(|_| ())? == p,
    )?;
    Ok(m)
}
fn read(p: &Path, max: usize, private: bool) -> Result<(Vec<u8>, fs::Metadata)> {
    let before = fs::symlink_metadata(p).map_err(|_| ())?;
    need(
        before.is_file()
            && before.nlink() == 1
            && before.size() > 0
            && before.size() <= max as u64
            && (!private
                || before.uid() == unsafe { libc::getuid() } && before.mode() & 0o777 == 0o600),
    )?;
    let mut f = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(p)
        .map_err(|_| ())?;
    need(stamp(&before) == stamp(&f.metadata().map_err(|_| ())?))?;
    let mut b = Vec::new();
    (&mut f)
        .take(max as u64 + 1)
        .read_to_end(&mut b)
        .map_err(|_| ())?;
    need(
        !b.is_empty()
            && b.len() <= max
            && stamp(&before) == stamp(&f.metadata().map_err(|_| ())?)
            && stamp(&before) == stamp(&fs::symlink_metadata(p).map_err(|_| ())?),
    )?;
    Ok((b, before))
}
fn write(p: &Path, bytes: &[u8]) -> Result<()> {
    use std::os::unix::io::AsRawFd;
    need(bytes.len() <= LIMIT && !bytes.is_empty())?;
    let parent = p.parent().ok_or(())?;
    let before = private_directory(parent)?;
    let dir = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY)
        .open(parent)
        .map_err(|_| ())?;
    need(
        dir.metadata().map_err(|_| ())?.dev() == before.dev()
            && dir.metadata().map_err(|_| ())?.ino() == before.ino(),
    )?;
    let name = p.file_name().and_then(|s| s.to_str()).ok_or(())?;
    let final_name = CString::new(name).map_err(|_| ())?;
    let temporary =
        CString::new(format!("{name}.tmp-{}", unsafe { libc::getpid() })).map_err(|_| ())?;
    let fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            temporary.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW,
            0o600,
        )
    };
    need(fd >= 0)?;
    let mut file = unsafe { File::from_raw_fd(fd) };
    let outcome = (|| {
        need(unsafe { libc::fchmod(fd, 0o600) } == 0)?;
        file.write_all(bytes).map_err(|_| ())?;
        file.sync_all().map_err(|_| ())?;
        need(
            unsafe {
                libc::linkat(
                    dir.as_raw_fd(),
                    temporary.as_ptr(),
                    dir.as_raw_fd(),
                    final_name.as_ptr(),
                    0,
                )
            } == 0,
        )?;
        need(unsafe { libc::unlinkat(dir.as_raw_fd(), temporary.as_ptr(), 0) } == 0)?;
        dir.sync_all().map_err(|_| ())?;
        let after = private_directory(parent)?;
        need(after.dev() == before.dev() && after.ino() == before.ino())
    })();
    if outcome.is_err() {
        unsafe { libc::unlinkat(dir.as_raw_fd(), temporary.as_ptr(), 0) };
    }
    outcome
}
// Only fixed metadata programs. Bounded wait; no raw argv/env or output is exported.
fn metadata(bin: &str, args: &[String]) -> Result<String> {
    let mut child = Command::new(bin)
        .args(args)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("LANG", "C")
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| ())?;
    let deadline = Instant::now() + Duration::from_secs(1);
    loop {
        match child.try_wait().map_err(|_| ())? {
            Some(status) => {
                need(status.success())?;
                break;
            }
            None => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(());
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        }
    }
    let mut b = Vec::new();
    child
        .stdout
        .take()
        .ok_or(())?
        .take(4097)
        .read_to_end(&mut b)
        .map_err(|_| ())?;
    need(b.len() <= 4096)?;
    Ok(String::from_utf8(b).map_err(|_| ())?.trim().to_string())
}
fn process_start(pid: i32) -> Result<String> {
    need(pid > 0)?;
    let text = metadata(
        "/bin/ps",
        &["-o".into(), "lstart=".into(), "-p".into(), pid.to_string()],
    )?;
    let parts: Vec<_> = text.split_whitespace().collect();
    need(parts.len() == 5)?;
    let month = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ]
    .iter()
    .position(|v| *v == parts[1])
    .ok_or(())?;
    let time: Vec<_> = parts[3].split(':').collect();
    need(time.len() == 3)?;
    let number = |s: &str| s.parse::<i32>().map_err(|_| ());
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    tm.tm_year = number(parts[4])? - 1900;
    tm.tm_mon = month as i32;
    tm.tm_mday = number(parts[2])?;
    tm.tm_hour = number(time[0])?;
    tm.tm_min = number(time[1])?;
    tm.tm_sec = number(time[2])?;
    tm.tm_isdst = -1;
    need(
        tm.tm_year >= 70
            && (1..=31).contains(&tm.tm_mday)
            && (0..24).contains(&tm.tm_hour)
            && (0..60).contains(&tm.tm_min)
            && (0..60).contains(&tm.tm_sec),
    )?;
    let seconds = unsafe { libc::mktime(&mut tm) };
    need(seconds > 0)?;
    Ok(format!("{:064x}", seconds))
}
fn parse_ticket(bytes: &[u8]) -> Result<Ticket> {
    need(!bytes.is_empty() && bytes.len() <= LIMIT)?;
    let t: Ticket = serde_json::from_slice(bytes).map_err(|_| ())?;
    need(
        t.schema_version == 2
            && t.scope == "desktop-native-metadata-launch"
            && uuid(&t.id)
            && uuid(&t.owner.token)
            && t.owner.pid > 0
            && hex(&t.owner.start_ref, 64)
            && t.owner.start_ref_source == "self-clock-epoch-second"
            && hex(&t.pending.bytes_digest, 64)
            && uuid(&t.boot_identity.boot_id)
            && hex(&t.boot_identity.machine_digest, 64)
            && hex(&t.host.sha256, 64)
            && t.parent.pid > 0
            && hex(&t.parent.start_ref, 64)
            && t.parent.executable == t.host.path,
    )?;
    need(
        [
            &t.root.dev,
            &t.root.ino,
            &t.owner.dev,
            &t.owner.ino,
            &t.pending.dev,
            &t.pending.ino,
            &t.host.stamp.dev,
            &t.host.stamp.ino,
            &t.host.stamp.size,
            &t.host.stamp.mtime_ns,
            &t.host.stamp.ctime_ns,
            &t.host.stamp.mode,
            &t.host.stamp.uid,
            &t.host.stamp.nlink,
        ]
        .iter()
        .all(|s| decimal(s)),
    )?;
    need(Path::new(&t.host.path).is_absolute() && !t.host.path.contains('\0'))?;
    Ok(t)
}
fn reservation(root: &Path, t: &Ticket, phase: &str, pid: i32) -> Result<()> {
    let a: Activity = serde_json::from_slice(
        &read(
            &root.join(".resource-quota-refresh-activity.json"),
            LIMIT,
            true,
        )?
        .0,
    )
    .map_err(|_| ())?;
    need(
        a.schema_version == 3
            && a.owner_token == t.owner.token
            && a.owner_identity == t.owner
            && a.pending.dev == t.pending.dev
            && a.pending.ino == t.pending.ino
            && hex(&a.marker_digest, 64)
            && a.sequence <= 9_007_199_254_740_991
            && a.reservations.len() <= 2,
    )?;
    let matches: Vec<_> = a.reservations.iter().filter(|v| v.id == t.id).collect();
    need(matches.len() == 1)?;
    let r = matches[0];
    need(
        r.launch_id.as_deref() == Some(&t.id)
            && r.phase == phase
            && r.pgid
                == if phase == "registered" {
                    Some(pid)
                } else {
                    None
                },
    )
}
fn check(root: &Path, path: &Path, t: &Ticket, digest: &str) -> Result<()> {
    let directory = private_directory(root)?;
    need(
        directory.dev().to_string() == t.root.dev
            && directory.ino().to_string() == t.root.ino
            && hash(&read(path, LIMIT, true)?.0) == digest,
    )?;
    let (p, m) = read(
        &root.join(".resource-quota-refresh-pending.json"),
        LIMIT,
        true,
    )?;
    need(
        m.dev().to_string() == t.pending.dev
            && m.ino().to_string() == t.pending.ino
            && hash(&p) == t.pending.bytes_digest,
    )?;
    let actual = std::env::current_exe().map_err(|_| ())?;
    need(
        actual == Path::new(&t.host.path) && fs::canonicalize(&actual).map_err(|_| ())? == actual,
    )?;
    let before = fs::symlink_metadata(&actual).map_err(|_| ())?;
    need(
        before.is_file()
            && before.nlink() == 1
            && stamp(&before) == t.host.stamp
            && before.mode() & 0o111 != 0,
    )?;
    let mut f = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&actual)
        .map_err(|_| ())?;
    need(stamp(&f.metadata().map_err(|_| ())?) == t.host.stamp)?;
    let mut h = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let n = f.read(&mut buffer).map_err(|_| ())?;
        if n == 0 {
            break;
        }
        h.update(&buffer[..n]);
    }
    need(
        format!("{:x}", h.finalize()) == t.host.sha256
            && stamp(&f.metadata().map_err(|_| ())?) == t.host.stamp
            && stamp(&fs::symlink_metadata(&actual).map_err(|_| ())?) == t.host.stamp,
    )
}
fn owner(root: &Path, t: &Ticket) -> Result<()> {
    need(
        process_start(t.parent.pid)? == t.parent.start_ref
            && metadata(
                "/bin/ps",
                &[
                    "-o".into(),
                    "comm=".into(),
                    "-p".into(),
                    t.parent.pid.to_string(),
                ],
            )? == t.parent.executable,
    )?;
    let (bytes, m) = read(&root.join(".resource-quota-refresh.lock"), LIMIT, true)?;
    let lock: Lock = serde_json::from_slice(&bytes).map_err(|_| ())?;
    need(
        m.dev().to_string() == t.owner.dev
            && m.ino().to_string() == t.owner.ino
            && lock.token == t.owner.token
            && lock.pid == t.owner.pid
            && lock.start_ref == t.owner.start_ref
            && lock.start_ref_source == t.owner.start_ref_source
            && lock.start_ref_verified,
    )?;
    let observed = process_start(lock.pid)?;
    let expected = u64::from_str_radix(&lock.start_ref, 16).map_err(|_| ())?;
    let actual = u64::from_str_radix(&observed, 16).map_err(|_| ())?;
    need(actual.abs_diff(expected) <= 1)?;
    need(
        metadata(
            "/usr/sbin/sysctl",
            &["-n".into(), "kern.bootsessionuuid".into()],
        )?
        .to_lowercase()
            == t.boot_identity.boot_id,
    )
}
fn not_started(
    root: &Path,
    path: &Path,
    t: &Ticket,
    digest: &str,
    registration: &[u8],
) -> Result<()> {
    check(root, path, t, digest)?;
    let receipt = NotStarted {
        schema_version: 1,
        scope: "native-metadata-not-started",
        ticket_digest: digest,
        registration_digest: &hash(registration),
    };
    let mut b = serde_json::to_vec(&receipt).map_err(|_| ())?;
    b.push(b'\n');
    write(
        &PathBuf::from(format!("{}.not-started", path.display())),
        &b,
    )
}
fn run() -> Result<()> {
    let name = std::env::var(TICKET_ENV).map_err(|_| ())?;
    std::env::remove_var(TICKET_ENV);
    let path = PathBuf::from(&name);
    let root = path.parent().ok_or(())?;
    private_directory(root)?;
    let (bytes, _) = read(&path, LIMIT, true)?;
    let t = parse_ticket(&bytes)?;
    need(path == root.join(format!(".resource-quota-launch-{}.json", t.id)))?;
    let digest = hash(&bytes);
    let pid = unsafe { libc::getpid() };
    need(unsafe { libc::getpgrp() } == pid)?;
    check(root, &path, &t, &digest)?;
    // Registration survives owner death before notification. A fresh live owner
    // and native parent are required only for go, never fabricated on recovery.
    need(
        metadata(
            "/usr/sbin/sysctl",
            &["-n".into(), "kern.bootsessionuuid".into()],
        )?
        .to_lowercase()
            == t.boot_identity.boot_id,
    )?;
    reservation(root, &t, "preparing", pid)?;
    // fd3 must be a private full-duplex pipe/socket; fd0 is never consumed here.
    let fd = unsafe { libc::fcntl(3, libc::F_GETFD) };
    need(fd >= 0)?;
    let mut control = unsafe { File::from_raw_fd(3) };
    // Node's Unix stdio pipe is a socketpair, as is the inert native fixture.
    // An inherited regular file is not a private duplex control channel.
    need(control.metadata().map_err(|_| ())?.file_type().is_socket())?;
    let registration = Registration {
        schema_version: 1,
        scope: "native-metadata-child",
        ticket_digest: &digest,
        pid,
        pgid: pid,
        start_ref: process_start(pid)?,
        start_ref_source: "ps-lstart",
    };
    let mut registered = serde_json::to_vec(&registration).map_err(|_| ())?;
    registered.push(b'\n');
    write(
        &PathBuf::from(format!("{}.registered", path.display())),
        &registered,
    )?;
    let result = (|| {
        control
            .write_all(format!("{digest}\n").as_bytes())
            .map_err(|_| ())?;
        let mut packet = Vec::new();
        let mut one = [0u8; 1];
        loop {
            if control.read(&mut one).map_err(|_| ())? == 0 {
                return Err(());
            }
            packet.push(one[0]);
            need(packet.len() <= 1_048_576)?;
            if one[0] == b'\n' {
                break;
            }
        }
        need(control.read(&mut one).map_err(|_| ())? == 0)?;
        let go: Go = serde_json::from_slice(&packet).map_err(|_| ())?;
        need(
            go.ticket_digest == digest
                && go.pid == pid
                && !go.argv.is_empty()
                && Path::new(&go.argv[0]).is_absolute()
                && go.argv.iter().all(|s| !s.contains('\0')),
        )?;
        check(root, &path, &t, &digest)?;
        owner(root, &t)?;
        reservation(root, &t, "registered", pid)?;
        let argv: Vec<CString> = go
            .argv
            .iter()
            .map(|s| CString::new(s.as_bytes()).map_err(|_| ()))
            .collect::<Result<_>>()?;
        let env: Vec<CString> = std::env::vars_os()
            .map(|(k, v)| {
                use std::os::unix::ffi::OsStrExt;
                let mut b = k.as_os_str().as_bytes().to_vec();
                b.push(b'=');
                b.extend_from_slice(v.as_os_str().as_bytes());
                CString::new(b).map_err(|_| ())
            })
            .collect::<Result<_>>()?;
        let mut args: Vec<_> = argv.iter().map(|s| s.as_ptr()).collect();
        args.push(std::ptr::null());
        let mut vars: Vec<_> = env.iter().map(|s| s.as_ptr()).collect();
        vars.push(std::ptr::null());
        drop(control);
        unsafe { libc::execve(argv[0].as_ptr(), args.as_ptr(), vars.as_ptr()) };
        Err(())
    })();
    if result.is_err() {
        let _ = not_started(root, &path, &t, &digest, &registered);
    }
    result
}
/// Some status means this closed entry was selected; callers must exit before GUI init.
pub fn dispatch(args: &[String]) -> Option<i32> {
    if !args.iter().skip(1).any(|v| v == FLAG) {
        return None;
    }
    if args.len() != 2 || args[1] != FLAG {
        return Some(126);
    }
    Some(if run().is_ok() { 0 } else { 126 })
}
#[cfg(test)]
mod tests {
    use super::*;
    fn ticket() -> String {
        format!(
            r#"{{"schemaVersion":2,"scope":"desktop-native-metadata-launch","id":"11111111-1111-4111-8111-111111111111","owner":{{"token":"22222222-2222-4222-8222-222222222222","pid":1,"startRef":"{}","startRefSource":"self-clock-epoch-second","dev":"1","ino":"2"}},"pending":{{"dev":"1","ino":"3","bytesDigest":"{}"}},"bootIdentity":{{"bootId":"33333333-3333-4333-8333-333333333333","machineDigest":"{}"}},"root":{{"dev":"1","ino":"4"}},"host":{{"path":"/Applications/Phantom.app/Contents/MacOS/ashlr-desktop","sha256":"{}","stamp":{{"dev":"1","ino":"5","size":"1","mtimeNs":"1","ctimeNs":"1","mode":"33261","uid":"0","nlink":"1"}}}},"parent":{{"pid":1,"startRef":"{}","executable":"/Applications/Phantom.app/Contents/MacOS/ashlr-desktop"}}}}"#,
            "a".repeat(64),
            "b".repeat(64),
            "c".repeat(64),
            "d".repeat(64),
            "e".repeat(64)
        )
    }
    #[test]
    fn native_child_entry() {
        if let Ok(ticket) = std::env::var(TICKET_ENV) {
            // Test-only startup witness distinguishes a surviving launcher from
            // bootstrap death. It is not registration or parent ready proof.
            let root = Path::new(&ticket).parent().unwrap();
            write(
                &root.join(format!(".inert-child-entered-{}", std::process::id())),
                b"entered",
            )
            .unwrap();
            std::process::exit(dispatch(&["native-fixture".into(), FLAG.into()]).unwrap());
        }
    }
    fn fixture() -> (PathBuf, Ticket, Vec<u8>) {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!(
            "phantom-native-inert-{}-{}-{}",
            std::process::id(),
            {
                static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
                NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            },
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let pid = unsafe { libc::getpid() };
        let start = process_start(pid).unwrap();
        let token = "22222222-2222-4222-8222-222222222222";
        write(&root.join(".resource-quota-refresh.lock"),&serde_json::to_vec(&serde_json::json!({"token":token,"pid":pid,"startRef":start,"startRefSource":"self-clock-epoch-second","startRefVerified":true})).unwrap()).unwrap();
        let lock = fs::symlink_metadata(root.join(".resource-quota-refresh.lock")).unwrap();
        let pending = b"{\"fixture\":true}\n";
        write(&root.join(".resource-quota-refresh-pending.json"), pending).unwrap();
        let pending_stat =
            fs::symlink_metadata(root.join(".resource-quota-refresh-pending.json")).unwrap();
        let exe = std::env::current_exe().unwrap();
        let exe_stat = fs::symlink_metadata(&exe).unwrap();
        let directory = fs::symlink_metadata(&root).unwrap();
        let t = Ticket {
            schema_version: 2,
            scope: "desktop-native-metadata-launch".into(),
            id: "11111111-1111-4111-8111-111111111111".into(),
            owner: Owner {
                token: token.into(),
                pid,
                start_ref: start.clone(),
                start_ref_source: "self-clock-epoch-second".into(),
                dev: lock.dev().to_string(),
                ino: lock.ino().to_string(),
            },
            pending: Pending {
                dev: pending_stat.dev().to_string(),
                ino: pending_stat.ino().to_string(),
                bytes_digest: hash(pending),
            },
            boot_identity: Boot {
                boot_id: metadata(
                    "/usr/sbin/sysctl",
                    &["-n".into(), "kern.bootsessionuuid".into()],
                )
                .unwrap()
                .to_lowercase(),
                machine_digest: "c".repeat(64),
            },
            root: Root {
                dev: directory.dev().to_string(),
                ino: directory.ino().to_string(),
            },
            host: Image {
                path: exe.to_string_lossy().into(),
                sha256: hash(&fs::read(&exe).unwrap()),
                stamp: stamp(&exe_stat),
            },
            parent: Parent {
                pid,
                start_ref: start,
                executable: exe.to_string_lossy().into(),
            },
        };
        let bytes = serde_json::to_vec(&t).unwrap();
        write(
            &root.join(format!(".resource-quota-launch-{}.json", t.id)),
            &bytes,
        )
        .unwrap();
        activity(&root, &t, "preparing", None);
        (root, t, bytes)
    }
    fn activity(root: &Path, t: &Ticket, phase: &str, pid: Option<i32>) {
        use std::os::unix::fs::PermissionsExt;
        let p = root.join(".resource-quota-refresh-activity.json");
        fs::write(&p,serde_json::to_vec(&serde_json::json!({"schemaVersion":3,"ownerToken":t.owner.token,"ownerIdentity":t.owner,"markerDigest":"b".repeat(64),"pending":{"dev":t.pending.dev,"ino":t.pending.ino},"sequence":1,"reservations":[{"id":t.id,"phase":phase,"pgid":pid,"launchId":t.id}]})).unwrap()).unwrap();
        fs::set_permissions(p, fs::Permissions::from_mode(0o600)).unwrap();
    }
    fn child(root: &Path, t: &Ticket) -> (std::process::Child, std::os::unix::net::UnixStream) {
        use std::os::unix::{io::AsRawFd, process::CommandExt};
        let (parent, child) = std::os::unix::net::UnixStream::pair().unwrap();
        let fd = child.as_raw_fd();
        let mut command = Command::new(std::env::current_exe().unwrap());
        let selected = format!(
            "{}::native_child_entry",
            module_path!().split_once("::").unwrap().1
        );
        command
            .args(["--exact", &selected, "--nocapture"])
            .env(
                TICKET_ENV,
                root.join(format!(".resource-quota-launch-{}.json", t.id)),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        unsafe {
            command.pre_exec(move || {
                if libc::setsid() < 0
                    || libc::dup2(fd, 3) < 0
                    || libc::fcntl(3, libc::F_SETFD, 0) < 0
                {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let spawned = command.spawn().unwrap();
        drop(child);
        parent
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        (spawned, parent)
    }
    fn ready(control: &mut std::os::unix::net::UnixStream) -> String {
        let mut b = [0u8; 65];
        control.read_exact(&mut b).unwrap();
        need(b[64] == b'\n').unwrap();
        String::from_utf8(b[..64].to_vec()).unwrap()
    }
    #[test]
    fn compiled_child_execs_same_pid_preserves_stdin_and_removes_private_ticket_env() {
        let (root, t, bytes) = fixture();
        let (mut child, mut control) = child(&root, &t);
        let digest = ready(&mut control);
        assert_eq!(digest, hash(&bytes));
        let reg: serde_json::Value = serde_json::from_slice(
            &read(
                &root.join(format!(".resource-quota-launch-{}.json.registered", t.id)),
                LIMIT,
                true,
            )
            .unwrap()
            .0,
        )
        .unwrap();
        assert_eq!(reg["pid"], child.id());
        assert_eq!(reg["pgid"], child.id());
        assert_eq!(reg["startRef"], process_start(child.id() as i32).unwrap());
        activity(&root, &t, "registered", Some(child.id() as i32));
        control.write_all(format!("{}\n",serde_json::json!({"ticketDigest":digest,"pid":child.id(),"argv":["/bin/sh","-c","printf 'PID=%s TICKET=%s\\n' \"$$\" \"${PHANTOM_NATIVE_METADATA_TICKET-unset}\"; /bin/cat"]})).as_bytes()).unwrap();
        control.shutdown(std::net::Shutdown::Write).unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(b"inert-stdin")
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success());
        let text = String::from_utf8(output.stdout).unwrap();
        assert!(text.contains(&format!("PID={} TICKET=unset", reg["pid"])));
        assert!(text.ends_with("inert-stdin"));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn compiled_regular_fd3_is_refused_before_registration_without_file_writes() {
        use std::os::unix::{io::AsRawFd, process::CommandExt};
        let (root, t, _) = fixture();
        let control = root.join("inert-control");
        fs::write(&control, b"unchanged").unwrap();
        let f = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&control)
            .unwrap();
        let fd = f.as_raw_fd();
        let selected = format!(
            "{}::native_child_entry",
            module_path!().split_once("::").unwrap().1
        );
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args(["--exact", &selected, "--nocapture"])
            .env(
                TICKET_ENV,
                root.join(format!(".resource-quota-launch-{}.json", t.id)),
            )
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        unsafe {
            command.pre_exec(move || {
                if libc::setsid() < 0
                    || libc::dup2(fd, 3) < 0
                    || libc::fcntl(3, libc::F_SETFD, 0) < 0
                {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        assert!(!command.spawn().unwrap().wait().unwrap().success());
        assert_eq!(fs::read(&control).unwrap(), b"unchanged");
        assert!(!root
            .join(format!(".resource-quota-launch-{}.json.registered", t.id))
            .exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn compiled_eof_publishes_not_started_and_never_contacts_target() {
        let (root, t, _) = fixture();
        let (mut child, mut control) = child(&root, &t);
        ready(&mut control);
        control.shutdown(std::net::Shutdown::Write).unwrap();
        assert!(!child.wait().unwrap().success());
        let bytes = read(
            &root.join(format!(".resource-quota-launch-{}.json.not-started", t.id)),
            LIMIT,
            true,
        )
        .unwrap()
        .0;
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["scope"], "native-metadata-not-started");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn compiled_reservation_drift_and_replay_never_execute() {
        let (root, t, _) = fixture();
        let (mut child, mut control) = child(&root, &t);
        let digest = ready(&mut control);
        activity(&root, &t, "registered", Some(child.id() as i32 + 1));
        control.write_all(format!("{}\n",serde_json::json!({"ticketDigest":digest,"pid":child.id(),"argv":["/usr/bin/touch",root.join("contact")]})).as_bytes()).unwrap();
        control.shutdown(std::net::Shutdown::Write).unwrap();
        assert!(!child.wait().unwrap().success());
        assert!(!root.join("contact").exists());
        activity(&root, &t, "preparing", None);
        let (mut replay, mut pipe) = self::child(&root, &t);
        let mut b = [0u8; 1];
        assert_eq!(pipe.read(&mut b).unwrap(), 0);
        assert!(!replay.wait().unwrap().success());
        assert!(!root.join("contact").exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn compiled_two_tickets_share_a_lease_without_invalidating_each_other() {
        let (root, t, _) = fixture();
        let mut second = t.clone();
        second.id = "44444444-4444-4444-8444-444444444444".into();
        write(
            &root.join(format!(".resource-quota-launch-{}.json", second.id)),
            &serde_json::to_vec(&second).unwrap(),
        )
        .unwrap();
        let publish = |a: Option<i32>, b: Option<i32>| {
            fs::write(root.join(".resource-quota-refresh-activity.json"), serde_json::to_vec(&serde_json::json!({
                "schemaVersion":3,"ownerToken":t.owner.token,"ownerIdentity":t.owner,"markerDigest":"b".repeat(64),
                "pending":{"dev":t.pending.dev,"ino":t.pending.ino},"sequence":2,
                "reservations":[{"id":t.id,"phase":if a.is_some(){"registered"}else{"preparing"},"pgid":a,"launchId":t.id},
                {"id":second.id,"phase":if b.is_some(){"registered"}else{"preparing"},"pgid":b,"launchId":second.id}]
            })).unwrap()).unwrap();
        };
        publish(None, None);
        let (mut a, mut pa) = child(&root, &t);
        let (mut b, mut pb) = child(&root, &second);
        let da = ready(&mut pa);
        let db = ready(&mut pb);
        publish(Some(a.id() as i32), Some(b.id() as i32));
        for (child, control, digest) in [(&mut a, &mut pa, da), (&mut b, &mut pb, db)] {
            control.write_all(format!("{}\n",serde_json::json!({"ticketDigest":digest,"pid":child.id(),"argv":["/usr/bin/true"]})).as_bytes()).unwrap();
            control.shutdown(std::net::Shutdown::Write).unwrap();
        }
        assert!(a.wait().unwrap().success());
        assert!(b.wait().unwrap().success());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn compiled_parent_image_boot_and_ticket_drift_never_contact_a_target() {
        for failure in ["parent", "image", "boot", "ticket"] {
            let (root, mut t, _) = fixture();
            // Image/boot refuse before registration; a stale captured parent
            // refuses at go. Ticket mutation after ready stays unknown.
            if failure != "ticket" {
                if failure == "image" {
                    t.host.sha256 = "0".repeat(64);
                } else if failure == "parent" {
                    t.parent.start_ref = "0".repeat(64);
                } else {
                    t.boot_identity.boot_id = "00000000-0000-4000-8000-000000000000".into();
                }
                fs::write(
                    root.join(format!(".resource-quota-launch-{}.json", t.id)),
                    serde_json::to_vec(&t).unwrap(),
                )
                .unwrap();
            }
            let (mut child, mut pipe) = child(&root, &t);
            if failure == "image" || failure == "boot" {
                let mut one = [0u8; 1];
                assert_eq!(pipe.read(&mut one).unwrap(), 0);
                assert!(!child.wait().unwrap().success());
                assert!(!root
                    .join(format!(".resource-quota-launch-{}.json.registered", t.id))
                    .exists());
            } else {
                let digest = ready(&mut pipe);
                activity(&root, &t, "registered", Some(child.id() as i32));
                if failure == "ticket" {
                    fs::write(
                        root.join(format!(".resource-quota-launch-{}.json", t.id)),
                        b"{\"malformed\":true}",
                    )
                    .unwrap();
                }
                pipe.write_all(format!("{}\n",serde_json::json!({"ticketDigest":digest,"pid":child.id(),"argv":["/usr/bin/touch",root.join("contact")]})).as_bytes()).unwrap();
                pipe.shutdown(std::net::Shutdown::Write).unwrap();
                assert!(!child.wait().unwrap().success());
                assert_eq!(
                    root.join(format!(".resource-quota-launch-{}.json.not-started", t.id))
                        .exists(),
                    failure == "parent"
                );
            }
            assert!(!root.join("contact").exists());
            fs::remove_dir_all(root).unwrap();
        }
    }
    #[test]
    fn inert_owner_entry() {
        if let Ok(handoff) = std::env::var("PHANTOM_INERT_HANDOFF") {
            let (root, t, _) = fixture();
            let (child, _control) = child(&root, &t);
            write(
                Path::new(&handoff),
                &serde_json::to_vec(&serde_json::json!({"root":root,"child":child.id()})).unwrap(),
            )
            .unwrap();
            let mut line = String::new();
            std::io::stdin().read_line(&mut line).unwrap();
        }
    }
    #[test]
    fn compiled_owner_death_before_notice_retains_independent_child_registration() {
        use std::os::unix::fs::PermissionsExt;
        let handoff_root = std::env::temp_dir().join(format!(
            "phantom-inert-handoff-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&handoff_root).unwrap();
        fs::set_permissions(&handoff_root, fs::Permissions::from_mode(0o700)).unwrap();
        let handoff_root = fs::canonicalize(handoff_root).unwrap();
        let handoff = handoff_root.join("handoff.json");
        let selected = format!(
            "{}::inert_owner_entry",
            module_path!().split_once("::").unwrap().1
        );
        let mut owner = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", &selected, "--nocapture"])
            .env("PHANTOM_INERT_HANDOFF", &handoff)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while !handoff.exists() {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(5));
        }
        let handoff_value: serde_json::Value =
            serde_json::from_slice(&fs::read(&handoff).unwrap()).unwrap();
        let root = PathBuf::from(handoff_value["root"].as_str().unwrap());
        let pid = handoff_value["child"].as_i64().unwrap() as i32;
        while !root.join(format!(".inert-child-entered-{pid}")).exists() {
            assert!(
                Instant::now() < deadline,
                "native child bootstrap not observed"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        owner.kill().unwrap();
        owner.wait().unwrap();
        let reg = root
            .join(".resource-quota-launch-11111111-1111-4111-8111-111111111111.json.registered");
        let stopped = root
            .join(".resource-quota-launch-11111111-1111-4111-8111-111111111111.json.not-started");
        while !stopped.exists() {
            assert!(
                Instant::now() < deadline,
                "registered={}, groupPresent={}",
                reg.exists(),
                unsafe { libc::kill(-pid, 0) } == 0
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        let value: serde_json::Value =
            serde_json::from_slice(&read(&reg, LIMIT, true).unwrap().0).unwrap();
        assert_eq!(value["pid"], pid);
        assert_eq!(value["pgid"], pid);
        loop {
            let result = unsafe { libc::kill(-pid, 0) };
            let error = std::io::Error::last_os_error().raw_os_error();
            if result == -1 && error == Some(libc::ESRCH) {
                break;
            }
            // A transient EPERM is unknown, never an absence witness. Keep
            // observing within the original budget, without sending a signal.
            assert!(
                Instant::now() < deadline,
                "group absence unconfirmed: result={result}, errno={error:?}"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(!root.join("contact").exists());
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(handoff_root).unwrap();
    }
    #[test]
    fn strict_ticket_refuses_duplicates_unknown_and_node() {
        let b = ticket();
        assert!(parse_ticket(b.as_bytes()).is_ok());
        for bad in [
            b.replacen("{", "{\"schemaVersion\":2,", 1),
            b.replacen("{", "{\"unknown\":1,", 1),
            b.replace("\"pid\":1", "\"pid\":1,\"pid\":2"),
            b.replace("\"schemaVersion\":2", "\"schemaVersion\":1"),
            b.replace("\"nlink\":\"1\"", "\"nlink\":\"01\""),
        ] {
            assert!(parse_ticket(bad.as_bytes()).is_err());
        }
    }
    #[test]
    fn closed_dispatch_never_takes_extra_operands() {
        assert_eq!(dispatch(&["app".into()]), None);
        assert_eq!(
            dispatch(&["app".into(), FLAG.into(), "operand".into()]),
            Some(126)
        );
    }
    #[test]
    fn actual_ps_start_is_epoch_hash() {
        let s = process_start(unsafe { libc::getpid() }).unwrap();
        assert!(hex(&s, 64));
        assert!(u64::from_str_radix(&s, 16).unwrap() > 1);
    }
}
