/// Biquad filter implementation for NeedMusic's equalizer.
///
/// Provides low-shelf, peaking (band), and high-shelf filters
/// that can be chained to create a multi-band EQ.
///
/// Based on the classic RBJ cookbook formulas.

use std::f64::consts::PI;

/// Filter type for a single EQ band.
#[derive(Debug, Clone, Copy, PartialEq)]
#[allow(dead_code)]
pub enum FilterType {
    LowShelf,
    Peaking,
    HighShelf,
}

/// A single biquad filter stage.
#[derive(Debug, Clone)]
pub struct BiquadFilter {
    ftype: FilterType,
    sample_rate: f64,
    freq: f64,
    gain_db: f64,
    q: f64,

    // Coefficients
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,

    // State (per channel)
    x1: Vec<f64>,
    x2: Vec<f64>,
    y1: Vec<f64>,
    y2: Vec<f64>,
}

impl BiquadFilter {
    /// Create a new biquad filter.
    pub fn new(ftype: FilterType, sample_rate: u32, freq: f64, gain_db: f64, q: f64) -> Self {
        let sr = sample_rate as f64;
        let mut f = Self {
            ftype,
            sample_rate: sr,
            freq,
            gain_db,
            q,
            b0: 1.0,
            b1: 0.0,
            b2: 0.0,
            a1: 0.0,
            a2: 0.0,
            x1: Vec::new(),
            x2: Vec::new(),
            y1: Vec::new(),
            y2: Vec::new(),
        };
        f.recalc();
        f
    }

    /// Recalculate filter coefficients.
    pub fn recalc(&mut self) {
        let sr = self.sample_rate;
        let w0 = 2.0 * PI * self.freq / sr;
        let cos_w0 = w0.cos();
        let sin_w0 = w0.sin();
        let a = 10.0_f64.powf(self.gain_db / 40.0);
        let alpha = sin_w0 / (2.0 * self.q);

        match self.ftype {
            FilterType::LowShelf => {
                let sqrt_a = a.sqrt();
                self.b0 = a * ((a + 1.0) - (a - 1.0) * cos_w0 + 2.0 * sqrt_a * alpha);
                self.b1 = 2.0 * a * ((a - 1.0) - (a + 1.0) * cos_w0);
                self.b2 = a * ((a + 1.0) - (a - 1.0) * cos_w0 - 2.0 * sqrt_a * alpha);
                let a0_inv = 1.0 / ((a + 1.0) + (a - 1.0) * cos_w0 + 2.0 * sqrt_a * alpha);
                self.b0 *= a0_inv;
                self.b1 *= a0_inv;
                self.b2 *= a0_inv;
                self.a1 = -2.0 * ((a - 1.0) + (a + 1.0) * cos_w0) * a0_inv;
                self.a2 = ((a + 1.0) + (a - 1.0) * cos_w0 - 2.0 * sqrt_a * alpha) * a0_inv;
            }
            FilterType::Peaking => {
                self.b0 = 1.0 + alpha * a;
                self.b1 = -2.0 * cos_w0;
                self.b2 = 1.0 - alpha * a;
                let a0_inv = 1.0 / (1.0 + alpha / a);
                self.b0 *= a0_inv;
                self.b1 *= a0_inv;
                self.b2 *= a0_inv;
                self.a1 = -2.0 * cos_w0 * a0_inv;
                self.a2 = (1.0 - alpha / a) * a0_inv;
            }
            FilterType::HighShelf => {
                let sqrt_a = a.sqrt();
                self.b0 = a * ((a + 1.0) + (a - 1.0) * cos_w0 + 2.0 * sqrt_a * alpha);
                self.b1 = -2.0 * a * ((a - 1.0) + (a + 1.0) * cos_w0);
                self.b2 = a * ((a + 1.0) + (a - 1.0) * cos_w0 - 2.0 * sqrt_a * alpha);
                let a0_inv = 1.0 / ((a + 1.0) - (a - 1.0) * cos_w0 + 2.0 * sqrt_a * alpha);
                self.b0 *= a0_inv;
                self.b1 *= a0_inv;
                self.b2 *= a0_inv;
                self.a1 = 2.0 * ((a - 1.0) - (a + 1.0) * cos_w0) * a0_inv;
                self.a2 = ((a + 1.0) - (a - 1.0) * cos_w0 - 2.0 * sqrt_a * alpha) * a0_inv;
            }
        }
    }

