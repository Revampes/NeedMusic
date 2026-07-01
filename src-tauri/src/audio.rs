/// NativeAudioPlayer — plays audio via rodio/symphonia (WASAPI on Windows).
/// This ensures the Windows volume mixer shows "NeedMusic" instead of
/// "Microsoft Edge WebView2".
///
/// We use symphonia directly for decoding (bypassing rodio's buggy Decoder)
/// and feed raw PCM samples to rodio's Sink via SamplesBuffer.

use rodio::{OutputStreamHandle, Sink, Source};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

use std::io::Cursor;
use std::sync::Mutex;

use crate::audio_eq::Equalizer;

pub struct NativeAudioPlayer {
    stream_handle: OutputStreamHandle,
    sink: Mutex<Option<Sink>>,
    current_path: Mutex<Option<String>>,
    current_duration: Mutex<f64>,
    /// Cached EQ band gains for processing decoded audio.
    eq_gains: Mutex<[f64; 5]>,
    eq_enabled: Mutex<bool>,
}

impl NativeAudioPlayer {
    pub fn new(stream_handle: OutputStreamHandle) -> Self {
        Self {
            stream_handle,
            sink: Mutex::new(None),
            current_path: Mutex::new(None),
            current_duration: Mutex::new(0.0),
            eq_gains: Mutex::new([0.0_f64; 5]),
            eq_enabled: Mutex::new(true),
        }
    }

    /// Set the EQ band gains. Values are in dB.
    pub fn set_eq_gains(&self, gains: [f64; 5]) {
        if let Ok(mut g) = self.eq_gains.lock() {
            *g = gains;
        }
    }

    /// Enable or disable the EQ.
    pub fn set_eq_enabled(&self, enabled: bool) {
        if let Ok(mut e) = self.eq_enabled.lock() {
            *e = enabled;
        }
    }

    fn apply_eq(&self, sample_rate: u32, channels: usize, samples: &mut [f32]) {
        let enabled = self.eq_enabled.lock().map(|e| *e).unwrap_or(true);
        if !enabled {
            return;
        }
        let gains = self.eq_gains.lock().map(|g| *g).unwrap_or([0.0; 5]);
        if gains.iter().all(|&g| g.abs() < 0.01) {
            return;
        }
        let mut eq = Equalizer::new(sample_rate);
        eq.set_band_gains(&gains);
        eq.process(channels, samples);
    }

    /// Decode audio data using symphonia directly into raw f32 PCM samples.
    /// Returns (samples, sample_rate, channels, duration_secs).
    fn decode_with_symphonia(
        data: &[u8],
    ) -> Result<(Vec<f32>, u32, usize, f64), String> {
        let cursor = Cursor::new(data.to_vec());
        let mss = MediaSourceStream::new(Box::new(cursor), Default::default());

        let hint = Hint::new();
        let format_opts = FormatOptions::default();
        let metadata_opts = MetadataOptions::default();
        let decoder_opts = DecoderOptions::default();

        let probed = symphonia::default::get_probe()
            .format(&hint, mss, &format_opts, &metadata_opts)
            .map_err(|e| format!("Format detection failed: {}", e))?;

        let mut format = probed.format;

        // Find the first audio track.
        let track = format
            .tracks()
            .iter()
            .find(|t| t.codec_params.codec != symphonia::core::codecs::CODEC_TYPE_NULL)
            .ok_or("No audio track found in file")?;

        let track_id = track.id;
        let codec_params = track.codec_params.clone();

        let sample_rate = codec_params.sample_rate.unwrap_or(44100);
        let channels = codec_params
            .channels
            .map(|c| c.count())
            .unwrap_or(2);

        let mut decoder = symphonia::default::get_codecs()
            .make(&codec_params, &decoder_opts)
            .map_err(|e| format!("Codec not supported: {}", e))?;

        // Calculate duration from timebase and total frames (if available).
        let duration_secs = if let (Some(tb), Some(frames)) = (
            codec_params.time_base,
            codec_params.n_frames,
        ) {
            frames as f64 * tb.numer as f64 / tb.denom as f64
        } else {
            0.0
        };

        // Decode all packets into f32 samples.
        let mut all_samples: Vec<f32> = Vec::new();

        loop {
            let packet = match format.next_packet() {
                Ok(p) => p,
                Err(symphonia::core::errors::Error::IoError(ref e))
                    if e.kind() == std::io::ErrorKind::UnexpectedEof =>
                {
                    break;
                }
                Err(e) => return Err(format!("Read error: {}", e)),
            };

            if packet.track_id() != track_id {
                continue;
            }

            let decoded = match decoder.decode(&packet) {
                Ok(d) => d,
                Err(e) => {
                    // Skip corrupt packets.
                    eprintln!("[NeedMusic] Decode warning: {}", e);
                    continue;
                }
            };

            let spec = *decoded.spec();
            let num_frames = decoded.frames();
            let mut sample_buf = SampleBuffer::<f32>::new(num_frames as u64, spec);

            // symphonia 0.5: copy_planar_ref instead of copy_interleaved_ref
            sample_buf.copy_interleaved_ref(decoded);

            all_samples.extend_from_slice(sample_buf.samples());
        }

        if all_samples.is_empty() {
            return Err("No audio data decoded".to_string());
        }

        Ok((all_samples, sample_rate, channels, duration_secs))
    }

