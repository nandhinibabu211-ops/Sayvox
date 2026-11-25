//! cpal microphone capture on a dedicated thread.
//!
//! The input stream is built paused at startup so a hotkey press only has to `play()` it
//! (capture starts in milliseconds, Story 1.4). Samples are processed in the cpal callback:
//! downmix → resample → 160 ms PCM16 chunks, which go out on a channel. When not recording
//! the stream is paused, so Windows' "microphone in use" indicator is off between presses.

use super::dsp::{downmix, Chunker, Resampler, UtteranceBuffer};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SampleFormat, SizedSample};
use std::sync::mpsc::{self, Receiver, Sender};

/// Where chunks and errors go. A callback (not a channel) so the caller can merge audio
/// with its own control events into one ordered queue.
pub type Emit = Arc<dyn Fn(AudioOut) + Send + Sync>;
use std::sync::{Arc, Mutex};

pub const CHUNK_MS: u32 = 160;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AudioErrorCode {
    /// Windows privacy setting "Let apps access your microphone" is off, or access denied.
    PermissionDenied,
    NoDevice,
    DeviceLost,
    Unsupported,
}

#[derive(Debug)]
pub enum AudioOut {
    Chunk(Vec<i16>),
    Error(AudioErrorCode),
}

struct Processor {
    recording: bool,
    channels: usize,
    source_rate: u32,
    mono: Vec<f32>,
    resampled: Vec<f32>,
    resampler: Resampler,
    chunker: Chunker,
    utterance: UtteranceBuffer,
    out: Emit,
}

impl Processor {
    fn reset(&mut self) {
        self.resampler = Resampler::new(self.source_rate);
        self.chunker = Chunker::new(CHUNK_MS);
        self.utterance.clear();
    }

    /// Stop recording, emit the last partial chunk, and return the utterance length.
    fn finish(&mut self) -> f32 {
        self.recording = false;
        let (out, utterance) = (&self.out, &mut self.utterance);
        self.chunker.flush(|chunk| {
            utterance.extend(&chunk);
            (out)(AudioOut::Chunk(chunk));
        });
        let seconds = self.utterance.seconds();
        self.utterance.clear();
        seconds
    }

    fn feed(&mut self, interleaved: &[f32]) {
        if !self.recording {
            return;
        }
        self.mono.clear();
        downmix(interleaved, self.channels, &mut self.mono);
        self.resampled.clear();
        let mono = std::mem::take(&mut self.mono);
        self.resampler.process(&mono, &mut self.resampled);
        self.mono = mono;
        let (out, utterance) = (&self.out, &mut self.utterance);
        self.chunker.push(&self.resampled, |chunk| {
            utterance.extend(&chunk);
            (out)(AudioOut::Chunk(chunk));
        });
    }
}

enum Command {
    Begin,
    End(Sender<f32>),
}

/// Control handle; cheap to clone.
#[derive(Clone)]
pub struct AudioHandle {
    commands: Sender<Command>,
}

impl AudioHandle {
    /// Start capturing a new utterance.
    pub fn begin(&self) {
        let _ = self.commands.send(Command::Begin);
    }

    /// Stop capturing; returns the utterance length in seconds (after the tail is flushed).
    pub fn end(&self) -> f32 {
        let (tx, rx) = mpsc::channel();
        if self.commands.send(Command::End(tx)).is_err() {
            return 0.0;
        }
        rx.recv_timeout(std::time::Duration::from_millis(500))
            .unwrap_or(0.0)
    }
}

fn classify(err: &cpal::Error) -> AudioErrorCode {
    let msg = err.to_string().to_lowercase();
    if msg.contains("denied") || msg.contains("permission") || msg.contains("0x80070005") {
        AudioErrorCode::PermissionDenied
    } else if msg.contains("not available")
        || msg.contains("no longer")
        || msg.contains("disconnected")
    {
        AudioErrorCode::DeviceLost
    } else {
        AudioErrorCode::Unsupported
    }
}

