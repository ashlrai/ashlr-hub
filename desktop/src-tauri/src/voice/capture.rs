//! Microphone capture: the default input device through CoreAudio (`cpal`),
//! downmixed to mono and resampled to 16 kHz for the engine.
//!
//! The `cpal::Stream` is not `Send` on every backend, so it lives on its own
//! thread for its whole life; [`Capture`] only holds a stop channel. The audio
//! callback does the minimum — downmix, resample, append under a mutex,
//! publish a meter level through an atomic — and never touches the webview.

use std::sync::{
    atomic::{AtomicU32, Ordering},
    Arc, Mutex,
};

use super::engine::SAMPLE_RATE;

/// Downmix interleaved frames to mono by averaging channels.
pub fn downmix(interleaved: &[f32], channels: usize, out: &mut Vec<f32>) {
    if channels <= 1 {
        out.extend_from_slice(interleaved);
        return;
    }
    out.extend(
        interleaved
            .chunks_exact(channels)
            .map(|frame| frame.iter().sum::<f32>() / channels as f32),
    );
}

/// Streaming resampler to 16 kHz: a moving-average low-pass sized to the
/// decimation ratio (anti-aliasing for 44.1/48/96 kHz mics), then linear
/// interpolation. Plenty for speech recognition; state carries across
/// callbacks so chunk boundaries are seamless.
#[derive(Debug)]
pub struct Resampler {
    step: f64,
    pos: f64,
    pending: Vec<f32>,
    taps: usize,
    history: std::collections::VecDeque<f32>,
    sum: f32,
}

impl Resampler {
    pub fn new(input_rate: u32) -> Self {
        let step = f64::from(input_rate.max(1)) / SAMPLE_RATE as f64;
        let taps = step.round().max(1.0) as usize;
        Self {
            step,
            pos: 0.0,
            pending: Vec::new(),
            taps,
            history: std::collections::VecDeque::with_capacity(taps),
            sum: 0.0,
        }
    }

