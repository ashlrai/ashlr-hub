//! The Parakeet model on disk: where it lives, how it is fetched, how it is
//! verified.
//!
//! NVIDIA Parakeet TDT 0.6B v3, int8 ONNX export (istupakov's, the one
//! `transcribe-rs` targets), pinned to one Hugging Face revision with the
//! SHA-256 of every file. ~670 MB, downloaded on first use into
//! `<app data>/models/parakeet-tdt-0.6b-v3-int8/` (macOS:
//! `~/Library/Application Support/ai.ashlr.desktop/…`).
//!
//! Download: `/usr/bin/curl` per file into `<file>.part` (resumable with
//! `-C -`), progress read from the growing file's size, then streamed
//! through SHA-256 and renamed into place only if it matches. A
//! `verified.json` marker records the revision once every file checked out,
//! so launch-time readiness is a stat, not a 670 MB hash. Nothing here ever
//! executes or loads a file that failed its checksum.

use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

use sha2::{Digest, Sha256};

pub const PARAKEET_DIR: &str = "parakeet-tdt-0.6b-v3-int8";
pub const PARAKEET_REPO: &str = "istupakov/parakeet-tdt-0.6b-v3-onnx";
pub const PARAKEET_REVISION: &str = "8f23f0c03c8761650bdb5b40aaf3e40d2c15f1ce";
const MARKER: &str = "verified.json";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ModelFile {
    pub name: &'static str,
    pub size: u64,
    pub sha256: &'static str,
}

/// Every file `ParakeetModel::load(dir, Int8)` reads.
pub const PARAKEET_FILES: [ModelFile; 5] = [
    ModelFile {
        name: "config.json",
        size: 97,
        sha256: "666903c76b9798caf2c210afd4f6cd60b08a8dbf9800ec8d7a3bc0d2148ac466",
    },
    ModelFile {
        name: "vocab.txt",
        size: 93_939,
        sha256: "d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d",
    },
    ModelFile {
        name: "nemo128.onnx",
        size: 139_764,
        sha256: "a9fde1486ebfcc08f328d75ad4610c67835fea58c73ba57e3209a6f6cf019e9f",
    },
    ModelFile {
        name: "decoder_joint-model.int8.onnx",
        size: 18_202_004,
        sha256: "eea7483ee3d1a30375daedc8ed83e3960c91b098812127a0d99d1c8977667a70",
    },
    ModelFile {
        name: "encoder-model.int8.onnx",
        size: 652_183_999,
        sha256: "6139d2fa7e1b086097b277c7149725edbab89cc7c7ae64b23c741be4055aff09",
    },
];

pub fn total_bytes(files: &[ModelFile]) -> u64 {
    files.iter().map(|f| f.size).sum()
}

pub fn file_url(file: &ModelFile) -> String {
    format!(
        "https://huggingface.co/{PARAKEET_REPO}/resolve/{PARAKEET_REVISION}/{}",
        file.name
    )
}

/// `<app data>/models/parakeet-tdt-0.6b-v3-int8`.
pub fn parakeet_dir(app_data: &Path) -> PathBuf {
    app_data.join("models").join(PARAKEET_DIR)
}

fn marker_body(files: &[ModelFile]) -> String {
    serde_json::json!({
        "repo": PARAKEET_REPO,
        "revision": PARAKEET_REVISION,
        "files": files.iter().map(|f| serde_json::json!({ "name": f.name, "sha256": f.sha256 })).collect::<Vec<_>>(),
    })
    .to_string()
}

/// True when every file is present at its expected size AND the marker says
/// this exact manifest was verified. Cheap: stats only.
pub fn is_installed(dir: &Path, files: &[ModelFile]) -> bool {
    let marker_ok = fs::read_to_string(dir.join(MARKER))
        .map(|raw| raw == marker_body(files))
        .unwrap_or(false);
    marker_ok
        && files.iter().all(|f| {
            fs::metadata(dir.join(f.name))
                .map(|m| m.len() == f.size)
                .unwrap_or(false)
        })
}

pub fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

