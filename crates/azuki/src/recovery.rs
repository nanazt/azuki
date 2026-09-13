use std::time::{Duration, SystemTime, UNIX_EPOCH};

use azuki_bot::BotControl;
use azuki_db::queries::queue::{PersistedPlayback, RecoverySnapshot, save_recovery_snapshot};
use azuki_player::{LoopMode, PlayStateInfo, PlayerController, PlayerEvent};
use sqlx::SqlitePool;
use tokio::sync::{broadcast, mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio::time::MissedTickBehavior;
use tokio_util::sync::CancellationToken;

const CHECKPOINT_INTERVAL: Duration = Duration::from_secs(4);
const CHECKPOINT_TIMEOUT: Duration = Duration::from_secs(4);

pub(crate) fn spawn_checkpoint_writer(
    pool: SqlitePool,
    player: PlayerController,
    control: BotControl,
    mut requests: mpsc::Receiver<oneshot::Sender<Result<(), String>>>,
    cancel: CancellationToken,
    invalid_restore: bool,
) -> JoinHandle<()> {
    // Subscribe before spawning so startup cannot lose its first state transition.
    let mut events = player.subscribe();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(CHECKPOINT_INTERVAL);
        interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
        let mut preserve_invalid_restore = invalid_restore;
        let mut stopping = false;
        if preserve_invalid_restore {
            control.checkpoint_failed();
        }
        loop {
            let request = tokio::select! {
                biased;
                () = cancel.cancelled() => {
                    stopping = true;
                    None
                },
                request = requests.recv() => {
                    let Some(reply) = request else { break };
                    if reply.is_closed() {
                        continue;
                    }
                    Some(reply)
                }
                event = events.recv() => {
                    match event {
                        Ok(event) => {
                            if replaces_invalid_current(&event.event) {
                                preserve_invalid_restore = false;
                            }
                            if !requires_checkpoint(&event.event) {
                                continue;
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => {
                            // Recover from the authoritative actor, never from a partial event batch.
                        }
                        Err(broadcast::error::RecvError::Closed) => break,
                    }
                    None
                }
                _ = interval.tick() => None,
            };
            if stopping && preserve_invalid_restore {
                loop {
                    match events.try_recv() {
                        Ok(event) if replaces_invalid_current(&event.event) => {
                            preserve_invalid_restore = false;
                            break;
                        }
                        Ok(_) | Err(broadcast::error::TryRecvError::Lagged(_)) => {}
                        Err(_) => break,
                    }
                }
            }
            let result = if preserve_invalid_restore {
                Err("saved playback requires a new playback action".to_owned())
            } else {
                match tokio::time::timeout(CHECKPOINT_TIMEOUT, checkpoint(&pool, &player)).await {
                    Ok(result) => result,
                    Err(_) => Err("playback checkpoint timed out".to_owned()),
                }
            };
            match &result {
                Ok(()) => control.checkpoint_saved(unix_millis()),
                Err(error) => {
                    tracing::warn!(%error, "playback checkpoint unavailable");
                    control.checkpoint_failed();
                }
            }
            if let Some(reply) = request {
                let _ = reply.send(result);
            }
            if stopping {
                break;
            }
        }
    })
}

fn replaces_invalid_current(event: &PlayerEvent) -> bool {
    matches!(event, PlayerEvent::TrackStarted { .. })
}

fn is_user_state_change(event: &PlayerEvent) -> bool {
    matches!(
        event,
        PlayerEvent::TrackStarted { .. }
            | PlayerEvent::TrackEnded { .. }
            | PlayerEvent::Paused { .. }
            | PlayerEvent::Resumed { .. }
            | PlayerEvent::Seeked { .. }
            | PlayerEvent::QueueUpdated { .. }
            | PlayerEvent::LoopModeChanged { .. }
    )
}

fn requires_checkpoint(event: &PlayerEvent) -> bool {
    is_user_state_change(event)
        || matches!(
            event,
            PlayerEvent::OutputSuspended { .. }
                | PlayerEvent::OutputResumed { .. }
                | PlayerEvent::VolumeChanged { .. }
        )
}

async fn checkpoint(pool: &SqlitePool, player: &PlayerController) -> Result<(), String> {
    let snapshot = player
        .try_get_state()
        .await
        .map_err(|_| "playback state unavailable".to_owned())?;
    let paused = matches!(&snapshot.state, PlayStateInfo::Paused { .. });
    let current = match snapshot.state {
        PlayStateInfo::Playing { track, position_ms }
        | PlayStateInfo::Paused { track, position_ms } => {
            let added_by = snapshot
                .current_added_by
                .ok_or_else(|| "current playback has no owner".to_owned())?;
            Some(PersistedPlayback {
                track_id: track.id,
                added_by: added_by.id,
                position_ms,
                paused,
            })
        }
        PlayStateInfo::Idle => None,
        PlayStateInfo::Loading { .. } | PlayStateInfo::Error { .. } => {
            return Err("playback state is not checkpointable".to_owned());
        }
    };
    let queue = snapshot
        .queue
        .into_iter()
        .map(|entry| (entry.track.id, entry.added_by.id))
        .collect();
    let loop_mode = match snapshot.loop_mode {
        LoopMode::Off => "off",
        LoopMode::One => "one",
        LoopMode::All => "all",
    }
    .to_owned();
    save_recovery_snapshot(
        pool,
        &RecoverySnapshot {
            current,
            queue,
            loop_mode,
        },
    )
    .await
    .map_err(|error| {
        tracing::error!(%error, "failed to commit playback recovery snapshot");
        "playback checkpoint failed".to_owned()
    })
}

pub(crate) async fn flush_checkpoint(
    requests: &mpsc::Sender<oneshot::Sender<Result<(), String>>>,
) -> Result<(), String> {
    let (reply, response) = oneshot::channel();
    tokio::time::timeout(Duration::from_secs(6), async {
        requests
            .send(reply)
            .await
            .map_err(|_| "checkpoint writer unavailable".to_owned())?;
        response
            .await
            .map_err(|_| "checkpoint writer stopped".to_owned())?
    })
    .await
    .unwrap_or_else(|_| Err("checkpoint flush timed out".to_owned()))
}

fn unix_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use azuki_db::queries::queue::load_recovery_snapshot;
    use azuki_player::{TrackInfo, UserInfo};

    async fn fixture() -> (SqlitePool, PlayerController, TrackInfo, UserInfo) {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        azuki_db::run_migrations(&pool).await.unwrap();
        azuki_db::queries::users::upsert_user(&pool, "listener", "Listener", None)
            .await
            .unwrap();
        azuki_db::queries::tracks::upsert_track(
            &pool,
            "song",
            "Song",
            None,
            120_000,
            None,
            "https://example.invalid/song",
            "upload",
            None,
            None,
            Some("listener"),
        )
        .await
        .unwrap();
        let player = PlayerController::new();
        player.suspend_output().await.unwrap();
        let track = TrackInfo {
            id: "song".into(),
            title: "Song".into(),
            artist: None,
            duration_ms: 120_000,
            thumbnail_url: None,
            source_url: "https://example.invalid/song".into(),
            source_type: "upload".into(),
            file_path: None,
            youtube_id: None,
            volume: 5,
        };
        let user = UserInfo {
            id: "listener".into(),
            username: "Listener".into(),
            avatar_url: None,
        };
        (pool, player, track, user)
    }

    #[tokio::test]
    async fn checkpoint_preserves_latest_intent_while_output_is_suspended() {
        let (pool, player, track, user) = fixture().await;
        player.play(track, user).await.unwrap();
        player.seek(12_345).await.unwrap();
        checkpoint(&pool, &player).await.unwrap();
        let restored = load_recovery_snapshot(&pool).await.unwrap();
        let current = restored.current.unwrap();
        assert_eq!(current.position_ms, 12_345);
        assert!(!current.paused);
        assert_eq!(current.entry.user_id, "listener");

        player.pause().await.unwrap();
        player.seek(8_000).await.unwrap();
        checkpoint(&pool, &player).await.unwrap();
        let restored = load_recovery_snapshot(&pool).await.unwrap();
        let current = restored.current.unwrap();
        assert_eq!(current.position_ms, 8_000);
        assert!(current.paused);

        player.stop().await.unwrap();
        checkpoint(&pool, &player).await.unwrap();
        let stopped = load_recovery_snapshot(&pool).await.unwrap();
        assert!(stopped.current.is_none());
        assert!(stopped.queue.is_empty());
    }

    #[tokio::test]
    async fn invalid_restore_survives_flush_until_user_replaces_playback() {
        let (pool, player, track, user) = fixture().await;
        let invalid = r#"{"version":1,"track_id":"song"}"#;
        azuki_db::config::save_config(&pool, &[("now_playing", invalid)])
            .await
            .unwrap();
        let (control, _runtime) = BotControl::new();
        let mut status = control.subscribe();
        let (requests, receiver) = mpsc::channel(8);
        let cancel = CancellationToken::new();
        let handle = spawn_checkpoint_writer(
            pool.clone(),
            player.clone(),
            control.clone(),
            receiver,
            cancel.clone(),
            true,
        );
        assert!(flush_checkpoint(&requests).await.is_err());
        assert_eq!(
            azuki_db::config::get_config(&pool, "now_playing")
                .await
                .unwrap()
                .as_deref(),
            Some(invalid)
        );
        assert!(control.status().persistence_error.is_some());

        player.play(track, user).await.unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if status.borrow_and_update().last_checkpoint_at.is_some() {
                    break;
                }
                status.changed().await.unwrap();
            }
        })
        .await
        .unwrap();
        flush_checkpoint(&requests).await.unwrap();
        let restored = load_recovery_snapshot(&pool).await.unwrap();
        assert_eq!(restored.current.unwrap().entry.track_id, "song");
        assert!(restored.error.is_none());
        cancel.cancel();
        handle.await.unwrap();
    }

    #[tokio::test]
    async fn shutdown_saves_latest_intent_before_writer_exit() {
        let (pool, player, track, user) = fixture().await;
        player.play(track, user).await.unwrap();
        player.seek(43_210).await.unwrap();
        player.pause().await.unwrap();
        let (control, _runtime) = BotControl::new();
        let (_requests, receiver) = mpsc::channel(8);
        let cancel = CancellationToken::new();
        cancel.cancel();
        spawn_checkpoint_writer(pool.clone(), player, control, receiver, cancel, false)
            .await
            .unwrap();
        let current = load_recovery_snapshot(&pool)
            .await
            .unwrap()
            .current
            .unwrap();
        assert_eq!(current.position_ms, 43_210);
        assert!(current.paused);
    }

    #[tokio::test]
    async fn queue_and_loop_edits_do_not_erase_invalid_current_on_shutdown() {
        let (pool, player, track, user) = fixture().await;
        let invalid = r#"{"version":1,"track_id":"song"}"#;
        azuki_db::config::save_config(&pool, &[("now_playing", invalid)])
            .await
            .unwrap();
        let (control, _runtime) = BotControl::new();
        let (_requests, receiver) = mpsc::channel(8);
        let cancel = CancellationToken::new();
        let handle = spawn_checkpoint_writer(
            pool.clone(),
            player.clone(),
            control.clone(),
            receiver,
            cancel.clone(),
            true,
        );
        player.enqueue(track, user).await.unwrap();
        player.set_loop(LoopMode::All).await.unwrap();
        cancel.cancel();
        handle.await.unwrap();
        assert_eq!(
            azuki_db::config::get_config(&pool, "now_playing")
                .await
                .unwrap()
                .as_deref(),
            Some(invalid),
        );
        assert!(control.status().persistence_error.is_some());
    }
}
