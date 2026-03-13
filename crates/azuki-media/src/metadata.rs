use std::io::Cursor;
use std::path::Path;
use std::time::Duration;

use lofty::config::ParseOptions;
use lofty::file::AudioFile;
use lofty::picture::PictureType;
use lofty::prelude::*;
use lofty::probe::Probe;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

use crate::MediaError;

const MAX_COVER_ART_SIZE: usize = 5 * 1024 * 1024;

#[derive(Default)]
pub struct AudioMetadata {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub duration_ms: u64,
    pub cover_art: Option<Vec<u8>>,
}

/// Parse audio metadata from bytes using lofty.
/// Runs in spawn_blocking with catch_unwind and 5-second timeout for safety.
pub async fn parse_audio_metadata(data: Vec<u8>) -> Result<AudioMetadata, MediaError> {
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        tokio::task::spawn_blocking(move || {
            std::panic::catch_unwind(|| parse_metadata_inner(&data))
        }),
    )
    .await;

    match result {
        Ok(Ok(Ok(Ok(meta)))) => Ok(meta),
        Ok(Ok(Ok(Err(e)))) => Err(e),
        Ok(Ok(Err(_panic))) => Err(MediaError::YtDlp("metadata parsing task panicked".into())),
        Ok(Err(_join_err)) => Err(MediaError::YtDlp("metadata parsing task failed".into())),
        Err(_timeout) => Err(MediaError::YtDlp("metadata parsing timed out".into())),
    }
}

/// Parse audio metadata from a file on disk.
/// Uses matroska crate for WebM/MKV, lofty for everything else,
/// symphonia as universal fallback.
pub async fn parse_audio_metadata_from_file(path: &Path) -> Result<AudioMetadata, MediaError> {
    let path = path.to_owned();
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        tokio::task::spawn_blocking(move || {
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                parse_metadata_from_file_inner(&path)
            }))
        }),
    )
    .await;

    match result {
        Ok(Ok(Ok(Ok(meta)))) => Ok(meta),
        Ok(Ok(Ok(Err(e)))) => Err(e),
        Ok(Ok(Err(_panic))) => Err(MediaError::YtDlp("metadata parsing task panicked".into())),
        Ok(Err(_join_err)) => Err(MediaError::YtDlp("metadata parsing task failed".into())),
        Err(_timeout) => Err(MediaError::YtDlp("metadata parsing timed out".into())),
    }
}

fn parse_metadata_from_file_inner(path: &Path) -> Result<AudioMetadata, MediaError> {
    if is_webm_or_matroska(path)? {
        let meta = parse_matroska(path);
        if let Ok(ref m) = meta
            && m.duration_ms > 0
        {
            return meta;
        }
        // Matroska failed or got zero duration — try symphonia fallback
        let fallback = parse_symphonia_from_file(path);
        match (meta.ok(), fallback.ok()) {
            (Some(mkv), Some(sym)) => Ok(merge_metadata(mkv, sym)),
            (Some(mkv), None) => Ok(mkv),
            (None, Some(sym)) => Ok(sym),
            (None, None) => Ok(AudioMetadata::default()),
        }
    } else {
        let meta = parse_lofty_from_file(path);
        if let Ok(ref m) = meta
            && m.duration_ms > 0
        {
            return meta;
        }
        // Lofty failed or got zero duration — try symphonia fallback
        let fallback = parse_symphonia_from_file(path);
        match (meta.ok(), fallback.ok()) {
            (Some(lofty), Some(sym)) => Ok(merge_metadata(lofty, sym)),
            (Some(lofty), None) => Ok(lofty),
            (None, Some(sym)) => Ok(sym),
            (None, None) => Ok(AudioMetadata::default()),
        }
    }
}

/// Merge primary metadata with symphonia fallback (fill gaps only).
fn merge_metadata(primary: AudioMetadata, fallback: AudioMetadata) -> AudioMetadata {
    AudioMetadata {
        title: primary.title.or(fallback.title),
        artist: primary.artist.or(fallback.artist),
        duration_ms: if primary.duration_ms > 0 {
            primary.duration_ms
        } else {
            fallback.duration_ms
        },
        cover_art: primary.cover_art.or(fallback.cover_art),
    }
}

/// Detect WebM/Matroska by reading the first few bytes with the `infer` crate.
fn is_webm_or_matroska(path: &Path) -> Result<bool, MediaError> {
    let mut buf = [0u8; 64];
    let mut file = std::fs::File::open(path)
        .map_err(|e| MediaError::YtDlp(format!("file open error: {e}")))?;
    let n = std::io::Read::read(&mut file, &mut buf)
        .map_err(|e| MediaError::YtDlp(format!("file read error: {e}")))?;
    let kind = infer::get(&buf[..n]);
    Ok(kind.is_some_and(|k| {
        matches!(
            k.mime_type(),
            "video/webm" | "audio/webm" | "video/x-matroska"
        )
    }))
}

