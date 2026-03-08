use std::sync::Arc;

use serenity::all::{
    ChannelId, CommandInteraction, CommandOptionType, ComponentInteraction, Context, CreateCommand,
    CreateCommandOption, CreateInteractionResponse, CreateInteractionResponseMessage, GuildId,
    UserId,
};
use tracing::info;

use azuki_player::{LoopMode, TrackInfo, UserInfo};

use crate::BotState;

fn user_info_from(user: &serenity::all::User) -> UserInfo {
    UserInfo {
        id: user.id.to_string(),
        username: user.global_name.as_deref().unwrap_or(&user.name).to_string(),
        avatar_url: user.avatar_url(),
    }
}

pub async fn register_commands(ctx: &Context, guild_id: GuildId) -> Result<(), serenity::Error> {
    let commands = vec![
        CreateCommand::new("play")
            .description("Play a track from YouTube or URL")
            .add_option(
                CreateCommandOption::new(CommandOptionType::String, "query", "Search query or URL")
                    .required(true),
            ),
        CreateCommand::new("pause").description("Pause playback"),
        CreateCommand::new("resume").description("Resume playback"),
        CreateCommand::new("skip").description("Skip to next track"),
        CreateCommand::new("stop").description("Stop playback and clear queue"),
        CreateCommand::new("queue").description("Show current queue"),
        CreateCommand::new("remove")
            .description("Remove track from queue")
            .add_option(
                CreateCommandOption::new(
                    CommandOptionType::Integer,
                    "position",
                    "Queue position to remove",
                )
                .required(true),
            ),
        CreateCommand::new("now").description("Show now playing"),
        CreateCommand::new("volume")
            .description("Set volume (0-100)")
            .add_option(
                CreateCommandOption::new(CommandOptionType::Integer, "level", "Volume level 0-100")
                    .required(true)
                    .min_int_value(0)
                    .max_int_value(100),
            ),
        CreateCommand::new("seek")
            .description("Seek to position (e.g. 1:30)")
            .add_option(
                CreateCommandOption::new(
                    CommandOptionType::String,
                    "time",
                    "Time position (e.g. 1:30)",
                )
                .required(true),
            ),
        CreateCommand::new("loop")
            .description("Set loop mode")
            .add_option(
                CreateCommandOption::new(CommandOptionType::String, "mode", "Loop mode")
                    .required(true)
                    .add_string_choice("off", "off")
                    .add_string_choice("one", "one")
                    .add_string_choice("all", "all"),
            ),
        CreateCommand::new("playlist")
            .description("Load a playlist into queue")
            .add_option(
                CreateCommandOption::new(
                    CommandOptionType::String,
                    "name",
                    "Playlist name or YouTube URL",
                )
                .required(true),
            ),
    ];

    guild_id.set_commands(&ctx.http, commands).await?;
    info!("registered 12 slash commands");
    Ok(())
}

pub async fn handle_command(
    ctx: &Context,
    cmd: &CommandInteraction,
    state: &Arc<BotState>,
) -> Result<(), crate::BotError> {
    match cmd.data.name.as_str() {
        "play" => handle_play(ctx, cmd, state).await,
        "pause" => handle_pause(ctx, cmd, state).await,
        "resume" => handle_resume(ctx, cmd, state).await,
        "skip" => handle_skip(ctx, cmd, state).await,
        "stop" => handle_stop(ctx, cmd, state).await,
        "queue" => handle_queue(ctx, cmd, state).await,
        "remove" => handle_remove(ctx, cmd, state).await,
        "now" => handle_now(ctx, cmd, state).await,
        "volume" => handle_volume(ctx, cmd, state).await,
        "seek" => handle_seek(ctx, cmd, state).await,
        "loop" => handle_loop(ctx, cmd, state).await,
        "playlist" => handle_playlist(ctx, cmd, state).await,
        _ => Ok(()),
    }
}

