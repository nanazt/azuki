use std::time::Instant;

use tokio::sync::{broadcast, mpsc, oneshot};
use tracing::{info, warn};

use crate::events::{
    LoopMode, PlayStateInfo, PlayerEvent, PlayerSnapshot, SeqEvent, TrackInfo, UserInfo,
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
        user_id: String,
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
        user_id: String,
        reply: oneshot::Sender<Result<(), PlayerError>>,
    },
    Remove {
        position: usize,
        reply: oneshot::Sender<Result<(), PlayerError>>,
    },
    GetState {
        reply: oneshot::Sender<PlayerSnapshot>,
    },
    OnTrackEnd {
        track_id: String,
        reason: TrackEndReason,
    },
}

#[derive(Debug, thiserror::Error)]
pub enum PlayerError {
    #[error("no track playing")]
    NoTrack,
    #[error("invalid state: {0}")]
    InvalidState(String),
    #[error("invalid position")]
    InvalidPosition,
}

#[allow(dead_code)]
enum PlayState {
    Idle,
    Loading {
        track: TrackInfo,
    },
    Playing {
        track: TrackInfo,
        started_at: Instant,
        position_ms: u64,
    },
    Paused {
        track: TrackInfo,
        position_ms: u64,
    },
    Error {
        track: TrackInfo,
        error: String,
    },
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
        let (cmd_tx, cmd_rx) = mpsc::channel(64);
        let (event_tx, _) = broadcast::channel(BROADCAST_CAPACITY);

        let actor = PlayerActor {
            cmd_rx,
            event_tx: event_tx.clone(),
            state: PlayState::Idle,
            queue: Queue::new(),
            volume: 5,
            seq: 0,
            listeners: Vec::new(),
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
        let _ = self.cmd_tx.send(cmd).await;
    }

