use axum::Json;
use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::header;
use axum::response::IntoResponse;
use axum_extra::extract::CookieJar;
use serde::Deserialize;
use tokio_util::io::ReaderStream;

use crate::auth::extract_user_id;
use crate::{ApiError, WebState};

#[derive(Deserialize)]
pub struct SearchQuery {
    pub q: String,
    pub source: Option<String>,
}

#[derive(Deserialize)]
pub struct PaginationQuery {
    pub page: Option<i64>,
    pub per_page: Option<i64>,
}

pub async fn search(
    jar: CookieJar,
    State(state): State<WebState>,
    Query(params): Query<SearchQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    extract_user_id(&jar, &state).await?;

    let source = params.source.as_deref().unwrap_or("youtube");

    match source {
        "youtube" => {
            let youtube = state.youtube.read().unwrap().clone()
                .ok_or_else(|| ApiError::BadRequest("YouTube API key not configured".to_string()))?;
            let results = youtube.search(&params.q, 10).await?;
            let items: Vec<serde_json::Value> = results
                .into_iter()
                .map(|m| {
                    serde_json::json!({
                        "title": m.title,
                        "artist": m.artist,
                        "duration_ms": m.duration_ms,
                        "thumbnail_url": m.thumbnail_url,
                        "source_url": m.source_url,
                        "youtube_id": m.youtube_id,
                    })
                })
                .collect();
            Ok(Json(serde_json::json!({ "results": items })))
        }
        "history" => {
            let tracks =
                azuki_db::queries::tracks::search_tracks(&state.db, &params.q, 20, 0).await?;
            Ok(Json(serde_json::json!({ "results": tracks })))
        }
        _ => Ok(Json(serde_json::json!({ "results": [] }))),
    }
}

pub async fn history(
    jar: CookieJar,
    State(state): State<WebState>,
    Query(params): Query<PaginationQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    extract_user_id(&jar, &state).await?;
    let page = params.page.unwrap_or(1).max(1);
    let per_page = params.per_page.unwrap_or(20).min(100);
    let offset = (page - 1) * per_page;

    let entries = azuki_db::queries::history::get_history(&state.db, per_page, offset).await?;
    let items: Vec<serde_json::Value> = entries.iter().map(|e| {
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
    }).collect();
    let total = items.len() as i64;
    Ok(Json(serde_json::json!({
        "items": items,
        "total": total,
        "page": page,
        "per_page": per_page,
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

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| ApiError::BadRequest(e.to_string()))?
    {
        field_count += 1;
        if field_count > 5 {
            return Err(ApiError::BadRequest("too many fields".into()));
        }

        match field.name() {
            Some("file") => {
                let filename = field.file_name().unwrap_or("upload").to_string();
                let data = field
                    .bytes()
                    .await
                    .map_err(|e| ApiError::BadRequest(e.to_string()))?;
                file_data = Some((filename, data));
            }
            Some("title") => {
                let val = field.text().await.map_err(|e| ApiError::BadRequest(e.to_string()))?;
                let val = val.trim().to_string();
                if val.len() > 500 {
                    return Err(ApiError::BadRequest("title too long (max 500)".into()));
                }
                if !val.is_empty() {
                    provided_title = Some(val);
                }
            }
            Some("artist") => {
                let val = field.text().await.map_err(|e| ApiError::BadRequest(e.to_string()))?;
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

    let (filename, data) = file_data.ok_or_else(|| ApiError::BadRequest("no file provided".into()))?;

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

    // Parse metadata with lofty
    let parsed = azuki_media::parse_audio_metadata(data.to_vec()).await.ok();

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

    // Sanitize source_url filename (remove control chars)
    let safe_filename: String = filename.chars().filter(|c| !c.is_control()).collect();

    azuki_db::queries::tracks::upsert_track(
        &state.db,
        &track_id,
        &title,
        artist.as_deref(),
        duration_ms,
        None,
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
    Query(params): Query<PaginationQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    extract_user_id(&jar, &state).await?;
    let page = params.page.unwrap_or(1).max(1);
    let per_page = params.per_page.unwrap_or(20).min(100);
    let offset = (page - 1) * per_page;

    let items = azuki_db::queries::tracks::list_uploads(&state.db, per_page, offset).await?;
    let total = azuki_db::queries::tracks::count_uploads(&state.db).await?;

    Ok(Json(serde_json::json!({
        "items": items,
        "total": total,
        "page": page,
        "per_page": per_page,
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

    let parsed_url = url::Url::parse(&params.url)
        .map_err(|_| ApiError::BadRequest("invalid URL".into()))?;

    let host = parsed_url.host_str().unwrap_or("");
    if !OEMBED_ALLOWED_HOSTS.contains(&host) {
        return Err(ApiError::BadRequest("URL domain not supported for oEmbed".into()));
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
        && !thumb.starts_with("http://") && !thumb.starts_with("https://")
        && let Some(obj) = data.as_object_mut()
    {
        obj.remove("thumbnail_url");
    }

    Ok(Json(data))
}

pub fn content_routes() -> axum::Router<WebState> {
    axum::Router::new()
        .route("/api/search", axum::routing::get(search))
        .route("/api/history", axum::routing::get(history))
        .route(
            "/api/upload",
            axum::routing::post(upload)
                .layer(DefaultBodyLimit::max(300 * 1024 * 1024)),
        )
        .route("/api/download/{track_id}", axum::routing::get(download))
        .route("/api/uploads", axum::routing::get(list_uploads))
        .route(
            "/api/tracks/{track_id}",
            axum::routing::put(update_track),
        )
        .route("/api/oembed", axum::routing::get(oembed_proxy))
}