fn get_string_option(cmd: &CommandInteraction, name: &str) -> Option<String> {
    cmd.data
        .options
        .iter()
        .find(|o| o.name == name)
        .and_then(|o| o.value.as_str().map(String::from))
}

fn get_int_option(cmd: &CommandInteraction, name: &str) -> Option<i64> {
    cmd.data
        .options
        .iter()
        .find(|o| o.name == name)
        .and_then(|o| o.value.as_i64())
}

async fn respond(
    ctx: &Context,
    cmd: &CommandInteraction,
    content: &str,
) -> Result<(), crate::BotError> {
    let msg = CreateInteractionResponseMessage::new().content(content);
    let response = CreateInteractionResponse::Message(msg);
    cmd.create_response(&ctx.http, response)
        .await
        .map_err(|e| crate::BotError::Serenity(e.to_string()))
}

async fn defer(ctx: &Context, cmd: &CommandInteraction) -> Result<(), crate::BotError> {
    cmd.defer(&ctx.http)
        .await
        .map_err(|e| crate::BotError::Serenity(e.to_string()))
}

pub async fn ensure_user_in_voice(
    ctx: &Context,
    guild_id: GuildId,
    user_id: UserId,
    state: &Arc<BotState>,
) -> Result<ChannelId, crate::BotError> {
    let channel_id = {
        let guild = ctx
            .cache
            .guild(guild_id)
            .ok_or(crate::BotError::NotInVoice)?;
        guild
            .voice_states
            .get(&user_id)
            .and_then(|vs| vs.channel_id)
    }
    .ok_or(crate::BotError::NotInVoice)?;

    if let Some(sb) = state.songbird.lock().await.as_ref()
        && sb.get(state.guild_id).is_none()
    {
        crate::voice::join_channel(sb, state.guild_id, channel_id)
            .await
            .map_err(crate::BotError::Voice)?;
    }

    Ok(channel_id)
}

async fn ensure_voice(
    ctx: &Context,
    cmd: &CommandInteraction,
    state: &Arc<BotState>,
) -> Result<ChannelId, crate::BotError> {
    let guild_id = cmd.guild_id.ok_or(crate::BotError::NotInVoice)?;
    ensure_user_in_voice(ctx, guild_id, cmd.user.id, state).await
}

async fn handle_play(
    ctx: &Context,
    cmd: &CommandInteraction,
    state: &Arc<BotState>,
) -> Result<(), crate::BotError> {
    ensure_voice(ctx, cmd, state).await?;
    defer(ctx, cmd).await?;

    let query = get_string_option(cmd, "query").unwrap_or_default();
    let user_info = user_info_from(&cmd.user);

    // Search or download
    let is_url = query.starts_with("http://") || query.starts_with("https://");
    let (file_path, meta) = if is_url {
        state
            .ytdlp
            .download(&query)
            .await
            .map_err(crate::BotError::Media)?
    } else {
        let youtube = state
            .youtube
            .read()
            .unwrap()
            .clone()
            .ok_or(crate::BotError::NoYouTubeKey)?;
        let results = youtube
            .search(&query, 1)
            .await
            .map_err(crate::BotError::Media)?;
        let meta = results
            .into_iter()
            .next()
            .ok_or_else(|| crate::BotError::NoResults)?;
        state
            .ytdlp
            .download(&meta.source_url)
            .await
            .map_err(crate::BotError::Media)?
    };

    let track_id = sha_id(&meta.source_url);
    let file_path_str = file_path.to_string_lossy().to_string();

    // Download thumbnail
    if let Some(ref thumb_url) = meta.thumbnail_url {
        let thumb_path = std::path::Path::new("media/thumbnails").join(format!("{track_id}.jpg"));
        if let Err(e) = azuki_media::YtDlp::download_thumbnail(thumb_url, &thumb_path).await {
            tracing::warn!("thumbnail download failed: {e}");
        }
    }

    // Save to DB
    azuki_db::queries::tracks::upsert_track(
        &state.db,
        &track_id,
        &meta.title,
        meta.artist.as_deref(),
        meta.duration_ms as i64,
        meta.thumbnail_url.as_deref(),
        &meta.source_url,
        "youtube",
        Some(&file_path_str),
        meta.youtube_id.as_deref(),
        None,
    )
    .await
    .ok();

    let track_volume = azuki_db::queries::tracks::get_track(&state.db, &track_id)
        .await
        .map(|t| t.volume as u8)
        .unwrap_or(5);

    let track_info = TrackInfo {
        id: track_id,
        title: meta.title.clone(),
        artist: meta.artist.clone(),
        duration_ms: meta.duration_ms,
        thumbnail_url: meta.thumbnail_url.clone(),
        source_url: meta.source_url,
        source_type: "youtube".to_string(),
        file_path: Some(file_path_str),
        youtube_id: meta.youtube_id,
        volume: track_volume,
    };

    // Check if something is playing
    let snapshot = state.player.get_state().await;
    match snapshot.state {
        azuki_player::PlayStateInfo::Idle => {
            state
                .player
                .play(track_info.clone(), user_info)
                .await
                .map_err(crate::BotError::Player)?;
        }
        _ => {
            state
                .player
                .enqueue(track_info.clone(), user_info)
                .await
                .map_err(crate::BotError::Player)?;
        }
    }

    let content = format!(
        "🎵 **{}** — {}",
        meta.title,
        meta.artist.as_deref().unwrap_or("Unknown")
    );
    cmd.edit_response(
        &ctx.http,
        serenity::all::EditInteractionResponse::new().content(&content),
    )
    .await
    .map_err(|e| crate::BotError::Serenity(e.to_string()))?;

    Ok(())
}

