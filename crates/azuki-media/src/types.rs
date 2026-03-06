#[derive(Debug, Clone)]
pub struct TrackMeta {
    pub youtube_id: Option<String>,
    pub title: String,
    pub artist: Option<String>,
    pub duration_ms: u64,
    pub thumbnail_url: Option<String>,
    pub source_url: String,
}
