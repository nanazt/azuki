use std::collections::VecDeque;
use std::time::Instant;

use tokio::sync::{broadcast, mpsc, oneshot};
use tracing::{info, warn};

use crate::events::{
    LoopMode, PlayStateInfo, PlayerEvent, PlayerSnapshot, QueueEntry, SeqEvent, TrackInfo, UserInfo,
};
use crate::multi_queue::{MultiQueue, PlaylistOverflow, QueueKind, QueueSlotInfo, SlotId};
use crate::queue::Queue;

const BROADCAST_CAPACITY: usize = 64;

#[derive(Debug)]
pub enum TrackEndReason {
    Finished,
    Error(String),
    Replaced,
}

pub enum MultiQueueCommand {
    PlayPlaylist {
        playlist_id: i64,
        entries: Vec<QueueEntry>,
        overflow_entries: Vec<QueueEntry>,
        total_tracks: usize,
        imported_by: UserInfo,
        reply: oneshot::Sender<Result<SlotId, PlayerError>>,
    },
    SwitchQueue {
        slot_id: SlotId,
        reply: oneshot::Sender<Result<(), PlayerError>>,
    },
    DeleteSlot {
        slot_id: SlotId,
        reply: oneshot::Sender<Result<(), PlayerError>>,
    },
    GetMultiQueueState {
        reply: oneshot::Sender<Vec<QueueSlotInfo>>,
    },
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
    OnTrackEnd {
        track_id: String,
        reason: TrackEndReason,
    },
    MultiQueue(MultiQueueCommand),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlayAction {
    PlayedNow,
    Enqueued,
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
    #[error("playlist queue: cannot modify")]
    PlaylistQueueReadOnly,
    #[error("slot limit reached (max 4)")]
    SlotLimitReached,
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
        Self::with_history(Vec::new())
    }

    pub fn with_history(history: Vec<QueueEntry>) -> Self {
        Self::with_state(Vec::new(), history, LoopMode::Off, None)
    }