async fn handle_pause(
    ctx: &Context,
    cmd: &CommandInteraction,
    state: &Arc<BotState>,
) -> Result<(), crate::BotError> {
    state
        .player
        .pause()
        .await
        .map_err(crate::BotError::Player)?;
    // Songbird pause is handled by run_audio_subscriber via Paused event
    respond(ctx, cmd, "⏸️ Paused").await
}

async fn handle_resume(
    ctx: &Context,
    cmd: &CommandInteraction,
    state: &Arc<BotState>,
) -> Result<(), crate::BotError> {
    state
        .player
        .resume()
        .await
        .map_err(crate::BotError::Player)?;
    // Audio will be re-triggered via the player event subscriber
    respond(ctx, cmd, "▶️ Resumed").await
}

async fn handle_skip(
    ctx: &Context,
    cmd: &CommandInteraction,
    state: &Arc<BotState>,
) -> Result<(), crate::BotError> {
    let next = state.player.skip().await.map_err(crate::BotError::Player)?;
    match next {
        Some(track) => respond(ctx, cmd, &format!("⏭️ Skipped → **{}**", track.title)).await,
        None => respond(ctx, cmd, "⏭️ Skipped — queue empty").await,
    }
}

async fn handle_stop(
    ctx: &Context,
    cmd: &CommandInteraction,
    state: &Arc<BotState>,
) -> Result<(), crate::BotError> {
    state.player.stop().await.map_err(crate::BotError::Player)?;
    if let Some(sb) = state.songbird.lock().await.as_ref() {
        crate::voice::leave_channel(sb, state.guild_id).await;
    }
    respond(ctx, cmd, "⏹️ Stopped and cleared queue").await
}

async fn handle_queue(
    ctx: &Context,
    cmd: &CommandInteraction,
    state: &Arc<BotState>,
) -> Result<(), crate::BotError> {
    let snapshot = state.player.get_state().await;
    if snapshot.queue.is_empty() {
        return respond(ctx, cmd, "Queue is empty").await;
    }

    let mut content = String::from("**Queue:**\n");
    for (i, entry) in snapshot.queue.iter().enumerate().take(10) {
        let duration = format_duration(entry.track.duration_ms);
        content.push_str(&format!(
            "{}. **{}** — {} [{duration}]\n",
            i + 1,
            entry.track.title,
            entry.track.artist.as_deref().unwrap_or("Unknown"),
        ));
    }
    if snapshot.queue.len() > 10 {
        content.push_str(&format!("...and {} more", snapshot.queue.len() - 10));
    }

    respond(ctx, cmd, &content).await
}