/// Hash `part` and, only if it matches `file`, move it to its final name.
/// A mismatch deletes the partial so the next attempt starts clean.
pub fn verify_and_install(dir: &Path, file: &ModelFile, part: &Path) -> Result<(), String> {
    let digest = sha256_file(part).map_err(|e| format!("could not read {}: {e}", file.name))?;
    if digest != file.sha256 {
        let _ = fs::remove_file(part);
        return Err(format!(
            "{} failed its checksum (the download was corrupted or tampered with) — try again",
            file.name
        ));
    }
    fs::rename(part, dir.join(file.name)).map_err(|e| format!("could not save {}: {e}", file.name))
}

pub struct Progress {
    pub done: u64,
    pub total: u64,
    pub verifying: bool,
}

/// How a file's bytes reach `<file>.part`. Real: curl. Tests: a copy.
pub trait Fetcher {
    /// Fetch into `part`, resuming if it exists; call `tick` often with the
    /// current size of `part`; stop early (Err) if `cancel` is set.
    fn fetch(
        &self,
        file: &ModelFile,
        part: &Path,
        cancel: &AtomicBool,
        tick: &mut dyn FnMut(u64),
    ) -> Result<(), String>;
}

/// `/usr/bin/curl -fL --retry 3 -C - -o <part> <url>`, polled every 250 ms.
pub struct CurlFetcher;

impl Fetcher for CurlFetcher {
    fn fetch(
        &self,
        file: &ModelFile,
        part: &Path,
        cancel: &AtomicBool,
        tick: &mut dyn FnMut(u64),
    ) -> Result<(), String> {
        let mut child = Command::new("/usr/bin/curl")
            .args([
                "-fsSL",
                "--retry",
                "3",
                "--connect-timeout",
                "20",
                "-C",
                "-",
                "-o",
            ])
            .arg(part)
            .arg(file_url(file))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("could not start curl: {e}"))?;
        loop {
            if cancel.load(Ordering::SeqCst) {
                let _ = child.kill();
                let _ = child.wait();
                return Err("cancelled".into());
            }
            tick(fs::metadata(part).map(|m| m.len()).unwrap_or(0));
            match child.try_wait() {
                Ok(Some(status)) if status.success() => return Ok(()),
                Ok(Some(status)) => {
                    return Err(format!(
                        "downloading {} failed (curl exit {}) — check the network and try again",
                        file.name,
                        status.code().unwrap_or(-1)
                    ))
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(250)),
                Err(e) => return Err(format!("download interrupted: {e}")),
            }
        }
    }
}

