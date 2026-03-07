use axum::Json;
use axum::body::Body;
use axum::extract::{Path, Query, State};
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

    let field = multipart
        .next_field()
        .await
        .map_err(|e| ApiError::BadRequest(e.to_string()))?
        .ok_or_else(|| ApiError::BadRequest("no file provided".to_string()))?;

    let filename = field.file_name().unwrap_or("upload").to_string();
    let data = field
        .bytes()
        .await
        .map_err(|e| ApiError::BadRequest(e.to_string()))?;

    let (track_id, file_path) =
        azuki_media::upload::handle_upload(&state.media_store, &data, &filename).await?;

    let file_path_str = file_path.to_string_lossy().to_string();

    azuki_db::queries::tracks::upsert_track(
        &state.db,
        &track_id,
        &filename,
        None,
        0,
        None,
        &format!("upload://{filename}"),
        "upload",
        Some(&file_path_str),
        None,
    )
    .await?;

    Ok(Json(serde_json::json!({
        "track_id": track_id,
        "filename": filename,
        "added_by": user_id,
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

    Ok((
        [
            (header::CONTENT_TYPE, "application/octet-stream".to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{filename}\""),
            ),
        ],
        body,
    ))
}

pub fn content_routes() -> axum::Router<WebState> {
    axum::Router::new()
        .route("/api/search", axum::routing::get(search))
        .route("/api/history", axum::routing::get(history))
        .route("/api/upload", axum::routing::post(upload))
        .route("/api/download/{track_id}", axum::routing::get(download))
}