    pub fn with_state(
        queue_items: Vec<QueueEntry>,
        history: Vec<QueueEntry>,
        loop_mode: LoopMode,
        current_track: Option<QueueEntry>,
    ) -> Self {
        let (cmd_tx, cmd_rx) = mpsc::channel(64);
        let (event_tx, _) = broadcast::channel(BROADCAST_CAPACITY);

        let current_added_by = current_track.as_ref().map(|e| e.added_by.clone());
        let initial_state = match current_track {
            Some(entry) => PlayState::Paused {
                track: entry.track,
                position_ms: 0,
            },
            None => PlayState::Idle,
        };
        let actor = PlayerActor {
            cmd_rx,
            event_tx: event_tx.clone(),
            state: initial_state,
            multi_queue: MultiQueue::with_default_queue(Queue::with_state(
                queue_items,
                history,
                loop_mode,
            )),
            volume: 5,
            seq: 0,
            listeners: Vec::new(),
            current_added_by,
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
        self.send_cmd(PlayerCommand::Remove { position, reply: tx })
            .await;
        rx.await.unwrap_or(Err(PlayerError::NoTrack))
    }

    pub async fn play_at(&self, position: usize) -> Result<(), PlayerError> {
        let (tx, rx) = oneshot::channel();
        self.send_cmd(PlayerCommand::PlayAt { position, reply: tx })
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

    pub async fn get_state(&self) -> PlayerSnapshot {
        let (tx, rx) = oneshot::channel();
        self.send_cmd(PlayerCommand::GetState { reply: tx }).await;
        rx.await.unwrap_or_else(|_| PlayerSnapshot {
            state: PlayStateInfo::Idle,
            queue: Vec::new(),
            history: Vec::new(),
            volume: 5,
            loop_mode: LoopMode::Off,
            listeners: Vec::new(),
            current_added_by: None,
            active_slot: 0,
            queue_slots: Vec::new(),
        })
    }

    pub async fn on_track_end(&self, track_id: String, reason: TrackEndReason) {
        self.send_cmd(PlayerCommand::OnTrackEnd { track_id, reason })
            .await;
    }

    pub async fn play_playlist(
        &self,
        playlist_id: i64,
        entries: Vec<QueueEntry>,
        overflow_entries: Vec<QueueEntry>,
        total_tracks: usize,
        imported_by: UserInfo,
    ) -> Result<SlotId, PlayerError> {
        let (tx, rx) = oneshot::channel();
        self.send_cmd(PlayerCommand::MultiQueue(MultiQueueCommand::PlayPlaylist {
            playlist_id,
            entries,
            overflow_entries,
            total_tracks,
            imported_by,
            reply: tx,
        }))
        .await;
        rx.await.unwrap_or(Err(PlayerError::NoTrack))
    }

    pub async fn switch_queue(&self, slot_id: SlotId) -> Result<(), PlayerError> {
        let (tx, rx) = oneshot::channel();
        self.send_cmd(PlayerCommand::MultiQueue(MultiQueueCommand::SwitchQueue {
            slot_id,
            reply: tx,
        }))
        .await;
        rx.await.unwrap_or(Err(PlayerError::NoTrack))
    }

    pub async fn delete_slot(&self, slot_id: SlotId) -> Result<(), PlayerError> {
        let (tx, rx) = oneshot::channel();
        self.send_cmd(PlayerCommand::MultiQueue(MultiQueueCommand::DeleteSlot {
            slot_id,
            reply: tx,
        }))
        .await;
        rx.await.unwrap_or(Err(PlayerError::NoTrack))
    }

    pub async fn get_multi_queue_state(&self) -> Vec<QueueSlotInfo> {
        let (tx, rx) = oneshot::channel();
        self.send_cmd(PlayerCommand::MultiQueue(
            MultiQueueCommand::GetMultiQueueState { reply: tx },
        ))
        .await;
        rx.await.unwrap_or_default()
    }
}

struct PlayerActor {
    cmd_rx: mpsc::Receiver<PlayerCommand>,
    event_tx: broadcast::Sender<SeqEvent>,
    state: PlayState,
    multi_queue: MultiQueue,
    volume: u8,
    seq: u64,
    listeners: Vec<UserInfo>,
    current_added_by: Option<UserInfo>,
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

    fn current_position_ms(&self) -> u64 {
        match &self.state {
            PlayState::Playing {
                started_at,
                position_ms,
                ..
            } => position_ms + started_at.elapsed().as_millis() as u64,
            PlayState::Paused { position_ms, .. } => *position_ms,
            _ => 0,
        }
    }

    fn current_track_id(&self) -> Option<String> {
        match &self.state {
            PlayState::Playing { track, .. }
            | PlayState::Paused { track, .. }
            | PlayState::Loading { track }
            | PlayState::Error { track, .. } => Some(track.id.clone()),
            PlayState::Idle => None,
        }
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
            queue: self.multi_queue.active_queue().items(),
            history: self.multi_queue.active_queue().history().to_vec(),
            volume: self.volume,
            loop_mode: self.multi_queue.active_queue().loop_mode(),
            listeners: self.listeners.clone(),
            current_added_by: self.current_added_by.clone(),
            active_slot: self.multi_queue.active_slot(),
            queue_slots: self.multi_queue.snapshot_slots(),
        }
    }

    fn handle(&mut self, cmd: PlayerCommand) {
        match cmd {
            PlayerCommand::Play {
                track,
                user_info,
                reply,
            } => {
                self.broadcast(PlayerEvent::TrackLoading {
                    track: track.clone(),
                });
                self.volume = track.volume;
                self.current_added_by = Some(user_info.clone());
                self.state = PlayState::Playing {
                    track: track.clone(),
                    started_at: Instant::now(),
                    position_ms: 0,
                };
                self.broadcast(PlayerEvent::TrackStarted {
                    track,
                    position_ms: 0,
                    added_by: user_info,
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
                let current_entry = match &self.state {
                    PlayState::Playing { track, .. }
                    | PlayState::Paused { track, .. }
                    | PlayState::Loading { track }
                    | PlayState::Error { track, .. } => Some(QueueEntry {
                        track: track.clone(),
                        added_by: self
                            .current_added_by
                            .clone()
                            .unwrap_or_else(UserInfo::unknown),
                    }),
                    PlayState::Idle => None,
                };

                if let Some(ref entry) = current_entry {
                    let listened_ms = self.current_position_ms();
                    self.broadcast(PlayerEvent::TrackEnded {
                        track_id: entry.track.id.clone(),
                        listened_ms,
                        completed: false,
                    });
                    self.multi_queue
                        .active_queue_mut()
                        .push_to_history(entry.clone());
                }

                if let Some(next) = self.multi_queue.active_queue_mut().advance() {
                    self.current_added_by = Some(next.added_by.clone());
                    let added_by = next.added_by;
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
                        added_by,
                    });
                    self.broadcast(PlayerEvent::VolumeChanged { volume: self.volume });
                    self.broadcast(PlayerEvent::QueueUpdated {
                        queue: self.multi_queue.active_queue().items(),
                        slot_id: self.multi_queue.active_slot(),
                    });
                    self.broadcast(PlayerEvent::HistoryUpdated {
                        history: self.multi_queue.active_queue().history().to_vec(),
                    });
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
                    let listened_ms = self.current_position_ms();
                    self.broadcast(PlayerEvent::TrackEnded {
                        track_id: track.id.clone(),
                        listened_ms,
                        completed: false,
                    });
                }
                self.state = PlayState::Idle;
                self.current_added_by = None;
                self.multi_queue.active_queue_mut().clear();
                self.broadcast(PlayerEvent::QueueUpdated {
                    queue: Vec::new(),
                    slot_id: self.multi_queue.active_slot(),
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
                    self.broadcast(PlayerEvent::Seeked {
                        position_ms,
                        paused: false,
                    });
                    let _ = reply.send(Ok(()));
                }
                PlayState::Paused { track, .. } => {
                    let track = track.clone();
                    self.state = PlayState::Paused {
                        track,
                        position_ms,
                    };
                    self.broadcast(PlayerEvent::Seeked {
                        position_ms,
                        paused: true,
                    });
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
                self.multi_queue.active_queue_mut().set_loop_mode(mode);
                self.broadcast(PlayerEvent::LoopModeChanged { mode });
                let _ = reply.send(Ok(()));
            }

            PlayerCommand::Enqueue {
                track,
                user_info,
                reply,
            } => {
                // Block enqueue on playlist queues
                if matches!(self.multi_queue.active_kind(), QueueKind::Playlist { .. }) {
                    let _ = reply.send(Err(PlayerError::PlaylistQueueReadOnly));
                    return;
                }
                let now_playing = match &self.state {
                    PlayState::Playing { track: t, .. }
                    | PlayState::Paused { track: t, .. }
                    | PlayState::Loading { track: t }
                    | PlayState::Error { track: t, .. } => Some(t.id.as_str()),
                    PlayState::Idle => None,
                };
                let is_duplicate = now_playing == Some(track.id.as_str())
                    || self.multi_queue.active_queue().contains(&track.id);
                if is_duplicate {
                    let _ = reply.send(Err(PlayerError::Duplicate));
                } else if self
                    .multi_queue
                    .active_queue_mut()
                    .enqueue(track, user_info)
                {
                    self.broadcast(PlayerEvent::QueueUpdated {
                        queue: self.multi_queue.active_queue().items(),
                        slot_id: self.multi_queue.active_slot(),
                    });
                    let _ = reply.send(Ok(()));
                } else {
                    let _ = reply.send(Err(PlayerError::QueueFull));
                }
            }

            PlayerCommand::Previous { reply } => {
                const RESTART_THRESHOLD_MS: u64 = 5000;

                let (current_pos, has_track) = match &self.state {
                    PlayState::Playing {
                        started_at,
                        position_ms,
                        ..
                    } => (*position_ms + started_at.elapsed().as_millis() as u64, true),
                    PlayState::Paused { position_ms, .. } => (*position_ms, true),
                    _ => (0, false),
                };

                if !has_track {
                    let _ = reply.send(Err(PlayerError::InvalidState(
                        "no track to go back from".to_string(),
                    )));
                    return;
                }

                // LoopMode::One or position > threshold → seek to 0
                let should_restart = self.multi_queue.active_queue().loop_mode() == LoopMode::One
                    || current_pos > RESTART_THRESHOLD_MS;

                if should_restart {
                    match &self.state {
                        PlayState::Playing { track, .. } => {
                            let track = track.clone();
                            self.state = PlayState::Playing {
                                track,
                                started_at: Instant::now(),
                                position_ms: 0,
                            };
                            self.broadcast(PlayerEvent::Seeked {
                                position_ms: 0,
                                paused: false,
                            });
                        }
                        PlayState::Paused { track, .. } => {
                            let track = track.clone();
                            self.state = PlayState::Paused {
                                track,
                                position_ms: 0,
                            };
                            self.broadcast(PlayerEvent::Seeked {
                                position_ms: 0,
                                paused: true,
                            });
                        }
                        _ => unreachable!(),
                    }
                    let _ = reply.send(Ok(()));
                    return;
                }

                // LoopMode::All and position <= threshold → rotate queue backward
                if self.multi_queue.active_queue().loop_mode() == LoopMode::All {
                    let prev = self.multi_queue.active_queue_mut().pop_back();
                    if let Some(prev_entry) = prev {
                        let current_track = match &self.state {
                            PlayState::Playing { track, .. }
                            | PlayState::Paused { track, .. } => track.clone(),
                            _ => unreachable!(),
                        };
                        let current_id = current_track.id.clone();
                        let listened_ms = self.current_position_ms();
                        self.multi_queue.active_queue_mut().push_front(QueueEntry {
                            track: current_track,
                            added_by: self
                                .current_added_by
                                .clone()
                                .unwrap_or_else(UserInfo::unknown),
                        });
                        self.broadcast(PlayerEvent::TrackEnded {
                            track_id: current_id,
                            listened_ms,
                            completed: false,
                        });
                        self.current_added_by = Some(prev_entry.added_by.clone());
                        let added_by = prev_entry.added_by;
                        let track = prev_entry.track;
                        self.volume = track.volume;
                        self.state = PlayState::Playing {
                            track: track.clone(),
                            started_at: Instant::now(),
                            position_ms: 0,
                        };
                        self.broadcast(PlayerEvent::TrackStarted {
                            track,
                            position_ms: 0,
                            added_by,
                        });
                        self.broadcast(PlayerEvent::VolumeChanged { volume: self.volume });
                        self.broadcast(PlayerEvent::QueueUpdated {
                            queue: self.multi_queue.active_queue().items(),
                            slot_id: self.multi_queue.active_slot(),
                        });
                    } else {
                        // Empty queue in All mode, just seek to 0
                        match &self.state {
                            PlayState::Playing { track, .. } => {
                                let track = track.clone();
                                self.state = PlayState::Playing {
                                    track,
                                    started_at: Instant::now(),
                                    position_ms: 0,
                                };
                                self.broadcast(PlayerEvent::Seeked {
                                    position_ms: 0,
                                    paused: false,
                                });
                            }
                            PlayState::Paused { track, .. } => {
                                let track = track.clone();
                                self.state = PlayState::Paused {
                                    track,
                                    position_ms: 0,
                                };
                                self.broadcast(PlayerEvent::Seeked {
                                    position_ms: 0,
                                    paused: true,
                                });
                            }
                            _ => unreachable!(),
                        }
                    }
                    let _ = reply.send(Ok(()));
                    return;
                }

                // LoopMode::Off and position <= threshold → go to history
                if let Some(prev_entry) = self.multi_queue.active_queue_mut().go_previous() {
                    let current_track = match &self.state {
                        PlayState::Playing { track, .. }
                        | PlayState::Paused { track, .. } => track.clone(),
                        _ => unreachable!(),
                    };
                    let current_id = current_track.id.clone();
                    let listened_ms = self.current_position_ms();
                    self.multi_queue.active_queue_mut().push_front(QueueEntry {
                        track: current_track,
                        added_by: self
                            .current_added_by
                            .clone()
                            .unwrap_or_else(UserInfo::unknown),
                    });
                    self.broadcast(PlayerEvent::TrackEnded {
                        track_id: current_id,
                        listened_ms,
                        completed: false,
                    });
                    self.current_added_by = Some(prev_entry.added_by.clone());
                    let added_by = prev_entry.added_by;
                    let track = prev_entry.track;
                    self.volume = track.volume;
                    self.state = PlayState::Playing {
                        track: track.clone(),
                        started_at: Instant::now(),
                        position_ms: 0,
                    };
                    self.broadcast(PlayerEvent::TrackStarted {
                        track,
                        position_ms: 0,
                        added_by,
                    });
                    self.broadcast(PlayerEvent::VolumeChanged { volume: self.volume });
                    self.broadcast(PlayerEvent::QueueUpdated {
                        queue: self.multi_queue.active_queue().items(),
                        slot_id: self.multi_queue.active_slot(),
                    });
                    self.broadcast(PlayerEvent::HistoryUpdated {
                        history: self.multi_queue.active_queue().history().to_vec(),
                    });
                } else {
                    // No history, seek to 0
                    match &self.state {
                        PlayState::Playing { track, .. } => {
                            let track = track.clone();
                            self.state = PlayState::Playing {
                                track,
                                started_at: Instant::now(),
                                position_ms: 0,
                            };
                            self.broadcast(PlayerEvent::Seeked {
                                position_ms: 0,
                                paused: false,
                            });
                        }
                        PlayState::Paused { track, .. } => {
                            let track = track.clone();
                            self.state = PlayState::Paused {
                                track,
                                position_ms: 0,
                            };
                            self.broadcast(PlayerEvent::Seeked {
                                position_ms: 0,
                                paused: true,
                            });
                        }
                        _ => unreachable!(),
                    }
                }
                let _ = reply.send(Ok(()));
            }

            PlayerCommand::PlayAt { position, reply } => {
                if let Some(entry) = self.multi_queue.active_queue_mut().remove(position) {
                    let current_entry = match &self.state {
                        PlayState::Playing { track, .. }
                        | PlayState::Paused { track, .. }
                        | PlayState::Loading { track }
                        | PlayState::Error { track, .. } => Some(QueueEntry {
                            track: track.clone(),
                            added_by: self
                                .current_added_by
                                .clone()
                                .unwrap_or_else(UserInfo::unknown),
                        }),
                        PlayState::Idle => None,
                    };

                    if let Some(ref cur) = current_entry {
                        let listened_ms = self.current_position_ms();
                        self.broadcast(PlayerEvent::TrackEnded {
                            track_id: cur.track.id.clone(),
                            listened_ms,
                            completed: false,
                        });
                        self.multi_queue
                            .active_queue_mut()
                            .push_to_history(cur.clone());
                    }

                    self.current_added_by = Some(entry.added_by.clone());
                    self.volume = entry.track.volume;
                    let added_by = entry.added_by;
                    let track = entry.track;
                    self.state = PlayState::Playing {
                        track: track.clone(),
                        started_at: Instant::now(),
                        position_ms: 0,
                    };
                    self.broadcast(PlayerEvent::TrackStarted {
                        track,
                        position_ms: 0,
                        added_by,
                    });
                    self.broadcast(PlayerEvent::VolumeChanged { volume: self.volume });
                    self.broadcast(PlayerEvent::QueueUpdated {
                        queue: self.multi_queue.active_queue().items(),
                        slot_id: self.multi_queue.active_slot(),
                    });
                    self.broadcast(PlayerEvent::HistoryUpdated {
                        history: self.multi_queue.active_queue().history().to_vec(),
                    });
                    let _ = reply.send(Ok(()));
                } else {
                    let _ = reply.send(Err(PlayerError::InvalidPosition));
                }
            }

            PlayerCommand::Remove { position, reply } => {
                if self
                    .multi_queue
                    .active_queue_mut()
                    .remove(position)
                    .is_some()
                {
                    self.broadcast(PlayerEvent::QueueUpdated {
                        queue: self.multi_queue.active_queue().items(),
                        slot_id: self.multi_queue.active_slot(),
                    });
                    let _ = reply.send(Ok(()));
                } else {
                    let _ = reply.send(Err(PlayerError::InvalidPosition));
                }
            }

            PlayerCommand::MoveInQueue { from, to, reply } => {
                if self.multi_queue.active_queue_mut().move_item(from, to) {
                    self.broadcast(PlayerEvent::QueueUpdated {
                        queue: self.multi_queue.active_queue().items(),
                        slot_id: self.multi_queue.active_slot(),
                    });
                    let _ = reply.send(Ok(()));
                } else {
                    let _ = reply.send(Err(PlayerError::InvalidPosition));
                }
            }

            PlayerCommand::PlayOrEnqueue {
                track,
                user_info,
                reply,
            } => {
                let action = match &self.state {
                    PlayState::Idle => {
                        self.broadcast(PlayerEvent::TrackLoading {
                            track: track.clone(),
                        });
                        self.volume = track.volume;
                        self.current_added_by = Some(user_info.clone());
                        self.state = PlayState::Playing {
                            track: track.clone(),
                            started_at: Instant::now(),
                            position_ms: 0,
                        };
                        self.broadcast(PlayerEvent::TrackStarted {
                            track,
                            position_ms: 0,
                            added_by: user_info,
                        });
                        self.broadcast(PlayerEvent::VolumeChanged { volume: self.volume });
                        Ok(PlayAction::PlayedNow)
                    }
                    PlayState::Paused {
                        track: current,
                        position_ms,
                    } if *position_ms >= current.duration_ms => {
                        self.broadcast(PlayerEvent::TrackLoading {
                            track: track.clone(),
                        });
                        self.volume = track.volume;
                        self.current_added_by = Some(user_info.clone());
                        self.state = PlayState::Playing {
                            track: track.clone(),
                            started_at: Instant::now(),
                            position_ms: 0,
                        };
                        self.broadcast(PlayerEvent::TrackStarted {
                            track,
                            position_ms: 0,
                            added_by: user_info,
                        });
                        self.broadcast(PlayerEvent::VolumeChanged { volume: self.volume });
                        Ok(PlayAction::PlayedNow)
                    }
                    _ => {
                        // Block enqueue on playlist queues
                        if matches!(self.multi_queue.active_kind(), QueueKind::Playlist { .. }) {
                            Err(PlayerError::PlaylistQueueReadOnly)
                        } else {
                            let now_playing = match &self.state {
                                PlayState::Playing { track: t, .. }
                                | PlayState::Paused { track: t, .. }
                                | PlayState::Loading { track: t }
                                | PlayState::Error { track: t, .. } => Some(t.id.as_str()),
                                PlayState::Idle => None,
                            };
                            let is_duplicate = now_playing == Some(track.id.as_str())
                                || self.multi_queue.active_queue().contains(&track.id);
                            if is_duplicate {
                                Err(PlayerError::Duplicate)
                            } else if self
                                .multi_queue
                                .active_queue_mut()
                                .enqueue(track, user_info)
                            {
                                self.broadcast(PlayerEvent::QueueUpdated {
                                    queue: self.multi_queue.active_queue().items(),
                                    slot_id: self.multi_queue.active_slot(),
                                });
                                Ok(PlayAction::Enqueued)
                            } else {
                                Err(PlayerError::QueueFull)
                            }
                        }
                    }
                };
                let _ = reply.send(action);
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

                if let TrackEndReason::Error(ref err) = reason {
                    self.broadcast(PlayerEvent::TrackError {
                        track_id: track_id.clone(),
                        error: err.clone(),
                    });
                }

                // Push current track to history before advancing
                let current_track = match &self.state {
                    PlayState::Playing { track, .. }
                    | PlayState::Loading { track }
                    | PlayState::Error { track, .. } => Some(track.clone()),
                    _ => None,
                };
                if let Some(ref track) = current_track {
                    self.multi_queue
                        .active_queue_mut()
                        .push_to_history(QueueEntry {
                            track: track.clone(),
                            added_by: self
                                .current_added_by
                                .clone()
                                .unwrap_or_else(UserInfo::unknown),
                        });
                }

                let completed = matches!(reason, TrackEndReason::Finished);
                let listened_ms = current_track.as_ref().map_or(0, |t| {
                    self.current_position_ms().min(t.duration_ms)
                });

                // Auto-advance
                if let Some(next) = self.multi_queue.active_queue_mut().advance() {
                    self.broadcast(PlayerEvent::TrackEnded {
                        track_id,
                        listened_ms,
                        completed,
                    });
                    self.current_added_by = Some(next.added_by.clone());
                    let added_by = next.added_by;
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
                        added_by,
                    });
                    self.broadcast(PlayerEvent::VolumeChanged { volume: self.volume });
                    self.broadcast(PlayerEvent::QueueUpdated {
                        queue: self.multi_queue.active_queue().items(),
                        slot_id: self.multi_queue.active_slot(),
                    });
                    self.broadcast(PlayerEvent::HistoryUpdated {
                        history: self.multi_queue.active_queue().history().to_vec(),
                    });

                    // Check for overflow refill
                    let refilled = self.multi_queue.refill_from_overflow();
                    if !refilled.is_empty() {
                        let tracks: Vec<TrackInfo> =
                            refilled.iter().map(|e| e.track.clone()).collect();
                        self.broadcast(PlayerEvent::PreDownloadNeeded { tracks });
                        self.broadcast(PlayerEvent::QueueUpdated {
                            queue: self.multi_queue.active_queue().items(),
                            slot_id: self.multi_queue.active_slot(),
                        });
                    }
                } else {
                    // No next track: go idle and notify frontend
                    self.broadcast(PlayerEvent::TrackEnded {
                        track_id,
                        listened_ms,
                        completed,
                    });

                    // Check if playlist slot exhausted — auto-delete and switch back
                    if self.multi_queue.is_active_exhausted() {
                        let exhausted_slot = self.multi_queue.active_slot();
                        if exhausted_slot != 0 {
                            self.multi_queue.delete_slot(exhausted_slot);
                            self.broadcast(PlayerEvent::QueueSlotExhausted {
                                slot_id: exhausted_slot,
                            });
                            self.broadcast(PlayerEvent::QueueSlotDeleted {
                                slot_id: exhausted_slot,
                            });
                            let _ = self.multi_queue.switch_to(0, None);
                            self.broadcast(PlayerEvent::QueueSwitched {
                                slot_id: 0,
                                previous_slot: exhausted_slot,
                            });
                        }
                    }

                    self.state = PlayState::Idle;
                    self.current_added_by = None;
                    self.broadcast(PlayerEvent::HistoryUpdated {
                        history: self.multi_queue.active_queue().history().to_vec(),
                    });
                }
            }

            PlayerCommand::MultiQueue(cmd) => self.handle_multi_queue(cmd),
        }
    }

    fn handle_multi_queue(&mut self, cmd: MultiQueueCommand) {
        match cmd {
            MultiQueueCommand::PlayPlaylist {
                playlist_id,
                entries,
                overflow_entries,
                total_tracks,
                imported_by: _,
                reply,
            } => {
                let overflow = if overflow_entries.is_empty() {
                    None
                } else {
                    Some(PlaylistOverflow {
                        playlist_id,
                        remaining: VecDeque::from(overflow_entries),
                        total_tracks,
                        loaded_count: entries.len(),
                    })
                };

                match self
                    .multi_queue
                    .create_playlist_slot(playlist_id, entries, overflow)
                {
                    Some(slot_id) => {
                        let kind = QueueKind::Playlist { playlist_id };
                        self.broadcast(PlayerEvent::QueueSlotCreated { slot_id, kind });

                        let current_track_id = self.current_track_id();
                        let previous_slot = self.multi_queue.active_slot();
                        if let Err(e) = self.multi_queue.switch_to(slot_id, current_track_id) {
                            let _ = reply.send(Err(e));
                            return;
                        }

                        self.broadcast(PlayerEvent::QueueSwitched {
                            slot_id,
                            previous_slot,
                        });

                        // Start playing the first track from the new slot
                        if let Some(next) = self.multi_queue.active_queue_mut().advance() {
                            self.current_added_by = Some(next.added_by.clone());
                            self.volume = next.track.volume;
                            let added_by = next.added_by;
                            let track = next.track;
                            self.state = PlayState::Playing {
                                track: track.clone(),
                                started_at: Instant::now(),
                                position_ms: 0,
                            };
                            self.broadcast(PlayerEvent::TrackStarted {
                                track,
                                position_ms: 0,
                                added_by,
                            });
                            self.broadcast(PlayerEvent::VolumeChanged { volume: self.volume });
                        }

                        self.broadcast(PlayerEvent::QueueUpdated {
                            queue: self.multi_queue.active_queue().items(),
                            slot_id: self.multi_queue.active_slot(),
                        });

                        let _ = reply.send(Ok(slot_id));
                    }
                    None => {
                        let _ = reply.send(Err(PlayerError::SlotLimitReached));
                    }
                }
            }

            MultiQueueCommand::SwitchQueue { slot_id, reply } => {
                let previous = self.multi_queue.active_slot();
                let current_track_id = self.current_track_id();

                match self.multi_queue.switch_to(slot_id, current_track_id) {
                    Ok(()) => {
                        self.broadcast(PlayerEvent::QueueSwitched {
                            slot_id,
                            previous_slot: previous,
                        });

                        // Try to play first track in new slot
                        if let Some(next) = self.multi_queue.active_queue_mut().advance() {
                            self.current_added_by = Some(next.added_by.clone());
                            self.volume = next.track.volume;
                            let added_by = next.added_by;
                            let track = next.track;
                            self.state = PlayState::Playing {
                                track: track.clone(),
                                started_at: Instant::now(),
                                position_ms: 0,
                            };
                            self.broadcast(PlayerEvent::TrackStarted {
                                track,
                                position_ms: 0,
                                added_by,
                            });
                            self.broadcast(PlayerEvent::VolumeChanged { volume: self.volume });
                        } else if slot_id == 0 {
                            self.state = PlayState::Idle;
                            self.current_added_by = None;
                        }

                        self.broadcast(PlayerEvent::QueueUpdated {
                            queue: self.multi_queue.active_queue().items(),
                            slot_id: self.multi_queue.active_slot(),
                        });

                        let _ = reply.send(Ok(()));
                    }
                    Err(e) => {
                        let _ = reply.send(Err(e));
                    }
                }
            }

            MultiQueueCommand::DeleteSlot { slot_id, reply } => {
                if slot_id == 0 {
                    let _ = reply.send(Err(PlayerError::InvalidState(
                        "cannot delete default queue".to_string(),
                    )));
                    return;
                }

                let was_active = self.multi_queue.active_slot() == slot_id;

                if self.multi_queue.delete_slot(slot_id) {
                    self.broadcast(PlayerEvent::QueueSlotDeleted { slot_id });

                    if was_active {
                        let current_track_id = self.current_track_id();
                        let _ = self.multi_queue.switch_to(0, current_track_id);
                        self.broadcast(PlayerEvent::QueueSwitched {
                            slot_id: 0,
                            previous_slot: slot_id,
                        });
                        self.state = PlayState::Idle;
                        self.current_added_by = None;
                    }

                    let _ = reply.send(Ok(()));
                } else {
                    let _ = reply.send(Err(PlayerError::InvalidState(format!(
                        "slot {slot_id} not found"
                    ))));
                }
            }

            MultiQueueCommand::GetMultiQueueState { reply } => {
                let _ = reply.send(self.multi_queue.snapshot_slots());
            }
        }
    }
}
