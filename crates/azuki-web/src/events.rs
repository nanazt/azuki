use std::sync::Mutex;

use azuki_bot::BotStatus;
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
        paused: bool,
    },
    TrackEnded {
        track_id: String,
        listened_ms: u64,
        completed: bool,
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
    OutputSuspended {
        position_ms: u64,
    },
    OutputResumed {
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
    },
    BotStatus {
        status: BotStatus,
    },

    // App events
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
    HistoryAdded {
        track: TrackInfo,
        user_id: String,
    },
    HistoryUpdated {
        history: Vec<azuki_player::QueueEntry>,
    },
    UploadAdded {
        track: TrackInfo,
        user_id: String,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct WebSeqEvent {
    pub seq: u64,
    pub event: WebEvent,
}

/// Assigns and broadcasts the next event while holding the shared publication lock.
pub fn publish_web_event(
    tx: &tokio::sync::broadcast::Sender<WebSeqEvent>,
    sequence: &Mutex<u64>,
    event: WebEvent,
) {
    let mut sequence = sequence
        .lock()
        .expect("web event sequence mutex should not be poisoned");
    *sequence = (*sequence).wrapping_add(1);
    let _ = tx.send(WebSeqEvent {
        seq: *sequence,
        event,
    });
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
            PlayerEvent::TrackStarted {
                track,
                position_ms,
                added_by,
                paused,
            } => WebEvent::TrackStarted {
                track,
                position_ms,
                added_by,
                paused,
            },
            PlayerEvent::TrackEnded {
                track_id,
                listened_ms,
                completed,
            } => WebEvent::TrackEnded {
                track_id,
                listened_ms,
                completed,
            },
            PlayerEvent::TrackLoading { track } => WebEvent::TrackLoading { track },
            PlayerEvent::TrackError { track_id, error } => WebEvent::TrackError { track_id, error },
            PlayerEvent::Paused { position_ms } => WebEvent::Paused { position_ms },
            PlayerEvent::Resumed { position_ms } => WebEvent::Resumed { position_ms },
            PlayerEvent::OutputSuspended { position_ms } => {
                WebEvent::OutputSuspended { position_ms }
            }
            PlayerEvent::OutputResumed { position_ms } => WebEvent::OutputResumed { position_ms },
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
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Barrier, Mutex};

    use tokio::sync::broadcast;

    use super::{WebEvent, WebSeqEvent, publish_web_event};

    #[test]
    fn concurrent_publications_are_delivered_in_sequence_order() {
        const PUBLISHERS: usize = 8;
        const EVENTS_PER_PUBLISHER: usize = 128;
        const EVENT_COUNT: usize = PUBLISHERS * EVENTS_PER_PUBLISHER;

        let (tx, mut rx) = broadcast::channel::<WebSeqEvent>(EVENT_COUNT);
        let sequence = Arc::new(Mutex::new(0));
        let start = Arc::new(Barrier::new(PUBLISHERS));

        std::thread::scope(|scope| {
            for publisher in 0..PUBLISHERS {
                let tx = tx.clone();
                let sequence = Arc::clone(&sequence);
                let start = Arc::clone(&start);
                scope.spawn(move || {
                    start.wait();
                    for event in 0..EVENTS_PER_PUBLISHER {
                        publish_web_event(
                            &tx,
                            &sequence,
                            WebEvent::VolumeChanged {
                                volume: (publisher + event) as u8,
                            },
                        );
                    }
                });
            }
        });

        for expected_sequence in 1..=EVENT_COUNT as u64 {
            let published = rx
                .try_recv()
                .expect("every publication should be delivered");
            assert_eq!(published.seq, expected_sequence);
        }
        assert!(matches!(
            rx.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));
    }
}
