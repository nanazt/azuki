use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use azuki_player::{PlayStateInfo, PlayerController, TrackEndReason};
use serenity::all::GuildId;
use songbird::Songbird;
use songbird::events::{Event, EventContext, EventHandler as SongbirdEventHandler, TrackEvent};
use songbird::input::File as AudioFile;
use songbird::tracks::{Track, TrackHandle};
use tokio::sync::{Mutex, MutexGuard};
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;
use tracing::{debug, warn};

use crate::BotControl;

const PREPARE_TIMEOUT: Duration = Duration::from_secs(10);

pub(crate) struct GenerationOutput {
    songbird: Arc<Songbird>,
    guild_id: GuildId,
    player: PlayerController,
    control: BotControl,
    generation: u64,
    cancel: CancellationToken,
    state: Mutex<OutputState>,
    operation: Mutex<()>,
}

#[derive(Default)]
struct OutputState {
    handle: Option<TrackHandle>,
    playback_revision: Option<u64>,
}

#[derive(Debug)]
pub(crate) struct ReconcileError {
    pub code: &'static str,
    pub message: &'static str,
}

impl GenerationOutput {
    pub(crate) fn new(
        songbird: Arc<Songbird>,
        guild_id: GuildId,
        player: PlayerController,
        control: BotControl,
        generation: u64,
        cancel: CancellationToken,
    ) -> Self {
        Self {
            songbird,
            guild_id,
            player,
            control,
            generation,
            cancel,
            state: Mutex::new(OutputState::default()),
            operation: Mutex::new(()),
        }
    }

    pub(crate) async fn stop(&self) {
        let Some(_operation) = self.lock_operation_for_generation().await else {
            return;
        };
        self.stop_inner().await;
    }

    pub(crate) async fn stop_for_retirement(&self) {
        let _operation = self.operation.lock().await;
        let mut output = self.state.lock().await;
        output.handle = None;
        output.playback_revision = None;
        if let Some(call) = self.songbird.get(self.guild_id) {
            call.lock().await.stop();
        }
    }

    async fn stop_inner(&self) {
        let mut output = self.state.lock().await;
        output.handle = None;
        output.playback_revision = None;
        if let Some(call) = self.songbird.get(self.guild_id) {
            let mut call = tokio::select! {
                biased;
                _ = self.cancel.cancelled() => return,
                call = call.lock() => call,
            };
            call.stop();
        }
    }