/// Parse WebM/MKV metadata using the matroska crate.
fn parse_matroska(path: &Path) -> Result<AudioMetadata, MediaError> {
    let mkv = matroska::open(path)
        .map_err(|e| MediaError::YtDlp(format!("matroska parse error: {e}")))?;

    let duration_ms = mkv.info.duration.map(|d| d.as_millis() as u64).unwrap_or(0);

    let mut title = mkv.info.title.clone();
    let mut artist = None;

    for tag in &mkv.tags {
        for simple_tag in &tag.simple {
            match simple_tag.name.to_uppercase().as_str() {
                "TITLE" if title.is_none() => {
                    title = simple_tag.value.as_ref().and_then(|v| match v {
                        matroska::TagValue::String(s) => Some(s.clone()),
                        _ => None,
                    });
                }
                "ARTIST" if artist.is_none() => {
                    artist = simple_tag.value.as_ref().and_then(|v| match v {
                        matroska::TagValue::String(s) => Some(s.clone()),
                        _ => None,
                    });
                }
                _ => {}
            }
        }
    }

    let cover_art = mkv
        .attachments
        .iter()
        .find(|a| a.mime_type.starts_with("image/") || a.name.to_lowercase().contains("cover"))
        .map(|a| a.data.clone())
        .filter(|d| !d.is_empty() && d.len() <= MAX_COVER_ART_SIZE);

    Ok(AudioMetadata {
        title,
        artist,
        duration_ms,
        cover_art,
    })
}

/// Parse metadata via lofty from a file path.
fn parse_lofty_from_file(path: &Path) -> Result<AudioMetadata, MediaError> {
    let options = ParseOptions::new().parsing_mode(lofty::config::ParsingMode::Relaxed);

    let tagged_file = Probe::open(path)
        .map_err(|e| MediaError::YtDlp(format!("lofty probe error: {e}")))?
        .options(options)
        .read()
        .map_err(|e| MediaError::YtDlp(format!("lofty parse error: {e}")))?;

    extract_lofty_metadata(&tagged_file)
}

/// Extract metadata fields from a lofty TaggedFile (shared logic).
fn extract_lofty_metadata(
    tagged_file: &lofty::file::TaggedFile,
) -> Result<AudioMetadata, MediaError> {
    let properties = tagged_file.properties();
    let duration_ms = properties.duration().as_millis() as u64;

    let tag = tagged_file
        .primary_tag()
        .or_else(|| tagged_file.first_tag());

    let (title, artist) = tag
        .map(|t| {
            let title = t.title().map(|s| s.to_string()).filter(|s| !s.is_empty());
            let artist = t.artist().map(|s| s.to_string()).filter(|s| !s.is_empty());
            (title, artist)
        })
        .unwrap_or((None, None));

    let cover_art = tag.and_then(|t| {
        let pic = t
            .get_picture_type(PictureType::CoverFront)
            .or_else(|| t.pictures().first())?;
        let data = pic.data();
        if data.is_empty() || data.len() > MAX_COVER_ART_SIZE {
            return None;
        }
        Some(data.to_vec())
    });

    Ok(AudioMetadata {
        title,
        artist,
        duration_ms,
        cover_art,
    })
}

/// Parse metadata via symphonia as a universal fallback.
fn parse_symphonia_from_file(path: &Path) -> Result<AudioMetadata, MediaError> {
    let file = std::fs::File::open(path)
        .map_err(|e| MediaError::YtDlp(format!("file open error: {e}")))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut probed = symphonia::default::get_probe()
        .format(
            &Hint::new(),
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|e| MediaError::YtDlp(format!("symphonia probe error: {e}")))?;

    let duration_ms = probed
        .format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != symphonia::core::codecs::CODEC_TYPE_NULL)
        .and_then(|t| {
            let p = &t.codec_params;
            match (p.n_frames, p.time_base) {
                (Some(frames), Some(tb)) => {
                    Some((frames as f64 * tb.numer as f64 / tb.denom as f64 * 1000.0) as u64)
                }
                _ => None,
            }
        })
        .unwrap_or(0);

    let (mut title, mut artist) = (None, None);
    if let Some(rev) = probed.format.metadata().current() {
        for tag in rev.tags() {
            match tag.key.to_uppercase().as_str() {
                "TITLE" if title.is_none() => title = Some(tag.value.to_string()),
                "ARTIST" if artist.is_none() => artist = Some(tag.value.to_string()),
                _ => {}
            }
        }
    }

    Ok(AudioMetadata {
        title,
        artist,
        duration_ms,
        cover_art: None,
    })
}

fn parse_metadata_inner(data: &[u8]) -> Result<AudioMetadata, MediaError> {
    let cursor = Cursor::new(data);
    let options = ParseOptions::new().parsing_mode(lofty::config::ParsingMode::Relaxed);

    let tagged_file = Probe::new(cursor)
        .guess_file_type()
        .map_err(|e| MediaError::YtDlp(format!("metadata probe error: {e}")))?
        .options(options)
        .read()
        .map_err(|e| MediaError::YtDlp(format!("metadata parse error: {e}")))?;

    extract_lofty_metadata(&tagged_file)
}