    pub async fn play(&self, track: TrackInfo, user_id: String) -> Result<(), PlayerError> {
        let (tx, rx) = oneshot::channel();
        self.send_cmd(PlayerCommand::Play {
            track,
            user_id,
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

    pub async fn enqueue(&self, track: TrackInfo, user_id: String) -> Result<(), PlayerError> {
        let (tx, rx) = oneshot::channel();
        self.send_cmd(PlayerCommand::Enqueue {
            track,
            user_id,
            reply: tx,
        })
        .await;
        rx.await.unwrap_or(Err(PlayerError::NoTrack))
    }

    pub async fn remove(&self, position: usize) -> Result<(), PlayerError> {
        let (tx, rx) = oneshot::channel();
        self.send_cmd(PlayerCommand::Remove { position, reply: tx })
            .await;
        rx.await.unwrap_or(Err(PlayerError::NoTrack))
    }

    pub async fn get_state(&self) -> PlayerSnapshot {
        let (tx, rx) = oneshot::channel();
        self.send_cmd(PlayerCommand::GetState { reply: tx }).await;
        rx.await.unwrap_or_else(|_| PlayerSnapshot {
            state: PlayStateInfo::Idle,
            queue: Vec::new(),
            volume: 5,
            loop_mode: LoopMode::Off,
            listeners: Vec::new(),
        })
    }

    pub async fn on_track_end(&self, track_id: String, reason: TrackEndReason) {
        self.send_cmd(PlayerCommand::OnTrackEnd { track_id, reason })
            .await;
    }
}

struct PlayerActor {
    cmd_rx: mpsc::Receiver<PlayerCommand>,
    event_tx: broadcast::Sender<SeqEvent>,
    state: PlayState,
    queue: Queue,
    volume: u8,
    seq: u64,
    listeners: Vec<UserInfo>,
}

impl PlayerActor {
    async fn run(mut self) {
        info!("Player actor started");
        while let Some(cmd) = self.cmd_rx.recv().await {
            self.handle(cmd);
        }
        info!("Player actor stopped");
    }

    fn broadcast(&mut self, event: PlayerEvent) {
        self.seq += 1;
        let seq_event = SeqEvent {
            seq: self.seq,
            event,
        };
        let _ = self.event_tx.send(seq_event);
    }

    fn snapshot(&self) -> PlayerSnapshot {
        let state_info = match &self.state {
            PlayState::Idle => PlayStateInfo::Idle,
            PlayState::Loading { track } => PlayStateInfo::Loading {
                track: track.clone(),
            },
            PlayState::Playing {
                track,
                started_at,
                position_ms,
            } => PlayStateInfo::Playing {
                track: track.clone(),
                position_ms: *position_ms + started_at.elapsed().as_millis() as u64,
            },
            PlayState::Paused { track, position_ms } => PlayStateInfo::Paused {
                track: track.clone(),
                position_ms: *position_ms,
            },
            PlayState::Error { track, error } => PlayStateInfo::Error {
                track: track.clone(),
                error: error.clone(),
            },
        };

        PlayerSnapshot {
            state: state_info,
            queue: self.queue.items(),
            volume: self.volume,
            loop_mode: self.queue.loop_mode(),
            listeners: self.listeners.clone(),
        }
    }

    fn handle(&mut self, cmd: PlayerCommand) {
        match cmd {
            PlayerCommand::Play {
                track,
                user_id: _,
                reply,
            } => {
                self.broadcast(PlayerEvent::TrackLoading {
                    track: track.clone(),
                });
                // Transition to Playing (in real code, Loading → download → Playing)
                // For now, go directly to Playing since download happens externally
                self.volume = track.volume;
                self.state = PlayState::Playing {
                    track: track.clone(),
                    started_at: Instant::now(),
                    position_ms: 0,
                };
                self.broadcast(PlayerEvent::TrackStarted {
                    track,
                    position_ms: 0,
                });
                self.broadcast(PlayerEvent::VolumeChanged { volume: self.volume });
                let _ = reply.send(Ok(()));
            }

            PlayerCommand::Pause { reply } => match &self.state {
                PlayState::Playing {
                    track,
                    started_at,
                    position_ms,
                } => {
                    let pos = *position_ms + started_at.elapsed().as_millis() as u64;
                    let track = track.clone();
                    self.state = PlayState::Paused {
                        track,
                        position_ms: pos,
                    };
                    self.broadcast(PlayerEvent::Paused { position_ms: pos });
                    let _ = reply.send(Ok(()));
                }
                _ => {
                    let _ = reply.send(Err(PlayerError::InvalidState(
                        "not playing".to_string(),
                    )));
                }
            },

            PlayerCommand::Resume { reply } => match &self.state {
                PlayState::Paused { track, position_ms } => {
                    let track = track.clone();
                    let pos = *position_ms;
                    self.state = PlayState::Playing {
                        track,
                        started_at: Instant::now(),
                        position_ms: pos,
                    };
                    self.broadcast(PlayerEvent::Resumed { position_ms: pos });
                    let _ = reply.send(Ok(()));
                }
                _ => {
                    let _ = reply.send(Err(PlayerError::InvalidState(
                        "not paused".to_string(),
                    )));
                }
            },

            PlayerCommand::Skip { reply } => {
                let current_track_id = match &self.state {
                    PlayState::Playing { track, .. }
                    | PlayState::Paused { track, .. }
                    | PlayState::Loading { track }
                    | PlayState::Error { track, .. } => Some(track.id.clone()),
                    PlayState::Idle => None,
                };

                if let Some(id) = current_track_id {
                    self.broadcast(PlayerEvent::TrackEnded { track_id: id });
                }

                if let Some(next) = self.queue.advance() {
                    let track = next.track;
                    self.volume = track.volume;
                    self.state = PlayState::Playing {
                        track: track.clone(),
                        started_at: Instant::now(),
                        position_ms: 0,
                    };
                    self.broadcast(PlayerEvent::TrackStarted {
                        track: track.clone(),
                        position_ms: 0,
                    });
                    self.broadcast(PlayerEvent::VolumeChanged { volume: self.volume });
                    let _ = reply.send(Ok(Some(track)));
                } else {
                    self.state = PlayState::Idle;
                    let _ = reply.send(Ok(None));
                }
            }

            PlayerCommand::Stop { reply } => {
                if let PlayState::Playing { track, .. }
                | PlayState::Paused { track, .. }
                | PlayState::Loading { track }
                | PlayState::Error { track, .. } = &self.state
                {
                    self.broadcast(PlayerEvent::TrackEnded {
                        track_id: track.id.clone(),
                    });
                }
                self.state = PlayState::Idle;
                self.queue.clear();
                self.broadcast(PlayerEvent::QueueUpdated {
                    queue: Vec::new(),
                });
                let _ = reply.send(Ok(()));
            }

            PlayerCommand::Seek { position_ms, reply } => match &self.state {
                PlayState::Playing { track, .. } => {
                    let track = track.clone();
                    self.state = PlayState::Playing {
                        track,
                        started_at: Instant::now(),
                        position_ms,
                    };
                    self.broadcast(PlayerEvent::Seeked { position_ms, paused: false });
                    let _ = reply.send(Ok(()));
                }
                PlayState::Paused { track, .. } => {
                    let track = track.clone();
                    self.state = PlayState::Paused {
                        track,
                        position_ms,
                    };
                    self.broadcast(PlayerEvent::Seeked { position_ms, paused: true });
                    let _ = reply.send(Ok(()));
                }
                _ => {
                    let _ = reply.send(Err(PlayerError::InvalidState(
                        "no track to seek".to_string(),
                    )));
                }
            },

            PlayerCommand::SetVolume { volume, reply } => {
                self.volume = volume.min(100);
                self.broadcast(PlayerEvent::VolumeChanged {
                    volume: self.volume,
                });
                let _ = reply.send(Ok(()));
            }

            PlayerCommand::SetLoop { mode, reply } => {
                self.queue.set_loop_mode(mode);
                self.broadcast(PlayerEvent::LoopModeChanged { mode });
                let _ = reply.send(Ok(()));
            }

            PlayerCommand::Enqueue {
                track,
                user_id,
                reply,
            } => {
                self.queue.enqueue(track, user_id);
                self.broadcast(PlayerEvent::QueueUpdated {
                    queue: self.queue.items(),
                });
                let _ = reply.send(Ok(()));
            }

            PlayerCommand::Remove { position, reply } => {
                if self.queue.remove(position).is_some() {
                    self.broadcast(PlayerEvent::QueueUpdated {
                        queue: self.queue.items(),
                    });
                    let _ = reply.send(Ok(()));
                } else {
                    let _ = reply.send(Err(PlayerError::InvalidPosition));
                }
            }

            PlayerCommand::GetState { reply } => {
                let _ = reply.send(self.snapshot());
            }

            PlayerCommand::OnTrackEnd { track_id, reason } => {
                // Verify the track_id matches the current track to prevent race conditions
                let current_matches = match &self.state {
                    PlayState::Playing { track, .. }
                    | PlayState::Loading { track }
                    | PlayState::Error { track, .. } => track.id == track_id,
                    _ => false,
                };

                if !current_matches {
                    warn!(
                        track_id,
                        "OnTrackEnd ignored: track_id doesn't match current"
                    );
                    return;
                }

                match reason {
                    TrackEndReason::Finished | TrackEndReason::Replaced => {
                        self.broadcast(PlayerEvent::TrackEnded { track_id });
                    }
                    TrackEndReason::Error(ref err) => {
                        self.broadcast(PlayerEvent::TrackError {
                            track_id: track_id.clone(),
                            error: err.clone(),
                        });
                    }
                }

                // Auto-advance
                if let Some(next) = self.queue.advance() {
                    let track = next.track;
                    self.volume = track.volume;
                    self.state = PlayState::Playing {
                        track: track.clone(),
                        started_at: Instant::now(),
                        position_ms: 0,
                    };
                    self.broadcast(PlayerEvent::TrackStarted {
                        track,
                        position_ms: 0,
                    });
                    self.broadcast(PlayerEvent::VolumeChanged { volume: self.volume });
                } else {
                    self.state = PlayState::Idle;
                }
            }
        }
    }
}
