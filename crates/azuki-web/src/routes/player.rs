use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use axum_extra::extract::CookieJar;
use serde::Deserialize;

use azuki_player::LoopMode;

use crate::auth::extract_user_id;
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

pub async fn pause(
    jar: CookieJar,
    State(state): State<WebState>,
) -> Result<StatusCode, ApiError> {
    extract_user_id(&jar, &state).await?;
    state.player.pause().await?;
    Ok(StatusCode::OK)
}

pub async fn resume(
    jar: CookieJar,
    State(state): State<WebState>,
) -> Result<StatusCode, ApiError> {
    extract_user_id(&jar, &state).await?;
    state.player.resume().await?;
    Ok(StatusCode::OK)
}

pub async fn skip(
    jar: CookieJar,
    State(state): State<WebState>,
) -> Result<StatusCode, ApiError> {
    extract_user_id(&jar, &state).await?;
    state.player.skip().await?;
    Ok(StatusCode::OK)
}

pub async fn stop(
    jar: CookieJar,
    State(state): State<WebState>,
) -> Result<StatusCode, ApiError> {
    extract_user_id(&jar, &state).await?;
    state.player.stop().await?;
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
        azuki_db::queries::tracks::update_track_volume(&state.db, &track.id, body.volume as i64).await.ok();
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

pub async fn queue_add(
    jar: CookieJar,
    State(state): State<WebState>,
    Json(body): Json<QueueAddRequest>,
) -> Result<(StatusCode, Json<serde_json::Value>), ApiError> {
    let user_id = extract_user_id(&jar, &state).await?;

    let download_id = uuid::Uuid::new_v4().to_string();

    // Check for duplicate active downloads by URL hash
    let url_hash = crate::util::sha_id(&body.query_or_url);
    for entry in state.active_downloads.iter() {
        let existing_hash = crate::util::sha_id(&entry.value().query);
        if existing_hash == url_hash {
            return Ok((StatusCode::ACCEPTED, Json(serde_json::json!({
                "download_id": entry.value().download_id,
                "status": "already_downloading",
            }))));
        }
    }

    let request = crate::DownloadRequest {
        query_or_url: body.query_or_url,
        user_id,
        download_id: download_id.clone(),
    };

    match state.download_tx.try_send(request) {
        Ok(_) => Ok((StatusCode::ACCEPTED, Json(serde_json::json!({
            "download_id": download_id,
        })))),
        Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => {
            Err(ApiError::BadRequest("too many downloads queued, try again later".into()))
        }
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
    Ok(StatusCode::OK)
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
    let vol = azuki_db::config::get_config(&state.db, "default_volume").await
        .map_err(ApiError::Db)?
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(5);
    Ok(Json(BotSettingsResponse { default_volume: vol }))
}

pub async fn update_bot_settings(
    jar: CookieJar,
    State(state): State<WebState>,
    Json(body): Json<UpdateBotSettings>,
) -> Result<Json<BotSettingsResponse>, ApiError> {
    extract_user_id(&jar, &state).await?;
    if let Some(vol) = body.default_volume {
        if !(0..=100).contains(&vol) {
            return Err(ApiError::BadRequest("default_volume must be 0-100".into()));
        }
        azuki_db::config::save_config(&state.db, &[("default_volume", &vol.to_string())]).await
            .map_err(ApiError::Db)?;
    }
    let vol = azuki_db::config::get_config(&state.db, "default_volume").await
        .map_err(ApiError::Db)?
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(5);
    Ok(Json(BotSettingsResponse { default_volume: vol }))
}

pub fn player_routes() -> axum::Router<WebState> {
    axum::Router::new()
        .route("/api/player/pause", axum::routing::post(pause))
        .route("/api/player/resume", axum::routing::post(resume))
        .route("/api/player/skip", axum::routing::post(skip))
        .route("/api/player/stop", axum::routing::post(stop))
        .route("/api/player/seek", axum::routing::post(seek))
        .route("/api/player/volume", axum::routing::post(volume))
        .route("/api/player/loop", axum::routing::post(set_loop))
        .route("/api/queue", axum::routing::get(get_queue))
        .route("/api/queue/add", axum::routing::post(queue_add))
        .route("/api/queue/{position}", axum::routing::delete(queue_remove))
        .route("/api/settings/bot", axum::routing::get(get_bot_settings).put(update_bot_settings))
}
