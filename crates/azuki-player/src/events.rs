use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackInfo {
    pub id: String,
    pub title: String,
    pub artist: Option<String>,
    pub duration_ms: u64,
    pub thumbnail_url: Option<String>,
    pub source_url: String,
    pub source_type: String,
    pub file_path: Option<String>,
    pub youtube_id: Option<String>,
    pub volume: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueueEntry {
    pub track: TrackInfo,
    pub added_by: UserInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserInfo {
    pub id: String,
    pub username: String,
    pub avatar_url: Option<String>,
}

impl UserInfo {
    pub fn unknown() -> Self {
        Self {
            id: String::new(),
            username: String::new(),
            avatar_url: None,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoopMode {
    #[default]
    Off,
    One,
    All,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlayerSnapshot {
    pub state: PlayStateInfo,
    pub queue: Vec<QueueEntry>,
    pub history: Vec<QueueEntry>,
    pub volume: u8,
    pub loop_mode: LoopMode,
    pub listeners: Vec<UserInfo>,
    pub current_added_by: Option<UserInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum PlayStateInfo {
    Idle,
    Loading { track: TrackInfo },
    Playing { track: TrackInfo, position_ms: u64 },
    Paused { track: TrackInfo, position_ms: u64 },
    Error { track: TrackInfo, error: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SeqEvent {
    pub seq: u64,
    pub event: PlayerEvent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PlayerEvent {
    TrackStarted {
        track: TrackInfo,
        position_ms: u64,
        added_by: UserInfo,
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
        paused: bool,
    },
    VolumeChanged {
        volume: u8,
    },
    QueueUpdated {
        queue: Vec<QueueEntry>,
    },
    LoopModeChanged {
        mode: LoopMode,
    },
    VideoSync {
        youtube_id: String,
        position_ms: u64,
        is_playing: bool,
        server_timestamp_ms: u64,
    },
    ListenersUpdated {
        users: Vec<UserInfo>,
    },
    HistoryUpdated {
        history: Vec<QueueEntry>,
    },
    StateSnapshot {
        state: PlayerSnapshot,
    },
}
