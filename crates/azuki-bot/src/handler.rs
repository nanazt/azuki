use std::sync::Arc;
use std::time::Duration;

use azuki_player::PlayerEvent;
use serenity::all::{
    Channel, ChannelType, Context, CreateInteractionResponse, CreateInteractionResponseMessage,
    EventHandler, GatewayIntents, GuildId, Interaction, Ready, VoiceState,
};
use serenity::async_trait;
use songbird::driver::retry::Retry;
use songbird::events::{CoreEvent, Event, EventContext, EventHandler as SongbirdEventHandler};
use songbird::{Config as SongbirdConfig, SerenityInit, Songbird};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio::time::{Instant as TokioInstant, sleep_until, timeout};
use tokio_util::sync::CancellationToken;
use tracing::{debug, error, info, warn};

use crate::commands;
use crate::control::{RuntimeCommand, unix_time_ms};
use crate::voice::{GenerationOutput, ReconcileError};
use crate::{
    BotControl, BotError, BotErrorStage, BotLifecycleStatus, BotRuntime, BotState, BotStatusError,
};

const BOT_OPERATION_TIMEOUT: Duration = Duration::from_secs(15);
const GENERATION_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(10);
const CHECKPOINT_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_RETRY_DELAY: Duration = Duration::from_secs(300);

pub struct Handler {
    pub state: Arc<BotState>,
    pub guild_id: GuildId,
    generation: u64,
}

#[async_trait]
impl EventHandler for Handler {
    async fn ready(&self, ctx: Context, ready: Ready) {
        if !self
            .state
            .control
            .if_current_generation(self.generation, || {
                let _ = self.state.http_tx.send(Some(ctx.http.clone()));
            })
        {
            return;
        }

        info!(
            generation = self.generation,
            "{} is connected", ready.user.name
        );
        if let Err(error) = commands::register_commands(&ctx, self.guild_id).await {
            error!(?error, "failed to register commands");
        }
        if !self.state.control.is_current_generation(self.generation) {
            return;
        }

        match ctx.http.get_channels(self.guild_id).await {
            Ok(channels) => {
                let voice = channels
                    .iter()
                    .filter(|channel| channel.kind == ChannelType::Voice)
                    .map(|channel| (channel.id.get(), channel.name.clone()))
                    .collect::<Vec<_>>();
                let text = channels
                    .iter()
                    .filter(|channel| channel.kind == ChannelType::Text)
                    .map(|channel| (channel.id.get(), channel.name.clone()))
                    .collect::<Vec<_>>();
                if !self
                    .state
                    .control
                    .if_current_generation(self.generation, || {
                        *self
                            .state
                            .voice_channels
                            .write()
                            .unwrap_or_else(|e| e.into_inner()) = voice;
                        *self
                            .state
                            .text_channels
                            .write()
                            .unwrap_or_else(|e| e.into_inner()) = text;
                    })
                {
                    return;
                }
            }
            Err(error) => warn!(?error, "failed to fetch guild channels"),
        }

        self.state
            .control
            .if_current_generation(self.generation, || {
                self.state.control.request_voice_recovery();
            });
    }

    async fn voice_state_update(&self, ctx: Context, _old: Option<VoiceState>, new: VoiceState) {
        if !self.state.control.is_current_generation(self.generation)
            || new.guild_id != Some(self.guild_id)
            || new.user_id != ctx.cache.current_user().id
        {
            return;
        }

        if new.channel_id.is_none() {
            self.state.control.voice_disconnected(self.generation);
        }
    }

    async fn interaction_create(&self, ctx: Context, interaction: Interaction) {
        if !self.state.control.is_current_generation(self.generation) {
            return;
        }

        match interaction {
            Interaction::Command(command) => {
                let result = commands::handle_command(&ctx, &command, &self.state).await;
                if let Err(error) = result {
                    error!(?error, "command failed");
                    let messages = crate::messages::get(&self.state.locale);
                    let message = CreateInteractionResponseMessage::new()
                        .content(commands::bot_error_message(messages, &error))
                        .ephemeral(true);
                    let response = CreateInteractionResponse::Message(message);
                    let _ = command.create_response(&ctx.http, response).await;
                }
            }
            Interaction::Component(component) => {
                let custom_id = component.data.custom_id.clone();
                if let Some(track_id) = custom_id
                    .strip_prefix("pn:")
                    .or_else(|| custom_id.strip_prefix("eq:"))
                    .or_else(|| custom_id.strip_prefix("play:"))
                {
                    commands::handle_smart_play_button(&ctx, &component, &self.state, track_id)
                        .await;
                } else if custom_id.starts_with("ss:") {
                    commands::handle_search_select(&ctx, &component, &self.state).await;
                } else if let Some(url) = custom_id.strip_prefix("play-from-clicked-button#") {
                    commands::handle_legacy_play(&ctx, &component, &self.state, url).await;
                } else if let Some(url) = custom_id.strip_prefix("play-yt-button-0;") {
                    commands::handle_legacy_play(&ctx, &component, &self.state, url).await;
                }
            }
            _ => {}
        }
    }
}

