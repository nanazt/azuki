use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use serenity::all::{
    ChannelId, ChannelType, Context, CreateInteractionResponse, CreateInteractionResponseMessage,
    EventHandler, GatewayIntents, GuildId, Interaction, Ready,
};
use serenity::async_trait;
use songbird::SerenityInit;
use songbird::events::{Event, EventContext, EventHandler as SongbirdEventHandler, TrackEvent};
use tokio_util::sync::CancellationToken;
use tracing::{debug, error, info, warn};

use crate::BotState;
use crate::commands;

pub struct Handler {
    pub state: Arc<BotState>,
    pub guild_id: GuildId,
}

#[async_trait]
impl EventHandler for Handler {
    async fn ready(&self, ctx: Context, ready: Ready) {
        info!("{} is connected!", ready.user.name);

        // Share Http with bridge task for embed sending
        let _ = self.state.http_tx.send(Some(ctx.http.clone()));

        if let Err(e) = commands::register_commands(&ctx, self.guild_id).await {
            error!("failed to register commands: {e}");
        }

        // Auto-join default voice channel
        {
            let sb_guard = self.state.songbird.lock().await;
            if let Some(ref sb) = *sb_guard {
                auto_join_default_channel(&self.state, sb).await;
            } else {
                warn!("songbird not ready at startup, skipping auto-join");
            }
        }

        // Populate available voice channels
        match ctx.http.get_channels(self.guild_id).await {
            Ok(channels) => {
                let voice: Vec<(u64, String)> = channels
                    .iter()
                    .filter(|c| c.kind == ChannelType::Voice)
                    .map(|c| (c.id.get(), c.name.clone()))
                    .collect();
                let text: Vec<(u64, String)> = channels
                    .iter()
                    .filter(|c| c.kind == ChannelType::Text)
                    .map(|c| (c.id.get(), c.name.clone()))
                    .collect();
                info!("found {} voice channels, {} text channels", voice.len(), text.len());
                *self.state.voice_channels.write().unwrap() = voice;
                *self.state.text_channels.write().unwrap() = text;
            }
            Err(e) => warn!("failed to fetch voice channels: {e}"),
        }
    }