/// Fetch and verify every missing file, then write the marker.
pub fn download(
    dir: &Path,
    files: &[ModelFile],
    fetcher: &dyn Fetcher,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(Progress),
) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    // A stale marker must not vouch for a half-replaced set.
    let _ = fs::remove_file(dir.join(MARKER));
    let total = total_bytes(files);
    let mut done_before = 0u64;
    for file in files {
        let target = dir.join(file.name);
        let present = fs::metadata(&target)
            .map(|m| m.len() == file.size)
            .unwrap_or(false);
        if present && sha256_file(&target).ok().as_deref() == Some(file.sha256) {
            done_before += file.size;
            progress(Progress {
                done: done_before,
                total,
                verifying: false,
            });
            continue;
        }
        let _ = fs::remove_file(&target);
        let part = dir.join(format!("{}.part", file.name));
        // A .part longer than the file can only be garbage: restart it.
        if fs::metadata(&part)
            .map(|m| m.len() > file.size)
            .unwrap_or(false)
        {
            let _ = fs::remove_file(&part);
        }
        fetcher.fetch(file, &part, cancel, &mut |bytes| {
            progress(Progress {
                done: done_before + bytes.min(file.size),
                total,
                verifying: false,
            })
        })?;
        progress(Progress {
            done: done_before + file.size,
            total,
            verifying: true,
        });
        verify_and_install(dir, file, &part)?;
        done_before += file.size;
    }
    fs::write(dir.join(MARKER), marker_body(files))
        .map_err(|e| format!("could not write the model marker: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ashlr-voice-model-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn hex(data: &[u8]) -> String {
        Sha256::digest(data)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }

    /// Serves fixed bytes per file name, optionally corrupted; counts calls.
    struct FakeFetcher {
        bodies: Vec<(&'static str, Vec<u8>)>,
        calls: std::cell::Cell<usize>,
    }

    impl Fetcher for FakeFetcher {
        fn fetch(
            &self,
            file: &ModelFile,
            part: &Path,
            cancel: &AtomicBool,
            tick: &mut dyn FnMut(u64),
        ) -> Result<(), String> {
            self.calls.set(self.calls.get() + 1);
            if cancel.load(Ordering::SeqCst) {
                return Err("cancelled".into());
            }
            let body = &self.bodies.iter().find(|(n, _)| *n == file.name).unwrap().1;
            fs::write(part, body).unwrap();
            tick(body.len() as u64);
            Ok(())
        }
    }

    #[test]
    fn the_pinned_manifest_is_well_formed() {
        assert_eq!(PARAKEET_REVISION.len(), 40);
        for f in PARAKEET_FILES {
            assert_eq!(f.sha256.len(), 64, "{}", f.name);
            assert!(f
                .sha256
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
            assert!(file_url(&f).starts_with(
                "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/8f23f0c"
            ));
        }
        let total = total_bytes(&PARAKEET_FILES);
        assert!((600_000_000..750_000_000).contains(&total), "{total}");
        // What transcribe-rs's ParakeetModel::load(dir, Int8) opens.
        let names: Vec<_> = PARAKEET_FILES.iter().map(|f| f.name).collect();
        for needed in [
            "encoder-model.int8.onnx",
            "decoder_joint-model.int8.onnx",
            "nemo128.onnx",
            "vocab.txt",
        ] {
            assert!(names.contains(&needed), "{needed}");
        }
        assert!(parakeet_dir(Path::new("/x")).ends_with("models/parakeet-tdt-0.6b-v3-int8"));
    }

    #[test]
    fn download_verifies_installs_and_marks() {
        let dir = tmp("ok");
        let a = b"alpha".to_vec();
        let b = b"bravo-bravo".to_vec();
        let files = [
            ModelFile {
                name: "a.bin",
                size: a.len() as u64,
                sha256: Box::leak(hex(&a).into_boxed_str()),
            },
            ModelFile {
                name: "b.bin",
                size: b.len() as u64,
                sha256: Box::leak(hex(&b).into_boxed_str()),
            },
        ];
        let fetcher = FakeFetcher {
            bodies: vec![("a.bin", a), ("b.bin", b)],
            calls: 0.into(),
        };
        assert!(!is_installed(&dir, &files));
        let mut seen = Vec::new();
        download(&dir, &files, &fetcher, &AtomicBool::new(false), &mut |p| {
            seen.push((p.done, p.total))
        })
        .unwrap();
        assert!(is_installed(&dir, &files));
        assert_eq!(seen.last(), Some(&(16, 16)));
        assert!(
            seen.windows(2).all(|w| w[0].0 <= w[1].0),
            "progress only grows"
        );
        assert!(!dir.join("a.bin.part").exists());

        // A second run re-uses verified files: nothing is fetched again.
        download(&dir, &files, &fetcher, &AtomicBool::new(false), &mut |_| {}).unwrap();
        assert_eq!(fetcher.calls.get(), 2);

        // A truncated file is no longer "installed".
        fs::write(dir.join("b.bin"), b"bra").unwrap();
        assert!(!is_installed(&dir, &files));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_checksum_mismatch_is_refused_and_leaves_nothing_behind() {
        let dir = tmp("bad");
        let files = [ModelFile {
            name: "m.onnx",
            size: 4,
            sha256: "0000000000000000000000000000000000000000000000000000000000000000",
        }];
        let fetcher = FakeFetcher {
            bodies: vec![("m.onnx", b"evil".to_vec())],
            calls: 0.into(),
        };
        let err =
            download(&dir, &files, &fetcher, &AtomicBool::new(false), &mut |_| {}).unwrap_err();
        assert!(err.contains("checksum"), "{err}");
        assert!(
            !dir.join("m.onnx").exists(),
            "a bad file is never installed"
        );
        assert!(!dir.join("m.onnx.part").exists());
        assert!(!is_installed(&dir, &files));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn cancel_stops_the_download() {
        let dir = tmp("cancel");
        let files = [ModelFile {
            name: "m.onnx",
            size: 1,
            sha256: "0000000000000000000000000000000000000000000000000000000000000000",
        }];
        let fetcher = FakeFetcher {
            bodies: vec![("m.onnx", b"x".to_vec())],
            calls: 0.into(),
        };
        let err =
            download(&dir, &files, &fetcher, &AtomicBool::new(true), &mut |_| {}).unwrap_err();
        assert_eq!(err, "cancelled");
        let _ = fs::remove_dir_all(&dir);
    }
}