pub async fn start_bot(
    token: &str,
    guild_id: u64,
    state: Arc<BotState>,
    mut runtime: BotRuntime,
    cancel: CancellationToken,
) -> Result<(), BotError> {
    let guild_id = GuildId::new(guild_id);
    if cancel.is_cancelled() {
        runtime.shared.set_accepting(false);
        runtime.shared.update(|status| {
            status.status = BotLifecycleStatus::Stopped;
        });
        return Ok(());
    }
    runtime.shared.set_accepting(true);
    runtime.shared.begin_startup();
    let shutdown_gate_shared = runtime.shared.clone();
    let shutdown_gate_cancel = cancel.clone();
    let shutdown_gate_task = tokio::spawn(async move {
        shutdown_gate_cancel.cancelled().await;
        shutdown_gate_shared.set_accepting(false);
    });

    let mut generation_id = 0_u64;
    let mut generation: Option<BotGeneration> = None;
    let mut bot_failures = 0_u32;
    let mut retry_delay = Duration::ZERO;

    'supervisor: loop {
        if generation.is_none() {
            loop {
                match runtime.command_rx.try_recv() {
                    Ok(RuntimeCommand::Restart) => retry_delay = Duration::ZERO,
                    Ok(_) => {}
                    Err(tokio::sync::mpsc::error::TryRecvError::Empty) => break,
                    Err(tokio::sync::mpsc::error::TryRecvError::Disconnected) => break 'supervisor,
                }
            }
        }

        if generation.is_none() {
            if !retry_delay.is_zero() {
                let retry_at = unix_time_ms().saturating_add(duration_ms(retry_delay));
                runtime.shared.update(|status| {
                    status.status = BotLifecycleStatus::RetryWait;
                    status.next_retry_at = Some(retry_at);
                });
                let deadline = TokioInstant::now() + retry_delay;
                loop {
                    tokio::select! {
                        _ = cancel.cancelled() => {
                            runtime.shared.set_accepting(false);
                            break 'supervisor;
                        }
                        _ = sleep_until(deadline) => break,
                        command = runtime.command_rx.recv() => {
                            match command {
                                Some(RuntimeCommand::Restart) => {
                                    break;
                                }
                                Some(_) => {}
                                None => break 'supervisor,
                            }
                        }
                    }
                }
            }

            if cancel.is_cancelled() {
                runtime.shared.set_accepting(false);
                break;
            }

            generation_id = generation_id.saturating_add(1);
            runtime.shared.set_generation(generation_id);
            runtime.shared.update(|status| {
                status.status = if status.restart_in_progress {
                    BotLifecycleStatus::Restarting
                } else {
                    BotLifecycleStatus::Starting
                };
                status.next_retry_at = None;
            });

            let started = tokio::select! {
                _ = cancel.cancelled() => {
                    runtime.shared.set_accepting(false);
                    break;
                },
                result = timeout(
                    BOT_OPERATION_TIMEOUT,
                    BotGeneration::start(
                        token,
                        guild_id,
                        state.clone(),
                        generation_id,
                        cancel.child_token(),
                        cancel.child_token(),
                    ),
                ) => result,
            };

            match started {
                Ok(Ok(next_generation)) => {
                    generation = Some(next_generation);
                    retry_delay = Duration::ZERO;
                    runtime.shared.update(|status| {
                        status.restart_in_progress = false;
                    });
                    continue;
                }
                Ok(Err(error)) => {
                    error!(
                        ?error,
                        generation = generation_id,
                        "failed to create bot generation"
                    );
                }
                Err(_) => {
                    error!(
                        generation = generation_id,
                        "bot generation creation timed out"
                    );
                }
            }

            runtime.shared.set_generation(0);
            bot_failures = bot_failures.saturating_add(1);
            retry_delay = capped_retry_delay(bot_failures);
            runtime.shared.update(|status| {
                status.restart_in_progress = false;
                status.last_error = Some(safe_error(
                    BotErrorStage::Bot,
                    "bot_start_failed",
                    "The Discord bot could not be started.",
                ));
            });
            continue;
        }

        if generation
            .as_ref()
            .is_some_and(|current| current.retirement.is_some())
        {
            let current = generation.as_mut().expect("generation checked above");
            if current.retirement_failures > 0 {
                let delay = capped_retry_delay(current.retirement_failures);
                let deadline = TokioInstant::now() + delay;
                loop {
                    tokio::select! {
                        _ = cancel.cancelled() => {
                            runtime.shared.set_accepting(false);
                            break 'supervisor;
                        }
                        _ = sleep_until(deadline) => break,
                        command = runtime.command_rx.recv() => {
                            match command {
                                Some(RuntimeCommand::Restart) => break,
                                Some(_) => {}
                                None => break 'supervisor,
                            }
                        }
                    }
                }
            }

            if cancel.is_cancelled() {
                runtime.shared.set_accepting(false);
                break;
            }
            if current.shutdown().await {
                let retirement = current
                    .retirement
                    .expect("retiring generation has a retirement reason");
                request_checkpoint(&state).await;
                generation = None;
                match retirement {
                    GenerationRetirement::Restart => retry_delay = Duration::ZERO,
                    GenerationRetirement::ClientExit { was_ready } => {
                        bot_failures = if was_ready {
                            1
                        } else {
                            bot_failures.saturating_add(1)
                        };
                        retry_delay = capped_retry_delay(bot_failures);
                    }
                }
            } else {
                current.retirement_failures = current.retirement_failures.saturating_add(1);
                let delay = capped_retry_delay(current.retirement_failures);
                let retry_at = unix_time_ms().saturating_add(duration_ms(delay));
                runtime.shared.update(|status| {
                    status.status = BotLifecycleStatus::RetryWait;
                    status.restart_in_progress = false;
                    status.target_voice_channel_id = None;
                    status.next_retry_at = Some(retry_at);
                    status.last_error = Some(safe_error(
                        BotErrorStage::Bot,
                        "bot_retirement_unconfirmed",
                        "The previous bot generation is still shutting down; cleanup will be retried.",
                    ));
                });
            }
            continue;
        }

        let current = generation.as_mut().expect("generation checked above");
        tokio::select! {
            biased;
            _ = cancel.cancelled() => {
                runtime.shared.set_accepting(false);
                break;
            },
            command = runtime.command_rx.recv() => {
                match command {
                    Some(RuntimeCommand::Restart) => {
                        current.begin_retirement(GenerationRetirement::Restart);
                        runtime.shared.set_generation(0);
                        let _ = state.http_tx.send(None);
                        freeze_playback(&state).await;
                    }
                    Some(RuntimeCommand::VoiceConfigChanged) => {
                        if runtime.shared.is_generation(current.id) {
                            current.trigger_voice();
                        }
                    }
                    Some(RuntimeCommand::RecoverVoice { generation }) => {
                        if runtime.shared.is_generation(generation) {
                            current.trigger_voice();
                        }
                    }
                    Some(RuntimeCommand::VoiceDisconnected { generation }) => {
                        if runtime.shared.is_generation(generation) {
                            current.trigger_voice();
                        }
                    }
                    Some(RuntimeCommand::VoiceConnected { generation, channel_id }) => {
                        if runtime.shared.is_generation(generation) {
                            debug!(generation, channel_id, "native voice driver connected");
                        }
                    }
                    Some(RuntimeCommand::VoiceReconnected { generation, channel_id }) => {
                        if runtime.shared.is_generation(generation) {
                            debug!(generation, channel_id, "native voice driver reconnected");
                            current.trigger_voice();
                        }
                    }
                    None => break,
                }
            }
            task_result = current
                .client_task
                .as_mut()
                .expect("active generation has a client task") => {
                let was_ready =
                    runtime.shared.status().status == BotLifecycleStatus::Ready;
                match task_result {
                    Ok(Ok(())) => warn!(generation = current.id, "bot client returned unexpectedly"),
                    Ok(Err(error)) => error!(?error, generation = current.id, "bot client failed"),
                    Err(error) if error.is_panic() => {
                        error!(?error, generation = current.id, "bot client task panicked");
                    }
                    Err(error) => warn!(?error, generation = current.id, "bot client task was cancelled"),
                }
                current.client_task = None;
                current.begin_retirement(GenerationRetirement::ClientExit { was_ready });
                runtime.shared.set_generation(0);
                runtime.shared.update(|status| {
                    status.status = BotLifecycleStatus::Failed;
                    status.restart_in_progress = false;
                    status.target_voice_channel_id = None;
                    status.next_retry_at = None;
                    status.last_error = Some(safe_error(
                        BotErrorStage::Bot,
                        "bot_task_ended",
                        "The Discord bot stopped unexpectedly and will be restarted.",
                    ));
                });
                let _ = state.http_tx.send(None);
                freeze_playback(&state).await;
            }
        }
    }

    runtime.shared.set_accepting(false);
    runtime.shared.set_generation(0);
    if let Some(mut active) = generation {
        freeze_playback(&state).await;
        active.shutdown().await;
        request_checkpoint(&state).await;
    }
    let _ = state.http_tx.send(None);
    runtime.shared.update(|status| {
        status.status = BotLifecycleStatus::Stopped;
        status.restart_in_progress = false;
        status.next_retry_at = None;
        status.target_voice_channel_id = None;
    });
    shutdown_gate_task.abort();
    let _ = shutdown_gate_task.await;
    Ok(())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum GenerationRetirement {
    Restart,
    ClientExit { was_ready: bool },
}