async fn handle_remove(
    ctx: &Context,
    cmd: &CommandInteraction,
    state: &Arc<BotState>,
) -> Result<(), crate::BotError> {
    let pos = get_int_option(cmd, "position").unwrap_or(0) as usize;
    if pos == 0 {
        return respond(ctx, cmd, "Position must be 1 or greater").await;
    }
    state
        .player
        .remove(pos - 1)
        .await
        .map_err(crate::BotError::Player)?;
    respond(ctx, cmd, &format!("Removed track at position {pos}")).await
}

async fn handle_now(
    ctx: &Context,
    cmd: &CommandInteraction,
    state: &Arc<BotState>,
) -> Result<(), crate::BotError> {
    let snapshot = state.player.get_state().await;
    match snapshot.state {
        azuki_player::PlayStateInfo::Playing { track, position_ms } => {
            let pos = format_duration(position_ms);
            let total = format_duration(track.duration_ms);
            let progress = if track.duration_ms > 0 {
                let pct = (position_ms as f64 / track.duration_ms as f64 * 20.0) as usize;
                let bar: String = "▓".repeat(pct) + &"░".repeat(20 - pct);
                bar
            } else {
                "░".repeat(20)
            };
            respond(
                ctx,
                cmd,
                &format!(
                    "🎵 **{}** — {}\n{pos} {progress} {total}",
                    track.title,
                    track.artist.as_deref().unwrap_or("Unknown"),
                ),
            )
            .await
        }
        azuki_player::PlayStateInfo::Paused { track, position_ms } => {
            let pos = format_duration(position_ms);
            let total = format_duration(track.duration_ms);
            respond(
                ctx,
                cmd,
                &format!(
                    "⏸️ **{}** — {} (paused at {pos}/{total})",
                    track.title,
                    track.artist.as_deref().unwrap_or("Unknown"),
                ),
            )
            .await
        }
        _ => respond(ctx, cmd, "Nothing playing").await,
    }
}

async fn handle_volume(
    ctx: &Context,
    cmd: &CommandInteraction,
    state: &Arc<BotState>,
) -> Result<(), crate::BotError> {
    let level = get_int_option(cmd, "level").unwrap_or(5) as u8;
    state
        .player
        .set_volume(level)
        .await
        .map_err(crate::BotError::Player)?;
    let snapshot = state.player.get_state().await;
    if let azuki_player::PlayStateInfo::Playing { ref track, .. }
    | azuki_player::PlayStateInfo::Paused { ref track, .. } = snapshot.state
    {
        azuki_db::queries::tracks::update_track_volume(&state.db, &track.id, level as i64)
            .await
            .ok();
    }
    respond(ctx, cmd, &format!("🔊 Volume: {level}%")).await
}

async fn handle_seek(
    ctx: &Context,
    cmd: &CommandInteraction,
    state: &Arc<BotState>,
) -> Result<(), crate::BotError> {
    let time_str = get_string_option(cmd, "time").unwrap_or_default();
    let position_ms = parse_time(&time_str)
        .ok_or_else(|| crate::BotError::InvalidInput("invalid time format".to_string()))?;
    state
        .player
        .seek(position_ms)
        .await
        .map_err(crate::BotError::Player)?;
    respond(
        ctx,
        cmd,
        &format!("⏩ Seeked to {}", format_duration(position_ms)),
    )
    .await
}

