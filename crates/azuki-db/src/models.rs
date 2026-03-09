use serde::{Deserialize, Serialize};
use sqlx::FromRow;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct User {
    pub id: String,
    pub username: String,
    pub avatar_url: Option<String>,
    pub token_version: i64,
    pub created_at: String,
    pub is_admin: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Track {
    pub id: String,
    pub title: String,
    pub artist: Option<String>,
    pub duration_ms: i64,
    pub thumbnail_url: Option<String>,
    pub source_url: String,
    pub source_type: String,
    pub file_path: Option<String>,
    pub youtube_id: Option<String>,
    pub volume: i64,
    pub uploaded_by: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct PlayHistory {
    pub id: i64,
    pub track_id: String,
    pub user_id: String,
    pub played_at: String,
    pub completed: bool,
    pub message_id: Option<String>,
    pub volume: i64,
    pub listened_ms: Option<i64>,
}

#[non_exhaustive]
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct UserPreferences {
    pub user_id: String,
    pub theme: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct DailyListened {
    pub date: String,
    pub listened_ms: i64,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct DailyCount {
    pub date: String,
    pub play_count: i64,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct DowEntry {
    pub dow: i64,
    pub avg_listened_ms: i64,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct StreakInfo {
    pub current: i64,
    pub max: i64,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct PeakDay {
    pub date: String,
    pub play_count: i64,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct TopTrackRow {
    pub track_id: String,
    pub title: String,
    pub artist: Option<String>,
    pub duration_ms: i64,
    pub thumbnail_url: Option<String>,
    pub play_count: i64,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct ArtistStat {
    pub artist: String,
    pub play_count: i64,
    pub total_listened_ms: i64,
    pub track_count: i64,
}