struct BotGeneration {
    id: u64,
    task_cancel: CancellationToken,
    client_cancel: CancellationToken,
    voice_trigger: mpsc::UnboundedSender<()>,
    output: Arc<GenerationOutput>,
    songbird: Arc<Songbird>,
    guild_id: GuildId,
    client_task: Option<JoinHandle<Result<(), BotError>>>,
    voice_task: Option<JoinHandle<()>>,
    audio_task: Option<JoinHandle<()>>,
    retirement: Option<GenerationRetirement>,
    retirement_failures: u32,
    call_retired: bool,
}

impl BotGeneration {
    async fn start(
        token: &str,
        guild_id: GuildId,
        state: Arc<BotState>,
        generation: u64,
        task_cancel: CancellationToken,
        client_cancel: CancellationToken,
    ) -> Result<Self, BotError> {
        let intents = GatewayIntents::non_privileged() | GatewayIntents::MESSAGE_CONTENT;
        let retry = Retry {
            retry_limit: Some(0),
            ..Retry::default()
        };
        let songbird_config = SongbirdConfig::default()
            .driver_retry(retry)
            .driver_timeout(Some(BOT_OPERATION_TIMEOUT));
        let songbird = Songbird::serenity_from_config(songbird_config);
        let handler = Handler {
            state: state.clone(),
            guild_id,
            generation,
        };
        let mut client = serenity::Client::builder(token, intents)
            .event_handler(handler)
            .register_songbird_with(songbird.clone())
            .await
            .map_err(|error| BotError::Serenity(error.to_string()))?;

        let output = Arc::new(GenerationOutput::new(
            songbird.clone(),
            guild_id,
            state.player.clone(),
            state.control.clone(),
            generation,
            task_cancel.clone(),
        ));
        let (voice_trigger, voice_rx) = mpsc::unbounded_channel();
        let client_shutdown = client_cancel.clone();
        let client_task = tokio::spawn(async move {
            tokio::select! {
                result = client.start() => {
                    result.map_err(|error| BotError::Serenity(error.to_string()))
                }
                _ = client_shutdown.cancelled() => {
                    client.shard_manager.shutdown_all().await;
                    Ok(())
                }
            }
        });
        let voice_task = tokio::spawn(run_voice_recovery(
            state.clone(),
            songbird.clone(),
            output.clone(),
            generation,
            voice_rx,
            task_cancel.clone(),
        ));
        let audio_task = tokio::spawn(run_audio_subscriber(
            state,
            output.clone(),
            generation,
            task_cancel.clone(),
        ));

        Ok(Self {
            id: generation,
            task_cancel,
            client_cancel,
            voice_trigger,
            output,
            songbird,
            guild_id,
            client_task: Some(client_task),
            voice_task: Some(voice_task),
            audio_task: Some(audio_task),
            retirement: None,
            retirement_failures: 0,
            call_retired: false,
        })
    }