async fn handle_loop(
    ctx: &Context,
    cmd: &CommandInteraction,
    state: &Arc<BotState>,
) -> Result<(), crate::BotError> {
    let mode_str = get_string_option(cmd, "mode").unwrap_or_default();
    let mode = match mode_str.as_str() {
        "one" => LoopMode::One,
        "all" => LoopMode::All,
        _ => LoopMode::Off,
    };
    state
        .player
        .set_loop(mode)
        .await
        .map_err(crate::BotError::Player)?;
    let emoji = match mode {
        LoopMode::Off => "➡️ Loop off",
        LoopMode::One => "🔂 Loop one",
        LoopMode::All => "🔁 Loop all",
    };
    respond(ctx, cmd, emoji).await
}

async fn handle_playlist(
    ctx: &Context,
    cmd: &CommandInteraction,
    state: &Arc<BotState>,
) -> Result<(), crate::BotError> {
    ensure_voice(ctx, cmd, state).await?;
    defer(ctx, cmd).await?;

    let name = get_string_option(cmd, "name").unwrap_or_default();
    let user_info = user_info_from(&cmd.user);

    // Check if it's a URL (YouTube playlist)
    if name.starts_with("http") {
        // TODO: YouTube playlist import
        cmd.edit_response(
            &ctx.http,
            serenity::all::EditInteractionResponse::new()
                .content("YouTube playlist import coming soon"),
        )
        .await
        .map_err(|e| crate::BotError::Serenity(e.to_string()))?;
        return Ok(());
    }

    // Search DB playlists
    let playlists = azuki_db::queries::playlists::list_playlists(&state.db, &user_info.id)
        .await
        .map_err(crate::BotError::Db)?;

    let playlist = playlists
        .iter()
        .find(|p| p.name.to_lowercase() == name.to_lowercase())
        .ok_or_else(|| crate::BotError::NoResults)?;

    let tracks = azuki_db::queries::playlists::get_playlist_tracks(&state.db, playlist.id)
        .await
        .map_err(crate::BotError::Db)?;

    for track in &tracks {
        let track_info = TrackInfo {
            id: track.id.clone(),
            title: track.title.clone(),
            artist: track.artist.clone(),
            duration_ms: track.duration_ms as u64,
            thumbnail_url: track.thumbnail_url.clone(),
            source_url: track.source_url.clone(),
            source_type: track.source_type.clone(),
            file_path: track.file_path.clone(),
            youtube_id: track.youtube_id.clone(),
            volume: track.volume as u8,
        };
        state.player.enqueue(track_info, user_info.clone()).await.ok();
    }

    cmd.edit_response(
        &ctx.http,
        serenity::all::EditInteractionResponse::new().content(format!(
            "📋 Loaded **{}** ({} tracks)",
            playlist.name,
            tracks.len()
        )),
    )
    .await
    .map_err(|e| crate::BotError::Serenity(e.to_string()))?;

    Ok(())
}

fn parse_time(s: &str) -> Option<u64> {
    let parts: Vec<&str> = s.split(':').collect();
    match parts.len() {
        1 => parts[0].parse::<u64>().ok().map(|s| s * 1000),
        2 => {
            let min = parts[0].parse::<u64>().ok()?;
            let sec = parts[1].parse::<u64>().ok()?;
            Some((min * 60 + sec) * 1000)
        }
        3 => {
            let hr = parts[0].parse::<u64>().ok()?;
            let min = parts[1].parse::<u64>().ok()?;
            let sec = parts[2].parse::<u64>().ok()?;
            Some((hr * 3600 + min * 60 + sec) * 1000)
        }
        _ => None,
    }
}

pub fn format_duration(ms: u64) -> String {
    let total_secs = ms / 1000;
    let mins = total_secs / 60;
    let secs = total_secs % 60;
    if mins >= 60 {
        let hrs = mins / 60;
        let mins = mins % 60;
        format!("{hrs}:{mins:02}:{secs:02}")
    } else {
        format!("{mins}:{secs:02}")
    }
}

fn sha_id(input: &str) -> String {
    use sha2::{Digest, Sha256};
    let hash = Sha256::digest(input.as_bytes());
    hex::encode(&hash[..8])
}

