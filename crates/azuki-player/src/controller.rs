use tokio::sync::{broadcast, mpsc, oneshot};

use crate::actor::{PlayState, PlayerActor};
use crate::events::{
    LoopMode, PlayStateInfo, PlayerSnapshot, QueueEntry, SeqEvent, TrackInfo, UserInfo,
};
use crate::queue::Queue;

const BROADCAST_CAPACITY: usize = 64;

#[derive(Debug)]
pub enum TrackEndReason {
    Finished,
    Error(String),
    Replaced,
}

pub enum PlayerCommand {
    Play {
        track: TrackInfo,
        user_info: UserInfo,
        reply: oneshot::Sender<Result<(), PlayerError>>,
    },
    Pause {
        reply: oneshot::Sender<Result<(), PlayerError>>,
    },
    Resume {
        reply: oneshot::Sender<Result<(), PlayerError>>,
    },
    Skip {
        reply: oneshot::Sender<Result<Option<TrackInfo>, PlayerError>>,
    },
    Stop {
        reply: oneshot::Sender<Result<(), PlayerError>>,
    },
    Seek {
        position_ms: u64,
        reply: oneshot::Sender<Result<(), PlayerError>>,
    },
    SetVolume {
        volume: u8,
        reply: oneshot::Sender<Result<(), PlayerError>>,
    },
    SetLoop {
        mode: LoopMode,
        reply: oneshot::Sender<Result<(), PlayerError>>,
    },
    Enqueue {
        track: TrackInfo,
        user_info: UserInfo,
        reply: oneshot::Sender<Result<(), PlayerError>>,
    },
    Previous {
        reply: oneshot::Sender<Result<(), PlayerError>>,
    },
    Remove {
        position: usize,
        reply: oneshot::Sender<Result<(), PlayerError>>,
    },
    PlayAt {
        position: usize,
        reply: oneshot::Sender<Result<(), PlayerError>>,
    },
    MoveInQueue {
        from: usize,
        to: usize,
        reply: oneshot::Sender<Result<(), PlayerError>>,
    },
    PlayOrEnqueue {
        track: TrackInfo,
        user_info: UserInfo,
        reply: oneshot::Sender<Result<PlayAction, PlayerError>>,
    },
    GetState {
        reply: oneshot::Sender<PlayerSnapshot>,
    },
    SuspendOutput {
        reply: oneshot::Sender<Result<(), PlayerError>>,
    },
    ResumeOutput {
        expected_revision: u64,
        reply: oneshot::Sender<Result<bool, PlayerError>>,
    },
    OnTrackEnd {
        track_id: String,
        reason: TrackEndReason,
        playback_revision: u64,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlayAction {
    PlayedNow,
    Enqueued,
}
#[derive(Debug, Clone)]
pub struct RestoredPlayback {
    pub entry: QueueEntry,
    pub position_ms: u64,
    pub paused: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum PlayerError {
    #[error("no track playing")]
    NoTrack,
    #[error("invalid state: {0}")]
    InvalidState(String),
    #[error("invalid position")]
    InvalidPosition,
    #[error("queue is full (max 50)")]
    QueueFull,
    #[error("track already in queue or playing")]
    Duplicate,
    #[error("player actor unavailable")]
    ActorUnavailable,
}

pub struct PlayerController {
    cmd_tx: mpsc::Sender<PlayerCommand>,
    event_tx: broadcast::Sender<SeqEvent>,
}

impl Clone for PlayerController {
    fn clone(&self) -> Self {
        Self {
            cmd_tx: self.cmd_tx.clone(),
            event_tx: self.event_tx.clone(),
        }
    }
}

impl Default for PlayerController {
    fn default() -> Self {
        Self::new()
    }
}

impl PlayerController {
    pub fn new() -> Self {
        Self::with_history(Vec::new())
    }

    pub fn with_history(history: Vec<QueueEntry>) -> Self {
        Self::with_state(Vec::new(), history, LoopMode::Off, None)
    }

    pub fn with_state(
        queue_items: Vec<QueueEntry>,
        history: Vec<QueueEntry>,
        loop_mode: LoopMode,
        restored_playback: Option<RestoredPlayback>,
    ) -> Self {
        let (cmd_tx, cmd_rx) = mpsc::channel(64);
        let (event_tx, _) = broadcast::channel(BROADCAST_CAPACITY);

        let playback_suspended = restored_playback.is_some();
        let volume = restored_playback
            .as_ref()
            .map_or(5, |playback| playback.entry.track.volume);
        let current_added_by = restored_playback
            .as_ref()
            .map(|playback| playback.entry.added_by.clone());
        let initial_state = match restored_playback {
            Some(RestoredPlayback {
                entry,
                position_ms,
                paused: true,
            }) => PlayState::Paused {
                track: entry.track,
                position_ms,
            },
            Some(RestoredPlayback {
                entry,
                position_ms,
                paused: false,
            }) => PlayState::Playing {
                track: entry.track,
                started_at: std::time::Instant::now(),
                position_ms,
            },
            None => PlayState::Idle,
        };
        let actor = PlayerActor {
            cmd_rx,
            event_tx: event_tx.clone(),
            state: initial_state,
            queue: Queue::with_state(queue_items, history, loop_mode),
            volume,
            seq: 0,
            listeners: Vec::new(),
            current_added_by,
            playback_suspended,
            playback_revision: 0,
        };

        tokio::spawn(actor.run());

        Self { cmd_tx, event_tx }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<SeqEvent> {
        self.event_tx.subscribe()
    }

    pub fn event_sender(&self) -> &broadcast::Sender<SeqEvent> {
        &self.event_tx
    }

    async fn send_cmd(&self, cmd: PlayerCommand) {
        if self.cmd_tx.send(cmd).await.is_err() {
            tracing::error!("Player actor is dead — command dropped");
        }
    }

    pub async fn play(&self, track: TrackInfo, user_info: UserInfo) -> Result<(), PlayerError> {
        let (tx, rx) = oneshot::channel();
        self.send_cmd(PlayerCommand::Play {
            track,
            user_info,
            reply: tx,
        })
        .await;
        rx.await.unwrap_or(Err(PlayerError::NoTrack))
    }

    pub async fn pause(&self) -> Result<(), PlayerError> {
        let (tx, rx) = oneshot::channel();
        self.send_cmd(PlayerCommand::Pause { reply: tx }).await;
        rx.await.unwrap_or(Err(PlayerError::NoTrack))
    }

    pub async fn resume(&self) -> Result<(), PlayerError> {
        let (tx, rx) = oneshot::channel();
        self.send_cmd(PlayerCommand::Resume { reply: tx }).await;
        rx.await.unwrap_or(Err(PlayerError::NoTrack))
    }

    pub async fn skip(&self) -> Result<Option<TrackInfo>, PlayerError> {
        let (tx, rx) = oneshot::channel();
        self.send_cmd(PlayerCommand::Skip { reply: tx }).await;
        rx.await.unwrap_or(Err(PlayerError::NoTrack))
    }

    pub async fn stop(&self) -> Result<(), PlayerError> {
        let (tx, rx) = oneshot::channel();
        self.send_cmd(PlayerCommand::Stop { reply: tx }).await;
        rx.await.unwrap_or(Err(PlayerError::NoTrack))
    }

    pub async fn seek(&self, position_ms: u64) -> Result<(), PlayerError> {
        let (tx, rx) = oneshot::channel();
        self.send_cmd(PlayerCommand::Seek {
            position_ms,
            reply: tx,
        })
        .await;
        rx.await.unwrap_or(Err(PlayerError::NoTrack))
    }

    pub async fn set_volume(&self, volume: u8) -> Result<(), PlayerError> {
        let (tx, rx) = oneshot::channel();
        self.send_cmd(PlayerCommand::SetVolume { volume, reply: tx })
            .await;
        rx.await.unwrap_or(Err(PlayerError::NoTrack))
    }

    pub async fn set_loop(&self, mode: LoopMode) -> Result<(), PlayerError> {
        let (tx, rx) = oneshot::channel();
        self.send_cmd(PlayerCommand::SetLoop { mode, reply: tx })
            .await;
        rx.await.unwrap_or(Err(PlayerError::NoTrack))
    }

    pub async fn previous(&self) -> Result<(), PlayerError> {
        let (tx, rx) = oneshot::channel();
        self.send_cmd(PlayerCommand::Previous { reply: tx }).await;
        rx.await.unwrap_or(Err(PlayerError::NoTrack))
    }

    pub async fn play_or_enqueue(
        &self,
        track: TrackInfo,
        user_info: UserInfo,
    ) -> Result<PlayAction, PlayerError> {
        let (tx, rx) = oneshot::channel();
        self.send_cmd(PlayerCommand::PlayOrEnqueue {
            track,
            user_info,
            reply: tx,
        })
        .await;
        rx.await.unwrap_or(Err(PlayerError::NoTrack))
    }

    pub async fn enqueue(&self, track: TrackInfo, user_info: UserInfo) -> Result<(), PlayerError> {
        let (tx, rx) = oneshot::channel();
        self.send_cmd(PlayerCommand::Enqueue {
            track,
            user_info,
            reply: tx,
        })
        .await;
        rx.await.unwrap_or(Err(PlayerError::NoTrack))
    }

    pub async fn remove(&self, position: usize) -> Result<(), PlayerError> {
        let (tx, rx) = oneshot::channel();
        self.send_cmd(PlayerCommand::Remove {
            position,
            reply: tx,
        })
        .await;
        rx.await.unwrap_or(Err(PlayerError::NoTrack))
    }

    pub async fn play_at(&self, position: usize) -> Result<(), PlayerError> {
        let (tx, rx) = oneshot::channel();
        self.send_cmd(PlayerCommand::PlayAt {
            position,
            reply: tx,
        })
        .await;
        rx.await.unwrap_or(Err(PlayerError::NoTrack))
    }

    pub async fn move_in_queue(&self, from: usize, to: usize) -> Result<(), PlayerError> {
        let (tx, rx) = oneshot::channel();
        self.send_cmd(PlayerCommand::MoveInQueue {
            from,
            to,
            reply: tx,
        })
        .await;
        rx.await.unwrap_or(Err(PlayerError::NoTrack))
    }

    pub async fn try_get_state(&self) -> Result<PlayerSnapshot, PlayerError> {
        let (tx, rx) = oneshot::channel();
        self.cmd_tx
            .send(PlayerCommand::GetState { reply: tx })
            .await
            .map_err(|_| PlayerError::ActorUnavailable)?;
        rx.await.map_err(|_| PlayerError::ActorUnavailable)
    }

    pub async fn get_state(&self) -> PlayerSnapshot {
        self.try_get_state()
            .await
            .unwrap_or_else(|_| PlayerSnapshot {
                state: PlayStateInfo::Idle,
                queue: Vec::new(),
                history: Vec::new(),
                volume: 5,
                loop_mode: LoopMode::Off,
                listeners: Vec::new(),
                current_added_by: None,
                playback_suspended: false,
                playback_revision: 0,
            })
    }

    pub async fn suspend_output(&self) -> Result<(), PlayerError> {
        let (tx, rx) = oneshot::channel();
        self.cmd_tx
            .send(PlayerCommand::SuspendOutput { reply: tx })
            .await
            .map_err(|_| PlayerError::ActorUnavailable)?;
        rx.await.map_err(|_| PlayerError::ActorUnavailable)?
    }

    pub async fn resume_output(&self, expected_revision: u64) -> Result<bool, PlayerError> {
        let (tx, rx) = oneshot::channel();
        self.cmd_tx
            .send(PlayerCommand::ResumeOutput {
                expected_revision,
                reply: tx,
            })
            .await
            .map_err(|_| PlayerError::ActorUnavailable)?;
        rx.await.map_err(|_| PlayerError::ActorUnavailable)?
    }

    pub async fn on_track_end(
        &self,
        track_id: String,
        reason: TrackEndReason,
        playback_revision: u64,
    ) {
        self.send_cmd(PlayerCommand::OnTrackEnd {
            track_id,
            reason,
            playback_revision,
        })
        .await;
    }
}

#[cfg(test)]
#[path = "controller_tests.rs"]
mod tests;