    fn trigger_voice(&self) {
        let _ = self.voice_trigger.send(());
    }

    fn begin_retirement(&mut self, retirement: GenerationRetirement) {
        self.retirement.get_or_insert(retirement);
    }

    async fn shutdown(&mut self) -> bool {
        self.task_cancel.cancel();
        self.abort_auxiliary_tasks();

        let retired = timeout(GENERATION_SHUTDOWN_TIMEOUT, async {
            self.finish_auxiliary_tasks().await;
            self.output.stop_for_retirement().await;
            if !self.call_retired {
                match self.songbird.remove(self.guild_id).await {
                    Ok(()) => self.call_retired = true,
                    Err(error) => {
                        warn!(
                            ?error,
                            generation = self.id,
                            "failed to retire native voice call; cleanup will be retried"
                        );
                        return false;
                    }
                }
            }
            self.client_cancel.cancel();
            self.finish_client_task().await;
            true
        })
        .await;

        match retired {
            Ok(confirmed) => confirmed,
            Err(_) => {
                warn!(
                    generation = self.id,
                    "bot generation teardown timed out; cleanup will be retried"
                );
                self.abort_auxiliary_tasks();
                if self.call_retired {
                    self.client_cancel.cancel();
                    if let Some(task) = &self.client_task {
                        task.abort();
                    }
                    let _ = timeout(GENERATION_SHUTDOWN_TIMEOUT, self.finish_all_tasks()).await;
                } else {
                    let _ =
                        timeout(GENERATION_SHUTDOWN_TIMEOUT, self.finish_auxiliary_tasks()).await;
                }
                false
            }
        }
    }