pub async fn handle_play_button(
    ctx: &Context,
    component: &ComponentInteraction,
    state: &Arc<BotState>,
    track_id: &str,
) {
    // Validate track_id format (16-char hex)
    if track_id.len() != 16 || !track_id.chars().all(|c| c.is_ascii_hexdigit()) {
        let _ = component
            .create_response(
                &ctx.http,
                CreateInteractionResponse::Message(
                    CreateInteractionResponseMessage::new()
                        .content("잘못된 트랙 ID입니다")
                        .ephemeral(true),
                ),
            )
            .await;
        return;
    }

    let guild_id = match component.guild_id {
        Some(id) => id,
        None => return,
    };

    if ensure_user_in_voice(ctx, guild_id, component.user.id, state)
        .await
        .is_err()
    {
        let _ = component
            .create_response(
                &ctx.http,
                CreateInteractionResponse::Message(
                    CreateInteractionResponseMessage::new()
                        .content("음성 채널에 먼저 접속해주세요")
                        .ephemeral(true),
                ),
            )
            .await;
        return;
    }

    let track = match azuki_db::queries::tracks::get_track(&state.db, track_id).await {
        Ok(t) => t,
        Err(_) => {
            let _ = component
                .create_response(
                    &ctx.http,
                    CreateInteractionResponse::Message(
                        CreateInteractionResponseMessage::new()
                            .content("트랙을 찾을 수 없습니다")
                            .ephemeral(true),
                    ),
                )
                .await;
            return;
        }
    };

    let ui = user_info_from(&component.user);
    let track_info = TrackInfo {
        id: track.id.clone(),
        title: track.title.clone(),
        artist: track.artist.clone(),
        duration_ms: track.duration_ms as u64,
        thumbnail_url: track.thumbnail_url.clone(),
        source_url: track.source_url.clone(),
        source_type: track.source_type.clone(),
        file_path: track.file_path.clone(),
        youtube_id: track.youtube_id.clone(),
        volume: track.volume as u8,
    };

    let has_file = track
        .file_path
        .as_ref()
        .is_some_and(|fp| std::path::Path::new(fp).exists());

    if has_file {
        let snapshot = state.player.get_state().await;
        let result = match snapshot.state {
            azuki_player::PlayStateInfo::Idle => {
                state.player.play(track_info.clone(), ui.clone()).await
            }
            _ => state.player.enqueue(track_info.clone(), ui).await,
        };

        let content = if result.is_ok() {
            format!("🎵 **{}** 재생 대기열에 추가했습니다", track_info.title)
        } else {
            "재생에 실패했습니다".to_string()
        };
        let _ = component
            .create_response(
                &ctx.http,
                CreateInteractionResponse::Message(
                    CreateInteractionResponseMessage::new()
                        .content(content)
                        .ephemeral(true),
                ),
            )
            .await;
    } else {
        let _ = component
            .create_response(
                &ctx.http,
                CreateInteractionResponse::Message(
                    CreateInteractionResponseMessage::new()
                        .content(format!(
                            "🔄 **{}** 다시 다운로드합니다...",
                            track_info.title
                        ))
                        .ephemeral(true),
                ),
            )
            .await;

        let ytdlp = state.ytdlp.clone();
        let player = state.player.clone();
        let db = state.db.clone();
        let source_url = track.source_url.clone();
        let ui = user_info_from(&component.user);

        tokio::spawn(async move {
            match ytdlp.download(&source_url).await {
                Ok((file_path, _meta)) => {
                    let file_path_str = file_path.to_string_lossy().to_string();
                    let mut ti = track_info;
                    ti.file_path = Some(file_path_str.clone());

                    let _ = azuki_db::queries::tracks::upsert_track(
                        &db,
                        &ti.id,
                        &ti.title,
                        ti.artist.as_deref(),
                        ti.duration_ms as i64,
                        ti.thumbnail_url.as_deref(),
                        &ti.source_url,
                        &ti.source_type,
                        Some(&file_path_str),
                        ti.youtube_id.as_deref(),
                        None,
                    )
                    .await;

                    let snapshot = player.get_state().await;
                    match snapshot.state {
                        azuki_player::PlayStateInfo::Idle => {
                            let _ = player.play(ti, ui.clone()).await;
                        }
                        _ => {
                            let _ = player.enqueue(ti, ui).await;
                        }
                    }
                }
                Err(e) => {
                    tracing::error!("re-download failed: {e}");
                }
            }
        });
    }
}

