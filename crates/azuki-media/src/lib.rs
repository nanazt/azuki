pub mod metadata;
pub mod store;
pub mod types;
pub mod upload;
pub mod ytdlp;
pub mod ytdlp_updater;
pub mod youtube;

pub use metadata::{parse_audio_metadata, AudioMetadata};
pub use store::MediaStore;
pub use types::TrackMeta;
pub use ytdlp::YtDlp;
pub use ytdlp_updater::ReleaseInfo;
pub use youtube::{extract_video_id, YouTubeClient};

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