    fn abort_auxiliary_tasks(&self) {
        if let Some(task) = &self.voice_task {
            task.abort();
        }
        if let Some(task) = &self.audio_task {
            task.abort();
        }
    }

    async fn finish_client_task(&mut self) {
        if let Some(task) = self.client_task.as_mut() {
            let _ = task.await;
            self.client_task = None;
        }
    }

    async fn finish_auxiliary_tasks(&mut self) {
        if let Some(task) = self.voice_task.as_mut() {
            let _ = task.await;
            self.voice_task = None;
        }
        if let Some(task) = self.audio_task.as_mut() {
            let _ = task.await;
            self.audio_task = None;
        }
    }

    async fn finish_all_tasks(&mut self) {
        self.finish_auxiliary_tasks().await;
        self.finish_client_task().await;
    }
}

async fn run_voice_recovery(
    state: Arc<BotState>,
    songbird: Arc<Songbird>,
    output: Arc<GenerationOutput>,
    generation: u64,
    mut triggers: mpsc::UnboundedReceiver<()>,
    cancel: CancellationToken,
) {
    let mut failures = 0_u32;
    let mut events_registered = false;

    while triggers.recv().await.is_some() {
        if cancel.is_cancelled() || !state.control.is_current_generation(generation) {
            break;
        }

        if let Err(error) = state.player.suspend_output().await {
            error!(
                ?error,
                "failed to suspend player output before voice recovery"
            );
            if !state
                .control
                .update_current_generation(generation, |status| {
                    status.status = BotLifecycleStatus::Failed;
                    status.last_error = Some(safe_error(
                        BotErrorStage::Playback,
                        "player_unavailable",
                        "The current playback state is unavailable.",
                    ));
                })
            {
                return;
            }
            continue;
        }
        output.stop().await;
        request_checkpoint(&state).await;
        loop {
            while triggers.try_recv().is_ok() {}
            let attempt = recover_voice_once(
                &state,
                &songbird,
                &output,
                generation,
                &mut events_registered,
            );
            let result = tokio::select! {
                _ = cancel.cancelled() => return,
                result = attempt => result,
            };
            if cancel.is_cancelled() || !state.control.is_current_generation(generation) {
                return;
            }

            let result = match result {
                Ok(()) => complete_voice_recovery(&state.control, &output, generation).await,
                Err(error) => Err(error),
            };
            match result {
                Ok(()) => {
                    failures = 0;
                    break;
                }
                Err(error) => {
                    failures = failures.saturating_add(1);
                    let delay = capped_retry_delay(failures);
                    let retry_at = unix_time_ms().saturating_add(duration_ms(delay));
                    let unconfigured = error.code == "voice_unconfigured"
                        || error.code == "voice_invalid_configuration";
                    if !state
                        .control
                        .update_current_generation(generation, |status| {
                            status.status = if unconfigured {
                                BotLifecycleStatus::Unconfigured
                            } else {
                                BotLifecycleStatus::RetryWait
                            };
                            status.next_retry_at = Some(retry_at);
                            status.last_error =
                                Some(safe_error(error.stage, error.code, error.message));
                        })
                    {
                        return;
                    }
                    if let Err(suspend_error) = state.player.suspend_output().await {
                        error!(
                            ?suspend_error,
                            "failed to keep playback frozen between recovery attempts"
                        );
                    }
                    output.stop().await;

                    let deadline = TokioInstant::now() + delay;
                    tokio::select! {
                        _ = cancel.cancelled() => return,
                        _ = sleep_until(deadline) => {},
                        trigger = triggers.recv() => {
                            if trigger.is_none() {
                                return;
                            }
                        }
                    }
                }
            }
        }
    }
}

