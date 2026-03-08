use std::io::Cursor;
use std::time::Duration;

use lofty::config::ParseOptions;
use lofty::file::AudioFile;
use lofty::prelude::*;
use lofty::probe::Probe;

use crate::MediaError;

pub struct AudioMetadata {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub duration_ms: u64,
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

fn parse_metadata_inner(data: &[u8]) -> Result<AudioMetadata, MediaError> {
    let cursor = Cursor::new(data);
    let options = ParseOptions::new().parsing_mode(lofty::config::ParsingMode::Relaxed);

    let tagged_file = Probe::new(cursor)
        .guess_file_type()
        .map_err(|e| MediaError::YtDlp(format!("metadata probe error: {e}")))?
        .options(options)
        .read()
        .map_err(|e| MediaError::YtDlp(format!("metadata parse error: {e}")))?;

    let properties = tagged_file.properties();
    let duration_ms = properties.duration().as_millis() as u64;

    let (title, artist) = tagged_file
        .primary_tag()
        .or_else(|| tagged_file.first_tag())
        .map(|tag| {
            let title = tag.title().map(|s| s.to_string()).filter(|s| !s.is_empty());
            let artist = tag.artist().map(|s| s.to_string()).filter(|s| !s.is_empty());
            (title, artist)
        })
        .unwrap_or((None, None));

    Ok(AudioMetadata {
        title,
        artist,
        duration_ms,
    })
}
