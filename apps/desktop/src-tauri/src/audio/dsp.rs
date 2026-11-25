//! Pure audio processing (Story 1.4): downmix → anti-aliased resample to 16 kHz → PCM16
//! chunks, plus the bounded utterance buffer used to replay audio on a Scribe retry.

/// Scribe input format (contracts/scribe-realtime.md).
pub const TARGET_RATE: u32 = 16_000;

/// Average interleaved frames to mono.
pub fn downmix(interleaved: &[f32], channels: usize, out: &mut Vec<f32>) {
    if channels <= 1 {
        out.extend_from_slice(interleaved);
        return;
    }
    let inv = 1.0 / channels as f32;
    out.extend(
        interleaved
            .chunks_exact(channels)
            .map(|f| f.iter().sum::<f32>() * inv),
    );
}

/// f32 [-1, 1] → i16 with clipping.
pub fn to_i16(x: f32) -> i16 {
    (x.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16
}

/// Streaming resampler: windowed-sinc low-pass at the source rate (cutoff just below the
/// target Nyquist, so 48/44.1 kHz input doesn't alias into speech), then linear
/// interpolation at the target positions. Stateful across `process` calls.
pub struct Resampler {
    step: f64,
    taps: Vec<f32>,
    history: Vec<f32>,
    filtered: Vec<f32>,
    /// Position of the next output sample, in source samples relative to `filtered[0]`.
    pos: f64,
}

impl Resampler {
    pub fn new(source_rate: u32) -> Self {
        let step = source_rate as f64 / TARGET_RATE as f64;
        let taps = if source_rate > TARGET_RATE {
            // Cutoff 7.2 kHz (0.9 × 8 kHz Nyquist), 63 taps, Blackman window.
            design_lowpass(7_200.0 / source_rate as f64, 63)
        } else {
            vec![1.0]
        };
        Self {
            step,
            history: vec![0.0; taps.len() - 1],
            taps,
            filtered: Vec::new(),
            pos: 0.0,
        }
    }

    /// Feed mono f32 source samples; appends 16 kHz samples to `out`.
    pub fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
        let n = self.taps.len();
        self.history.extend_from_slice(input);
        let available = self.history.len().saturating_sub(n - 1);
        for i in 0..available {
            let window = &self.history[i..i + n];
            let y: f32 = window.iter().zip(&self.taps).map(|(a, b)| a * b).sum();
            self.filtered.push(y);
        }
        self.history.drain(..available);

        while self.pos + 1.0 < self.filtered.len() as f64 {
            let i = self.pos.floor() as usize;
            let frac = (self.pos - i as f64) as f32;
            out.push(self.filtered[i] * (1.0 - frac) + self.filtered[i + 1] * frac);
            self.pos += self.step;
        }
        let consumed = self.pos.floor() as usize;
        let consumed = consumed.min(self.filtered.len());
        self.filtered.drain(..consumed);
        self.pos -= consumed as f64;
    }
}

fn design_lowpass(cutoff: f64, taps: usize) -> Vec<f32> {
    let m = (taps - 1) as f64;
    let mut h: Vec<f64> = (0..taps)
        .map(|i| {
            let x = i as f64 - m / 2.0;
            let sinc = if x == 0.0 {
                2.0 * cutoff
            } else {
                (2.0 * std::f64::consts::PI * cutoff * x).sin() / (std::f64::consts::PI * x)
            };
            let w = 0.42 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / m).cos()
                + 0.08 * (4.0 * std::f64::consts::PI * i as f64 / m).cos();
            sinc * w
        })
        .collect();
    let sum: f64 = h.iter().sum();
    h.iter_mut().for_each(|v| *v /= sum);
    h.into_iter().map(|v| v as f32).collect()
}

/// Splits a 16 kHz stream into fixed-size PCM16 chunks (default 160 ms = 2 560 samples).
pub struct Chunker {
    size: usize,
    pending: Vec<i16>,
}

impl Chunker {
    pub fn new(chunk_ms: u32) -> Self {
        let size = (TARGET_RATE * chunk_ms / 1000) as usize;
        Self {
            size: size.max(1),
            pending: Vec::with_capacity(size),
        }
    }

    pub fn push(&mut self, samples: &[f32], mut emit: impl FnMut(Vec<i16>)) {
        for &s in samples {
            self.pending.push(to_i16(s));
            if self.pending.len() == self.size {
                emit(std::mem::replace(
                    &mut self.pending,
                    Vec::with_capacity(self.size),
                ));
            }
        }
    }

    /// Emit whatever is left (on release) so the tail of speech isn't lost.
    pub fn flush(&mut self, mut emit: impl FnMut(Vec<i16>)) {
        if !self.pending.is_empty() {
            emit(std::mem::take(&mut self.pending));
        }
    }
}

/// Everything captured in the current utterance, capped at `max_seconds`; used for the
/// utterance length reported at release (the Scribe retry replays chunks held by the web
/// side). In memory only and zeroed when cleared (Constitution I).
pub struct UtteranceBuffer {
    max_samples: usize,
    samples: Vec<i16>,
}

impl UtteranceBuffer {
    pub fn new(max_seconds: u32) -> Self {
        Self {
            max_samples: (TARGET_RATE * max_seconds) as usize,
            samples: Vec::new(),
        }
    }

