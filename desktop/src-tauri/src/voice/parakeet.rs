//! The default engine: NVIDIA Parakeet TDT 0.6B v3 (int8) through
//! `transcribe-rs` / ONNX Runtime, on the CPU.
//!
//! Measured on an M5 Max (release build, 4 threads default): model load
//! ≈0.7 s (once, kept warm), 2 s of audio ≈85 ms, 5 s ≈160 ms, 12 s ≈320 ms.
//! Punctuation and capitalisation come from the model itself.

use std::path::Path;

use transcribe_rs::onnx::{
    parakeet::{ParakeetModel, ParakeetParams},
    Quantization,
};

use super::engine::{padded, SpeechEngine};

pub struct ParakeetEngine {
    model: ParakeetModel,
}

impl ParakeetEngine {
    pub fn load(dir: &Path) -> Result<Self, String> {
        ParakeetModel::load(dir, &Quantization::Int8)
            .map(|model| Self { model })
            .map_err(|e| format!("could not load the Parakeet model: {e}"))
    }
}

impl SpeechEngine for ParakeetEngine {
    fn id(&self) -> &'static str {
        "parakeet"
    }

    fn label(&self) -> &'static str {
        "local Parakeet"
    }

    fn transcribe(&mut self, samples: &[f32]) -> Result<String, String> {
        let audio = padded(samples);
        self.model
            .transcribe_with(&audio, &ParakeetParams::default())
            .map(|result| result.text.trim().to_string())
            .map_err(|e| format!("Parakeet could not transcribe: {e}"))
    }
}
