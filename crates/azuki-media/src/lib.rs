pub mod metadata;
pub mod store;
pub mod types;
pub mod upload;
pub mod url_detect;
pub mod youtube;
pub mod ytdlp;
pub mod ytdlp_updater;

pub use metadata::{AudioMetadata, parse_audio_metadata, parse_audio_metadata_from_file};
pub use store::MediaStore;
pub use types::TrackMeta;
pub use url_detect::{DetectedUrl, detect_url};
pub use youtube::{PlaylistItemMeta, PlaylistMeta, YouTubeClient, extract_video_id};
pub use ytdlp::{FlatPlaylistEntry, REFILL_SEMAPHORE, YtDlp};
pub use ytdlp_updater::ReleaseInfo;

#[derive(Debug, thiserror::Error)]
pub enum MediaError {
    #[error("yt-dlp error: {0}")]
    YtDlp(String),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("invalid MIME type: {0}")]
    InvalidMime(String),
    #[error("path traversal detected")]
    PathTraversal,
    #[error("file not found: {0}")]
    FileNotFound(String),
    #[error("YouTube API error: {0}")]
    YouTube(String),
}
