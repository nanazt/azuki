use std::sync::atomic::{AtomicI64, Ordering};

use axum::Json;
use axum::extract::State;
use axum_extra::extract::CookieJar;

use crate::auth::extract_admin_id;
use crate::{ApiError, WebState};

static LAST_UPDATE: AtomicI64 = AtomicI64::new(0);
const UPDATE_COOLDOWN_SECS: i64 = 300;

pub async fn ytdlp_info(
    jar: CookieJar,
    State(state): State<WebState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    extract_admin_id(&jar, &state).await?;

    let current_version = state.ytdlp.version().await.ok();
    let managed = state.ytdlp.is_managed();

    Ok(Json(serde_json::json!({
        "current_version": current_version,
        "managed": managed,
    })))
}

pub async fn ytdlp_check(
    jar: CookieJar,
    State(state): State<WebState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    extract_admin_id(&jar, &state).await?;

    let release = azuki_media::ytdlp_updater::get_latest_release()
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    let current = state.ytdlp.version().await.ok();
    let update_available = current.as_ref().is_none_or(|v| release.version != *v);

    Ok(Json(serde_json::json!({
        "latest_version": release.version,
        "update_available": update_available,
    })))
}

pub async fn ytdlp_update(
    jar: CookieJar,
    State(state): State<WebState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    extract_admin_id(&jar, &state).await?;

    let now = chrono::Utc::now().timestamp();
    let last = LAST_UPDATE.load(Ordering::Relaxed);
    if now - last < UPDATE_COOLDOWN_SECS {
        let remaining = UPDATE_COOLDOWN_SECS - (now - last);
        return Err(ApiError::BadRequest(format!(
            "update cooldown: try again in {remaining}s"
        )));
    }

    let release = azuki_media::ytdlp_updater::get_latest_release()
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    state
        .ytdlp
        .update(&release)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    LAST_UPDATE.store(now, Ordering::Relaxed);

    let version = state.ytdlp.version().await.ok();

    Ok(Json(serde_json::json!({
        "version": version,
        "success": true,
    })))
}

pub async fn youtube_info(
    jar: CookieJar,
    State(state): State<WebState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    extract_admin_id(&jar, &state).await?;

    let (has_key, key_masked) = match state.youtube.read().unwrap().as_ref() {
        Some(yt) => (true, Some(yt.api_key_masked())),
        None => (false, None),
    };

    Ok(Json(serde_json::json!({
        "has_key": has_key,
        "key_masked": key_masked,
    })))
}

#[derive(serde::Deserialize)]
pub struct YouTubeKeyRequest {
    api_key: String,
}

pub async fn youtube_set_key(
    jar: CookieJar,
    State(state): State<WebState>,
    Json(body): Json<YouTubeKeyRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let user_id = extract_admin_id(&jar, &state).await?;

    if body.api_key.is_empty() {
        return Err(ApiError::BadRequest("API key cannot be empty".to_string()));
    }

    tracing::info!("youtube api key updated by user {user_id}");

    azuki_db::config::save_config(&state.db, &[("youtube_api_key", &body.api_key)])
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    // Hot-swap the YouTube client without restart
    let new_client = std::sync::Arc::new(azuki_media::YouTubeClient::new(body.api_key));
    *state.youtube.write().unwrap() = Some(new_client);

    Ok(Json(serde_json::json!({
        "success": true,
        "restart_required": false,
    })))
}

pub async fn voice_channel_get(
    jar: CookieJar,
    State(state): State<WebState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    extract_admin_id(&jar, &state).await?;

    let default_id = azuki_db::config::get_config(&state.db, "default_voice_channel_id")
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    let channels: Vec<serde_json::Value> = state
        .voice_channels
        .read()
        .unwrap()
        .iter()
        .map(|(id, name)| serde_json::json!({ "id": id.to_string(), "name": name }))
        .collect();

    Ok(Json(serde_json::json!({
        "default_channel_id": default_id,
        "channels": channels,
    })))
}

#[derive(serde::Deserialize)]
pub struct VoiceChannelRequest {
    channel_id: String,
}

pub async fn voice_channel_set(
    jar: CookieJar,
    State(state): State<WebState>,
    Json(body): Json<VoiceChannelRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    extract_admin_id(&jar, &state).await?;

    azuki_db::config::save_config(&state.db, &[("default_voice_channel_id", &body.channel_id)])
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    Ok(Json(serde_json::json!({ "success": true })))
}

