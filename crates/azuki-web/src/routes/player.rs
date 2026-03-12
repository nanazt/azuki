use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use axum_extra::extract::CookieJar;
use serde::Deserialize;

use azuki_media::{DetectedUrl, detect_url};
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
    pub track_id: Option<String>,
    pub query_or_url: Option<String>,
}

#[derive(Deserialize)]
pub struct MoveRequest {
    pub from: usize,
    pub to: usize,
}

pub async fn pause(jar: CookieJar, State(state): State<WebState>) -> Result<StatusCode, ApiError> {
    extract_user_id(&jar, &state).await?;
    state.player.pause().await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn resume(jar: CookieJar, State(state): State<WebState>) -> Result<StatusCode, ApiError> {
    extract_user_id(&jar, &state).await?;
    state.player.resume().await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn skip(jar: CookieJar, State(state): State<WebState>) -> Result<StatusCode, ApiError> {
    extract_user_id(&jar, &state).await?;
    state.player.skip().await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn previous(
    jar: CookieJar,
    State(state): State<WebState>,
) -> Result<StatusCode, ApiError> {
    extract_user_id(&jar, &state).await?;
    state.player.previous().await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn seek(
    jar: CookieJar,
    State(state): State<WebState>,
    Json(body): Json<SeekRequest>,
) -> Result<StatusCode, ApiError> {
    extract_user_id(&jar, &state).await?;
    state.player.seek(body.position_ms).await?;
    Ok(StatusCode::NO_CONTENT)
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
    Ok(StatusCode::NO_CONTENT)
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
    Ok(StatusCode::NO_CONTENT)
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

/// Known tracking query parameters to strip from resolved SoundCloud URLs.
const TRACKING_PARAMS: &[&str] = &[
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_content",
    "utm_term",
    "si",
    "ref",
];

/// Resolve SoundCloud shortened URLs (on.soundcloud.com) to canonical form.
/// Returns the original URL unchanged if not a shortened URL or if resolution fails.
async fn resolve_soundcloud_short_url(url: &str) -> String {
    let Ok(parsed) = url::Url::parse(url) else {
        return url.to_string();
    };
    if parsed.host_str() != Some("on.soundcloud.com") {
        return url.to_string();
    }

    static SC_CLIENT: std::sync::LazyLock<reqwest::Client> = std::sync::LazyLock::new(|| {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::limited(5))
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .expect("failed to build SC redirect client")
    });

    let Ok(resp) = SC_CLIENT.get(url).send().await else {
        return url.to_string();
    };

    let final_url = resp.url().clone();
    let mut cleaned = final_url.clone();
    let retained: Vec<(String, String)> = final_url
        .query_pairs()
        .filter(|(k, _)| !TRACKING_PARAMS.contains(&k.as_ref()))
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    if retained.is_empty() {
        cleaned.set_query(None);
    } else {
        cleaned.query_pairs_mut().clear().extend_pairs(&retained);
    }
    cleaned.to_string()
}

pub async fn queue_add(
    jar: CookieJar,
    State(state): State<WebState>,
    Json(body): Json<QueueAddRequest>,
) -> Result<(StatusCode, Json<serde_json::Value>), ApiError> {
    let user_id = extract_user_id(&jar, &state).await?;

    match (body.track_id, body.query_or_url) {
        (Some(_), Some(_)) | (None, None) => Err(ApiError::BadRequest(
            "exactly one of track_id or query_or_url is required".into(),
        )),
        // track_id path: DB lookup → file check → duplicate check → enqueue
        (Some(tid), None) => {
            let track = azuki_db::queries::tracks::get_track(&state.db, &tid)
                .await
                .map_err(|_| ApiError::NotFound("track not found".to_string()))?;

            let file_path = track
                .file_path
                .ok_or_else(|| ApiError::BadRequest("track has no file".into()))?;

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
            Ok((StatusCode::NO_CONTENT, Json(serde_json::json!(null))))
        }
        // query_or_url path: URL detection → cache/download
        (None, Some(query_or_url)) => {
            let download_id = uuid::Uuid::new_v4().to_string();

            // Check for duplicate active downloads by URL hash
            let url_hash = crate::util::sha_id(&query_or_url);
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

            // Resolve SoundCloud shortened URLs before detection
            let resolved_url = resolve_soundcloud_short_url(&query_or_url).await;

            let canonical_url = match detect_url(&resolved_url) {
                DetectedUrl::YoutubeVideo { video_id } => {
                    Some(format!("https://www.youtube.com/watch?v={video_id}"))
                }
                DetectedUrl::SoundcloudTrack { url } => Some(url),
                _ => None,
            };

            if let Some(ref canonical) = canonical_url {
                let track_id = crate::util::sha_id(canonical);

                // Duplicate-in-queue check
                let snapshot = state.player.get_state().await;
                let now_playing_id = match &snapshot.state {
                    azuki_player::PlayStateInfo::Playing { track, .. }
                    | azuki_player::PlayStateInfo::Paused { track, .. } => Some(track.id.as_str()),
                    _ => None,
                };
                if now_playing_id == Some(&*track_id)
                    || snapshot.queue.iter().any(|e| e.track.id == track_id)
                {
                    return Err(ApiError::BadRequest("duplicate".into()));
                }

                // Cache fast-path: if track exists in DB with a valid file, enqueue immediately
                if let Ok(existing) =
                    azuki_db::queries::tracks::get_track(&state.db, &track_id).await
                    && let Some(ref fp) = existing.file_path
                    && state.media_store.file_exists(fp)
                {
                    let user = azuki_db::queries::users::get_user(&state.db, &user_id)
                        .await
                        .map_err(ApiError::Db)?;
                    let user_info = azuki_player::UserInfo {
                        id: user.id,
                        username: user.username,
                        avatar_url: user.avatar_url,
                    };
                    let track_info = azuki_player::TrackInfo {
                        id: existing.id,
                        title: existing.title,
                        artist: existing.artist,
                        duration_ms: existing.duration_ms as u64,
                        thumbnail_url: existing.thumbnail_url,
                        source_url: existing.source_url,
                        source_type: existing.source_type,
                        file_path: existing.file_path,
                        youtube_id: existing.youtube_id,
                        volume: existing.volume as u8,
                    };
                    state.player.play_or_enqueue(track_info, user_info).await?;
                    return Ok((StatusCode::NO_CONTENT, Json(serde_json::json!(null))));
                }
            }

            // Cache miss or search query — fall through to download worker
            let user = azuki_db::queries::users::get_user(&state.db, &user_id)
                .await
                .map_err(ApiError::Db)?;
            let user_info = azuki_player::UserInfo {
                id: user.id,
                username: user.username,
                avatar_url: user.avatar_url,
            };

            let request = crate::DownloadRequest {
                query_or_url: resolved_url,
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
        .route("/api/queue/move", axum::routing::put(queue_move))
        .route("/api/queue/{position}", axum::routing::delete(queue_remove))
        .route(
            "/api/queue/{position}/play",
            axum::routing::post(queue_play_at),
        )
        .route(
            "/api/settings/bot",
            axum::routing::get(get_bot_settings).put(update_bot_settings),
        )
}
