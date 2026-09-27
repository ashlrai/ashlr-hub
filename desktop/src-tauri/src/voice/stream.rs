//! Streaming on top of a non-streaming engine: re-decode the growing buffer
//! for partials, one final pass on release.
//!
//! Parakeet TDT is an offline model, but it is fast enough (≈0.3 s for 12 s of
//! audio on an M-series CPU) that re-decoding everything captured so far every
//! ~400 ms reads as live text. Two things keep that cheap on long dictation:
//!
//! - **Commit.** Once more than [`StreamConfig::commit_after`] of audio is
//!   uncommitted, the quietest 100 ms frame between `commit_min` and 1 s before
//!   the end is chosen as a cut; the audio before it is decoded ONE last time
//!   and its text frozen. Partials then only re-decode the tail, so their cost
//!   stays bounded however long the operator talks.
//! - **VAD.** A simple energy detector (adaptive noise floor) skips decodes of
//!   pure silence and trims leading/trailing silence before the final pass —
//!   less audio to decode, and no hallucinated words from room noise.
//!
//! Pure logic over `&[f32]` + [`SpeechEngine`]: the worker in `mod.rs` owns the
//! threads, tests here use a fake engine.

use super::engine::{SpeechEngine, SAMPLE_RATE};

#[derive(Clone, Copy, Debug)]
pub struct StreamConfig {
    /// Don't re-decode for partials until at least this much new audio.
    pub min_new_samples: usize,
    /// Commit a prefix once this much audio is uncommitted.
    pub commit_after: usize,
    /// Never cut closer than this to the last commit.
    pub commit_min: usize,
    /// Never cut closer than this to the end of the buffer.
    pub commit_guard: usize,
}

impl Default for StreamConfig {
    fn default() -> Self {
        Self {
            min_new_samples: SAMPLE_RATE / 4,
            commit_after: SAMPLE_RATE * 8,
            commit_min: SAMPLE_RATE * 3,
            commit_guard: SAMPLE_RATE,
        }
    }
}

#[derive(Debug, Default)]
pub struct Stream {
    cfg: StreamConfig,
    committed_text: String,
    committed_until: usize,
    decoded_len: usize,
    last_partial: String,
}

/// Join two transcript pieces with exactly one space.
pub fn join_text(a: &str, b: &str) -> String {
    let (a, b) = (a.trim(), b.trim());
    match (a.is_empty(), b.is_empty()) {
        (true, _) => b.to_string(),
        (_, true) => a.to_string(),
        _ => format!("{a} {b}"),
    }
}

impl Stream {
    pub fn new(cfg: StreamConfig) -> Self {
        Self {
            cfg,
            ..Self::default()
        }
    }

    /// A new partial transcript, or `None` when nothing changed (too little
    /// new audio, only silence, or the same words as last time).
    pub fn partial(
        &mut self,
        audio: &[f32],
        engine: &mut dyn SpeechEngine,
    ) -> Result<Option<String>, String> {
        if audio.len() < self.decoded_len + self.cfg.min_new_samples {
            return Ok(None);
        }
        self.decoded_len = audio.len();
        self.maybe_commit(audio, engine)?;
        let tail = &audio[self.committed_until.min(audio.len())..];
        let text = match vad::trim(tail) {
            Some(speech) => join_text(&self.committed_text, &engine.transcribe(speech)?),
            None => self.committed_text.clone(),
        };
        if text.is_empty() || text == self.last_partial {
            return Ok(None);
        }
        self.last_partial = text.clone();
        Ok(Some(text))
    }

    /// The final transcript of everything captured. Empty when the operator
    /// said nothing.
    pub fn finish(
        &mut self,
        audio: &[f32],
        engine: &mut dyn SpeechEngine,
    ) -> Result<String, String> {
        let tail = &audio[self.committed_until.min(audio.len())..];
        // The final pass errs toward transcribing: if the detector found no
        // speech but there is signal, the engine gets the whole tail (a
        // model returns nothing for noise far more reliably than a VAD
        // spots a whisper).
        let speech = vad::trim(tail).or_else(|| vad::any_signal(tail).then_some(tail));
        let text = match speech {
            Some(speech) => join_text(&self.committed_text, &engine.transcribe(speech)?),
            None => self.committed_text.clone(),
        };
        Ok(text.trim().to_string())
    }

