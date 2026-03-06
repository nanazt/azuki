use std::path::{Path, PathBuf};

use tracing::info;

use crate::MediaError;

pub struct MediaStore {
    media_dir: PathBuf,
    max_cache_bytes: u64,
}

impl MediaStore {
    pub fn new(media_dir: impl Into<PathBuf>, max_cache_gb: u64) -> Result<Self, MediaError> {
        let media_dir = media_dir.into();
        std::fs::create_dir_all(&media_dir).map_err(MediaError::Io)?;
        Ok(Self {
            media_dir,
            max_cache_bytes: max_cache_gb * 1024 * 1024 * 1024,
        })
    }

    pub fn media_dir(&self) -> &Path {
        &self.media_dir
    }

    pub fn get_file_path(&self, track_id: &str, ext: &str) -> PathBuf {
        self.media_dir.join(format!("{track_id}.{ext}"))
    }

    pub fn resolve_path(&self, file_path: &str) -> Result<PathBuf, MediaError> {
        let path = PathBuf::from(file_path);
        let canonical = path.canonicalize().map_err(MediaError::Io)?;
        let media_canonical = self.media_dir.canonicalize().map_err(MediaError::Io)?;

        if !canonical.starts_with(&media_canonical) {
            return Err(MediaError::PathTraversal);
        }

        Ok(canonical)
    }

    pub fn file_exists(&self, file_path: &str) -> bool {
        if let Ok(path) = self.resolve_path(file_path) {
            path.exists()
        } else {
            false
        }
    }

    pub async fn cleanup_cache(&self) -> Result<(), MediaError> {
        let mut entries: Vec<(PathBuf, u64, std::time::SystemTime)> = Vec::new();
        let mut total_size: u64 = 0;

        let read_dir = std::fs::read_dir(&self.media_dir).map_err(MediaError::Io)?;

        for entry in read_dir {
            let entry = entry.map_err(MediaError::Io)?;
            let metadata = entry.metadata().map_err(MediaError::Io)?;
            if metadata.is_file() {
                let size = metadata.len();
                let modified = metadata.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
                total_size += size;
                entries.push((entry.path(), size, modified));
            }
        }

        if total_size <= self.max_cache_bytes {
            return Ok(());
        }

        // Sort by last modified (oldest first) for LRU eviction
        entries.sort_by_key(|(_, _, modified)| *modified);

        for (path, size, _) in &entries {
            if total_size <= self.max_cache_bytes {
                break;
            }
            info!("evicting cached file: {}", path.display());
            if let Err(e) = std::fs::remove_file(path) {
                tracing::warn!("failed to remove {}: {e}", path.display());
            } else {
                total_size -= size;
            }
        }

        Ok(())
    }
}
