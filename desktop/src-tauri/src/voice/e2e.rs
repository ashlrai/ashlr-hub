//! Opt-in end-to-end checks of the real pipeline, headless (no mic, no UI).
//! Ignored by default — they need a downloaded model or the network, which
//! plain `cargo test` must never touch:
//!
//! ```text
//! ASHLR_PARAKEET_DIR=~/Library/Application\ Support/ai.ashlr.desktop/models/parakeet-tdt-0.6b-v3-int8 \
//! ASHLR_VOICE_WAV=/path/to/16k-mono.wav \
//!   cargo test --release voice::e2e -- --ignored --nocapture
//! ```
//!
//! The WAV is replayed in 20 ms chunks at real time speed through the same
//! `Stream` the session thread uses (partials every 400 ms), then released:
//! what is printed is what dictation would feel like — first partial,
//! partial cost, release → final latency — plus the lexicon pass.

#![cfg(all(test, target_os = "macos"))]

use std::time::{Duration, Instant};

use super::engine::{SpeechEngine, SAMPLE_RATE};
use super::stream::{Stream, StreamConfig};

fn read_wav_16k_mono(path: &str) -> Vec<f32> {
    let bytes = std::fs::read(path).expect("read wav");
    assert_eq!(&bytes[0..4], b"RIFF");
    // Walk the chunks to `fmt ` and `data`.
    let mut at = 12;
    let (mut channels, mut rate, mut bits) = (0u16, 0u32, 0u16);
    while at + 8 <= bytes.len() {
        let id = &bytes[at..at + 4];
        let len = u32::from_le_bytes(bytes[at + 4..at + 8].try_into().unwrap()) as usize;
        let body = &bytes[at + 8..(at + 8 + len).min(bytes.len())];
        if id == b"fmt " {
            channels = u16::from_le_bytes(body[2..4].try_into().unwrap());
            rate = u32::from_le_bytes(body[4..8].try_into().unwrap());
            bits = u16::from_le_bytes(body[14..16].try_into().unwrap());
        } else if id == b"data" {
            assert_eq!(
                (channels, rate, bits),
                (1, 16_000, 16),
                "need 16 kHz mono PCM16"
            );
            return body
                .chunks_exact(2)
                .map(|b| f32::from(i16::from_le_bytes([b[0], b[1]])) / 32768.0)
                .collect();
        }
        at += 8 + len + (len & 1);
    }
    panic!("no data chunk");
}

#[test]
#[ignore = "needs ASHLR_PARAKEET_DIR + ASHLR_VOICE_WAV (a downloaded model)"]
fn parakeet_streams_partials_and_finalises_fast() {
    let dir = std::env::var("ASHLR_PARAKEET_DIR").expect("ASHLR_PARAKEET_DIR");
    let wav = std::env::var("ASHLR_VOICE_WAV").expect("ASHLR_VOICE_WAV");
    let t = Instant::now();
    let mut engine =
        super::parakeet::ParakeetEngine::load(std::path::Path::new(&dir)).expect("load parakeet");
    println!("load: {} ms", t.elapsed().as_millis());
    let audio = read_wav_16k_mono(&wav);
    let mut stream = Stream::new(StreamConfig::default());
    let chunk = SAMPLE_RATE / 50;
    let mut fed = 0;
    let started = Instant::now();
    let mut next_partial = Duration::from_millis(400);
    let mut first_partial = None;
    let mut partial_costs = Vec::new();
    while fed < audio.len() {
        fed = (fed + chunk).min(audio.len());
        // Real time: 20 ms of audio per 20 ms of wall clock.
        let due = Duration::from_millis((fed * 1000 / SAMPLE_RATE) as u64);
        if let Some(wait) = due.checked_sub(started.elapsed()) {
            std::thread::sleep(wait);
        }
        if started.elapsed() >= next_partial {
            next_partial += Duration::from_millis(400);
            let t = Instant::now();
            if let Some(text) = stream.partial(&audio[..fed], &mut engine).unwrap() {
                partial_costs.push(t.elapsed().as_millis());
                first_partial.get_or_insert(started.elapsed().as_millis());
                println!("partial @{:>5} ms: {text}", started.elapsed().as_millis());
            }
        }
    }
    let released = Instant::now();
    let text = stream.finish(&audio, &mut engine).unwrap();
    let final_ms = released.elapsed().as_millis();
    let lexicon = super::lexicon::Lexicon::new(
        super::lexicon::default_serve_config_path(),
        std::env::temp_dir().join("ashlr-voice-e2e-lexicon.json"),
    );
    let t = Instant::now();
    let (normalized, status) = lexicon.normalize(&text, None);
    println!("final (release → text) {final_ms} ms: {text}");
    println!(
        "lexicon {status:?} in {} ms: {normalized}",
        t.elapsed().as_millis()
    );
    println!(
        "audio {} ms · first partial @{:?} ms · partial decode p50/max {:?}/{:?} ms",
        audio.len() * 1000 / SAMPLE_RATE,
        first_partial,
        {
            let mut c = partial_costs.clone();
            c.sort();
            c.get(c.len() / 2).copied()
        },
        partial_costs.iter().max()
    );
    assert!(!text.is_empty());
    assert!(engine.id() == "parakeet");
}

#[test]
#[ignore = "network: fetches the three small Parakeet files from the pinned revision"]
fn the_pinned_small_files_download_and_verify() {
    use super::model::{download, CurlFetcher, PARAKEET_FILES};
    let dir = std::env::temp_dir().join(format!("ashlr-voice-dl-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let small: Vec<_> = PARAKEET_FILES
        .iter()
        .copied()
        .filter(|f| f.size < 1_000_000)
        .collect();
    download(
        &dir,
        &small,
        &CurlFetcher,
        &std::sync::atomic::AtomicBool::new(false),
        &mut |_| {},
    )
    .expect("download + checksum");
    assert!(super::model::is_installed(&dir, &small));
    let _ = std::fs::remove_dir_all(&dir);
}