async fn complete_voice_recovery(
    control: &BotControl,
    output: &GenerationOutput,
    generation: u64,
) -> Result<(), RecoveryFailure> {
    output
        .reconcile_after_change()
        .await
        .map_err(reconcile_failure)?;
    if !control.update_current_generation(generation, |status| {
        status.status = BotLifecycleStatus::Ready;
        status.next_retry_at = None;
        status.last_error = None;
    }) {
        return Err(RecoveryFailure {
            stage: BotErrorStage::Voice,
            code: "stale_generation",
            message: "A superseded bot generation cannot restore voice.",
        });
    }

    output
        .reconcile_after_change()
        .await
        .map_err(reconcile_failure)
}

struct RecoveryFailure {
    stage: BotErrorStage,
    code: &'static str,
    message: &'static str,
}

fn stale_recovery_failure() -> RecoveryFailure {
    RecoveryFailure {
        stage: BotErrorStage::Voice,
        code: "stale_generation",
        message: "A superseded bot generation cannot restore voice.",
    }
}

async fn recover_voice_once(
    state: &BotState,
    songbird: &Arc<Songbird>,
    output: &GenerationOutput,
    generation: u64,
    events_registered: &mut bool,
) -> Result<(), RecoveryFailure> {
    let configured = azuki_db::config::get_config(&state.db, "default_voice_channel_id")
        .await
        .map_err(|error| {
            error!(?error, "failed to read default voice channel configuration");
            RecoveryFailure {
                stage: BotErrorStage::Voice,
                code: "voice_configuration_unavailable",
                message: "The default voice channel configuration could not be read.",
            }
        })?;
    let Some(configured) = configured else {
        if !state
            .control
            .update_current_generation(generation, |status| {
                status.target_voice_channel_id = None;
            })
        {
            return Err(stale_recovery_failure());
        }
        return Err(RecoveryFailure {
            stage: BotErrorStage::Voice,
            code: "voice_unconfigured",
            message: "A default voice channel is not configured.",
        });
    };
    let Ok(channel_id) = configured.parse::<u64>() else {
        if !state
            .control
            .update_current_generation(generation, |status| {
                status.target_voice_channel_id = None;
            })
        {
            return Err(stale_recovery_failure());
        }
        return Err(RecoveryFailure {
            stage: BotErrorStage::Voice,
            code: "voice_invalid_configuration",
            message: "The configured default voice channel is invalid.",
        });
    };
    if channel_id == 0 {
        if !state
            .control
            .update_current_generation(generation, |status| {
                status.target_voice_channel_id = None;
            })
        {
            return Err(stale_recovery_failure());
        }
        return Err(RecoveryFailure {
            stage: BotErrorStage::Voice,
            code: "voice_invalid_configuration",
            message: "The configured default voice channel is invalid.",
        });
    }
    if !state
        .control
        .update_current_generation(generation, |status| {
            status.status = BotLifecycleStatus::Connecting;
            status.target_voice_channel_id = Some(channel_id.to_string());
            status.next_retry_at = None;
        })
    {
        return Err(stale_recovery_failure());
    }

    let http_rx = state.http_tx.subscribe();
    let Some(http) = http_rx.borrow().clone() else {
        return Err(RecoveryFailure {
            stage: BotErrorStage::Voice,
            code: "discord_http_unavailable",
            message: "The Discord bot is not ready to inspect the default voice channel.",
        });
    };
    let channel = timeout(BOT_OPERATION_TIMEOUT, http.get_channel(channel_id.into()))
        .await
        .map_err(|_| RecoveryFailure {
            stage: BotErrorStage::Voice,
            code: "voice_channel_check_timeout",
            message: "Checking the default voice channel timed out.",
        })?
        .map_err(|error| {
            let (code, message) = match &error {
                serenity::Error::Http(http_error)
                    if http_error.status_code() == Some(serenity::http::StatusCode::NOT_FOUND) =>
                {
                    (
                        "voice_channel_not_found",
                        "The configured default voice channel no longer exists.",
                    )
                }
                serenity::Error::Http(http_error)
                    if http_error.status_code() == Some(serenity::http::StatusCode::FORBIDDEN) =>
                {
                    (
                        "voice_channel_forbidden",
                        "The bot cannot access the configured default voice channel.",
                    )
                }
                _ => (
                    "voice_channel_check_failed",
                    "The default voice channel could not be checked.",
                ),
            };
            warn!(
                ?error,
                channel_id, "failed to inspect default voice channel"
            );
            RecoveryFailure {
                stage: BotErrorStage::Voice,
                code,
                message,
            }
        })?;
    match channel {
        Channel::Guild(channel)
            if channel.guild_id == state.guild_id && channel.kind == ChannelType::Voice => {}
        _ => {
            return Err(RecoveryFailure {
                stage: BotErrorStage::Voice,
                code: "voice_channel_invalid",
                message: "The configured channel is not a voice channel in this server.",
            });
        }
    }

    if !*events_registered {
        let call = songbird.get_or_insert(state.guild_id);
        let mut call = call.lock().await;
        for event in [
            CoreEvent::DriverConnect,
            CoreEvent::DriverReconnect,
            CoreEvent::DriverDisconnect,
        ] {
            call.add_global_event(
                Event::Core(event),
                VoiceDriverEvent {
                    control: state.control.clone(),
                    generation,
                },
            );
        }
        *events_registered = true;
    }

    match timeout(
        BOT_OPERATION_TIMEOUT,
        songbird.join(state.guild_id, serenity::all::ChannelId::new(channel_id)),
    )
    .await
    {
        Ok(Ok(_)) => {}
        Ok(Err(error)) => {
            warn!(?error, channel_id, "failed to join default voice channel");
            let _ = timeout(BOT_OPERATION_TIMEOUT, songbird.leave(state.guild_id)).await;
            return Err(RecoveryFailure {
                stage: BotErrorStage::Voice,
                code: "voice_join_failed",
                message: "The default voice channel is unavailable or cannot be joined.",
            });
        }
        Err(_) => {
            let _ = timeout(BOT_OPERATION_TIMEOUT, songbird.leave(state.guild_id)).await;
            return Err(RecoveryFailure {
                stage: BotErrorStage::Voice,
                code: "voice_join_timeout",
                message: "Connecting to the default voice channel timed out.",
            });
        }
    }

    if !state.control.is_current_generation(generation) {
        return Err(RecoveryFailure {
            stage: BotErrorStage::Voice,
            code: "stale_generation",
            message: "A superseded bot generation cannot restore voice.",
        });
    }

    output.reconcile(true).await.map_err(reconcile_failure)?;
    state.control.voice_connected(generation, channel_id);
    Ok(())
}

