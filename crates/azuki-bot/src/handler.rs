use std::sync::Arc;

use serenity::all::{
    ChannelId, ChannelType, Context, CreateInteractionResponse,
    CreateInteractionResponseMessage, EventHandler, GatewayIntents, GuildId, Interaction, Ready,
};
use serenity::async_trait;
use songbird::SerenityInit;
use tokio_util::sync::CancellationToken;
use tracing::{error, info, warn};

use crate::commands;
use crate::BotState;

pub struct Handler {
    pub state: Arc<BotState>,
    pub guild_id: GuildId,
}

#[async_trait]
impl EventHandler for Handler {
    async fn ready(&self, ctx: Context, ready: Ready) {
        info!("{} is connected!", ready.user.name);

        if let Err(e) = commands::register_commands(&ctx, self.guild_id).await {
            error!("failed to register commands: {e}");
        }

        // Auto-join default voice channel
        {
            let sb_guard = self.state.songbird.lock().await;
            if let Some(ref sb) = *sb_guard {
                match azuki_db::config::get_config(&self.state.db, "default_voice_channel_id").await {
                    Ok(Some(ch_id_str)) => {
                        if let Ok(ch_id) = ch_id_str.parse::<u64>() {
                            let channel_id = ChannelId::new(ch_id);
                            info!("auto-joining voice channel {channel_id} on startup");
                            if let Err(e) = crate::voice::join_channel(sb, self.guild_id, channel_id).await {
                                error!("auto-join failed: {e}");
                            }
                        }
                    }
                    Ok(None) => info!("no default voice channel configured, skipping auto-join"),
                    Err(e) => error!("failed to read default voice channel config: {e}"),
                }
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
                info!("found {} voice channels", voice.len());
                *self.state.voice_channels.write().unwrap() = voice;
            }
            Err(e) => warn!("failed to fetch voice channels: {e}"),
        }
    }

    async fn interaction_create(&self, ctx: Context, interaction: Interaction) {
        if let Interaction::Command(cmd) = interaction {
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

    // Spawn audio event subscriber
    let event_state = state.clone();
    tokio::spawn(async move {
        let mut rx = event_state.player.subscribe();
        let mut current_track_handle: Option<songbird::tracks::TrackHandle> = None;
        loop {
            match rx.recv().await {
                Ok(seq_event) => {
                    if let azuki_player::PlayerEvent::TrackStarted { ref track, .. } = seq_event.event
                        && let Some(ref file_path) = track.file_path
                    {
                        let sb_guard = event_state.songbird.lock().await;
                        if let Some(sb) = sb_guard.as_ref() {
                            // Auto-join default voice channel if not in one
                            if sb.get(event_state.guild_id).is_none() {
                                match azuki_db::config::get_config(&event_state.db, "default_voice_channel_id").await {
                                    Ok(Some(ch_id_str)) => {
                                        if let Ok(ch_id) = ch_id_str.parse::<u64>() {
                                            let channel_id = ChannelId::new(ch_id);
                                            info!("auto-joining voice channel {channel_id}");
                                            if let Err(e) = crate::voice::join_channel(sb, event_state.guild_id, channel_id).await {
                                                error!("auto-join failed: {e}");
                                            }
                                        }
                                    }
                                    Ok(None) => {
                                        warn!("no default voice channel configured, skipping auto-join");
                                    }
                                    Err(e) => {
                                        error!("failed to read default voice channel config: {e}");
                                    }
                                }
                            }
                            let handle = crate::voice::play_file(sb, event_state.guild_id, file_path).await;
                            if let Some(ref h) = handle {
                                crate::voice::set_volume(h, track.volume);
                            }
                            current_track_handle = handle;
                        }
                    }

                    if let azuki_player::PlayerEvent::VolumeChanged { volume } = seq_event.event
                        && let Some(ref h) = current_track_handle {
                            crate::voice::set_volume(h, volume);
                        }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!("audio subscriber lagged by {n} events");
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });

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
