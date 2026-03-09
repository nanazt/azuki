use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use axum_extra::extract::CookieJar;
use serde::Deserialize;

use azuki_player::LoopMode;

use crate::auth::{extract_admin_id, extract_user_id};
use crate::{ApiError, WebState};

#[derive(Deserialize)]
pub struct SeekRequest {
    pub position_ms: u64,
}

#[derive(Deserialize)]
pub struct VolumeRequest {
    pub volume: u8,
}

#[derive(Deserialize)]
pub struct LoopRequest {
    pub mode: String,
}

#[derive(Deserialize)]
pub struct QueueAddRequest {
    pub query_or_url: String,
}

#[derive(Deserialize)]
pub struct MoveRequest {
    pub from: usize,
    pub to: usize,
}

pub async fn pause(jar: CookieJar, State(state): State<WebState>) -> Result<StatusCode, ApiError> {
    extract_user_id(&jar, &state).await?;
    state.player.pause().await?;
    Ok(StatusCode::OK)
}

pub async fn resume(jar: CookieJar, State(state): State<WebState>) -> Result<StatusCode, ApiError> {
    extract_user_id(&jar, &state).await?;
    state.player.resume().await?;
    Ok(StatusCode::OK)
}

pub async fn skip(jar: CookieJar, State(state): State<WebState>) -> Result<StatusCode, ApiError> {
    extract_user_id(&jar, &state).await?;
    state.player.skip().await?;
    Ok(StatusCode::OK)
}

pub async fn previous(
    jar: CookieJar,
    State(state): State<WebState>,
) -> Result<StatusCode, ApiError> {
    extract_user_id(&jar, &state).await?;
    state.player.previous().await?;
    Ok(StatusCode::OK)
}

pub async fn seek(
    jar: CookieJar,
    State(state): State<WebState>,
    Json(body): Json<SeekRequest>,
) -> Result<StatusCode, ApiError> {
    extract_user_id(&jar, &state).await?;
    state.player.seek(body.position_ms).await?;
    Ok(StatusCode::OK)
}

pub async fn volume(
    jar: CookieJar,
    State(state): State<WebState>,
    Json(body): Json<VolumeRequest>,
) -> Result<StatusCode, ApiError> {
    extract_user_id(&jar, &state).await?;
    if body.volume > 100 {
        return Err(ApiError::BadRequest("volume must be 0-100".into()));
    }
    state.player.set_volume(body.volume).await?;
    let snapshot = state.player.get_state().await;
    if let azuki_player::PlayStateInfo::Playing { ref track, .. }
    | azuki_player::PlayStateInfo::Paused { ref track, .. } = snapshot.state
    {
        azuki_db::queries::tracks::update_track_volume(&state.db, &track.id, body.volume as i64)
            .await
            .ok();
    }
    Ok(StatusCode::OK)
}

pub async fn set_loop(
    jar: CookieJar,
    State(state): State<WebState>,
    Json(body): Json<LoopRequest>,
) -> Result<StatusCode, ApiError> {
    extract_user_id(&jar, &state).await?;
    let mode = match body.mode.as_str() {
        "one" => LoopMode::One,
        "all" => LoopMode::All,
        _ => LoopMode::Off,
    };
    state.player.set_loop(mode).await?;
    Ok(StatusCode::OK)
}

pub async fn get_queue(
    jar: CookieJar,
    State(state): State<WebState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    extract_user_id(&jar, &state).await?;
    let snapshot = state.player.get_state().await;
    Ok(Json(serde_json::json!({
        "state": snapshot.state,
        "queue": snapshot.queue,
        "volume": snapshot.volume,
        "loop_mode": snapshot.loop_mode,
    })))
}

#[derive(Deserialize)]
pub struct AddTrackRequest {
    pub track_id: String,
}

pub async fn queue_add_track(
    jar: CookieJar,
    State(state): State<WebState>,
    Json(body): Json<AddTrackRequest>,
) -> Result<StatusCode, ApiError> {
    let user_id = extract_user_id(&jar, &state).await?;

    let track = azuki_db::queries::tracks::get_track(&state.db, &body.track_id)
        .await
        .map_err(|_| ApiError::NotFound("track not found".to_string()))?;

    let file_path = track
        .file_path
        .ok_or_else(|| ApiError::BadRequest("track has no file".into()))?;

    // Resolve through media store if relative, otherwise check directly
    let exists = state
        .media_store
        .resolve_path(&file_path)
        .map(|p| p.exists())
        .unwrap_or_else(|_| std::path::Path::new(&file_path).exists());

    if !exists {
        return Err(ApiError::BadRequest("track file not found on disk".into()));
    }

    let user = azuki_db::queries::users::get_user(&state.db, &user_id)
        .await
        .map_err(ApiError::Db)?;

    let track_info = azuki_player::TrackInfo {
        id: track.id,
        title: track.title,
        artist: track.artist,
        duration_ms: track.duration_ms as u64,
        thumbnail_url: track.thumbnail_url,
        source_url: track.source_url,
        source_type: track.source_type,
        file_path: Some(file_path),
        youtube_id: track.youtube_id,
        volume: track.volume as u8,
    };

    let user_info = azuki_player::UserInfo {
        id: user.id,
        username: user.username,
        avatar_url: user.avatar_url,
    };

    state.player.play_or_enqueue(track_info, user_info).await?;

    Ok(StatusCode::NO_CONTENT)
}