    fn maybe_commit(&mut self, audio: &[f32], engine: &mut dyn SpeechEngine) -> Result<(), String> {
        let uncommitted = audio.len().saturating_sub(self.committed_until);
        if uncommitted < self.cfg.commit_after {
            return Ok(());
        }
        let from = self.committed_until + self.cfg.commit_min;
        let to = audio.len().saturating_sub(self.cfg.commit_guard);
        let Some(cut) = vad::quietest_point(audio, from, to) else {
            return Ok(());
        };
        let segment = &audio[self.committed_until..cut];
        if let Some(speech) = vad::trim(segment) {
            let text = engine.transcribe(speech)?;
            self.committed_text = join_text(&self.committed_text, &text);
        }
        self.committed_until = cut;
        Ok(())
    }

    #[cfg(test)]
    fn committed_until(&self) -> usize {
        self.committed_until
    }
}

/// Energy-based voice activity detection. Deliberately simple — it only has
/// to tell "someone is talking" from "room tone" on a close mic.
pub mod vad {
    use super::SAMPLE_RATE;

    /// 20 ms frames.
    pub const FRAME: usize = SAMPLE_RATE / 50;
    /// Speech must last this many consecutive frames (60 ms) to count.
    const MIN_RUN: usize = 3;
    /// Kept around detected speech so word onsets/offsets are not clipped.
    const PAD: usize = SAMPLE_RATE / 5; // 200 ms
    /// Absolute floor: below this RMS nothing is speech (≈ -50 dBFS).
    pub const ABS_FLOOR: f32 = 0.003;
    /// The threshold never rises above this (≈ -38 dBFS), however loud the
    /// "noise floor" looks: an utterance with no pause at all (push-to-talk,
    /// talking from the first millisecond) has a floor that IS speech.
    const THRESHOLD_CAP: f32 = 0.012;

    pub fn rms(frame: &[f32]) -> f32 {
        if frame.is_empty() {
            return 0.0;
        }
        (frame.iter().map(|s| s * s).sum::<f32>() / frame.len() as f32).sqrt()
    }

    fn frame_energies(samples: &[f32]) -> Vec<f32> {
        samples.chunks(FRAME).map(rms).collect()
    }

    /// Speech threshold: 3× the noise floor (the 10th-percentile frame),
    /// clamped to [`ABS_FLOOR`]..=[`THRESHOLD_CAP`].
    fn threshold(energies: &[f32]) -> f32 {
        let mut sorted: Vec<f32> = energies.to_vec();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let floor = sorted.get(sorted.len() / 10).copied().unwrap_or(0.0);
        (floor * 3.0).clamp(ABS_FLOOR, THRESHOLD_CAP)
    }

    /// Anything at all above the absolute floor (used by the final pass so a
    /// quiet talker the detector missed is still transcribed).
    pub fn any_signal(samples: &[f32]) -> bool {
        samples.chunks(FRAME).any(|f| rms(f) > ABS_FLOOR)
    }

    /// Frame indices of the first and last frame inside a speech run.
    fn speech_span(energies: &[f32]) -> Option<(usize, usize)> {
        let th = threshold(energies);
        let mut first = None;
        let mut last = None;
        let mut run = 0;
        for (i, e) in energies.iter().enumerate() {
            if *e > th {
                run += 1;
                if run >= MIN_RUN {
                    first.get_or_insert(i + 1 - run);
                    last = Some(i);
                }
            } else {
                run = 0;
            }
        }
        Some((first?, last?))
    }

    #[cfg(test)]
    pub fn has_speech(samples: &[f32]) -> bool {
        speech_span(&frame_energies(samples)).is_some()
    }

    /// `samples` with leading/trailing silence removed (200 ms of padding
    /// kept), or `None` if there is no speech at all.
    pub fn trim(samples: &[f32]) -> Option<&[f32]> {
        let (first, last) = speech_span(&frame_energies(samples))?;
        let start = (first * FRAME).saturating_sub(PAD);
        let end = ((last + 1) * FRAME + PAD).min(samples.len());
        Some(&samples[start..end])
    }

    /// Sample index at the centre of the quietest 100 ms window whose start
    /// lies in `from..to` — but only if it is a real PAUSE (well under the
    /// region's typical loudness, or under the absolute floor). `None` when
    /// the range is empty or the talker never paused: cutting mid-word would
    /// split a word between two decodes.
    pub fn quietest_point(samples: &[f32], from: usize, to: usize) -> Option<usize> {
        let window = FRAME * 5;
        let to = to.min(samples.len().saturating_sub(window));
        if from >= to {
            return None;
        }
        let mut best = (f32::MAX, from);
        let mut energies = Vec::new();
        let mut at = from;
        while at < to {
            let e = rms(&samples[at..at + window]);
            energies.push(e);
            if e < best.0 {
                best = (e, at);
            }
            at += FRAME;
        }
        energies.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let median = energies.get(energies.len() / 2).copied().unwrap_or(0.0);
        let pause = best.0 <= ABS_FLOOR || best.0 <= median * 0.25;
        pause.then_some(best.1 + window / 2)
    }