async fn run_audio_subscriber(
    state: Arc<BotState>,
    output: Arc<GenerationOutput>,
    generation: u64,
    cancel: CancellationToken,
) {
    let mut events = state.player.subscribe();
    loop {
        let event = tokio::select! {
            _ = cancel.cancelled() => break,
            event = events.recv() => event,
        };
        if !state.control.is_current_generation(generation) {
            break;
        }

        match event {
            Ok(event) => match event.event {
                PlayerEvent::TrackStarted { .. }
                | PlayerEvent::Paused { .. }
                | PlayerEvent::Resumed { .. }
                | PlayerEvent::Seeked { .. }
                | PlayerEvent::VolumeChanged { .. } => {
                    if state.control.status().status == BotLifecycleStatus::Ready {
                        reconcile_after_player_event(&state.control, &output, generation).await;
                    }
                }
                PlayerEvent::TrackEnded { .. } => output.stop().await,
                PlayerEvent::OutputSuspended { .. }
                | PlayerEvent::OutputResumed { .. }
                | PlayerEvent::TrackLoading { .. }
                | PlayerEvent::TrackError { .. }
                | PlayerEvent::QueueUpdated { .. }
                | PlayerEvent::LoopModeChanged { .. }
                | PlayerEvent::VideoSync { .. }
                | PlayerEvent::ListenersUpdated { .. }
                | PlayerEvent::HistoryUpdated { .. }
                | PlayerEvent::StateSnapshot { .. } => {}
            },
            Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                warn!(
                    skipped,
                    generation, "audio subscriber lagged; reconciling latest state"
                );
                if state.control.status().status == BotLifecycleStatus::Ready {
                    reconcile_after_player_event(&state.control, &output, generation).await;
                }
            }
            Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
        }
    }
}

