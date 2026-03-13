use axum::Json;
use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::header;
use axum::response::IntoResponse;
use axum_extra::extract::CookieJar;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};
use tokio_util::io::ReaderStream;

use crate::auth::extract_user_id;
use crate::{ApiError, WebState};

#[derive(Deserialize)]
pub struct SearchQuery {
    pub q: String,
    pub source: Option<String>,
    pub cursor: Option<String>,
    pub limit: Option<i64>,
}

#[derive(Deserialize)]
pub struct CursorQuery {
    pub cursor: Option<String>,
    pub limit: Option<i64>,
}

pub fn decode_cursor<T: serde::de::DeserializeOwned>(cursor: &str) -> Result<T, ApiError> {
    if cursor.len() > 256 {
        return Err(ApiError::BadRequest("cursor too large".into()));
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(cursor)
        .map_err(|_| ApiError::BadRequest("invalid cursor".into()))?;
    serde_json::from_slice(&bytes).map_err(|_| ApiError::BadRequest("invalid cursor".into()))
}

pub fn encode_cursor<T: Serialize>(value: &T) -> String {
    let json = serde_json::to_vec(value).expect("cursor serialization");
    URL_SAFE_NO_PAD.encode(&json)
}

pub async fn search(
    jar: CookieJar,
    State(state): State<WebState>,
    Query(params): Query<SearchQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    extract_user_id(&jar, &state).await?;

    // Query length limit
    if params.q.len() > 200 {
        return Err(ApiError::BadRequest("query too long".into()));
    }

    let source = params.source.as_deref().unwrap_or("youtube");

    match source {
        "youtube" => {
            let limit = params.limit.unwrap_or(25).clamp(1, 50) as u32;
            let page_token = params.cursor.as_deref();

            let youtube = state.youtube.read().unwrap().clone().ok_or_else(|| {
                ApiError::BadRequest("YouTube API key not configured".to_string())
            })?;
            let (results, next_page_token) = youtube.search(&params.q, limit, page_token).await?;

            let items: Vec<serde_json::Value> = results
                .into_iter()
                .map(|m| {
                    serde_json::json!({
                        "id": m.youtube_id.as_deref().unwrap_or(""),
                        "title": m.title,
                        "artist": m.artist,
                        "duration_ms": m.duration_ms,
                        "thumbnail_url": m.thumbnail_url,
                        "source_url": m.source_url,
                        "youtube_id": m.youtube_id,
                    })
                })
                .collect();

            Ok(Json(serde_json::json!({
                "items": items,
                "next_cursor": next_page_token,
            })))
        }
        "history" => {
            let limit = params.limit.unwrap_or(20).clamp(1, 100);
            let cursor: Option<(String, String)> =
                params.cursor.as_deref().map(decode_cursor).transpose()?;

            let cursor_refs = cursor.as_ref().map(|(a, b)| (a.as_str(), b.as_str()));
            let mut tracks = azuki_db::queries::tracks::search_tracks_cursor(
                &state.db,
                &params.q,
                limit,
                cursor_refs,
            )
            .await?;

            let next_cursor = if tracks.len() as i64 > limit {
                tracks.pop();
                let last = tracks.last().unwrap();
                Some(encode_cursor(&(&last.created_at, &last.id)))
            } else {
                None
            };

            Ok(Json(serde_json::json!({
                "items": tracks,
                "next_cursor": next_cursor,
            })))
        }
        _ => Ok(Json(
            serde_json::json!({ "items": [], "next_cursor": null }),
        )),
    }
}

pub async fn history(
    jar: CookieJar,
    State(state): State<WebState>,
    Query(params): Query<CursorQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    extract_user_id(&jar, &state).await?;
    let limit = params.limit.unwrap_or(20).clamp(1, 100);

    let before_id: Option<i64> = params.cursor.as_deref().map(decode_cursor).transpose()?;

    let entries = azuki_db::queries::history::get_history(&state.db, limit, before_id).await?;

    let next_cursor = if entries.len() as i64 == limit {
        entries.last().map(|e| encode_cursor(&e.id))
    } else {
        None
    };

    let items: Vec<serde_json::Value> = entries
        .iter()
        .map(|e| {
            serde_json::json!({
                "track": {
                    "id": e.track_id,
                    "title": e.title,
                    "artist": e.artist,
                    "duration_ms": e.duration_ms,
                    "thumbnail_url": e.thumbnail_url,
                    "source_url": e.source_url,
                },
                "played_at": e.played_at,
                "user_id": e.user_id,
                "play_count": e.play_count,
            })
        })
        .collect();

    Ok(Json(serde_json::json!({
        "items": items,
        "next_cursor": next_cursor,
    })))
}

pub async fn upload(
    jar: CookieJar,
    State(state): State<WebState>,
    mut multipart: axum::extract::Multipart,
) -> Result<Json<serde_json::Value>, ApiError> {
    let user_id = extract_user_id(&jar, &state).await?;

    let mut file_data: Option<(String, axum::body::Bytes)> = None;
    let mut provided_title: Option<String> = None;
    let mut provided_artist: Option<String> = None;
    let mut field_count = 0u8;

    while let Some(field) = multipart.next_field().await.map_err(|e| {
        let msg = e.to_string();
        if msg.contains("limit") || msg.contains("body") {
            ApiError::BadRequest(format!(
                "File too large (max {}MB)",
                state.max_upload_size_mb
            ))
        } else {
            ApiError::BadRequest(msg)
        }
    })? {
        field_count += 1;
        if field_count > 5 {
            return Err(ApiError::BadRequest("too many fields".into()));
        }

        match field.name() {
            Some("file") => {
                let filename = field.file_name().unwrap_or("upload").to_string();
                let data = field.bytes().await.map_err(|e| {
                    let msg = e.to_string();
                    if msg.contains("limit") || msg.contains("body") {
                        ApiError::BadRequest(format!(
                            "File too large (max {}MB)",
                            state.max_upload_size_mb
                        ))
                    } else {
                        ApiError::BadRequest(msg)
                    }
                })?;
                file_data = Some((filename, data));
            }
            Some("title") => {
                let val = field
                    .text()
                    .await
                    .map_err(|e| ApiError::BadRequest(e.to_string()))?;
                let val = val.trim().to_string();
                if val.len() > 500 {
                    return Err(ApiError::BadRequest("title too long (max 500)".into()));
                }
                if !val.is_empty() {
                    provided_title = Some(val);
                }
            }
            Some("artist") => {
                let val = field
                    .text()
                    .await
                    .map_err(|e| ApiError::BadRequest(e.to_string()))?;
                let val = val.trim().to_string();
                if val.len() > 200 {
                    return Err(ApiError::BadRequest("artist too long (max 200)".into()));
                }
                if !val.is_empty() {
                    provided_artist = Some(val);
                }
            }
            _ => { /* ignore unknown fields */ }
        }
    }

    let (filename, data) =
        file_data.ok_or_else(|| ApiError::BadRequest("no file provided".into()))?;

    // Validate and hash (generates track_id without writing file yet)
    let (track_id, file_path) =
        azuki_media::upload::handle_upload(&state.media_store, &data, &filename).await?;

    // Check for duplicate
    if let Ok(existing) = azuki_db::queries::tracks::get_track(&state.db, &track_id).await {
        return Ok(Json(serde_json::json!({
            "track_id": existing.id,
            "filename": filename,
            "title": existing.title,
            "artist": existing.artist,
            "duration_ms": existing.duration_ms,
            "added_by": user_id,
            "duplicate": true,
        })));
    }

    let file_path_str = file_path.to_string_lossy().to_string();

    // Parse metadata (matroska for WebM, lofty for others, symphonia fallback)
    let parsed = azuki_media::parse_audio_metadata_from_file(&file_path)
        .await
        .ok();

    let title = provided_title
        .or_else(|| parsed.as_ref().and_then(|p| p.title.clone()))
        .unwrap_or_else(|| {
            // Strip extension from filename as fallback
            std::path::Path::new(&filename)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or(&filename)
                .to_string()
        });
    let artist = provided_artist.or_else(|| parsed.as_ref().and_then(|p| p.artist.clone()));
    let duration_ms = parsed.as_ref().map(|p| p.duration_ms as i64).unwrap_or(0);

    // Save embedded cover art as thumbnail before DB upsert
    let cover_art = parsed.as_ref().and_then(|p| p.cover_art.as_ref());
    let thumbnail_url = if let Some(bytes) = cover_art {
        match async {
            tokio::fs::create_dir_all("media/thumbnails").await?;
            tokio::fs::write(format!("media/thumbnails/{track_id}.jpg"), bytes).await
        }
        .await
        {
            Ok(()) => Some("local"),
            Err(e) => {
                tracing::warn!("failed to save cover art for {track_id}: {e}");
                None
            }
        }
    } else {
        None
    };

    // Sanitize source_url filename (remove control chars)
    let safe_filename: String = filename.chars().filter(|c| !c.is_control()).collect();

    azuki_db::queries::tracks::upsert_track(
        &state.db,
        &track_id,
        &title,
        artist.as_deref(),
        duration_ms,
        thumbnail_url,
        &format!("upload://{safe_filename}"),
        "upload",
        Some(&file_path_str),
        None,
        Some(&user_id),
    )
    .await?;

    Ok(Json(serde_json::json!({
        "track_id": track_id,
        "filename": filename,
        "title": title,
        "artist": artist,
        "duration_ms": duration_ms,
        "added_by": user_id,
        "duplicate": false,
    })))
}

pub async fn download(
    jar: CookieJar,
    State(state): State<WebState>,
    Path(track_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    extract_user_id(&jar, &state).await?;

    let track = azuki_db::queries::tracks::get_track(&state.db, &track_id).await?;
    let file_path = track
        .file_path
        .ok_or_else(|| ApiError::NotFound("file not available".to_string()))?;

    let resolved = state
        .media_store
        .resolve_path(&file_path)
        .map_err(|_| ApiError::NotFound("file not found".to_string()))?;

    let file = tokio::fs::File::open(&resolved)
        .await
        .map_err(|_| ApiError::NotFound("file not found".to_string()))?;

    let stream = ReaderStream::new(file);
    let body = Body::from_stream(stream);

    let filename = resolved
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("download");

    // Sanitize filename for Content-Disposition
    let safe_name: String = filename
        .chars()
        .filter(|c| *c != '"' && *c != '\r' && *c != '\n')
        .collect();

    Ok((
        [
            (header::CONTENT_TYPE, "application/octet-stream".to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{safe_name}\""),
            ),
        ],
        body,
    ))
}

pub async fn list_uploads(
    jar: CookieJar,
    State(state): State<WebState>,
    Query(params): Query<CursorQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    extract_user_id(&jar, &state).await?;
    let limit = params.limit.unwrap_or(20).clamp(1, 100);

    let before_created_at: Option<String> =
        params.cursor.as_deref().map(decode_cursor).transpose()?;

    let items =
        azuki_db::queries::tracks::list_uploads(&state.db, limit, before_created_at.as_deref())
            .await?;
    let total = azuki_db::queries::tracks::count_uploads(&state.db).await?;

    let next_cursor = if items.len() as i64 == limit {
        items.last().map(|t| encode_cursor(&t.created_at))
    } else {
        None
    };

    Ok(Json(serde_json::json!({
        "items": items,
        "total": total,
        "next_cursor": next_cursor,
    })))
}

#[derive(Deserialize)]
pub struct UpdateTrackRequest {
    pub title: Option<String>,
    pub artist: Option<String>,
}

pub async fn update_track(
    jar: CookieJar,
    State(state): State<WebState>,
    Path(track_id): Path<String>,
    Json(body): Json<UpdateTrackRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let user_id = extract_user_id(&jar, &state).await?;

    if body.title.is_none() && body.artist.is_none() {
        return Err(ApiError::BadRequest("at least one field required".into()));
    }

    // Validate lengths
    if let Some(ref t) = body.title
        && t.len() > 500
    {
        return Err(ApiError::BadRequest("title too long (max 500)".into()));
    }
    if let Some(ref a) = body.artist
        && a.len() > 200
    {
        return Err(ApiError::BadRequest("artist too long (max 200)".into()));
    }

    let track = azuki_db::queries::tracks::get_track(&state.db, &track_id).await?;

    // Only allow editing upload tracks
    if track.source_type != "upload" {
        return Err(ApiError::Forbidden);
    }

    // Ownership check
    if track.uploaded_by.as_deref() != Some(&user_id) {
        return Err(ApiError::Forbidden);
    }

    let updated = azuki_db::queries::tracks::update_track_metadata(
        &state.db,
        &track_id,
        body.title.as_deref(),
        body.artist.as_deref(),
    )
    .await?;

    Ok(Json(serde_json::json!(updated)))
}

pub async fn delete_track(
    jar: CookieJar,
    State(state): State<WebState>,
    Path(track_id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let user_id = extract_user_id(&jar, &state).await?;

    let user = azuki_db::queries::users::get_user(&state.db, &user_id).await?;
    if !user.is_admin {
        return Err(ApiError::Forbidden);
    }

    let track = azuki_db::queries::tracks::get_track(&state.db, &track_id).await?;
    if track.source_type != "upload" {
        return Err(ApiError::BadRequest(
            "only upload tracks can be deleted".into(),
        ));
    }

    // If currently playing this track, skip to next
    let snapshot = state.player.get_state().await;
    let current_track_id = match &snapshot.state {
        azuki_player::PlayStateInfo::Playing { track, .. }
        | azuki_player::PlayStateInfo::Paused { track, .. }
        | azuki_player::PlayStateInfo::Loading { track } => Some(track.id.clone()),
        _ => None,
    };
    if current_track_id.as_deref() == Some(&track_id) {
        let _ = state.player.skip().await;
    }

    let file_path = azuki_db::queries::tracks::delete_track_cascade(&state.db, &track_id).await?;

    if let Some(ref fp) = file_path
        && let Ok(resolved) = state.media_store.resolve_path(fp)
    {
        let _ = tokio::fs::remove_file(resolved).await;
    }

    // Clean up thumbnail if it exists
    let _ = tokio::fs::remove_file(format!("media/thumbnails/{track_id}.jpg")).await;

    Ok(Json(serde_json::json!({ "deleted": true })))
}

// --- oEmbed proxy ---

const OEMBED_ALLOWED_HOSTS: &[&str] = &[
    "youtube.com",
    "www.youtube.com",
    "youtu.be",
    "soundcloud.com",
    "www.soundcloud.com",
];

#[derive(Deserialize)]
pub struct OEmbedQuery {
    pub url: String,
}

pub async fn oembed_proxy(
    jar: CookieJar,
    State(state): State<WebState>,
    Query(params): Query<OEmbedQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    extract_user_id(&jar, &state).await?;

    let parsed_url =
        url::Url::parse(&params.url).map_err(|_| ApiError::BadRequest("invalid URL".into()))?;

    let host = parsed_url.host_str().unwrap_or("");
    if !OEMBED_ALLOWED_HOSTS.contains(&host) {
        return Err(ApiError::BadRequest(
            "URL domain not supported for oEmbed".into(),
        ));
    }

    // Determine provider endpoint
    let oembed_url = if host.contains("youtube") || host == "youtu.be" {
        format!(
            "https://www.youtube.com/oembed?url={}&format=json",
            url::form_urlencoded::byte_serialize(params.url.as_bytes()).collect::<String>()
        )
    } else {
        format!(
            "https://soundcloud.com/oembed?url={}&format=json",
            url::form_urlencoded::byte_serialize(params.url.as_bytes()).collect::<String>()
        )
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    let resp = client
        .get(&oembed_url)
        .send()
        .await
        .map_err(|e| ApiError::Internal(format!("oEmbed fetch failed: {e}")))?;

    if !resp.status().is_success() {
        return Err(ApiError::BadRequest("oEmbed fetch returned error".into()));
    }

    let mut data: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| ApiError::Internal(format!("oEmbed parse failed: {e}")))?;

    // Remove html field for security (XSS prevention)
    if let Some(obj) = data.as_object_mut() {
        obj.remove("html");
    }

    // Validate thumbnail URL scheme
    if let Some(thumb) = data.get("thumbnail_url").and_then(|v| v.as_str())
        && !thumb.starts_with("http://")
        && !thumb.starts_with("https://")
        && let Some(obj) = data.as_object_mut()
    {
        obj.remove("thumbnail_url");
    }

    Ok(Json(data))
}

pub fn content_routes(max_upload_size_mb: u64) -> axum::Router<WebState> {
    let max_bytes = (max_upload_size_mb as usize) * 1024 * 1024;
    axum::Router::new()
        .route("/api/search", axum::routing::get(search))
        .route("/api/history", axum::routing::get(history))
        .route(
            "/api/upload",
            axum::routing::post(upload).layer(DefaultBodyLimit::max(max_bytes)),
        )
        .route("/api/download/{track_id}", axum::routing::get(download))
        .route("/api/uploads", axum::routing::get(list_uploads))
        .route(
            "/api/tracks/{track_id}",
            axum::routing::put(update_track).delete(delete_track),
        )
        .route("/api/oembed", axum::routing::get(oembed_proxy))
}
