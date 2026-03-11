use anyhow::{Context, Result};
use hound::{WavSpec, WavWriter};
use log::{debug, info};
use rubato::{FftFixedIn, Resampler};
use std::path::Path;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

const TARGET_SAMPLE_RATE: u32 = 16000;

/// Save audio samples as a WAV file
pub async fn save_wav_file<P: AsRef<Path>>(file_path: P, samples: &[f32]) -> Result<()> {
    let spec = WavSpec {
        channels: 1,
        sample_rate: 16000,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };

    let mut writer = WavWriter::create(file_path.as_ref(), spec)?;

    // Convert f32 samples to i16 for WAV
    for sample in samples {
        let sample_i16 = (sample * i16::MAX as f32) as i16;
        writer.write_sample(sample_i16)?;
    }

    writer.finalize()?;
    debug!("Saved WAV file: {:?}", file_path.as_ref());
    Ok(())
}

/// Load an audio file (WAV, MP3, FLAC, OGG, AAC) and return mono f32 samples at 16kHz
pub fn load_audio_file<P: AsRef<Path>>(file_path: P) -> Result<Vec<f32>> {
    let path = file_path.as_ref();
    info!("Loading audio file: {:?}", path);

    let file = std::fs::File::open(path)
        .with_context(|| format!("Failed to open audio file: {:?}", path))?;

    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    // Provide a hint based on file extension
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .context("Failed to probe audio format")?;

    let mut format = probed.format;

    let track = format
        .default_track()
        .context("No default audio track found")?;

    let channels = track.codec_params.channels.map(|c| c.count()).unwrap_or(1);
    let sample_rate = track
        .codec_params
        .sample_rate
        .context("No sample rate found")?;
    let track_id = track.id;

    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .context("Failed to create audio decoder")?;

    let mut all_samples: Vec<f32> = Vec::new();

    // Decode all packets
    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(symphonia::core::errors::Error::IoError(ref e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break;
            }
            Err(e) => return Err(e.into()),
        };

        if packet.track_id() != track_id {
            continue;
        }

        let decoded = decoder.decode(&packet)?;
        let spec = *decoded.spec();
        let num_frames = decoded.frames();

        if num_frames == 0 {
            continue;
        }

        let mut sample_buf = SampleBuffer::<f32>::new(num_frames as u64, spec);
        sample_buf.copy_interleaved_ref(decoded);
        let samples = sample_buf.samples();

        // Mix down to mono if multi-channel
        if channels > 1 {
            for frame in samples.chunks(channels) {
                let mono: f32 = frame.iter().sum::<f32>() / channels as f32;
                all_samples.push(mono);
            }
        } else {
            all_samples.extend_from_slice(samples);
        }
    }

    info!(
        "Decoded {} samples at {} Hz ({} channels)",
        all_samples.len(),
        sample_rate,
        channels
    );

    // Resample to 16kHz if needed
    if sample_rate != TARGET_SAMPLE_RATE {
        info!("Resampling from {} Hz to {} Hz", sample_rate, TARGET_SAMPLE_RATE);
        all_samples = resample_audio(&all_samples, sample_rate as usize, TARGET_SAMPLE_RATE as usize)?;
    }

    info!("Audio file loaded: {} samples at 16kHz", all_samples.len());
    Ok(all_samples)
}

/// Resample audio from one sample rate to another using rubato
fn resample_audio(input: &[f32], from_hz: usize, to_hz: usize) -> Result<Vec<f32>> {
    if from_hz == to_hz {
        return Ok(input.to_vec());
    }

    let chunk_size = 1024;
    let mut resampler = FftFixedIn::<f32>::new(from_hz, to_hz, chunk_size, 1, 1)
        .context("Failed to create resampler")?;

    let mut output = Vec::with_capacity(input.len() * to_hz / from_hz + chunk_size);
    let mut pos = 0;

    while pos + chunk_size <= input.len() {
        let chunk = &input[pos..pos + chunk_size];
        if let Ok(out) = resampler.process(&[chunk], None) {
            output.extend_from_slice(&out[0]);
        }
        pos += chunk_size;
    }

    // Handle remaining samples by padding with zeros
    if pos < input.len() {
        let mut last_chunk = input[pos..].to_vec();
        last_chunk.resize(chunk_size, 0.0);
        if let Ok(out) = resampler.process(&[&last_chunk], None) {
            // Only take proportional amount of output
            let expected = (input.len() - pos) * to_hz / from_hz;
            let take = expected.min(out[0].len());
            output.extend_from_slice(&out[0][..take]);
        }
    }

    Ok(output)
}