    async fn lock_operation_for_generation(&self) -> Option<MutexGuard<'_, ()>> {
        tokio::select! {
            biased;
            _ = self.cancel.cancelled() => None,
            operation = self.operation.lock() => Some(operation),
        }
    }

    fn interrupted(&self) -> ReconcileError {
        ReconcileError {
            code: "stale_generation",
            message: "A superseded bot generation cannot change playback.",
        }
    }

    async fn until_cancelled<T>(
        &self,
        future: impl Future<Output = T>,
    ) -> Result<T, ReconcileError> {
        tokio::select! {
            biased;
            _ = self.cancel.cancelled() => Err(self.interrupted()),
            result = future => Ok(result),
        }
    }

    pub(crate) async fn reconcile_after_change(&self) -> Result<(), ReconcileError> {
        let _operation = self
            .lock_operation_for_generation()
            .await
            .ok_or_else(|| self.interrupted())?;
        if !self.control.is_current_generation(self.generation) {
            return Err(self.interrupted());
        }
        let snapshot = self
            .until_cancelled(self.player.try_get_state())
            .await?
            .map_err(|error| {
                warn!(?error, "failed to read changed player state");
                ReconcileError {
                    code: "player_unavailable",
                    message: "The current playback state is unavailable.",
                }
            })?;
        if snapshot.playback_suspended {
            self.stop_inner().await;
            return Ok(());
        }

        let applied_revision = self
            .until_cancelled(self.state.lock())
            .await?
            .playback_revision;
        if applied_revision == Some(snapshot.playback_revision) {
            return self.reconcile_inner(false).await;
        }

        if self.cancel.is_cancelled() || !self.control.is_current_generation(self.generation) {
            return Err(self.interrupted());
        }
        self.until_cancelled(self.player.suspend_output())
            .await?
            .map_err(|error| {
                warn!(
                    ?error,
                    "failed to freeze changed playback before native replacement"
                );
                ReconcileError {
                    code: "player_unavailable",
                    message: "The current playback state is unavailable.",
                }
            })?;
        self.stop_inner().await;
        self.reconcile_inner(true).await
    }

    pub(crate) async fn reconcile(&self, allow_resume: bool) -> Result<(), ReconcileError> {
        let _operation = self
            .lock_operation_for_generation()
            .await
            .ok_or_else(|| self.interrupted())?;
        self.reconcile_inner(allow_resume).await
    }

    async fn reconcile_inner(&self, allow_resume: bool) -> Result<(), ReconcileError> {
        if self.cancel.is_cancelled() || !self.control.is_current_generation(self.generation) {
            return Err(self.interrupted());
        }

        let snapshot = self
            .until_cancelled(self.player.try_get_state())
            .await?
            .map_err(|error| {
                warn!(
                    ?error,
                    "failed to read player state for voice reconciliation"
                );
                ReconcileError {
                    code: "player_unavailable",
                    message: "The current playback state is unavailable.",
                }
            })?;
        let revision = snapshot.playback_revision;

        if snapshot.playback_suspended && !allow_resume {
            self.stop_inner().await;
            return Ok(());
        }

        let desired = match &snapshot.state {
            PlayStateInfo::Playing { track, position_ms } => Some((track, *position_ms, false)),
            PlayStateInfo::Paused { track, position_ms } => Some((track, *position_ms, true)),
            PlayStateInfo::Idle => None,
            PlayStateInfo::Loading { .. } => {
                return Err(ReconcileError {
                    code: "playback_loading",
                    message: "Playback is not ready to be restored yet.",
                });
            }
            PlayStateInfo::Error { .. } => {
                return Err(ReconcileError {
                    code: "playback_error",
                    message: "The current track could not be restored.",
                });
            }
        };

        let mut output = self.until_cancelled(self.state.lock()).await?;
        if self.cancel.is_cancelled() || !self.control.is_current_generation(self.generation) {
            return Err(self.interrupted());
        }

        if output.playback_revision == Some(revision) && !snapshot.playback_suspended {
            if desired.is_some()
                && let Some(handle) = &output.handle
                && let Err(error) = handle.set_volume(f32::from(snapshot.volume) / 100.0)
            {
                debug!(?error, "failed to refresh native track volume");
            }
            return Ok(());
        }

        let prepared = if let Some((track, position_ms, paused)) = desired {
            let Some(file_path) = track.file_path.as_deref() else {
                return Err(ReconcileError {
                    code: "track_file_missing",
                    message: "The current track has no playable audio file.",
                });
            };

            let Some(call) = self.songbird.get(self.guild_id) else {
                return Err(ReconcileError {
                    code: "voice_not_connected",
                    message: "The voice connection is not ready.",
                });
            };
            let source = AudioFile::new(file_path.to_owned());
            let native_track = Track::from(source)
                .pause()
                .volume(f32::from(snapshot.volume) / 100.0);
            let handle = {
                let mut call = self.until_cancelled(call.lock()).await?;
                call.stop();
                call.play_only(native_track)
            };

            self.until_cancelled(timeout(PREPARE_TIMEOUT, handle.make_playable_async()))
                .await?
                .map_err(|_| ReconcileError {
                    code: "track_prepare_timeout",
                    message: "Preparing the current track timed out.",
                })?
                .map_err(|error| {
                    warn!(?error, "failed to prepare native track");
                    ReconcileError {
                        code: "track_prepare_failed",
                        message: "The current track could not be prepared.",
                    }
                })?;

            if position_ms > 0 {
                self.until_cancelled(timeout(
                    PREPARE_TIMEOUT,
                    handle.seek_async(Duration::from_millis(position_ms)),
                ))
                .await?
                .map_err(|_| ReconcileError {
                    code: "track_seek_timeout",
                    message: "Restoring the playback position timed out.",
                })?
                .map_err(|error| {
                    warn!(?error, "failed to restore native track position");
                    ReconcileError {
                        code: "track_seek_failed",
                        message: "The playback position could not be restored.",
                    }
                })?;
            }

            handle
                .add_event(
                    Event::Track(TrackEvent::End),
                    TrackEndNotifier {
                        player: self.player.clone(),
                        control: self.control.clone(),
                        track_id: track.id.clone(),
                        generation: self.generation,
                        playback_revision: revision,
                    },
                )
                .map_err(|error| {
                    warn!(?error, "failed to attach native track end callback");
                    ReconcileError {
                        code: "track_callback_failed",
                        message: "Playback completion could not be monitored.",
                    }
                })?;

            Some((handle, paused, track.id.as_str()))
        } else {
            if let Some(call) = self.songbird.get(self.guild_id) {
                self.until_cancelled(call.lock()).await?.stop();
            }
            None
        };

        let latest = self
            .until_cancelled(self.player.try_get_state())
            .await?
            .map_err(|error| {
                warn!(?error, "failed to confirm reconciled player state");
                ReconcileError {
                    code: "player_unavailable",
                    message: "The current playback state is unavailable.",
                }
            })?;
        let same_intent =
            latest.playback_revision == revision && prepared_matches(&prepared, &latest.state);
        if self.cancel.is_cancelled()
            || !same_intent
            || !self.control.is_current_generation(self.generation)
        {
            stop_prepared(&prepared);
            return Err(ReconcileError {
                code: "playback_changed",
                message: "Playback changed while output was being restored.",
            });
        }

        if latest.playback_suspended {
            if !allow_resume {
                stop_prepared(&prepared);
                return Ok(());
            }
            let resumed = self
                .until_cancelled(self.player.resume_output(revision))
                .await?
                .map_err(|error| {
                    warn!(?error, "failed to acknowledge restored output");
                    ReconcileError {
                        code: "player_unavailable",
                        message: "The current playback state is unavailable.",
                    }
                })?;
            if !resumed {
                stop_prepared(&prepared);
                return Err(ReconcileError {
                    code: "playback_changed",
                    message: "Playback changed while output was being restored.",
                });
            }

            let confirmed = self
                .until_cancelled(self.player.try_get_state())
                .await?
                .map_err(|error| {
                    warn!(?error, "failed to confirm resumed player state");
                    ReconcileError {
                        code: "player_unavailable",
                        message: "The current playback state is unavailable.",
                    }
                })?;
            if confirmed.playback_suspended
                || confirmed.playback_revision != revision
                || !prepared_matches(&prepared, &confirmed.state)
                || !self.control.is_current_generation(self.generation)
            {
                stop_prepared(&prepared);
                return Err(ReconcileError {
                    code: "playback_changed",
                    message: "Playback changed while output was being restored.",
                });
            }
        }

        match prepared {
            Some((handle, paused, _)) => {
                if !paused {
                    handle.play().map_err(|error| {
                        warn!(?error, "failed to enable prepared native track");
                        ReconcileError {
                            code: "track_start_failed",
                            message: "The restored track could not be started.",
                        }
                    })?;
                }
                output.handle = Some(handle);
                output.playback_revision = Some(revision);
            }
            None => {
                output.handle = None;
                output.playback_revision = Some(revision);
            }
        }

        Ok(())
    }
}

fn prepared_matches(prepared: &Option<(TrackHandle, bool, &str)>, state: &PlayStateInfo) -> bool {
    match (prepared, state) {
        (Some((_, false, track_id)), PlayStateInfo::Playing { track, .. }) => {
            *track_id == track.id.as_str()
        }
        (Some((_, true, track_id)), PlayStateInfo::Paused { track, .. }) => {
            *track_id == track.id.as_str()
        }
        (None, PlayStateInfo::Idle) => true,
        _ => false,
    }
}

fn stop_prepared(prepared: &Option<(TrackHandle, bool, &str)>) {
    if let Some((handle, _, _)) = prepared {
        let _ = handle.stop();
    }
}

struct TrackEndNotifier {
    player: PlayerController,
    control: BotControl,
    track_id: String,
    generation: u64,
    playback_revision: u64,
}

#[serenity::async_trait]
impl SongbirdEventHandler for TrackEndNotifier {
    async fn act(&self, _ctx: &EventContext<'_>) -> Option<Event> {
        if self.control.is_current_generation(self.generation) {
            self.player
                .on_track_end(
                    self.track_id.clone(),
                    TrackEndReason::Finished,
                    self.playback_revision,
                )
                .await;
        }
        None
    }
}
