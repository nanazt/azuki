use serde::{Deserialize, Serialize};
use sqlx::FromRow;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct User {
    pub id: String,
    pub username: String,
    pub avatar_url: Option<String>,
    pub token_version: i64,
    pub created_at: String,
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
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct PlayHistory {
    pub id: i64,
    pub track_id: String,
    pub user_id: String,
    pub played_at: String,
    pub completed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Playlist {
    pub id: i64,
    pub name: String,
    pub owner_id: Option<String>,
    pub is_shared: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct PlaylistTrack {
    pub playlist_id: i64,
    pub track_id: String,
    pub position: i64,
    pub added_by: Option<String>,
    pub added_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Favorite {
    pub user_id: String,
    pub track_id: String,
    pub created_at: String,
}

#[non_exhaustive]
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct UserPreferences {
    pub user_id: String,
    pub theme: String,
    pub updated_at: String,
}