fn build_stream<T>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    processor: Arc<Mutex<Processor>>,
    out: Emit,
) -> Result<cpal::Stream, cpal::Error>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let mut scratch: Vec<f32> = Vec::new();
    device.build_input_stream::<T, _, _>(
        config,
        move |data: &[T], _info| {
            scratch.clear();
            scratch.extend(data.iter().map(|s| s.to_sample::<f32>()));
            if let Ok(mut p) = processor.lock() {
                p.feed(&scratch);
            }
        },
        move |err| {
            (out)(AudioOut::Error(classify(&err)));
        },
        None,
    )
}

struct Engine {
    stream: Option<cpal::Stream>,
    processor: Option<Arc<Mutex<Processor>>>,
}

fn open(out: &Emit, max_seconds: u32) -> Result<Engine, AudioErrorCode> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or(AudioErrorCode::NoDevice)?;
    let supported = device.default_input_config().map_err(|e| classify(&e))?;
    let config = supported.config();
    let processor = Arc::new(Mutex::new(Processor {
        recording: false,
        channels: config.channels as usize,
        source_rate: config.sample_rate,
        mono: Vec::new(),
        resampled: Vec::new(),
        resampler: Resampler::new(config.sample_rate),
        chunker: Chunker::new(CHUNK_MS),
        utterance: UtteranceBuffer::new(max_seconds),
        out: out.clone(),
    }));
    let p = processor.clone();
    let o = out.clone();
    let stream = match supported.sample_format() {
        SampleFormat::F32 => build_stream::<f32>(&device, config, p, o),
        SampleFormat::I16 => build_stream::<i16>(&device, config, p, o),
        SampleFormat::U16 => build_stream::<u16>(&device, config, p, o),
        SampleFormat::I32 => build_stream::<i32>(&device, config, p, o),
        _ => return Err(AudioErrorCode::Unsupported),
    }
    .map_err(|e| classify(&e))?;
    // Built paused; `play()` on each press.
    let _ = stream.pause();
    Ok(Engine {
        stream: Some(stream),
        processor: Some(processor),
    })
}

fn run(commands: Receiver<Command>, out: Emit, max_seconds: u32) {
    let mut engine = open(&out, max_seconds).unwrap_or(Engine {
        stream: None,
        processor: None,
    });
    for cmd in commands {
        match cmd {
            Command::Begin => {
                // (Re)open if the first open failed or the device went away.
                if engine.stream.is_none() {
                    match open(&out, max_seconds) {
                        Ok(e) => engine = e,
                        Err(code) => {
                            (out)(AudioOut::Error(code));
                            continue;
                        }
                    }
                }
                if let Some(p) = &engine.processor {
                    if let Ok(mut p) = p.lock() {
                        p.reset();
                        p.recording = true;
                    }
                }
                if let Some(s) = &engine.stream {
                    if let Err(e) = s.play() {
                        (out)(AudioOut::Error(classify(&e)));
                        engine.stream = None;
                    }
                }
            }
            Command::End(reply) => {
                if let Some(s) = &engine.stream {
                    let _ = s.pause();
                }
                let mut seconds = 0.0;
                if let Some(p) = &engine.processor {
                    if let Ok(mut p) = p.lock() {
                        seconds = p.finish();
                    }
                }
                let _ = reply.send(seconds);
            }
        }
    }
}

/// Spawn the capture thread. Every chunk and error is passed to `emit`, in order; a
/// chunk emitted for an utterance always comes before `AudioHandle::end` returns.
pub fn spawn(max_seconds: u32, emit: Emit) -> AudioHandle {
    let (cmd_tx, cmd_rx) = mpsc::channel();
    let _ = std::thread::Builder::new()
        .name("sayvox-audio".into())
        .spawn(move || run(cmd_rx, emit, max_seconds));
    AudioHandle { commands: cmd_tx }
}
