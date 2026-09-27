//! Fallback engine: whisper.cpp's `whisper-cli`, when the Parakeet model is
//! not installed yet but a whisper binary and a ggml model already are.
//!
//! whisper-cli loads its model on every call, so partials are slow and
//! sparse (every ~1.5 s); the final pass is what matters. The lexicon's
//! `whisper-prompt` export goes in as `--prompt`, which biases whisper toward
//! Mason's spellings. Audio reaches it as a 16-bit WAV in a private temp dir
//! that is removed after every call.

use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

use super::engine::{padded, SpeechEngine, SAMPLE_RATE};

const BIN_CANDIDATES: [&str; 2] = [
    "/opt/homebrew/bin/whisper-cli",
    "/usr/local/bin/whisper-cli",
];
/// Best first. `for-tests-*` models that Homebrew ships are never used.
const MODEL_PREFERENCE: [&str; 8] = [
    "ggml-large-v3-turbo.bin",
    "ggml-large-v3-turbo-q5_0.bin",
    "ggml-medium.en.bin",
    "ggml-medium.bin",
    "ggml-small.en.bin",
    "ggml-small.bin",
    "ggml-base.en.bin",
    "ggml-base.bin",
];

pub fn find_binary() -> Option<PathBuf> {
    BIN_CANDIDATES
        .iter()
        .map(PathBuf::from)
        .find(|p| p.is_file())
}

/// A ggml model: `$ASHLR_WHISPER_MODEL`, else the best-named file in
/// `<app data>/models/whisper/`, `~/.cache/whisper.cpp/` or
/// `/opt/homebrew/share/whisper-cpp/`.
pub fn find_model(app_data: &Path) -> Option<PathBuf> {
    if let Some(explicit) = std::env::var_os("ASHLR_WHISPER_MODEL").map(PathBuf::from) {
        if explicit.is_file() {
            return Some(explicit);
        }
    }
    let mut dirs = vec![app_data.join("models").join("whisper")];
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        dirs.push(home.join(".cache").join("whisper.cpp"));
    }
    dirs.push(PathBuf::from("/opt/homebrew/share/whisper-cpp"));
    pick_model(&dirs)
}

pub fn pick_model(dirs: &[PathBuf]) -> Option<PathBuf> {
    for name in MODEL_PREFERENCE {
        for dir in dirs {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// 16-bit PCM mono WAV bytes.
pub fn wav_bytes(samples: &[f32]) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let rate = SAMPLE_RATE as u32;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for s in samples {
        let v = (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

/// whisper-cli prints one line per segment, sometimes with leading spaces and
/// `[BLANK_AUDIO]`-style markers; join the words.
pub fn clean_output(stdout: &str) -> String {
    stdout
        .lines()
        .map(str::trim)
        .filter(|l| !(l.is_empty() || (l.starts_with('[') && l.ends_with(']'))))
        .collect::<Vec<_>>()
        .join(" ")
}

pub struct WhisperCliEngine {
    bin: PathBuf,
    model: PathBuf,
    prompt: Option<String>,
    scratch: PathBuf,
}

impl WhisperCliEngine {
    pub fn new(bin: PathBuf, model: PathBuf, prompt: Option<String>, scratch: PathBuf) -> Self {
        Self {
            bin,
            model,
            prompt,
            scratch,
        }
    }
}

impl SpeechEngine for WhisperCliEngine {
    fn id(&self) -> &'static str {
        "whisper"
    }

    fn label(&self) -> &'static str {
        "local Whisper"
    }

    fn partial_interval_ms(&self) -> u64 {
        1500
    }

    fn transcribe(&mut self, samples: &[f32]) -> Result<String, String> {
        let _ = std::fs::create_dir_all(&self.scratch);
        let wav = self
            .scratch
            .join(format!("utterance-{}.wav", std::process::id()));
        std::fs::write(&wav, wav_bytes(&padded(samples)))
            .map_err(|e| format!("could not stage audio for whisper: {e}"))?;
        let mut cmd = Command::new(&self.bin);
        cmd.arg("-m")
            .arg(&self.model)
            .arg("-f")
            .arg(&wav)
            .args(["-nt", "-np", "-l", "en"])
            .stdin(Stdio::null())
            .stderr(Stdio::null());
        if let Some(prompt) = &self.prompt {
            cmd.arg("--prompt").arg(prompt);
        }
        let output = cmd.output();
        let _ = std::fs::remove_file(&wav);
        let output = output.map_err(|e| format!("could not run whisper-cli: {e}"))?;
        if !output.status.success() {
            return Err(format!(
                "whisper-cli failed (exit {})",
                output.status.code().unwrap_or(-1)
            ));
        }
        Ok(clean_output(&String::from_utf8_lossy(&output.stdout)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wav_header_is_16k_mono_pcm16() {
        let bytes = wav_bytes(&[0.0, 1.0, -1.0]);
        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(&bytes[8..16], b"WAVEfmt ");
        assert_eq!(
            u32::from_le_bytes(bytes[24..28].try_into().unwrap()),
            16_000
        );
        assert_eq!(u16::from_le_bytes(bytes[22..24].try_into().unwrap()), 1);
        assert_eq!(u32::from_le_bytes(bytes[40..44].try_into().unwrap()), 6);
        assert_eq!(bytes.len(), 44 + 6);
        assert_eq!(i16::from_le_bytes([bytes[46], bytes[47]]), i16::MAX);
    }

    #[test]
    fn output_markers_are_dropped_and_segments_joined() {
        assert_eq!(
            clean_output("  Hello there.\n[BLANK_AUDIO]\n  General Kenobi.\n"),
            "Hello there. General Kenobi."
        );
        assert_eq!(clean_output(""), "");
    }

    #[test]
    fn the_best_model_wins_and_test_models_never_do() {
        let dir = std::env::temp_dir().join(format!("ashlr-whisper-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("for-tests-ggml-base.bin"), b"x").unwrap();
        assert_eq!(pick_model(std::slice::from_ref(&dir)), None);
        std::fs::write(dir.join("ggml-base.en.bin"), b"x").unwrap();
        std::fs::write(dir.join("ggml-small.en.bin"), b"x").unwrap();
        assert_eq!(
            pick_model(std::slice::from_ref(&dir)),
            Some(dir.join("ggml-small.en.bin"))
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