async fn reconcile_after_player_event(
    control: &BotControl,
    output: &GenerationOutput,
    generation: u64,
) {
    if let Err(error) = output.reconcile_after_change().await
        && control.is_current_generation(generation)
    {
        handle_reconcile_error(control, generation, error);
    }
}

fn handle_reconcile_error(control: &BotControl, generation: u64, error: ReconcileError) {
    if error.code == "stale_generation" {
        return;
    }
    if control.update_current_generation(generation, |status| {
        status.status = BotLifecycleStatus::Failed;
        status.last_error = Some(safe_error(
            BotErrorStage::Playback,
            error.code,
            error.message,
        ));
    }) {
        control.request_voice_recovery();
    }
}

struct VoiceDriverEvent {
    control: BotControl,
    generation: u64,
}

#[async_trait]
impl SongbirdEventHandler for VoiceDriverEvent {
    async fn act(&self, context: &EventContext<'_>) -> Option<Event> {
        if !self.control.is_current_generation(self.generation) {
            return Some(Event::Cancel);
        }

        match context {
            EventContext::DriverConnect(data) => {
                if let Some(channel_id) = data.channel_id {
                    self.control
                        .voice_connected(self.generation, channel_id.0.get());
                }
            }
            EventContext::DriverReconnect(data) => {
                let channel_id = data.channel_id.map_or(0, |channel_id| channel_id.0.get());
                if self.control.status().status == BotLifecycleStatus::Ready {
                    self.control.voice_reconnected(self.generation, channel_id);
                } else {
                    self.control.voice_connected(self.generation, channel_id);
                }
            }
            EventContext::DriverDisconnect(_) => {
                self.control.voice_disconnected(self.generation);
            }
            _ => {}
        }
        None
    }
}

async fn freeze_playback(state: &BotState) {
    match timeout(BOT_OPERATION_TIMEOUT, state.player.suspend_output()).await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            error!(?error, "failed to suspend playback before bot replacement");
            publish_error(
                &state.control,
                BotErrorStage::Playback,
                "player_unavailable",
                "The current playback state is unavailable.",
            );
        }
        Err(_) => {
            error!("suspending playback before bot replacement timed out");
            publish_error(
                &state.control,
                BotErrorStage::Playback,
                "player_suspend_timeout",
                "Suspending playback before bot replacement timed out.",
            );
        }
    }
}

async fn request_checkpoint(state: &BotState) {
    let (reply_tx, reply_rx) = oneshot::channel();
    let request = timeout(CHECKPOINT_TIMEOUT, state.checkpoint_tx.send(reply_tx)).await;
    let result = match request {
        Ok(Ok(())) => timeout(CHECKPOINT_TIMEOUT, reply_rx).await,
        Ok(Err(_)) | Err(_) => {
            state.control.checkpoint_failed();
            return;
        }
    };

    match result {
        Ok(Ok(Ok(()))) => {}
        Ok(Ok(Err(error))) => {
            warn!(?error, "bot restart checkpoint failed");
            state.control.checkpoint_failed();
        }
        Ok(Err(_)) | Err(_) => state.control.checkpoint_failed(),
    }
}

fn publish_error(
    control: &BotControl,
    stage: BotErrorStage,
    code: &'static str,
    message: &'static str,
) {
    control.shared.update(|status| {
        status.status = BotLifecycleStatus::Failed;
        status.last_error = Some(safe_error(stage, code, message));
    });
}

fn safe_error(stage: BotErrorStage, code: &'static str, message: &'static str) -> BotStatusError {
    BotStatusError {
        stage,
        code: code.to_string(),
        message: message.to_string(),
    }
}

fn reconcile_failure(error: ReconcileError) -> RecoveryFailure {
    RecoveryFailure {
        stage: BotErrorStage::Playback,
        code: error.code,
        message: error.message,
    }
}

fn capped_retry_delay(failures: u32) -> Duration {
    let seconds = 1_u64
        .checked_shl(failures.saturating_sub(1))
        .unwrap_or(MAX_RETRY_DELAY.as_secs())
        .min(MAX_RETRY_DELAY.as_secs());
    Duration::from_secs(seconds)
}

fn duration_ms(duration: Duration) -> i64 {
    i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_schedule_is_immediate_then_infinite_with_a_300_second_cap() {
        let seconds = (1..=12)
            .map(|failure| capped_retry_delay(failure).as_secs())
            .collect::<Vec<_>>();
        assert_eq!(
            seconds,
            vec![1, 2, 4, 8, 16, 32, 64, 128, 256, 300, 300, 300]
        );
    }
}
