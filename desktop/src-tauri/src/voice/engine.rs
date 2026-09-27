//! The speech-to-text engine seam. Everything above this trait (streaming,
//! post-processing, the page) is engine-agnostic; tests drive it with a fake.

/// Every engine takes 16 kHz mono `f32` samples in `[-1, 1]`
/// (`capture.rs` resamples to this).
pub const SAMPLE_RATE: usize = 16_000;

pub trait SpeechEngine: Send {
    /// Wire id: `parakeet` | `whisper` (`EngineView::id`).
    fn id(&self) -> &'static str;
    /// Pill copy after "Listening · ": "local Parakeet".
    fn label(&self) -> &'static str;
    /// Transcribe one utterance. Called repeatedly on a growing buffer for
    /// partials, so it must be stateless between calls.
    fn transcribe(&mut self, samples: &[f32]) -> Result<String, String>;
    /// How often a partial re-decode is worth it. Parakeet decodes 12 s of
    /// audio in ~0.3 s on an M-series CPU, so ~400 ms; whisper-cli reloads its
    /// model on every call and gets a much slower cadence.
    fn partial_interval_ms(&self) -> u64 {
        400
    }
}

/// Parakeet (and most CTC/TDT models) produce junk or nothing on a sliver of
/// audio; a short utterance is padded with trailing silence up to this.
pub const MIN_DECODE_SAMPLES: usize = SAMPLE_RATE; // 1 s

/// `samples`, padded with silence to [`MIN_DECODE_SAMPLES`] when shorter.
pub fn padded(samples: &[f32]) -> std::borrow::Cow<'_, [f32]> {
    if samples.len() >= MIN_DECODE_SAMPLES {
        std::borrow::Cow::Borrowed(samples)
    } else {
        let mut owned = samples.to_vec();
        owned.resize(MIN_DECODE_SAMPLES, 0.0);
        std::borrow::Cow::Owned(owned)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_audio_is_padded_with_silence_long_audio_is_untouched() {
        let short = vec![0.5f32; 100];
        let p = padded(&short);
        assert_eq!(p.len(), MIN_DECODE_SAMPLES);
        assert_eq!(p[99], 0.5);
        assert_eq!(p[100], 0.0);
        let long = vec![0.1f32; MIN_DECODE_SAMPLES + 5];
        assert!(matches!(padded(&long), std::borrow::Cow::Borrowed(_)));
    }
}
