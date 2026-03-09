use std::path::PathBuf;

use sha2::{Digest, Sha256};

use crate::MediaError;
use crate::store::MediaStore;

const ALLOWED_AUDIO_TYPES: &[&str] = &[
    "audio/mpeg",
    "audio/ogg",
    "audio/wav",
    "audio/x-wav",
    "audio/flac",
    "audio/x-flac",
    "audio/aac",
    "audio/x-aac",
    "audio/opus",
    "audio/webm",
    "audio/mp4",
    "audio/m4a",
    "audio/x-m4a",
    "video/mp4",
    "video/webm",
];

const ALLOWED_EXTENSIONS: &[&str] = &[
    "mp3", "ogg", "wav", "flac", "aac", "opus", "webm", "mp4", "m4a",
];

pub async fn handle_upload(
    store: &MediaStore,
    data: &[u8],
    original_filename: &str,
) -> Result<(String, PathBuf), MediaError> {
    // Validate via magic bytes, fall back to extension
    let inferred = infer::get(data);

    if let Some(ref kind) = inferred {
        if !ALLOWED_AUDIO_TYPES.contains(&kind.mime_type()) {
            return Err(MediaError::InvalidMime(format!(
                "unsupported type: {}",
                kind.mime_type()
            )));
        }
    } else {
        // magic bytes unknown — check file extension as fallback
        let ext = std::path::Path::new(original_filename)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_lowercase());
        match ext {
            Some(ref e) if ALLOWED_EXTENSIONS.contains(&e.as_str()) => {}
            _ => {
                return Err(MediaError::InvalidMime("unknown file type".to_string()));
            }
        }
    }

    // Generate track ID from content hash
    let mut hasher = Sha256::new();
    hasher.update(data);
    let hash = hex::encode(hasher.finalize());
    let track_id = format!("upload_{}", &hash[..16]);

    // Determine extension from original filename or inferred type
    let ext = std::path::Path::new(original_filename)
        .extension()
        .and_then(|e| e.to_str())
        .or_else(|| inferred.as_ref().map(|k| k.extension()))
        .unwrap_or("bin");

    let file_path = store.get_file_path(&track_id, ext);

    tokio::fs::write(&file_path, data)
        .await
        .map_err(MediaError::Io)?;

    Ok((track_id, file_path))
}