    pub fn play(&self, file_path: &str) -> Result<(), String> {
        let _ = self.stop();

        let meta = std::fs::metadata(file_path)
            .map_err(|e| format!("Cannot access file: {}", e))?;
        if meta.len() == 0 {
            return Err("Downloaded file is empty. Try again.".to_string());
        }

        let data = std::fs::read(file_path)
            .map_err(|e| format!("Read error: {}", e))?;

        // Decode using symphonia directly — avoids rodio's buggy Decoder.
        let (mut samples, sample_rate, channels, dur) =
            Self::decode_with_symphonia(&data)?;

        // Apply EQ to decoded samples.
        self.apply_eq(sample_rate, channels, &mut samples);

        // Wrap decoded PCM in rodio's SamplesBuffer (implements Source).
        let source = rodio::buffer::SamplesBuffer::new(
            channels as u16,
            sample_rate,
            samples,
        );

        let dur_from_samples = source.total_duration()
            .map(|d| d.as_secs_f64())
            .unwrap_or(0.0);
        let final_dur = if dur > 0.0 { dur } else { dur_from_samples };

        let sink = Sink::try_new(&self.stream_handle)
            .map_err(|e| format!("Sink: {}", e))?;
        sink.append(source);
        sink.play();

        *self.sink.lock().map_err(|e| e.to_string())? = Some(sink);
        *self.current_path.lock().map_err(|e| e.to_string())? =
            Some(file_path.to_string());
        *self.current_duration.lock().map_err(|e| e.to_string())? = final_dur;
        Ok(())
    }

    pub fn pause(&self) -> Result<(), String> {
        if let Ok(g) = self.sink.lock() { if let Some(ref s) = *g { s.pause(); } }
        Ok(())
    }

    pub fn resume(&self) -> Result<(), String> {
        if let Ok(g) = self.sink.lock() { if let Some(ref s) = *g { s.play(); } }
        Ok(())
    }

    pub fn stop(&self) -> Result<(), String> {
        if let Ok(mut g) = self.sink.lock() { if let Some(s) = g.take() { s.stop(); } }
        if let Ok(mut g) = self.current_path.lock() { *g = None; }
        if let Ok(mut g) = self.current_duration.lock() { *g = 0.0; }
        Ok(())
    }

    pub fn set_volume(&self, volume: f32) -> Result<(), String> {
        let v = volume.clamp(0.0, 1.0);
        if let Ok(g) = self.sink.lock() { if let Some(ref s) = *g { s.set_volume(v); } }
        Ok(())
    }

    pub fn seek(&self, secs: f64) -> Result<(), String> {
        let path = self.current_path.lock().map_err(|e| e.to_string())?.clone();
        if let Some(ref p) = path {
            let vol = self.sink.lock().ok()
                .and_then(|g| g.as_ref().map(|s| s.volume()))
                .unwrap_or(1.0);
            self.stop()?;

            let data = std::fs::read(p)
                .map_err(|e| format!("Read error: {}", e))?;

            let (mut samples, sample_rate, channels, metadata_dur) =
                Self::decode_with_symphonia(&data)?;

            // Apply EQ to decoded samples before seeking.
            self.apply_eq(sample_rate, channels, &mut samples);

            // Compute total duration before we consume samples with split_off.
            let total_from_samples = samples.len() as f64
                / (sample_rate as f64 * channels.max(1) as f64);
            let total_dur = if metadata_dur > 0.0 { metadata_dur } else { total_from_samples };

            // Skip to the desired position.
            let skip_frames = (secs.max(0.0) * sample_rate as f64) as usize * channels;
            let skip_frames = skip_frames.min(samples.len());
            let remaining: Vec<f32> = samples.split_off(skip_frames);

            if remaining.is_empty() {
                // Seek past end: restore path so future operations still work,
                // but don't create a sink (nothing to play).
                *self.current_path.lock().map_err(|e| e.to_string())? =
                    Some(p.clone());
                *self.current_duration.lock().map_err(|e| e.to_string())? = total_dur;
                return Ok(());
            }

            let source = rodio::buffer::SamplesBuffer::new(
                channels as u16,
                sample_rate,
                remaining,
            );

            let sink = Sink::try_new(&self.stream_handle)
                .map_err(|e| format!("Sink: {}", e))?;
            sink.set_volume(vol);
            sink.append(source);
            sink.play();
            *self.sink.lock().map_err(|e| e.to_string())? = Some(sink);
            // Restore path and TOTAL duration so subsequent seeks work correctly.
            *self.current_path.lock().map_err(|e| e.to_string())? =
                Some(p.clone());
            *self.current_duration.lock().map_err(|e| e.to_string())? = total_dur;
        }
        Ok(())
    }

    pub fn is_playing(&self) -> bool {
        self.sink.lock().ok().and_then(|g| g.as_ref().map(|s| !s.is_paused() && !s.empty())).unwrap_or(false)
    }

    /// Returns the total duration (seconds) of the currently loaded track, from rodio's decoder.
    pub fn get_duration(&self) -> f64 {
        self.current_duration.lock().ok().map(|d| *d).unwrap_or(0.0)
    }

    /// Returns true if the sink has no more data (track ended).
    /// Returns false when no sink is loaded (e.g. during a seek rebuild)
    /// to avoid false track-end triggers.
    pub fn is_sink_empty(&self) -> bool {
        self.sink.lock().ok().and_then(|g| g.as_ref().map(|s| s.empty())).unwrap_or(false)
    }
}