    /// Ensure state buffers match the channel count.
    fn ensure_channels(&mut self, channels: usize) {
        if self.x1.len() != channels {
            self.x1 = vec![0.0; channels];
            self.x2 = vec![0.0; channels];
            self.y1 = vec![0.0; channels];
            self.y2 = vec![0.0; channels];
        }
    }

    /// Process a single frame of interleaved audio samples.
    pub fn process_frame(&mut self, channels: usize, samples: &mut [f32]) {
        self.ensure_channels(channels);

        for (ch, sample) in samples.iter_mut().enumerate() {
            let x0 = *sample as f64;
            let y0 = self.b0 * x0 + self.b1 * self.x1[ch] + self.b2 * self.x2[ch]
                - self.a1 * self.y1[ch] - self.a2 * self.y2[ch];

            self.x2[ch] = self.x1[ch];
            self.x1[ch] = x0;
            self.y2[ch] = self.y1[ch];
            self.y1[ch] = y0;

            *sample = y0.clamp(-1.0, 1.0) as f32;
        }
    }

    /// Process a buffer of interleaved samples.
    pub fn process(&mut self, channels: usize, data: &mut [f32]) {
        let chunk_size = channels;
        for chunk in data.chunks_exact_mut(chunk_size) {
            self.process_frame(channels, chunk);
        }
    }
}

/// A multi-band equalizer built from biquad filters.
pub struct Equalizer {
    #[allow(dead_code)]
    sample_rate: u32,
    bands: Vec<BiquadFilter>,
    enabled: bool,
}

/// EQ band configuration.
#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize)]
pub struct EqBand {
    pub freq: f64,
    pub gain_db: f64,
    pub q: f64,
}

impl Default for EqBand {
    fn default() -> Self {
        Self { freq: 1000.0, gain_db: 0.0, q: 0.707 }
    }
}

impl Equalizer {
    /// Default 5-band EQ frequencies:
    ///   Sub-bass: 60Hz
    ///   Bass:     250Hz
    ///   Mid:      1000Hz
    ///   Presence: 4000Hz
    ///   Treble:   12000Hz
    pub const DEFAULT_BANDS: [EqBand; 5] = [
        EqBand { freq: 60.0,   gain_db: 0.0, q: 0.7 },
        EqBand { freq: 250.0,  gain_db: 0.0, q: 1.0 },
        EqBand { freq: 1000.0, gain_db: 0.0, q: 1.0 },
        EqBand { freq: 4000.0, gain_db: 0.0, q: 1.0 },
        EqBand { freq: 12000.0,gain_db: 0.0, q: 0.7 },
    ];

    pub fn new(sample_rate: u32) -> Self {
        let bands = Self::DEFAULT_BANDS
            .iter()
            .map(|b| BiquadFilter::new(FilterType::Peaking, sample_rate, b.freq, b.gain_db, b.q))
            .collect();
        Self { sample_rate, bands, enabled: true }
    }

    pub fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    /// Set gains for all bands at once. `gains_db` must have the same length as bands.
    pub fn set_band_gains(&mut self, gains_db: &[f64]) {
        for (i, &gain) in gains_db.iter().enumerate() {
            if i < self.bands.len() {
                self.bands[i].gain_db = gain;
                self.bands[i].recalc();
            }
        }
    }

