use std::sync::Arc;
use std::sync::atomic::Ordering;

use serenity::all::{
    ChannelId, CommandInteraction, CommandOptionType, ComponentInteraction,
    ComponentInteractionDataKind, Context, CreateCommand,
    CreateCommandOption, CreateInteractionResponse, CreateInteractionResponseFollowup,
    CreateInteractionResponseMessage, GuildId, UserId,
};
use tracing::info;

use azuki_player::{LoopMode, PlayAction, PlayerError, TrackInfo, UserInfo};

use crate::BotState;

fn user_info_from(user: &serenity::all::User) -> UserInfo {
    UserInfo {
        id: user.id.to_string(),
        username: user
            .global_name
            .as_deref()
            .unwrap_or(&user.name)
            .to_string(),
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
        CreateCommand::new("now").description("Show now playing"),
        CreateCommand::new("volume")
            .description("Set volume (0-100)")
            .add_option(
                CreateCommandOption::new(CommandOptionType::Integer, "level", "Volume level 0-100")
                    .required(true)
                    .min_int_value(0)
                    .max_int_value(100),
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
    ];

    guild_id.set_commands(&ctx.http, commands).await?;
    info!("registered 7 slash commands");
    Ok(())
}

pub async fn handle_command(
    ctx: &Context,
    cmd: &CommandInteraction,
    state: &Arc<BotState>,
) -> Result<(), crate::BotError> {
    let is_history = is_history_channel(state, cmd.channel_id.get());
    match cmd.data.name.as_str() {
        "play" => handle_play(ctx, cmd, state, is_history).await,
        "pause" => handle_pause(ctx, cmd, state, is_history).await,
        "resume" => handle_resume(ctx, cmd, state, is_history).await,
        "skip" => handle_skip(ctx, cmd, state, is_history).await,
        "now" => handle_now(ctx, cmd, state, is_history).await,
        "volume" => handle_volume(ctx, cmd, state, is_history).await,
        "loop" => handle_loop(ctx, cmd, state, is_history).await,
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
    ephemeral: bool,
) -> Result<(), crate::BotError> {
    let msg = CreateInteractionResponseMessage::new()
        .content(content)
        .ephemeral(ephemeral);
    let response = CreateInteractionResponse::Message(msg);
    cmd.create_response(&ctx.http, response)
        .await
        .map_err(|e| crate::BotError::Serenity(e.to_string()))
}

async fn defer(ctx: &Context, cmd: &CommandInteraction, ephemeral: bool) -> Result<(), crate::BotError> {
    if ephemeral {
        cmd.defer_ephemeral(&ctx.http).await
    } else {
        cmd.defer(&ctx.http).await
    }
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

// ---------------------------------------------------------------------------
// /play
// ---------------------------------------------------------------------------

async fn handle_play(
    ctx: &Context,
    cmd: &CommandInteraction,
    state: &Arc<BotState>,
    is_history: bool,
) -> Result<(), crate::BotError> {
    ensure_voice(ctx, cmd, state).await?;
    defer(ctx, cmd, is_history).await?;

    // Post-defer errors are handled via edit_response, not returned as BotError
    if let Err(e) = handle_play_inner(ctx, cmd, state).await {
        let _ = cmd
            .edit_response(
                &ctx.http,
                serenity::all::EditInteractionResponse::new()
                    .content(format!("Error: {e}")),
            )
            .await;
    }
    Ok(())
}

async fn handle_play_inner(
    ctx: &Context,
    cmd: &CommandInteraction,
    state: &Arc<BotState>,
) -> Result<(), crate::BotError> {
    let query = get_string_option(cmd, "query").unwrap_or_default();
    let user_info = user_info_from(&cmd.user);

    let is_url = query.starts_with("http://") || query.starts_with("https://");

    if is_url {
        // URL path: download and auto-play/enqueue
        let (file_path, meta) = state
            .ytdlp
            .download(&query)
            .await
            .map_err(crate::BotError::Media)?;

        let track_id = sha_id(&meta.source_url);
        let file_path_str = file_path.to_string_lossy().to_string();

        // Download thumbnail
        if let Some(ref thumb_url) = meta.thumbnail_url {
            let thumb_path =
                std::path::Path::new("media/thumbnails").join(format!("{track_id}.jpg"));
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
            id: track_id.clone(),
            title: meta.title.clone(),
            artist: meta.artist.clone(),
            duration_ms: meta.duration_ms,
            thumbnail_url: meta.thumbnail_url.clone(),
            source_url: meta.source_url.clone(),
            source_type: "youtube".to_string(),
            file_path: Some(file_path_str),
            youtube_id: meta.youtube_id,
            volume: track_volume,
        };

        let action = state
            .player
            .play_or_enqueue(track_info, user_info)
            .await
            .map_err(crate::BotError::Player)?;
        let content = play_action_message(action, &meta.title, &meta.source_url);

        cmd.edit_response(
            &ctx.http,
            serenity::all::EditInteractionResponse::new()
                .content(&content)
                .components(vec![crate::embed::build_play_button(&track_id)]),
        )
        .await
        .map_err(|e| crate::BotError::Serenity(e.to_string()))?;
    } else {
        // Search path: show select menu with up to 5 results
        let youtube = state
            .youtube
            .read()
            .unwrap()
            .clone()
            .ok_or(crate::BotError::NoYouTubeKey)?;
        let results = youtube
            .search(&query, 5)
            .await
            .map_err(crate::BotError::Media)?;

        if results.is_empty() {
            return Err(crate::BotError::NoResults);
        }

        let select_data: Vec<(String, String, String, String)> = results
            .iter()
            .map(|r| {
                (
                    r.youtube_id.clone().unwrap_or_default(),
                    r.title.clone(),
                    r.artist.clone().unwrap_or_else(|| "Unknown".to_string()),
                    format_duration(r.duration_ms),
                )
            })
            .collect();

        cmd.edit_response(
            &ctx.http,
            serenity::all::EditInteractionResponse::new()
                .content("🔍 Select a track:")
                .components(vec![crate::embed::build_search_select(&select_data)]),
        )
        .await
        .map_err(|e| crate::BotError::Serenity(e.to_string()))?;
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// /pause, /resume, /skip
// ---------------------------------------------------------------------------

async fn handle_pause(
    ctx: &Context,
    cmd: &CommandInteraction,
    state: &Arc<BotState>,
    is_history: bool,
) -> Result<(), crate::BotError> {
    state
        .player
        .pause()
        .await
        .map_err(crate::BotError::Player)?;
    respond(ctx, cmd, "⏸️ Paused", is_history).await
}

async fn handle_resume(
    ctx: &Context,
    cmd: &CommandInteraction,
    state: &Arc<BotState>,
    is_history: bool,
) -> Result<(), crate::BotError> {
    state
        .player
        .resume()
        .await
        .map_err(crate::BotError::Player)?;
    respond(ctx, cmd, "▶️ Resumed", is_history).await
}

async fn handle_skip(
    ctx: &Context,
    cmd: &CommandInteraction,
    state: &Arc<BotState>,
    is_history: bool,
) -> Result<(), crate::BotError> {
    let next = state.player.skip().await.map_err(crate::BotError::Player)?;
    match next {
        Some(track) => respond(ctx, cmd, &format!("⏭️ Skipped → **{}**", track.title), is_history).await,
        None => respond(ctx, cmd, "⏭️ Skipped — queue empty", is_history).await,
    }
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// /now
// ---------------------------------------------------------------------------

fn make_title_link(title: &str, source_url: &str) -> String {
    if source_url.starts_with("https://www.youtube.com")
        || source_url.starts_with("https://youtube.com")
        || source_url.starts_with("https://soundcloud.com")
    {
        format!("[{title}]({source_url})")
    } else {
        format!("**{title}**")
    }
}

async fn handle_now(
    ctx: &Context,
    cmd: &CommandInteraction,
    state: &Arc<BotState>,
    is_history: bool,
) -> Result<(), crate::BotError> {
    let snapshot = state.player.get_state().await;
    match snapshot.state {
        azuki_player::PlayStateInfo::Playing { track, position_ms } => {
            let pos = format_duration(position_ms);
            let total = format_duration(track.duration_ms);
            let progress = if track.duration_ms > 0 {
                let pct = (position_ms as f64 / track.duration_ms as f64 * 20.0) as usize;
                "▓".repeat(pct) + &"░".repeat(20 - pct)
            } else {
                "░".repeat(20)
            };
            let title = make_title_link(&track.title, &track.source_url);
            respond(ctx, cmd, &format!("{title}\n{pos} {progress} {total}"), is_history).await
        }
        azuki_player::PlayStateInfo::Paused { track, position_ms } => {
            let pos = format_duration(position_ms);
            let total = format_duration(track.duration_ms);
            let title = make_title_link(&track.title, &track.source_url);
            respond(ctx, cmd, &format!("⏸️ {title} — paused at {pos}/{total}"), is_history).await
        }
        _ => respond(ctx, cmd, "Nothing playing", is_history).await,
    }
}

// ---------------------------------------------------------------------------
// /volume, /loop
// ---------------------------------------------------------------------------

async fn handle_volume(
    ctx: &Context,
    cmd: &CommandInteraction,
    state: &Arc<BotState>,
    is_history: bool,
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
    respond(ctx, cmd, &format!("🔊 Volume: {level}%"), is_history).await
}

async fn handle_loop(
    ctx: &Context,
    cmd: &CommandInteraction,
    state: &Arc<BotState>,
    is_history: bool,
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
    respond(ctx, cmd, emoji, is_history).await
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

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

fn build_track_info_from_db(track: &azuki_db::models::Track) -> TrackInfo {
    TrackInfo {
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
    }
}

/// 현재 채널이 기록채널인지 확인 (AtomicU64 캐시 사용)
fn is_history_channel(state: &BotState, channel_id: u64) -> bool {
    let hc = state.history_channel_id.load(Ordering::Relaxed);
    hc != 0 && hc == channel_id
}

/// smart play 결과를 메시지로 변환
fn play_action_message(action: PlayAction, title: &str, url: &str) -> String {
    match action {
        PlayAction::PlayedNow => format!("[{}]({})\n재생 시작", title, url),
        PlayAction::Enqueued => format!("[{}]({})\n대기열에 추가됨", title, url),
    }
}

/// PlayerError → 한국어 메시지
fn player_error_message(err: &PlayerError) -> &'static str {
    match err {
        PlayerError::NoTrack => "재생 중인 곡이 없습니다",
        PlayerError::InvalidState(_) => "현재 상태에서 실행할 수 없습니다",
        PlayerError::InvalidPosition => "잘못된 위치입니다",
        PlayerError::QueueFull => "대기열이 가득 찼습니다",
        PlayerError::Duplicate => "이미 대기열에 있는 곡입니다",
        PlayerError::PlaylistQueueReadOnly => "플레이리스트 대기열에는 곡을 추가할 수 없습니다",
        PlayerError::SlotLimitReached => "대기열 슬롯이 가득 찼습니다 (최대 4개)",
    }
}

// ---------------------------------------------------------------------------
// Component interaction handlers
// ---------------------------------------------------------------------------

/// Unified smart play button handler (pn:/eq:/play: prefixes)
pub async fn handle_smart_play_button(
    ctx: &Context,
    component: &ComponentInteraction,
    state: &Arc<BotState>,
    track_id: &str,
) {
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
    let track_info = build_track_info_from_db(&track);
    let has_file = track
        .file_path
        .as_ref()
        .is_some_and(|fp| std::path::Path::new(fp).exists());

    if !has_file {
        let _ = component
            .create_response(
                &ctx.http,
                CreateInteractionResponse::Message(
                    CreateInteractionResponseMessage::new().content(format!(
                        "🔄 **{}** 다시 다운로드합니다...",
                        track_info.title
                    )),
                ),
            )
            .await;

        let ytdlp = state.ytdlp.clone();
        let player = state.player.clone();
        let db = state.db.clone();
        let source_url = track.source_url.clone();

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
                    let _ = player.play_or_enqueue(ti, ui).await;
                }
                Err(e) => tracing::error!("re-download failed: {e}"),
            }
        });
        return;
    }

    // File exists: atomic play_or_enqueue
    let action = state.player.play_or_enqueue(track_info.clone(), ui).await;
    let in_history = is_history_channel(state, component.channel_id.get());

    match action {
        Ok(act) if in_history => {
            let msg = match act {
                PlayAction::PlayedNow => "재생 시작",
                PlayAction::Enqueued => "대기열에 추가됨",
            };
            let _ = component
                .create_response(
                    &ctx.http,
                    CreateInteractionResponse::Message(
                        CreateInteractionResponseMessage::new()
                            .content(msg)
                            .ephemeral(true),
                    ),
                )
                .await;
        }
        Ok(act) => {
            let _ = component
                .create_response(
                    &ctx.http,
                    CreateInteractionResponse::Message(
                        CreateInteractionResponseMessage::new()
                            .content(play_action_message(
                                act,
                                &track_info.title,
                                &track_info.source_url,
                            ))
                            .components(vec![crate::embed::build_play_button(&track_info.id)]),
                    ),
                )
                .await;
            // Delete the original message (bot's own message with play button)
            if let Err(e) = component.message.delete(&ctx.http).await {
                tracing::debug!("failed to delete original message: {e}");
            }
        }
        Err(e) => {
            tracing::warn!("play error: {e}");
            let _ = component
                .create_response(
                    &ctx.http,
                    CreateInteractionResponse::Message(
                        CreateInteractionResponseMessage::new()
                            .content(player_error_message(&e))
                            .ephemeral(true),
                    ),
                )
                .await;
        }
    }
}

/// Search select menu handler (ss:search)
pub async fn handle_search_select(
    ctx: &Context,
    component: &ComponentInteraction,
    state: &Arc<BotState>,
) {
    let youtube_id = match &component.data.kind {
        ComponentInteractionDataKind::StringSelect { values } => {
            values.first().cloned().unwrap_or_default()
        }
        _ => return,
    };

    if youtube_id.is_empty() {
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
        if component
            .create_response(
                &ctx.http,
                CreateInteractionResponse::Message(
                    CreateInteractionResponseMessage::new()
                        .content("음성 채널에 먼저 접속해주세요")
                        .ephemeral(true),
                ),
            )
            .await
            .is_ok()
        {
            let _ = component.message.delete(&ctx.http).await;
        }
        return;
    }

    // Pre-check: compute track_id from URL and check for duplicates before downloading
    let url = format!("https://www.youtube.com/watch?v={youtube_id}");
    let track_id = sha_id(&url);

    let snapshot = state.player.get_state().await;
    let now_playing_id = match &snapshot.state {
        azuki_player::PlayStateInfo::Playing { track, .. }
        | azuki_player::PlayStateInfo::Paused { track, .. } => Some(track.id.as_str()),
        _ => None,
    };
    let in_queue = snapshot.queue.iter().any(|e| e.track.id == track_id);
    if now_playing_id == Some(&track_id) || in_queue {
        if component
            .create_response(
                &ctx.http,
                CreateInteractionResponse::Message(
                    CreateInteractionResponseMessage::new()
                        .content(player_error_message(&PlayerError::Duplicate))
                        .ephemeral(true),
                ),
            )
            .await
            .is_ok()
        {
            let _ = component.message.delete(&ctx.http).await;
        }
        return;
    }

    // Check if file already exists in DB — skip download if so
    if let Ok(existing) = azuki_db::queries::tracks::get_track(&state.db, &track_id).await
        && existing
            .file_path
            .as_ref()
            .is_some_and(|fp| std::path::Path::new(fp).exists())
    {
        // Defer + replace select menu
        let _ = component.defer(&ctx.http).await;
        let track_info = build_track_info_from_db(&existing);
        let ui = user_info_from(&component.user);
        let action = state.player.play_or_enqueue(track_info, ui).await;

        match action {
            Ok(act) => {
                let content = play_action_message(act, &existing.title, &existing.source_url);
                let _ = component
                    .edit_response(
                        &ctx.http,
                        serenity::all::EditInteractionResponse::new()
                            .content(&content)
                            .components(vec![crate::embed::build_play_button(&track_id)]),
                    )
                    .await;
            }
            Err(e) => {
                let _ = component.delete_response(&ctx.http).await;
                let _ = component
                    .create_followup(
                        &ctx.http,
                        CreateInteractionResponseFollowup::new()
                            .content(player_error_message(&e))
                            .ephemeral(true),
                    )
                    .await;
            }
        }
        return;
    }

    // Defer (update type so we can edit the original message)
    let _ = component.defer(&ctx.http).await;

    // Immediately replace select menu with loading indicator
    let _ = component
        .edit_response(
            &ctx.http,
            serenity::all::EditInteractionResponse::new()
                .content("재생하는 중...")
                .components(vec![]),
        )
        .await;

    // Download
    let (file_path, meta) = match state.ytdlp.download(&url).await {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("search select download failed: {e}");
            let _ = component.delete_response(&ctx.http).await;
            let _ = component
                .create_followup(
                    &ctx.http,
                    CreateInteractionResponseFollowup::new()
                        .content(format!("다운로드 실패: {e}"))
                        .ephemeral(true),
                )
                .await;
            return;
        }
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
        id: track_id.clone(),
        title: meta.title.clone(),
        artist: meta.artist.clone(),
        duration_ms: meta.duration_ms,
        thumbnail_url: meta.thumbnail_url.clone(),
        source_url: meta.source_url.clone(),
        source_type: "youtube".to_string(),
        file_path: Some(file_path_str),
        youtube_id: meta.youtube_id,
        volume: track_volume,
    };

    let ui = user_info_from(&component.user);
    let action = state.player.play_or_enqueue(track_info, ui).await;

    match action {
        Ok(act) => {
            let content = play_action_message(act, &meta.title, &meta.source_url);
            let _ = component
                .edit_response(
                    &ctx.http,
                    serenity::all::EditInteractionResponse::new()
                        .content(&content)
                        .components(vec![crate::embed::build_play_button(&track_id)]),
                )
                .await;
        }
        Err(e) => {
            let _ = component.delete_response(&ctx.http).await;
            let _ = component
                .create_followup(
                    &ctx.http,
                    CreateInteractionResponseFollowup::new()
                        .content(player_error_message(&e))
                        .ephemeral(true),
                )
                .await;
        }
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

                let _ = player.play_or_enqueue(track_info, ui).await;
            }
            Err(e) => {
                tracing::error!("legacy play download failed: {e}");
            }
        }
    });
}