    pub fn extend(&mut self, chunk: &[i16]) {
        let room = self.max_samples.saturating_sub(self.samples.len());
        self.samples
            .extend_from_slice(&chunk[..chunk.len().min(room)]);
    }

    pub fn seconds(&self) -> f32 {
        self.samples.len() as f32 / TARGET_RATE as f32
    }

    #[cfg(test)]
    pub fn is_full(&self) -> bool {
        self.samples.len() >= self.max_samples
    }

    #[cfg(test)]
    pub fn samples(&self) -> &[i16] {
        &self.samples
    }

    pub fn clear(&mut self) {
        self.samples.iter_mut().for_each(|s| *s = 0);
        self.samples.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(freq: f64, rate: u32, seconds: f64) -> Vec<f32> {
        let n = (rate as f64 * seconds) as usize;
        (0..n)
            .map(|i| {
                (2.0 * std::f64::consts::PI * freq * i as f64 / rate as f64).sin() as f32 * 0.5
            })
            .collect()
    }

    /// Goertzel power at `freq` — measures how much of one frequency is in a signal.
    fn power_at(x: &[f32], freq: f64, rate: u32) -> f64 {
        let w = 2.0 * std::f64::consts::PI * freq / rate as f64;
        let c = 2.0 * w.cos();
        let (mut s1, mut s2) = (0.0f64, 0.0f64);
        for &v in x {
            let s = v as f64 + c * s1 - s2;
            s2 = s1;
            s1 = s;
        }
        (s1 * s1 + s2 * s2 - c * s1 * s2) / x.len() as f64
    }

    fn resample_all(input: &[f32], rate: u32, block: usize) -> Vec<f32> {
        let mut r = Resampler::new(rate);
        let mut out = Vec::new();
        for b in input.chunks(block) {
            r.process(b, &mut out);
        }
        out
    }

    #[test]
    fn resamples_48k_to_16k_keeping_a_speech_tone() {
        let out = resample_all(&sine(1_000.0, 48_000, 1.0), 48_000, 480);
        assert!((out.len() as i64 - 16_000).abs() < 40, "len {}", out.len());
        let steady = &out[200..];
        assert!(power_at(steady, 1_000.0, 16_000) > 100.0 * power_at(steady, 3_000.0, 16_000));
    }

    #[test]
    fn resamples_44_1k_to_16k() {
        let out = resample_all(&sine(440.0, 44_100, 1.0), 44_100, 441);
        assert!((out.len() as i64 - 16_000).abs() < 40, "len {}", out.len());
        let steady = &out[200..];
        assert!(power_at(steady, 440.0, 16_000) > 100.0 * power_at(steady, 2_000.0, 16_000));
    }

    #[test]
    fn suppresses_tones_above_8khz_instead_of_aliasing() {
        // A 12 kHz tone at 48 kHz would alias to 4 kHz without the low-pass filter.
        let tone = resample_all(&sine(12_000.0, 48_000, 1.0), 48_000, 480);
        let speech = resample_all(&sine(1_000.0, 48_000, 1.0), 48_000, 480);
        let alias = power_at(&tone[200..], 4_000.0, 16_000);
        let reference = power_at(&speech[200..], 1_000.0, 16_000);
        assert!(alias < reference / 1_000.0, "alias {alias} ref {reference}");
    }

    #[test]
    fn block_size_does_not_change_the_output() {
        let input = sine(700.0, 48_000, 0.5);
        let a = resample_all(&input, 48_000, 480);
        let b = resample_all(&input, 48_000, 1_237);
        assert_eq!(a.len(), b.len());
        for (x, y) in a.iter().zip(&b) {
            assert!((x - y).abs() < 1e-5);
        }
    }

    #[test]
    fn passes_16k_through() {
        let input = sine(500.0, 16_000, 0.1);
        let out = resample_all(&input, 16_000, 160);
        assert!((out.len() as i64 - input.len() as i64).abs() <= 1);
    }

    #[test]
    fn downmixes_stereo() {
        let mut out = Vec::new();
        downmix(&[1.0, 0.0, 0.5, 0.5, -1.0, 1.0], 2, &mut out);
        assert_eq!(out, vec![0.5, 0.5, 0.0]);
    }

    #[test]
    fn converts_and_clips_to_i16() {
        assert_eq!(to_i16(0.0), 0);
        assert_eq!(to_i16(1.5), i16::MAX);
        assert_eq!(to_i16(-1.5), -i16::MAX);
    }

    #[test]
    fn chunks_160ms_and_flushes_the_tail() {
        let mut c = Chunker::new(160);
        let mut chunks = Vec::new();
        c.push(&vec![0.1; 2_560 * 2 + 100], |ch| chunks.push(ch));
        assert_eq!(chunks.len(), 2);
        assert!(chunks.iter().all(|ch| ch.len() == 2_560));
        c.flush(|ch| chunks.push(ch));
        assert_eq!(chunks.last().unwrap().len(), 100);
        c.flush(|ch| chunks.push(ch));
        assert_eq!(chunks.len(), 3);
    }

    #[test]
    fn utterance_buffer_caps_and_clears() {
        let mut b = UtteranceBuffer::new(1);
        b.extend(&vec![7; 10_000]);
        b.extend(&vec![7; 10_000]);
        assert_eq!(b.samples().len(), 16_000);
        assert!(b.is_full());
        assert!((b.seconds() - 1.0).abs() < 1e-6);
        b.clear();
        assert!(b.samples().is_empty());
    }
}