pub async fn queue_add(
    jar: CookieJar,
    State(state): State<WebState>,
    Json(body): Json<QueueAddRequest>,
) -> Result<(StatusCode, Json<serde_json::Value>), ApiError> {
    let user_id = extract_user_id(&jar, &state).await?;

    // Block playlist URLs — use /api/playlists/import instead
    let detected = azuki_media::detect_url(&body.query_or_url);
    if matches!(
        detected,
        azuki_media::DetectedUrl::YoutubePlaylist { .. }
            | azuki_media::DetectedUrl::SoundcloudPlaylist { .. }
    ) {
        return Err(ApiError::BadRequest(
            "Playlist URLs cannot be added to queue. Use playlist import instead.".to_string(),
        ));
    }

    let download_id = uuid::Uuid::new_v4().to_string();

    // Check for duplicate active downloads by URL hash
    let url_hash = crate::util::sha_id(&body.query_or_url);
    for entry in state.active_downloads.iter() {
        let existing_hash = crate::util::sha_id(&entry.value().query);
        if existing_hash == url_hash {
            return Ok((
                StatusCode::ACCEPTED,
                Json(serde_json::json!({
                    "download_id": entry.value().download_id,
                    "status": "already_downloading",
                })),
            ));
        }
    }

    let user = azuki_db::queries::users::get_user(&state.db, &user_id)
        .await
        .map_err(ApiError::Db)?;
    let user_info = azuki_player::UserInfo {
        id: user.id,
        username: user.username,
        avatar_url: user.avatar_url,
    };

    let request = crate::DownloadRequest {
        query_or_url: body.query_or_url,
        user_info,
        download_id: download_id.clone(),
    };

    match state.download_tx.try_send(request) {
        Ok(_) => Ok((
            StatusCode::ACCEPTED,
            Json(serde_json::json!({
                "download_id": download_id,
            })),
        )),
        Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => Err(ApiError::BadRequest(
            "too many downloads queued, try again later".into(),
        )),
        Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
            Err(ApiError::Internal("download service unavailable".into()))
        }
    }
}

pub async fn queue_remove(
    jar: CookieJar,
    State(state): State<WebState>,
    axum::extract::Path(position): axum::extract::Path<usize>,
) -> Result<StatusCode, ApiError> {
    extract_user_id(&jar, &state).await?;
    state.player.remove(position).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn queue_play_at(
    jar: CookieJar,
    State(state): State<WebState>,
    axum::extract::Path(position): axum::extract::Path<usize>,
) -> Result<StatusCode, ApiError> {
    extract_user_id(&jar, &state).await?;
    state.player.play_at(position).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn queue_move(
    jar: CookieJar,
    State(state): State<WebState>,
    Json(body): Json<MoveRequest>,
) -> Result<StatusCode, ApiError> {
    extract_user_id(&jar, &state).await?;
    state.player.move_in_queue(body.from, body.to).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(serde::Serialize)]
pub struct BotSettingsResponse {
    pub default_volume: i64,
}

#[derive(serde::Deserialize)]
pub struct UpdateBotSettings {
    pub default_volume: Option<i64>,
}

pub async fn get_bot_settings(
    jar: CookieJar,
    State(state): State<WebState>,
) -> Result<Json<BotSettingsResponse>, ApiError> {
    extract_user_id(&jar, &state).await?;
    let vol = azuki_db::config::get_config(&state.db, "default_volume")
        .await
        .map_err(ApiError::Db)?
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(5);
    Ok(Json(BotSettingsResponse {
        default_volume: vol,
    }))
}

pub async fn update_bot_settings(
    jar: CookieJar,
    State(state): State<WebState>,
    Json(body): Json<UpdateBotSettings>,
) -> Result<Json<BotSettingsResponse>, ApiError> {
    extract_admin_id(&jar, &state).await?;
    if let Some(vol) = body.default_volume {
        if !(0..=100).contains(&vol) {
            return Err(ApiError::BadRequest("default_volume must be 0-100".into()));
        }
        azuki_db::config::save_config(&state.db, &[("default_volume", &vol.to_string())])
            .await
            .map_err(ApiError::Db)?;
    }
    let vol = azuki_db::config::get_config(&state.db, "default_volume")
        .await
        .map_err(ApiError::Db)?
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(5);
    Ok(Json(BotSettingsResponse {
        default_volume: vol,
    }))
}

pub fn player_routes() -> axum::Router<WebState> {
    axum::Router::new()
        .route("/api/player/pause", axum::routing::post(pause))
        .route("/api/player/resume", axum::routing::post(resume))
        .route("/api/player/skip", axum::routing::post(skip))
        .route("/api/player/previous", axum::routing::post(previous))
        .route("/api/player/seek", axum::routing::post(seek))
        .route("/api/player/volume", axum::routing::post(volume))
        .route("/api/player/loop", axum::routing::post(set_loop))
        .route("/api/queue", axum::routing::get(get_queue))
        .route("/api/queue/add", axum::routing::post(queue_add))
        .route("/api/queue/add-track", axum::routing::post(queue_add_track))
        .route("/api/queue/move", axum::routing::put(queue_move))
        .route("/api/queue/{position}", axum::routing::delete(queue_remove))
        .route("/api/queue/{position}/play", axum::routing::post(queue_play_at))
        .route(
            "/api/settings/bot",
            axum::routing::get(get_bot_settings).put(update_bot_settings),
        )
}