pub async fn history_channel_get(
    jar: CookieJar,
    State(state): State<WebState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    extract_admin_id(&jar, &state).await?;

    let channel_id = azuki_db::config::get_config(&state.db, "history_channel_id")
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    let channels: Vec<serde_json::Value> = state
        .text_channels
        .read()
        .unwrap()
        .iter()
        .map(|(id, name)| serde_json::json!({ "id": id.to_string(), "name": name }))
        .collect();

    Ok(Json(serde_json::json!({
        "history_channel_id": channel_id,
        "channels": channels,
    })))
}

#[derive(serde::Deserialize)]
pub struct HistoryChannelRequest {
    channel_id: String,
}

pub async fn history_channel_set(
    jar: CookieJar,
    State(state): State<WebState>,
    Json(body): Json<HistoryChannelRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    extract_admin_id(&jar, &state).await?;

    // Validate: must be empty (to clear) or a numeric snowflake
    if !body.channel_id.is_empty() && body.channel_id.parse::<u64>().is_err() {
        return Err(ApiError::BadRequest(
            "channel_id must be a numeric Discord snowflake".to_string(),
        ));
    }

    azuki_db::config::save_config(&state.db, &[("history_channel_id", &body.channel_id)])
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    // Update in-memory cache
    let new_id = body.channel_id.parse::<u64>().unwrap_or(0);
    state
        .history_channel_id
        .store(new_id, std::sync::atomic::Ordering::Relaxed);

    Ok(Json(serde_json::json!({ "success": true })))
}

pub async fn web_base_url_get(
    jar: CookieJar,
    State(state): State<WebState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    extract_admin_id(&jar, &state).await?;

    let web_base_url = azuki_db::config::get_config(&state.db, "web_base_url")
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    Ok(Json(serde_json::json!({
        "web_base_url": web_base_url,
    })))
}

#[derive(serde::Deserialize)]
pub struct WebBaseUrlRequest {
    url: String,
}

pub async fn web_base_url_set(
    jar: CookieJar,
    State(state): State<WebState>,
    Json(body): Json<WebBaseUrlRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    extract_admin_id(&jar, &state).await?;

    if !body.url.is_empty() {
        let parsed = url::Url::parse(&body.url)
            .map_err(|_| ApiError::BadRequest("invalid URL format".to_string()))?;
        match parsed.scheme() {
            "http" | "https" => {}
            _ => {
                return Err(ApiError::BadRequest(
                    "URL must use http or https scheme".to_string(),
                ));
            }
        }
    }

    azuki_db::config::save_config(&state.db, &[("web_base_url", &body.url)])
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    Ok(Json(serde_json::json!({ "success": true })))
}

pub async fn timezone_get(
    jar: CookieJar,
    State(state): State<WebState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    extract_admin_id(&jar, &state).await?;

    let timezone = azuki_db::config::get_config(&state.db, "timezone")
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?
        .unwrap_or_else(|| "UTC".to_string());

    Ok(Json(serde_json::json!({ "timezone": timezone })))
}

#[derive(serde::Deserialize)]
pub struct TimezoneRequest {
    timezone: String,
}

pub async fn timezone_set(
    jar: CookieJar,
    State(state): State<WebState>,
    Json(body): Json<TimezoneRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    extract_admin_id(&jar, &state).await?;

    // Validate IANA timezone name
    body.timezone
        .parse::<chrono_tz::Tz>()
        .map_err(|_| ApiError::BadRequest(format!("invalid timezone: {}", body.timezone)))?;

    azuki_db::config::save_config(&state.db, &[("timezone", &body.timezone)])
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    Ok(Json(serde_json::json!({ "success": true })))
}

pub fn admin_routes() -> axum::Router<WebState> {
    axum::Router::new()
        .route("/api/admin/ytdlp", axum::routing::get(ytdlp_info))
        .route("/api/admin/ytdlp/check", axum::routing::post(ytdlp_check))
        .route("/api/admin/ytdlp/update", axum::routing::post(ytdlp_update))
        .route(
            "/api/admin/youtube",
            axum::routing::get(youtube_info).post(youtube_set_key),
        )
        .route(
            "/api/admin/voice-channel",
            axum::routing::get(voice_channel_get).put(voice_channel_set),
        )
        .route(
            "/api/admin/history-channel",
            axum::routing::get(history_channel_get).put(history_channel_set),
        )
        .route(
            "/api/admin/web-base-url",
            axum::routing::get(web_base_url_get).put(web_base_url_set),
        )
        .route(
            "/api/admin/timezone",
            axum::routing::get(timezone_get).put(timezone_set),
        )
}