    /// Meter level 0..=1 for a chunk: -60 dBFS → 0, 0 dBFS → 1.
    pub fn level(samples: &[f32]) -> f32 {
        let r = rms(samples);
        if r <= 1e-6 {
            return 0.0;
        }
        ((20.0 * r.log10() + 60.0) / 60.0).clamp(0.0, 1.0)
    }
}

#[cfg(test)]
mod tests {
    use super::vad::FRAME;
    use super::*;

    /// Transcribes each 0.5 s chunk that carries speech-level audio as one
    /// word `wN` (silence says nothing, as a real model would), so the output
    /// depends on what it was given; records every call's length.
    #[derive(Default)]
    struct Fake {
        calls: Vec<usize>,
        fail: bool,
    }

    impl SpeechEngine for Fake {
        fn id(&self) -> &'static str {
            "fake"
        }
        fn label(&self) -> &'static str {
            "fake"
        }
        fn transcribe(&mut self, samples: &[f32]) -> Result<String, String> {
            self.calls.push(samples.len());
            if self.fail {
                return Err("engine exploded".into());
            }
            let words = samples
                .chunks(SAMPLE_RATE / 2)
                .filter(|chunk| vad::rms(chunk) > 0.01)
                .count();
            Ok((0..words)
                .map(|i| format!("w{i}"))
                .collect::<Vec<_>>()
                .join(" "))
        }
    }

    fn speech(secs: f32) -> Vec<f32> {
        // A 220 Hz tone at -12 dBFS.
        (0..(secs * SAMPLE_RATE as f32) as usize)
            .map(|i| 0.25 * (i as f32 * 220.0 * std::f32::consts::TAU / SAMPLE_RATE as f32).sin())
            .collect()
    }

    fn silence(secs: f32) -> Vec<f32> {
        // Faint room tone, well under the speech threshold.
        (0..(secs * SAMPLE_RATE as f32) as usize)
            .map(|i| if i % 2 == 0 { 0.0005 } else { -0.0005 })
            .collect()
    }

    fn cat(parts: &[Vec<f32>]) -> Vec<f32> {
        parts.iter().flatten().copied().collect()
    }

    #[test]
    fn no_partial_until_enough_new_audio() {
        let mut s = Stream::new(StreamConfig::default());
        let mut e = Fake::default();
        let audio = speech(0.2);
        assert_eq!(s.partial(&audio, &mut e).unwrap(), None);
        assert!(e.calls.is_empty(), "0.2 s is below the 0.25 s step");
        let audio = speech(1.0);
        assert!(s.partial(&audio, &mut e).unwrap().is_some());
        assert_eq!(e.calls.len(), 1);
        // 0.1 s more is not worth a decode.
        let more = cat(&[audio.clone(), speech(0.1)]);
        assert_eq!(s.partial(&more, &mut e).unwrap(), None);
        assert_eq!(e.calls.len(), 1);
    }

    #[test]
    fn partials_grow_and_repeats_are_suppressed() {
        let mut s = Stream::new(StreamConfig::default());
        let mut e = Fake::default();
        let one = speech(1.0);
        let p1 = s.partial(&one, &mut e).unwrap().expect("first partial");
        let two = cat(&[one.clone(), speech(1.0)]);
        let p2 = s.partial(&two, &mut e).unwrap().expect("longer partial");
        assert!(
            p2.split(' ').count() > p1.split(' ').count(),
            "{p1:?} → {p2:?}"
        );
        // New audio that is only silence gives the same words: not re-sent.
        let quiet = cat(&[two.clone(), silence(0.5)]);
        assert_eq!(s.partial(&quiet, &mut e).unwrap(), None);
    }

    #[test]
    fn silence_is_never_decoded_and_finishes_empty() {
        let mut s = Stream::new(StreamConfig::default());
        let mut e = Fake::default();
        let audio = silence(3.0);
        assert_eq!(s.partial(&audio, &mut e).unwrap(), None);
        assert_eq!(s.finish(&audio, &mut e).unwrap(), "");
        assert!(e.calls.is_empty(), "room tone must not reach the engine");
    }

    #[test]
    fn the_final_pass_trims_leading_and_trailing_silence() {
        let mut s = Stream::new(StreamConfig::default());
        let mut e = Fake::default();
        let audio = cat(&[silence(2.0), speech(1.0), silence(2.0)]);
        let text = s.finish(&audio, &mut e).unwrap();
        assert!(!text.is_empty());
        let decoded = *e.calls.last().unwrap();
        // 1 s of speech + at most 200 ms padding each side (+ a frame of slop).
        assert!(decoded >= SAMPLE_RATE, "clipped speech: {decoded}");
        assert!(
            decoded <= SAMPLE_RATE * 14 / 10 + 2 * FRAME,
            "kept silence: {decoded}"
        );
    }

    #[test]
    fn long_dictation_commits_at_a_pause_and_partials_decode_only_the_tail() {
        let cfg = StreamConfig::default();
        let mut s = Stream::new(cfg);
        let mut e = Fake::default();
        // 12 s talk, a clear 1 s pause, 10 s talk: 23 s > commit_after (20 s).
        let audio = cat(&[speech(12.0), silence(1.0), speech(10.0)]);
        let partial = s.partial(&audio, &mut e).unwrap().expect("partial");
        let cut = s.committed_until();
        let pause = (12 * SAMPLE_RATE)..(13 * SAMPLE_RATE);
        assert!(pause.contains(&cut), "cut at {cut}, pause is {pause:?}");
        // Two decodes: the committed prefix once, then only the tail.
        assert_eq!(e.calls.len(), 2);
        assert!(
            e.calls[1] < 11 * SAMPLE_RATE,
            "tail decode was {}",
            e.calls[1]
        );

        // More speech: the committed prefix is NOT decoded again.
        let longer = cat(&[audio.clone(), speech(1.0)]);
        let next = s.partial(&longer, &mut e).unwrap().expect("partial");
        assert_eq!(e.calls.len(), 3);
        assert!(e.calls[2] < 12 * SAMPLE_RATE);
        assert!(next.starts_with(partial.split(" w").next().unwrap()));

        // Final = committed text + a decode of the tail only.
        let text = s.finish(&longer, &mut e).unwrap();
        assert_eq!(e.calls.len(), 4);
        assert!(e.calls[3] < 12 * SAMPLE_RATE);
        let words = text.split(' ').count();
        assert!(
            words >= 40,
            "12 s + 11 s of speech at 2 words/s, got {words}: {text}"
        );
    }

    #[test]
    fn engine_errors_surface() {
        let mut s = Stream::new(StreamConfig::default());
        let mut e = Fake {
            fail: true,
            ..Fake::default()
        };
        let audio = speech(1.0);
        assert_eq!(s.partial(&audio, &mut e).unwrap_err(), "engine exploded");
        assert_eq!(s.finish(&audio, &mut e).unwrap_err(), "engine exploded");
    }

    #[test]
    fn text_is_joined_with_single_spaces() {
        assert_eq!(join_text("", " b "), "b");
        assert_eq!(join_text(" a ", ""), "a");
        assert_eq!(join_text("a.", "b"), "a. b");
        assert_eq!(join_text("", ""), "");
    }

    #[test]
    fn vad_levels_and_quiet_points() {
        assert_eq!(vad::level(&[0.0; 320]), 0.0);
        let loud = vad::level(&speech(0.1));
        assert!(loud > 0.6 && loud <= 1.0, "{loud}");
        assert!(vad::level(&silence(0.1)) < 0.2);
        assert!(vad::has_speech(&speech(0.5)));
        assert!(!vad::has_speech(&silence(0.5)));
        // A 40 ms click is not speech.
        assert!(!vad::has_speech(&cat(&[
            silence(1.0),
            speech(0.04),
            silence(1.0)
        ])));
        let audio = cat(&[speech(2.0), silence(0.5), speech(2.0)]);
        let q = vad::quietest_point(&audio, 0, audio.len()).unwrap();
        assert!(
            (2 * SAMPLE_RATE..2 * SAMPLE_RATE + SAMPLE_RATE / 2).contains(&q),
            "{q}"
        );
        assert_eq!(vad::quietest_point(&audio, 10, 10), None);
        // Nonstop talking has no pause to cut at.
        assert_eq!(vad::quietest_point(&speech(5.0), 0, 5 * SAMPLE_RATE), None);
    }
}