    pub fn push(&mut self, input: &[f32], out: &mut Vec<f32>) {
        for &x in input {
            let filtered = if self.taps == 1 {
                x
            } else {
                self.history.push_back(x);
                self.sum += x;
                if self.history.len() > self.taps {
                    self.sum -= self.history.pop_front().unwrap_or(0.0);
                }
                self.sum / self.history.len() as f32
            };
            self.pending.push(filtered);
        }
        while self.pos + 1.0 < self.pending.len() as f64 {
            let i = self.pos.floor() as usize;
            let frac = (self.pos - i as f64) as f32;
            out.push(self.pending[i] * (1.0 - frac) + self.pending[i + 1] * frac);
            self.pos += self.step;
        }
        let consumed = (self.pos.floor() as usize).min(self.pending.len());
        self.pending.drain(..consumed);
        self.pos -= consumed as f64;
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CaptureError {
    /// No default input device (no mic, or it was unplugged).
    NoDevice,
    /// The device refused to open or stream; operator-safe detail.
    Failed(String),
}

/// The live capture. Dropping it (or calling [`Capture::stop`]) stops the
/// stream and joins its thread.
pub struct Capture {
    stop: Option<std::sync::mpsc::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Capture {
    pub fn stop(mut self) {
        self.shutdown();
    }

    fn shutdown(&mut self) {
        if let Some(tx) = self.stop.take() {
            let _ = tx.send(());
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Where captured audio goes: 16 kHz mono samples appended to `samples`, the
/// latest meter level (f32 bits) in `level`.
#[derive(Clone)]
pub struct Sink {
    pub samples: Arc<Mutex<Vec<f32>>>,
    pub level: Arc<AtomicU32>,
}

impl Sink {
    pub fn new() -> Self {
        Self {
            samples: Arc::new(Mutex::new(Vec::with_capacity(SAMPLE_RATE * 30))),
            level: Arc::new(AtomicU32::new(0)),
        }
    }

    pub fn level(&self) -> f32 {
        f32::from_bits(self.level.load(Ordering::Relaxed))
    }

    pub fn snapshot(&self) -> Vec<f32> {
        match self.samples.lock() {
            Ok(guard) => guard.clone(),
            Err(poisoned) => poisoned.into_inner().clone(),
        }
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        match self.samples.lock() {
            Ok(guard) => guard.len(),
            Err(poisoned) => poisoned.into_inner().len(),
        }
    }

    /// Append already-16 kHz mono audio and publish its level.
    pub fn append(&self, mono16k: &[f32]) {
        if mono16k.is_empty() {
            return;
        }
        let level = super::stream::vad::level(mono16k);
        self.level.store(level.to_bits(), Ordering::Relaxed);
        match self.samples.lock() {
            Ok(mut guard) => guard.extend_from_slice(mono16k),
            Err(poisoned) => poisoned.into_inner().extend_from_slice(mono16k),
        }
    }
}

impl Default for Sink {
    fn default() -> Self {
        Self::new()
    }
}

/// Open the default input device and start streaming into `sink`. Returns
/// once the stream is actually running (or failed to start). `on_error` is
/// called from the audio thread if the stream dies later (device unplugged).
#[cfg(target_os = "macos")]
pub fn start(
    sink: Sink,
    on_error: impl Fn(CaptureError) + Send + 'static,
) -> Result<Capture, CaptureError> {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use std::sync::mpsc;

    let (ready_tx, ready_rx) = mpsc::channel::<Result<(), CaptureError>>();
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let thread = std::thread::Builder::new()
        .name("ashlr-voice-capture".into())
        .spawn(move || {
            let host = cpal::default_host();
            let Some(device) = host.default_input_device() else {
                let _ = ready_tx.send(Err(CaptureError::NoDevice));
                return;
            };
            let config = match device.default_input_config() {
                Ok(config) => config,
                Err(e) => {
                    let _ = ready_tx.send(Err(CaptureError::Failed(e.to_string())));
                    return;
                }
            };
            let channels = usize::from(config.channels());
            let rate = config.sample_rate();
            let format = config.sample_format();
            let mut resampler = Resampler::new(rate);
            // Reused across callbacks: no allocation on the audio thread once
            // the buffers have grown to the device's callback size.
            let mut conv: Vec<f32> = Vec::new();
            let mut mono = Vec::new();
            let mut out = Vec::new();
            let stream_config: cpal::StreamConfig = config.into();
            let err = move |e: cpal::Error| on_error(CaptureError::Failed(e.to_string()));

            macro_rules! build {
                ($t:ty) => {
                    device.build_input_stream::<$t, _, _>(
                        stream_config,
                        move |data: &[$t], _: &cpal::InputCallbackInfo| {
                            use cpal::Sample;
                            mono.clear();
                            out.clear();
                            conv.clear();
                            conv.extend(data.iter().map(|s| s.to_sample::<f32>()));
                            downmix(&conv, channels, &mut mono);
                            resampler.push(&mono, &mut out);
                            sink.append(&out);
                        },
                        err,
                        None,
                    )
                };
            }
            let stream = match format {
                cpal::SampleFormat::F32 => build!(f32),
                cpal::SampleFormat::I16 => build!(i16),
                cpal::SampleFormat::I32 => build!(i32),
                cpal::SampleFormat::U16 => build!(u16),
                other => {
                    let _ = ready_tx.send(Err(CaptureError::Failed(format!(
                        "unsupported input sample format {other:?}"
                    ))));
                    return;
                }
            };
            let stream = match stream {
                Ok(stream) => stream,
                Err(e) => {
                    let _ = ready_tx.send(Err(CaptureError::Failed(e.to_string())));
                    return;
                }
            };
            if let Err(e) = stream.play() {
                let _ = ready_tx.send(Err(CaptureError::Failed(e.to_string())));
                return;
            }
            let _ = ready_tx.send(Ok(()));
            // Park until told to stop (or the owner vanished); dropping the
            // stream stops CoreAudio.
            let _ = stop_rx.recv();
            drop(stream);
        })
        .map_err(|e| CaptureError::Failed(e.to_string()))?;

    match ready_rx.recv_timeout(std::time::Duration::from_secs(5)) {
        Ok(Ok(())) => Ok(Capture {
            stop: Some(stop_tx),
            thread: Some(thread),
        }),
        Ok(Err(e)) => {
            let _ = thread.join();
            Err(e)
        }
        Err(_) => {
            let _ = stop_tx.send(());
            Err(CaptureError::Failed(
                "the microphone did not start within 5 s".into(),
            ))
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub fn start(
    _sink: Sink,
    _on_error: impl Fn(CaptureError) + Send + 'static,
) -> Result<Capture, CaptureError> {
    Err(CaptureError::Failed(
        "dictation is only available on macOS".into(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stereo_is_averaged_to_mono() {
        let mut out = Vec::new();
        downmix(&[1.0, 0.0, 0.5, 0.5, -1.0, 1.0], 2, &mut out);
        assert_eq!(out, vec![0.5, 0.5, 0.0]);
        let mut mono = Vec::new();
        downmix(&[0.1, 0.2], 1, &mut mono);
        assert_eq!(mono, vec![0.1, 0.2]);
    }

    fn resample_all(rate: u32, input: &[f32], chunk: usize) -> Vec<f32> {
        let mut r = Resampler::new(rate);
        let mut out = Vec::new();
        for part in input.chunks(chunk) {
            r.push(part, &mut out);
        }
        out
    }

    #[test]
    fn common_mic_rates_come_out_at_16k() {
        for rate in [16_000u32, 44_100, 48_000, 96_000] {
            let input = vec![0.25f32; rate as usize]; // 1 s of DC
            let out = resample_all(rate, &input, 512);
            let expected = SAMPLE_RATE as f64;
            assert!(
                (out.len() as f64 - expected).abs() <= 2.0,
                "{rate} Hz → {} samples",
                out.len()
            );
            // DC passes through the low-pass unchanged (after warm-up).
            assert!(out[100..].iter().all(|s| (s - 0.25).abs() < 1e-4), "{rate}");
        }
    }

    #[test]
    fn chunk_boundaries_do_not_change_the_output() {
        let input: Vec<f32> = (0..48_000).map(|i| ((i as f32) * 0.01).sin()).collect();
        let a = resample_all(48_000, &input, 480);
        let b = resample_all(48_000, &input, 4_096);
        let c = resample_all(48_000, &input, 7);
        assert_eq!(a.len(), b.len());
        assert_eq!(a.len(), c.len());
        for ((x, y), z) in a.iter().zip(&b).zip(&c) {
            assert!((x - y).abs() < 1e-5 && (x - z).abs() < 1e-5);
        }
    }

    #[test]
    fn a_tone_above_nyquist_is_attenuated_at_48k() {
        // 12 kHz aliases badly without a low-pass when decimating 48k → 16k.
        let input: Vec<f32> = (0..48_000)
            .map(|i| 0.5 * (i as f32 * 12_000.0 * std::f32::consts::TAU / 48_000.0).sin())
            .collect();
        let out = resample_all(48_000, &input, 480);
        let rms = super::super::stream::vad::rms(&out[100..]);
        assert!(rms < 0.2, "aliased energy {rms}");
    }

    #[test]
    fn the_sink_appends_and_meters() {
        let sink = Sink::new();
        assert_eq!(sink.level(), 0.0);
        sink.append(&[0.5; 1600]);
        assert_eq!(sink.len(), 1600);
        assert!(sink.level() > 0.8);
        sink.append(&[]);
        assert_eq!(sink.snapshot().len(), 1600);
    }
}