    async fn interaction_create(&self, ctx: Context, interaction: Interaction) {
        match interaction {
            Interaction::Command(cmd) => {
                let result = commands::handle_command(&ctx, &cmd, &self.state).await;

                if let Err(e) = result {
                    error!("command error: {e}");
                    let msg = CreateInteractionResponseMessage::new()
                        .content(format!("Error: {e}"))
                        .ephemeral(true);
                    let response = CreateInteractionResponse::Message(msg);
                    let _ = cmd.create_response(&ctx.http, response).await;
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
                } else if let Some(pos) = custom_id.strip_prefix("qr:").and_then(|s| s.parse::<usize>().ok()) {
                    commands::handle_queue_remove(&ctx, &component, &self.state, pos).await;
                } else if let Some(page) = custom_id.strip_prefix("qp:").and_then(|s| s.parse::<usize>().ok()) {
                    commands::handle_queue_page(&ctx, &component, &self.state, page).await;
                } else if let Some(page) = custom_id.strip_prefix("qn:").and_then(|s| s.parse::<usize>().ok()) {
                    commands::handle_queue_page(&ctx, &component, &self.state, page).await;
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
    cancel: CancellationToken,
) -> Result<(), crate::BotError> {
    let guild_id = GuildId::new(guild_id);

    let intents = GatewayIntents::non_privileged() | GatewayIntents::MESSAGE_CONTENT;

    let songbird = songbird::Songbird::serenity();

    let handler = Handler {
        state: state.clone(),
        guild_id,
    };

    let mut client = serenity::Client::builder(token, intents)
        .event_handler(handler)
        .register_songbird_with(songbird.clone())
        .await
        .map_err(|e| crate::BotError::Serenity(e.to_string()))?;

    // Store songbird in bot state
    *state.songbird.lock().await = Some(songbird);
    debug!("start_bot: songbird stored, spawning audio subscriber");

    // Spawn audio event subscriber
    tokio::spawn(run_audio_subscriber(state.clone()));
    debug!("start_bot: audio subscriber spawned");

    // Run client with cancellation
    tokio::select! {
        result = client.start() => {
            if let Err(e) = result {
                error!("bot client error: {e}");
            }
        }
        _ = cancel.cancelled() => {
            info!("bot shutting down");
            client.shard_manager.shutdown_all().await;
        }
    }

    Ok(())
}

async fn run_audio_subscriber(state: Arc<BotState>) {
    debug!("audio_subscriber: started");
    let mut rx = state.player.subscribe();
    let mut current_track_handle: Option<songbird::tracks::TrackHandle> = None;
    // (file_path, track_id, volume) for re-play on seek
    let mut current_file: Option<(String, String, u8)> = None;
    let generation = Arc::new(AtomicU64::new(0));

    loop {
        match rx.recv().await {
            Ok(seq_event) => match seq_event.event {
                azuki_player::PlayerEvent::TrackStarted { ref track, .. } => {
                    debug!("audio_subscriber: TrackStarted id={} title={:?} file_path={:?}", track.id, track.title, track.file_path);
                    let Some(ref file_path) = track.file_path else {
                        debug!("audio_subscriber: file_path is None, skipping");
                        continue;
                    };
                    let sb_guard = state.songbird.lock().await;
                    let Some(sb) = sb_guard.as_ref() else {
                        debug!("audio_subscriber: songbird not ready");
                        continue;
                    };

                    if sb.get(state.guild_id).is_none() {
                        debug!("audio_subscriber: not in voice, auto-joining");
                        auto_join_default_channel(&state, sb).await;
                    }

                    let in_call = sb.get(state.guild_id).is_some();
                    debug!("audio_subscriber: in_call={in_call}, playing file={file_path}");

                    let notifier_gen = generation.fetch_add(1, Ordering::SeqCst) + 1;
                    let handle =
                        crate::voice::play_file(sb, state.guild_id, file_path).await;
                    debug!("audio_subscriber: play_file returned handle={}", handle.is_some());
                    if let Some(ref h) = handle {
                        crate::voice::set_volume(h, track.volume);
                        let _ = h.add_event(
                            Event::Track(TrackEvent::End),
                            TrackEndNotifier {
                                player: state.player.clone(),
                                track_id: track.id.clone(),
                                generation: notifier_gen,
                                current_generation: generation.clone(),
                            },
                        );
                    }
                    current_file = Some((file_path.clone(), track.id.clone(), track.volume));
                    current_track_handle = handle;
                }
                azuki_player::PlayerEvent::VolumeChanged { volume } => {
                    if let Some(ref h) = current_track_handle {
                        crate::voice::set_volume(h, volume);
                    }
                    if let Some((_, _, ref mut v)) = current_file {
                        *v = volume;
                    }
                }
                azuki_player::PlayerEvent::Paused { .. } => {
                    if let Some(ref h) = current_track_handle {
                        crate::voice::pause_track(h);
                    }
                }
                azuki_player::PlayerEvent::Resumed { position_ms } => {
                    if let Some(ref h) = current_track_handle {
                        crate::voice::resume_track(h);
                    } else {
                        // Restored track: no songbird handle yet, need to play from scratch
                        let snapshot = state.player.get_state().await;
                        if let azuki_player::PlayStateInfo::Playing { ref track, .. } = snapshot.state
                            && let Some(ref file_path) = track.file_path
                        {
                            debug!("audio_subscriber: resuming restored track, playing from file");
                            let sb_guard = state.songbird.lock().await;
                            if let Some(sb) = sb_guard.as_ref() {
                                if sb.get(state.guild_id).is_none() {
                                    auto_join_default_channel(&state, sb).await;
                                }
                                let notifier_gen = generation.fetch_add(1, Ordering::SeqCst) + 1;
                                let handle = crate::voice::play_file(sb, state.guild_id, file_path).await;
                                if let Some(ref h) = handle {
                                    crate::voice::set_volume(h, track.volume);
                                    if position_ms > 0 {
                                        let h2 = h.clone();
                                        tokio::spawn(async move {
                                            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                                            crate::voice::seek_track(&h2, position_ms);
                                        });
                                    }
                                    let _ = h.add_event(
                                        Event::Track(TrackEvent::End),
                                        TrackEndNotifier {
                                            player: state.player.clone(),
                                            track_id: track.id.clone(),
                                            generation: notifier_gen,
                                            current_generation: generation.clone(),
                                        },
                                    );
                                }
                                current_file = Some((file_path.clone(), track.id.clone(), track.volume));
                                current_track_handle = handle;
                            }
                        }
                    }
                }
                azuki_player::PlayerEvent::Seeked { position_ms, paused } => {
                    // Re-play file to avoid songbird backward-seek failures
                    if let Some((ref file_path, ref track_id, volume)) = current_file {
                        let sb_guard = state.songbird.lock().await;
                        if let Some(sb) = sb_guard.as_ref() {
                            let notifier_gen = generation.fetch_add(1, Ordering::SeqCst) + 1;
                            let handle =
                                crate::voice::play_file(sb, state.guild_id, file_path).await;
                            if let Some(ref h) = handle {
                                crate::voice::set_volume(h, volume);
                                if position_ms > 0 {
                                    // Delay seek to let the driver initialize the track
                                    let h2 = h.clone();
                                    let should_pause = paused;
                                    tokio::spawn(async move {
                                        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                                        crate::voice::seek_track(&h2, position_ms);
                                        if should_pause {
                                            crate::voice::pause_track(&h2);
                                        }
                                    });
                                } else if paused {
                                    crate::voice::pause_track(h);
                                }
                                let _ = h.add_event(
                                    Event::Track(TrackEvent::End),
                                    TrackEndNotifier {
                                        player: state.player.clone(),
                                        track_id: track_id.clone(),
                                        generation: notifier_gen,
                                        current_generation: generation.clone(),
                                    },
                                );
                            }
                            current_track_handle = handle;
                        }
                    }
                }
                azuki_player::PlayerEvent::TrackEnded { .. } => {
                    current_track_handle = None;
                    current_file = None;
                    let sb_guard = state.songbird.lock().await;
                    if let Some(sb) = sb_guard.as_ref() {
                        crate::voice::stop_playback(sb, state.guild_id).await;
                    }
                }
                _ => {}
            },
            Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                warn!("audio subscriber lagged by {n} events");
            }
            Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
        }
    }
    debug!("audio_subscriber: EXITED");
}

struct TrackEndNotifier {
    player: azuki_player::PlayerController,
    track_id: String,
    generation: u64,
    current_generation: Arc<AtomicU64>,
}

#[async_trait]
impl SongbirdEventHandler for TrackEndNotifier {
    async fn act(&self, _ctx: &EventContext<'_>) -> Option<Event> {
        // Only fire if this notifier's generation is still current
        // (stale notifiers from seek/re-play are ignored)
        if self.generation == self.current_generation.load(Ordering::SeqCst) {
            self.player
                .on_track_end(
                    self.track_id.clone(),
                    azuki_player::TrackEndReason::Finished,
                )
                .await;
        }
        None
    }
}

async fn auto_join_default_channel(state: &BotState, sb: &Arc<songbird::Songbird>) {
    let config = match azuki_db::config::get_config(&state.db, "default_voice_channel_id").await {
        Ok(Some(val)) => val,
        Ok(None) => {
            warn!("no default voice channel configured, skipping auto-join");
            return;
        }
        Err(e) => {
            error!("failed to read default voice channel config: {e}");
            return;
        }
    };

    let Ok(ch_id) = config.parse::<u64>() else {
        return;
    };
    let channel_id = ChannelId::new(ch_id);
    info!("auto-joining voice channel {channel_id}");
    if let Err(e) = crate::voice::join_channel(sb, state.guild_id, channel_id).await {
        error!("auto-join failed: {e}");
    }
}
