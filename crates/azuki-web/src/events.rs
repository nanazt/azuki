use serde::Serialize;

use azuki_player::{PlayerEvent, PlayerSnapshot, TrackInfo};

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WebEvent {
    // PlayerEvent 1:1 mappings
    TrackStarted {
        track: TrackInfo,
        position_ms: u64,
        added_by: azuki_player::UserInfo,
    },
    TrackEnded {
        track_id: String,
    },
    TrackLoading {
        track: TrackInfo,
    },
    TrackError {
        track_id: String,
        error: String,
    },
    Paused {
        position_ms: u64,
    },
    Resumed {
        position_ms: u64,
    },
    Seeked {
        position_ms: u64,
    },
    VolumeChanged {
        volume: u8,
    },
    QueueUpdated {
        queue: Vec<azuki_player::QueueEntry>,
    },
    LoopModeChanged {
        mode: azuki_player::LoopMode,
    },
    VideoSync {
        youtube_id: String,
        position_ms: u64,
        is_playing: bool,
        server_timestamp_ms: u64,
    },
    ListenersUpdated {
        users: Vec<azuki_player::UserInfo>,
    },
    StateSnapshot {
        state: PlayerSnapshot,
        active_downloads: Vec<DownloadStatus>,
        favorited_track_ids: Vec<String>,
    },

    // New app events
    DownloadStarted {
        download_id: String,
        query: String,
        user_info: azuki_player::UserInfo,
    },
    DownloadMetadataResolved {
        download_id: String,
        title: String,
        artist: Option<String>,
        thumbnail_url: Option<String>,
        duration_ms: u64,
        source_url: String,
    },
    DownloadProgress {
        download_id: String,
        stage: String,
        percent: u8,
        speed_bps: Option<u64>,
    },
    DownloadComplete {
        download_id: String,
        track: TrackInfo,
    },
    DownloadFailed {
        download_id: String,
        error: String,
    },
    FavoriteChanged {
        track_id: String,
        user_id: String,
        favorited: bool,
    },
    PlaylistUpdated {
        playlist_id: i64,
    },
    HistoryAdded {
        track: TrackInfo,
        user_id: String,
    },
    HistoryUpdated {
        history: Vec<azuki_player::QueueEntry>,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct WebSeqEvent {
    pub seq: u64,
    pub event: WebEvent,
}

#[derive(Debug, Clone, Serialize)]
pub struct DownloadStatus {
    pub download_id: String,
    pub query: String,
    pub percent: u8,
    pub speed_bps: Option<u64>,
    pub user_info: Option<azuki_player::UserInfo>,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub thumbnail_url: Option<String>,
    pub duration_ms: Option<u64>,
    pub source_url: Option<String>,
}

impl From<PlayerEvent> for WebEvent {
    fn from(event: PlayerEvent) -> Self {
        match event {
            PlayerEvent::TrackStarted { track, position_ms, added_by } => {
                WebEvent::TrackStarted { track, position_ms, added_by }
            }
            PlayerEvent::TrackEnded { track_id } => WebEvent::TrackEnded { track_id },
            PlayerEvent::TrackLoading { track } => WebEvent::TrackLoading { track },
            PlayerEvent::TrackError { track_id, error } => {
                WebEvent::TrackError { track_id, error }
            }
            PlayerEvent::Paused { position_ms } => WebEvent::Paused { position_ms },
            PlayerEvent::Resumed { position_ms } => WebEvent::Resumed { position_ms },
            PlayerEvent::Seeked { position_ms, .. } => WebEvent::Seeked { position_ms },
            PlayerEvent::VolumeChanged { volume } => WebEvent::VolumeChanged { volume },
            PlayerEvent::QueueUpdated { queue } => WebEvent::QueueUpdated { queue },
            PlayerEvent::LoopModeChanged { mode } => WebEvent::LoopModeChanged { mode },
            PlayerEvent::VideoSync {
                youtube_id,
                position_ms,
                is_playing,
                server_timestamp_ms,
            } => WebEvent::VideoSync {
                youtube_id,
                position_ms,
                is_playing,
                server_timestamp_ms,
            },
            PlayerEvent::ListenersUpdated { users } => WebEvent::ListenersUpdated { users },
            PlayerEvent::HistoryUpdated { history } => WebEvent::HistoryUpdated { history },
            PlayerEvent::StateSnapshot { state } => WebEvent::StateSnapshot {
                state,
                active_downloads: Vec::new(),
                favorited_track_ids: Vec::new(),
            },
        }
    }
}
