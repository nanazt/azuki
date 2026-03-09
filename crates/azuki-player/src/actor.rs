use std::time::Instant;

use tokio::sync::{broadcast, mpsc};
use tracing::{info, warn};

use crate::controller::{PlayAction, PlayerCommand, PlayerError, TrackEndReason};
use crate::events::{
    LoopMode, PlayStateInfo, PlayerEvent, PlayerSnapshot, QueueEntry, SeqEvent, TrackInfo, UserInfo,
};
use crate::queue::Queue;

#[allow(dead_code)]
pub(crate) enum PlayState {
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

pub(crate) struct PlayerActor {
    pub(crate) cmd_rx: mpsc::Receiver<PlayerCommand>,
    pub(crate) event_tx: broadcast::Sender<SeqEvent>,
    pub(crate) state: PlayState,
    pub(crate) queue: Queue,
    pub(crate) volume: u8,
    pub(crate) seq: u64,
    pub(crate) listeners: Vec<UserInfo>,
    pub(crate) current_added_by: Option<UserInfo>,
}

impl PlayerActor {
    pub(crate) async fn run(mut self) {
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
            history: self.queue.history().to_vec(),
            volume: self.volume,
            loop_mode: self.queue.loop_mode(),
            listeners: self.listeners.clone(),
            current_added_by: self.current_added_by.clone(),
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
                    paused: false,
                });
                self.broadcast(PlayerEvent::VolumeChanged {
                    volume: self.volume,
                });
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
                    let _ = reply.send(Err(PlayerError::InvalidState("not playing".to_string())));
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
                    let _ = reply.send(Err(PlayerError::InvalidState("not paused".to_string())));
                }
            },

            PlayerCommand::Skip { reply } => {
                let was_paused = matches!(&self.state, PlayState::Paused { .. });

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
                    self.queue.push_to_history(entry.clone());
                }

                if let Some(next) = self.queue.skip_advance() {
                    self.current_added_by = Some(next.added_by.clone());
                    let added_by = next.added_by;
                    let track = next.track;
                    self.volume = track.volume;
                    self.state = if was_paused {
                        PlayState::Paused {
                            track: track.clone(),
                            position_ms: 0,
                        }
                    } else {
                        PlayState::Playing {
                            track: track.clone(),
                            started_at: Instant::now(),
                            position_ms: 0,
                        }
                    };
                    self.broadcast(PlayerEvent::TrackStarted {
                        track: track.clone(),
                        position_ms: 0,
                        added_by,
                        paused: was_paused,
                    });
                    self.broadcast(PlayerEvent::VolumeChanged {
                        volume: self.volume,
                    });
                    self.broadcast(PlayerEvent::QueueUpdated {
                        queue: self.queue.items(),
                    });
                    self.broadcast(PlayerEvent::HistoryUpdated {
                        history: self.queue.history().to_vec(),
                    });
                    let _ = reply.send(Ok(Some(track)));
                } else {
                    self.state = PlayState::Idle;
                    if current_entry.is_some() {
                        self.broadcast(PlayerEvent::HistoryUpdated {
                            history: self.queue.history().to_vec(),
                        });
                    }
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
                self.queue.clear();
                self.broadcast(PlayerEvent::QueueUpdated { queue: Vec::new() });
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
                    self.state = PlayState::Paused { track, position_ms };
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
                self.queue.set_loop_mode(mode);
                self.broadcast(PlayerEvent::LoopModeChanged { mode });
                let _ = reply.send(Ok(()));
            }

            PlayerCommand::Enqueue {
                track,
                user_info,
                reply,
            } => {
                let now_playing = match &self.state {
                    PlayState::Playing { track: t, .. }
                    | PlayState::Paused { track: t, .. }
                    | PlayState::Loading { track: t }
                    | PlayState::Error { track: t, .. } => Some(t.id.as_str()),
                    PlayState::Idle => None,
                };
                let is_duplicate =
                    now_playing == Some(track.id.as_str()) || self.queue.contains(&track.id);
                if is_duplicate {
                    let _ = reply.send(Err(PlayerError::Duplicate));
                } else if self.queue.enqueue(track, user_info) {
                    self.broadcast(PlayerEvent::QueueUpdated {
                        queue: self.queue.items(),
                    });
                    let _ = reply.send(Ok(()));
                } else {
                    let _ = reply.send(Err(PlayerError::QueueFull));
                }
            }

            PlayerCommand::Previous { reply } => {
                const RESTART_THRESHOLD_MS: u64 = 3000;

                let (current_pos, has_track, was_paused) = match &self.state {
                    PlayState::Playing {
                        started_at,
                        position_ms,
                        ..
                    } => (
                        *position_ms + started_at.elapsed().as_millis() as u64,
                        true,
                        false,
                    ),
                    PlayState::Paused { position_ms, .. } => (*position_ms, true, true),
                    _ => (0, false, false),
                };

                if !has_track {
                    let _ = reply.send(Err(PlayerError::InvalidState(
                        "no track to go back from".to_string(),
                    )));
                    return;
                }

                // Position > threshold → seek to 0 (restart current track)
                let should_restart = current_pos > RESTART_THRESHOLD_MS;

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

                // Position <= threshold → go to history (all loop modes)
                // LoopAll: remove current track's rotation clone before going to history
                if self.queue.loop_mode() == LoopMode::All {
                    let current_id = match &self.state {
                        PlayState::Playing { track, .. } | PlayState::Paused { track, .. } => {
                            track.id.clone()
                        }
                        _ => unreachable!(),
                    };
                    self.queue.remove_last_by_track_id(&current_id);
                }

                if let Some(prev_entry) = self.queue.go_previous() {
                    let current_track = match &self.state {
                        PlayState::Playing { track, .. } | PlayState::Paused { track, .. } => {
                            track.clone()
                        }
                        _ => unreachable!(),
                    };
                    let current_id = current_track.id.clone();
                    let listened_ms = self.current_position_ms();

                    // LoopAll: remove prev's rotation clone from queue
                    if self.queue.loop_mode() == LoopMode::All {
                        self.queue.remove_last_by_track_id(&prev_entry.track.id);
                    }

                    self.queue.push_front(QueueEntry {
                        track: current_track,
                        added_by: self
                            .current_added_by
                            .clone()
                            .unwrap_or_else(UserInfo::unknown),
                    });

                    // LoopAll: push prev's clone to back to maintain rotation invariant
                    if self.queue.loop_mode() == LoopMode::All {
                        self.queue.push_back(QueueEntry {
                            track: prev_entry.track.clone(),
                            added_by: prev_entry.added_by.clone(),
                        });
                    }

                    self.broadcast(PlayerEvent::TrackEnded {
                        track_id: current_id,
                        listened_ms,
                        completed: false,
                    });
                    self.current_added_by = Some(prev_entry.added_by.clone());
                    let added_by = prev_entry.added_by;
                    let track = prev_entry.track;
                    self.volume = track.volume;
                    self.state = if was_paused {
                        PlayState::Paused {
                            track: track.clone(),
                            position_ms: 0,
                        }
                    } else {
                        PlayState::Playing {
                            track: track.clone(),
                            started_at: Instant::now(),
                            position_ms: 0,
                        }
                    };
                    self.broadcast(PlayerEvent::TrackStarted {
                        track,
                        position_ms: 0,
                        added_by,
                        paused: was_paused,
                    });
                    self.broadcast(PlayerEvent::VolumeChanged {
                        volume: self.volume,
                    });
                    self.broadcast(PlayerEvent::QueueUpdated {
                        queue: self.queue.items(),
                    });
                    self.broadcast(PlayerEvent::HistoryUpdated {
                        history: self.queue.history().to_vec(),
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
                let was_paused = matches!(&self.state, PlayState::Paused { .. });
                if let Some(entry) = self.queue.remove(position) {
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
                        self.queue.push_to_history(cur.clone());
                    }

                    self.current_added_by = Some(entry.added_by.clone());
                    self.volume = entry.track.volume;
                    let added_by = entry.added_by;
                    let track = entry.track;
                    self.state = if was_paused {
                        PlayState::Paused {
                            track: track.clone(),
                            position_ms: 0,
                        }
                    } else {
                        PlayState::Playing {
                            track: track.clone(),
                            started_at: Instant::now(),
                            position_ms: 0,
                        }
                    };
                    self.broadcast(PlayerEvent::TrackStarted {
                        track,
                        position_ms: 0,
                        added_by,
                        paused: was_paused,
                    });
                    self.broadcast(PlayerEvent::VolumeChanged {
                        volume: self.volume,
                    });
                    self.broadcast(PlayerEvent::QueueUpdated {
                        queue: self.queue.items(),
                    });
                    self.broadcast(PlayerEvent::HistoryUpdated {
                        history: self.queue.history().to_vec(),
                    });
                    let _ = reply.send(Ok(()));
                } else {
                    let _ = reply.send(Err(PlayerError::InvalidPosition));
                }
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

            PlayerCommand::MoveInQueue { from, to, reply } => {
                if self.queue.move_item(from, to) {
                    self.broadcast(PlayerEvent::QueueUpdated {
                        queue: self.queue.items(),
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
                            paused: false,
                        });
                        self.broadcast(PlayerEvent::VolumeChanged {
                            volume: self.volume,
                        });
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
                            paused: false,
                        });
                        self.broadcast(PlayerEvent::VolumeChanged {
                            volume: self.volume,
                        });
                        Ok(PlayAction::PlayedNow)
                    }
                    _ => {
                        let now_playing = match &self.state {
                            PlayState::Playing { track: t, .. }
                            | PlayState::Paused { track: t, .. }
                            | PlayState::Loading { track: t }
                            | PlayState::Error { track: t, .. } => Some(t.id.as_str()),
                            PlayState::Idle => None,
                        };
                        let is_duplicate = now_playing == Some(track.id.as_str())
                            || self.queue.contains(&track.id);
                        if is_duplicate {
                            Err(PlayerError::Duplicate)
                        } else if self.queue.enqueue(track, user_info) {
                            self.broadcast(PlayerEvent::QueueUpdated {
                                queue: self.queue.items(),
                            });
                            Ok(PlayAction::Enqueued)
                        } else {
                            Err(PlayerError::QueueFull)
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

                // Extract current track info
                let current_track = match &self.state {
                    PlayState::Playing { track, .. }
                    | PlayState::Loading { track }
                    | PlayState::Error { track, .. } => Some(track.clone()),
                    _ => None,
                };

                let completed = matches!(reason, TrackEndReason::Finished);
                let listened_ms = current_track
                    .as_ref()
                    .map_or(0, |t| self.current_position_ms().min(t.duration_ms));

                // LoopMode::One → replay same track without touching history
                if self.queue.loop_mode() == LoopMode::One
                    && let Some(track) = current_track
                {
                    self.broadcast(PlayerEvent::TrackEnded {
                        track_id,
                        listened_ms,
                        completed,
                    });
                    self.volume = track.volume;
                    self.state = PlayState::Playing {
                        track: track.clone(),
                        started_at: Instant::now(),
                        position_ms: 0,
                    };
                    self.broadcast(PlayerEvent::TrackStarted {
                        track,
                        position_ms: 0,
                        added_by: self
                            .current_added_by
                            .clone()
                            .unwrap_or_else(UserInfo::unknown),
                        paused: false,
                    });
                    self.broadcast(PlayerEvent::VolumeChanged {
                        volume: self.volume,
                    });
                    return;
                }

                // Push current track to history (not for LoopMode::One which returned above)
                if let Some(ref track) = current_track {
                    self.queue.push_to_history(QueueEntry {
                        track: track.clone(),
                        added_by: self
                            .current_added_by
                            .clone()
                            .unwrap_or_else(UserInfo::unknown),
                    });
                }

                // Auto-advance
                if let Some(next) = self.queue.advance() {
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
                        paused: false,
                    });
                    self.broadcast(PlayerEvent::VolumeChanged {
                        volume: self.volume,
                    });
                    self.broadcast(PlayerEvent::QueueUpdated {
                        queue: self.queue.items(),
                    });
                    self.broadcast(PlayerEvent::HistoryUpdated {
                        history: self.queue.history().to_vec(),
                    });
                } else {
                    self.broadcast(PlayerEvent::TrackEnded {
                        track_id,
                        listened_ms,
                        completed,
                    });

                    self.state = PlayState::Idle;
                    self.current_added_by = None;
                    self.broadcast(PlayerEvent::HistoryUpdated {
                        history: self.queue.history().to_vec(),
                    });
                }
            }
        }
    }
}
