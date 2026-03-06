use std::path::PathBuf;

use sha2::{Digest, Sha256};

use crate::store::MediaStore;
use crate::MediaError;

const ALLOWED_AUDIO_TYPES: &[&str] = &[
    "audio/mpeg",
    "audio/ogg",
    "audio/wav",
    "audio/flac",
    "audio/aac",
    "audio/opus",
    "audio/webm",
    "audio/mp4",
    "video/mp4",
    "video/webm",
];

pub async fn handle_upload(
    store: &MediaStore,
    data: &[u8],
    original_filename: &str,
) -> Result<(String, PathBuf), MediaError> {
    // Validate via magic bytes
    let kind = infer::get(data).ok_or(MediaError::InvalidMime("unknown file type".to_string()))?;

    if !ALLOWED_AUDIO_TYPES.contains(&kind.mime_type()) {
        return Err(MediaError::InvalidMime(format!(
            "unsupported type: {}",
            kind.mime_type()
        )));
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
        .unwrap_or(kind.extension());

    let file_path = store.get_file_path(&track_id, ext);

    tokio::fs::write(&file_path, data)
        .await
        .map_err(MediaError::Io)?;

    Ok((track_id, file_path))
}
