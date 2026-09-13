use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tokio::sync::{mpsc, watch};

const RESTART_COOLDOWN: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BotLifecycleStatus {
    Starting,
    Restarting,
    Connecting,
    RetryWait,
    Ready,
    Unconfigured,
    Failed,
    Stopped,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BotErrorStage {
    Bot,
    Voice,
    Playback,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct BotStatusError {
    pub stage: BotErrorStage,
    pub code: String,
    pub message: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct BotPersistenceError {
    pub code: String,
    pub message: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct BotStatus {
    pub revision: u64,
    pub status: BotLifecycleStatus,
    pub target_voice_channel_id: Option<String>,
    pub restart_in_progress: bool,
    pub restart_available_at: Option<i64>,
    pub next_retry_at: Option<i64>,
    pub last_error: Option<BotStatusError>,
    pub last_checkpoint_at: Option<i64>,
    pub persistence_error: Option<BotPersistenceError>,
}

impl Default for BotStatus {
    fn default() -> Self {
        Self {
            revision: 0,
            status: BotLifecycleStatus::Stopped,
            target_voice_channel_id: None,
            restart_in_progress: false,
            restart_available_at: None,
            next_retry_at: None,
            last_error: None,
            last_checkpoint_at: None,
            persistence_error: None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RestartOutcome {
    Accepted(BotStatus),
    AlreadyRestarting(BotStatus),
}

#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum RestartError {
    #[error("bot restart is on cooldown for {retry_after_seconds} seconds")]
    Cooldown { retry_after_seconds: u64 },
    #[error("bot runtime is unavailable")]
    Unavailable,
}

#[derive(Clone)]
pub struct BotControl {
    pub(crate) shared: Arc<SharedControl>,
    command_tx: mpsc::UnboundedSender<RuntimeCommand>,
}

pub struct BotRuntime {
    pub(crate) shared: Arc<SharedControl>,
    pub(crate) command_rx: mpsc::UnboundedReceiver<RuntimeCommand>,
}

pub(crate) enum RuntimeCommand {
    Restart,
    VoiceConfigChanged,
    RecoverVoice { generation: u64 },
    VoiceConnected { generation: u64, channel_id: u64 },
    VoiceReconnected { generation: u64, channel_id: u64 },
    VoiceDisconnected { generation: u64 },
}

pub(crate) struct SharedControl {
    state: Mutex<ControlState>,
    status_tx: watch::Sender<BotStatus>,
    active_generation: AtomicU64,
}

struct ControlState {
    status: BotStatus,
    last_restart_accepted: Option<Instant>,
    accepting: bool,
}

impl BotControl {
    #[must_use]
    pub fn new() -> (Self, BotRuntime) {
        let status = BotStatus::default();
        let (status_tx, _) = watch::channel(status.clone());
        let (command_tx, command_rx) = mpsc::unbounded_channel();
        let shared = Arc::new(SharedControl {
            state: Mutex::new(ControlState {
                status,
                last_restart_accepted: None,
                accepting: true,
            }),
            status_tx,
            active_generation: AtomicU64::new(0),
        });

        (
            Self {
                shared: shared.clone(),
                command_tx,
            },
            BotRuntime { shared, command_rx },
        )
    }

    pub async fn restart(&self) -> Result<RestartOutcome, RestartError> {
        let now = Instant::now();
        let now_ms = unix_time_ms();
        let mut state = self.shared.state.lock().unwrap_or_else(|e| e.into_inner());

        if !state.accepting || self.command_tx.is_closed() {
            return Err(RestartError::Unavailable);
        }

        if state.status.restart_in_progress {
            return Ok(RestartOutcome::AlreadyRestarting(state.status.clone()));
        }

        if let Some(accepted_at) = state.last_restart_accepted {
            let elapsed = now.saturating_duration_since(accepted_at);
            if elapsed < RESTART_COOLDOWN {
                let remaining = RESTART_COOLDOWN - elapsed;
                return Err(RestartError::Cooldown {
                    retry_after_seconds: remaining
                        .as_secs()
                        .saturating_add(u64::from(remaining.subsec_nanos() > 0)),
                });
            }
        }

        self.command_tx
            .send(RuntimeCommand::Restart)
            .map_err(|_| RestartError::Unavailable)?;
        state.last_restart_accepted = Some(now);
        state.status.status = BotLifecycleStatus::Restarting;
        state.status.restart_in_progress = true;
        state.status.restart_available_at = Some(now_ms.saturating_add(30_000));
        state.status.next_retry_at = None;
        publish_locked(&self.shared, &mut state);
        let accepted_status = state.status.clone();
        drop(state);
        schedule_cooldown_expiry(&self.shared, now);
        Ok(RestartOutcome::Accepted(accepted_status))
    }

    pub fn voice_config_changed(&self) {
        let _ = self.command_tx.send(RuntimeCommand::VoiceConfigChanged);
    }

    #[must_use]
    pub fn status(&self) -> BotStatus {
        self.shared.current_status()
    }

    #[must_use]
    pub fn subscribe(&self) -> watch::Receiver<BotStatus> {
        self.shared.status_tx.subscribe()
    }

    pub fn checkpoint_saved(&self, at_ms: i64) {
        self.shared.update(|status| {
            status.last_checkpoint_at = Some(at_ms);
            status.persistence_error = None;
        });
    }

    pub fn checkpoint_failed(&self) {
        self.shared.update(|status| {
            status.persistence_error = Some(BotPersistenceError {
                code: "checkpoint_failed".to_string(),
                message: "The recovery checkpoint could not be saved.".to_string(),
            });
        });
    }

    pub(crate) fn request_voice_recovery(&self) {
        let generation = self.shared.active_generation.load(Ordering::Acquire);
        if generation != 0 {
            let _ = self
                .command_tx
                .send(RuntimeCommand::RecoverVoice { generation });
        }
    }

    pub(crate) fn voice_connected(&self, generation: u64, channel_id: u64) {
        let _ = self.command_tx.send(RuntimeCommand::VoiceConnected {
            generation,
            channel_id,
        });
    }

    pub(crate) fn voice_disconnected(&self, generation: u64) {
        let _ = self
            .command_tx
            .send(RuntimeCommand::VoiceDisconnected { generation });
    }

    pub(crate) fn voice_reconnected(&self, generation: u64, channel_id: u64) {
        let _ = self.command_tx.send(RuntimeCommand::VoiceReconnected {
            generation,
            channel_id,
        });
    }

    pub(crate) fn if_current_generation(&self, generation: u64, action: impl FnOnce()) -> bool {
        let _state = self.shared.state.lock().unwrap_or_else(|e| e.into_inner());
        if generation == 0 || self.shared.active_generation.load(Ordering::Acquire) != generation {
            return false;
        }
        action();
        true
    }

    pub(crate) fn update_current_generation(
        &self,
        generation: u64,
        mutate: impl FnOnce(&mut BotStatus),
    ) -> bool {
        self.shared.update_generation(generation, mutate).is_some()
    }
    pub(crate) fn is_current_generation(&self, generation: u64) -> bool {
        generation != 0 && self.shared.active_generation.load(Ordering::Acquire) == generation
    }
}

impl SharedControl {
    pub(crate) fn begin_startup(&self) {
        self.update(|status| {
            status.status = if status.restart_in_progress {
                BotLifecycleStatus::Restarting
            } else {
                BotLifecycleStatus::Starting
            };
            status.next_retry_at = None;
            status.last_error = None;
        });
    }
    pub(crate) fn update(&self, mutate: impl FnOnce(&mut BotStatus)) -> BotStatus {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        mutate(&mut state.status);
        publish_locked(self, &mut state);
        state.status.clone()
    }

    pub(crate) fn status(&self) -> BotStatus {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .status
            .clone()
    }

    fn current_status(&self) -> BotStatus {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        clear_expired_cooldown(self, &mut state);
        state.status.clone()
    }

    fn update_generation(
        &self,
        generation: u64,
        mutate: impl FnOnce(&mut BotStatus),
    ) -> Option<BotStatus> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if generation == 0 || self.active_generation.load(Ordering::Acquire) != generation {
            return None;
        }
        mutate(&mut state.status);
        publish_locked(self, &mut state);
        Some(state.status.clone())
    }

    pub(crate) fn set_generation(&self, generation: u64) {
        let _state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        self.active_generation.store(generation, Ordering::Release);
    }

    pub(crate) fn is_generation(&self, generation: u64) -> bool {
        generation != 0 && self.active_generation.load(Ordering::Acquire) == generation
    }

    pub(crate) fn set_accepting(&self, accepting: bool) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.accepting = accepting;
    }
}

impl Drop for BotRuntime {
    fn drop(&mut self) {
        self.shared.set_accepting(false);
    }
}

fn publish_locked(shared: &SharedControl, state: &mut ControlState) {
    state.status.revision = state.status.revision.saturating_add(1);
    shared.status_tx.send_replace(state.status.clone());
}

fn schedule_cooldown_expiry(shared: &Arc<SharedControl>, accepted_at: Instant) {
    let shared = Arc::downgrade(shared);
    tokio::spawn(async move {
        tokio::time::sleep(RESTART_COOLDOWN).await;
        let Some(shared) = shared.upgrade() else {
            return;
        };
        let mut state = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.last_restart_accepted == Some(accepted_at)
            && state.status.restart_available_at.is_some()
        {
            state.status.restart_available_at = None;
            publish_locked(&shared, &mut state);
        }
    });
}

fn clear_expired_cooldown(shared: &SharedControl, state: &mut ControlState) {
    if state.status.restart_available_at.is_some()
        && state
            .last_restart_accepted
            .is_some_and(|accepted| accepted.elapsed() >= RESTART_COOLDOWN)
    {
        state.status.restart_available_at = None;
        publish_locked(shared, state);
    }
}

pub(crate) fn unix_time_ms() -> i64 {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    i64::try_from(millis).unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn restart_gate_coalesces_then_applies_shared_cooldown() {
        let (control, mut runtime) = BotControl::new();

        let accepted = control.restart().await.unwrap();
        assert!(matches!(accepted, RestartOutcome::Accepted(_)));
        assert!(matches!(
            runtime.command_rx.recv().await,
            Some(RuntimeCommand::Restart)
        ));

        let coalesced = control.restart().await.unwrap();
        assert!(matches!(coalesced, RestartOutcome::AlreadyRestarting(_)));

        runtime
            .shared
            .update(|status| status.restart_in_progress = false);
        let cooldown = control.restart().await.unwrap_err();
        assert_eq!(
            cooldown,
            RestartError::Cooldown {
                retry_after_seconds: 30
            }
        );

        runtime.shared.state.lock().unwrap().last_restart_accepted =
            Some(Instant::now() - RESTART_COOLDOWN);
        let accepted_at_boundary = control.restart().await.unwrap();
        assert!(matches!(accepted_at_boundary, RestartOutcome::Accepted(_)));
    }

    #[tokio::test]
    async fn startup_preserves_a_restart_accepted_before_the_runtime_is_polled() {
        let (control, runtime) = BotControl::new();
        assert!(matches!(
            control.restart().await,
            Ok(RestartOutcome::Accepted(_))
        ));

        runtime.shared.begin_startup();

        let status = control.status();
        assert_eq!(status.status, BotLifecycleStatus::Restarting);
        assert!(status.restart_in_progress);
    }

    #[test]
    fn only_the_current_nonzero_generation_can_publish_native_effects() {
        let (control, runtime) = BotControl::new();
        runtime.shared.set_generation(7);

        assert!(control.is_current_generation(7));
        assert!(!control.is_current_generation(6));
        assert!(!control.is_current_generation(0));

        runtime.shared.set_generation(8);
        assert!(!control.is_current_generation(7));
        assert!(control.is_current_generation(8));
    }

    #[test]
    fn status_clears_an_expired_restart_deadline() {
        let (control, runtime) = BotControl::new();
        {
            let mut state = runtime.shared.state.lock().unwrap();
            state.last_restart_accepted = Some(Instant::now() - RESTART_COOLDOWN);
            state.status.restart_available_at = Some(1);
        }

        assert_eq!(control.status().restart_available_at, None);
    }

    #[tokio::test]
    async fn dropping_runtime_makes_restart_unavailable() {
        let (control, runtime) = BotControl::new();
        drop(runtime);
        assert_eq!(control.restart().await, Err(RestartError::Unavailable));
    }

    #[test]
    fn status_serialization_matches_the_external_contract() {
        let (control, _runtime) = BotControl::new();
        control.shared.update(|status| {
            status.status = BotLifecycleStatus::RetryWait;
            status.target_voice_channel_id = Some("42".to_string());
            status.next_retry_at = Some(1_000);
            status.last_error = Some(BotStatusError {
                stage: BotErrorStage::Voice,
                code: "voice_join_failed".to_string(),
                message: "Voice recovery failed.".to_string(),
            });
        });

        let value = serde_json::to_value(control.status()).unwrap();
        assert_eq!(value["status"], "retry_wait");
        assert_eq!(value["target_voice_channel_id"], "42");
        assert_eq!(value["next_retry_at"], 1_000);
        assert_eq!(value["last_error"]["stage"], "voice");
        assert!(value.get("restart_in_progress").is_some());
        assert!(value.get("restart_available_at").is_some());
        assert!(value.get("last_checkpoint_at").is_some());
        assert!(value.get("persistence_error").is_some());
    }

    #[test]
    fn checkpoint_status_is_independent_from_connection_error() {
        let (control, _runtime) = BotControl::new();
        control.shared.update(|status| {
            status.last_error = Some(BotStatusError {
                stage: BotErrorStage::Voice,
                code: "voice_disconnected".to_string(),
                message: "Voice disconnected.".to_string(),
            });
        });

        control.checkpoint_failed();
        assert!(control.status().last_error.is_some());
        assert!(control.status().persistence_error.is_some());

        control.checkpoint_saved(42);
        let status = control.status();
        assert!(status.last_error.is_some());
        assert_eq!(status.last_checkpoint_at, Some(42));
        assert!(status.persistence_error.is_none());
    }
}