pub async fn handle_legacy_play(
    ctx: &Context,
    component: &ComponentInteraction,
    state: &Arc<BotState>,
    url: &str,
) {
    // URL validation
    let parsed = match url::Url::parse(url) {
        Ok(u) => u,
        Err(_) => {
            let _ = component
                .create_response(
                    &ctx.http,
                    CreateInteractionResponse::Message(
                        CreateInteractionResponseMessage::new()
                            .content("잘못된 URL입니다")
                            .ephemeral(true),
                    ),
                )
                .await;
            return;
        }
    };

    match parsed.scheme() {
        "http" | "https" => {}
        _ => {
            let _ = component
                .create_response(
                    &ctx.http,
                    CreateInteractionResponse::Message(
                        CreateInteractionResponseMessage::new()
                            .content("잘못된 URL 형식입니다")
                            .ephemeral(true),
                    ),
                )
                .await;
            return;
        }
    }

    let guild_id = match component.guild_id {
        Some(id) => id,
        None => return,
    };

    if ensure_user_in_voice(ctx, guild_id, component.user.id, state)
        .await
        .is_err()
    {
        let _ = component
            .create_response(
                &ctx.http,
                CreateInteractionResponse::Message(
                    CreateInteractionResponseMessage::new()
                        .content("음성 채널에 먼저 접속해주세요")
                        .ephemeral(true),
                ),
            )
            .await;
        return;
    }

    let _ = component
        .create_response(
            &ctx.http,
            CreateInteractionResponse::Message(
                CreateInteractionResponseMessage::new()
                    .content("🔄 다운로드 중...")
                    .ephemeral(true),
            ),
        )
        .await;

    let ytdlp = state.ytdlp.clone();
    let player = state.player.clone();
    let db = state.db.clone();
    let ui = user_info_from(&component.user);
    let url = url.to_string();

    tokio::spawn(async move {
        match ytdlp.download(&url).await {
            Ok((file_path, meta)) => {
                let track_id = sha_id(&meta.source_url);
                let file_path_str = file_path.to_string_lossy().to_string();

                let _ = azuki_db::queries::tracks::upsert_track(
                    &db,
                    &track_id,
                    &meta.title,
                    meta.artist.as_deref(),
                    meta.duration_ms as i64,
                    meta.thumbnail_url.as_deref(),
                    &meta.source_url,
                    "youtube",
                    Some(&file_path_str),
                    meta.youtube_id.as_deref(),
                    None,
                )
                .await;

                let track_volume = azuki_db::queries::tracks::get_track(&db, &track_id)
                    .await
                    .map(|t| t.volume as u8)
                    .unwrap_or(5);

                let track_info = TrackInfo {
                    id: track_id,
                    title: meta.title,
                    artist: meta.artist,
                    duration_ms: meta.duration_ms,
                    thumbnail_url: meta.thumbnail_url,
                    source_url: meta.source_url,
                    source_type: "youtube".to_string(),
                    file_path: Some(file_path_str),
                    youtube_id: meta.youtube_id,
                    volume: track_volume,
                };

                let snapshot = player.get_state().await;
                match snapshot.state {
                    azuki_player::PlayStateInfo::Idle => {
                        let _ = player.play(track_info, ui.clone()).await;
                    }
                    _ => {
                        let _ = player.enqueue(track_info, ui).await;
                    }
                }
            }
            Err(e) => {
                tracing::error!("legacy play download failed: {e}");
            }
        }
    });
}