    /// Set a single band's gain.
    pub fn set_band_gain(&mut self, index: usize, gain_db: f64) {
        if index < self.bands.len() {
            self.bands[index].gain_db = gain_db;
            self.bands[index].recalc();
        }
    }

    /// Get current band gains.
    pub fn get_band_gains(&self) -> Vec<f64> {
        self.bands.iter().map(|b| b.gain_db).collect()
    }

    /// Process an interleaved f32 sample buffer through all EQ bands.
    pub fn process(&mut self, channels: usize, data: &mut [f32]) {
        if !self.enabled || self.bands.iter().all(|b| b.gain_db.abs() < 0.01) {
            return;
        }
        for band in &mut self.bands {
            band.process(channels, data);
        }
    }
}

/// EQ preset definitions for UI selection.
#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize)]
pub struct EqPreset {
    pub name: &'static str,
    pub description: &'static str,
    /// Gain values in dB for each band (5 bands).
    pub gains: [f64; 5],
}

pub const EQ_PRESETS: &[EqPreset] = &[
    EqPreset {
        name: "Flat",
        description: "No adjustment",
        gains: [0.0, 0.0, 0.0, 0.0, 0.0],
    },
    EqPreset {
        name: "Bass Boost",
        description: "Emphasizes drums, bass guitar, and low-end",
        gains: [6.0, 4.0, 0.0, 0.0, 0.0],
    },
    EqPreset {
        name: "Drum Enhancer",
        description: "Boosts subs and presence for punchy drums",
        gains: [5.0, 2.0, -1.0, 3.0, 2.0],
    },
    EqPreset {
        name: "Piano Clarity",
        description: "Brings out piano harmonics and brightness",
        gains: [1.0, 2.0, 3.0, 3.0, 2.0],
    },
    EqPreset {
        name: "Vocal Boost",
        description: "Enhances vocals and mid-range clarity",
        gains: [-1.0, 1.0, 3.0, 2.0, 0.0],
    },
    EqPreset {
        name: "Treble Boost",
        description: "Adds sparkle to cymbals and high frequencies",
        gains: [0.0, 0.0, 0.0, 3.0, 5.0],
    },
    EqPreset {
        name: "Rock",
        description: "Emphasizes guitar crunch and drum punch",
        gains: [3.0, 1.0, -2.0, 2.0, 3.0],
    },
    EqPreset {
        name: "Classical",
        description: "Wide, natural sound for orchestral music",
        gains: [2.0, 1.0, 0.0, 1.0, 2.0],
    },
    EqPreset {
        name: "Electronic",
        description: "Deep bass, crisp highs for EDM",
        gains: [5.0, 3.0, -1.0, 2.0, 4.0],
    },
    EqPreset {
        name: "Hip-Hop",
        description: "Heavy bass and clear vocals",
        gains: [5.0, 3.0, 1.0, 1.0, 2.0],
    },
    EqPreset {
        name: "Jazz",
        description: "Warm tones, smooth mids",
        gains: [2.0, 1.0, 1.0, 1.0, 0.0],
    },
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_biquad_peaking_identity() {
        let mut f = BiquadFilter::new(FilterType::Peaking, 44100, 1000.0, 0.0, 1.0);
        let mut samples = vec![0.5_f32, -0.3, 0.8, 0.1];
        f.process(2, &mut samples);
        // With 0 gain, output should be nearly identical to input
        for (&inp, &out) in [0.5_f32, -0.3, 0.8, 0.1].iter().zip(samples.iter()) {
            assert!((inp - out).abs() < 0.001, "Expected {inp}, got {out}");
        }
    }

    #[test]
    fn test_equalizer_default_flat() {
        let mut eq = Equalizer::new(44100);
        let mut samples = vec![0.5_f32, -0.3, 0.8, 0.1];
        let original = samples.clone();
        eq.process(2, &mut samples);
        for (&orig, &proc) in original.iter().zip(samples.iter()) {
            assert!((orig - proc).abs() < 0.01);
        }
    }
}
