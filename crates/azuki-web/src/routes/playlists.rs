use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use axum_extra::extract::CookieJar;
use serde::Deserialize;

use crate::auth::extract_user_id;
use crate::{ApiError, WebState};

#[derive(Deserialize)]
pub struct CreatePlaylistRequest {
    pub name: String,
    pub is_shared: Option<bool>,
}

#[derive(Deserialize)]
pub struct RenamePlaylistRequest {
    pub name: String,
}

#[derive(Deserialize)]
pub struct AddTrackRequest {
    pub track_id: String,
}

pub async fn list_playlists(
    jar: CookieJar,
    State(state): State<WebState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let user_id = extract_user_id(&jar, &state).await?;
    let playlists = azuki_db::queries::playlists::list_playlists(&state.db, &user_id).await?;
    Ok(Json(serde_json::json!({ "playlists": playlists })))
}

pub async fn create_playlist(
    jar: CookieJar,
    State(state): State<WebState>,
    Json(body): Json<CreatePlaylistRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let user_id = extract_user_id(&jar, &state).await?;
    let playlist = azuki_db::queries::playlists::create_playlist(
        &state.db,
        &body.name,
        Some(&user_id),
        body.is_shared.unwrap_or(false),
    )
    .await?;
    let _ = state.web_tx.send(crate::events::WebSeqEvent {
        seq: 0,
        event: crate::events::WebEvent::PlaylistUpdated { playlist_id: playlist.id },
    });
    Ok(Json(serde_json::json!({ "playlist": playlist })))
}

pub async fn rename_playlist(
    jar: CookieJar,
    State(state): State<WebState>,
    Path(id): Path<i64>,
    Json(body): Json<RenamePlaylistRequest>,
) -> Result<StatusCode, ApiError> {
    let user_id = extract_user_id(&jar, &state).await?;
    let playlist = azuki_db::queries::playlists::get_playlist(&state.db, id).await?;
    if playlist.owner_id.as_deref() != Some(&user_id) {
        return Err(ApiError::Forbidden);
    }
    azuki_db::queries::playlists::rename_playlist(&state.db, id, &body.name).await?;
    let _ = state.web_tx.send(crate::events::WebSeqEvent {
        seq: 0,
        event: crate::events::WebEvent::PlaylistUpdated { playlist_id: id },
    });
    Ok(StatusCode::OK)
}

pub async fn delete_playlist(
    jar: CookieJar,
    State(state): State<WebState>,
    Path(id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    let user_id = extract_user_id(&jar, &state).await?;
    let playlist = azuki_db::queries::playlists::get_playlist(&state.db, id).await?;
    if playlist.owner_id.as_deref() != Some(&user_id) {
        return Err(ApiError::Forbidden);
    }
    azuki_db::queries::playlists::delete_playlist(&state.db, id).await?;
    let _ = state.web_tx.send(crate::events::WebSeqEvent {
        seq: 0,
        event: crate::events::WebEvent::PlaylistUpdated { playlist_id: id },
    });
    Ok(StatusCode::OK)
}

pub async fn get_tracks(
    jar: CookieJar,
    State(state): State<WebState>,
    Path(id): Path<i64>,
) -> Result<Json<serde_json::Value>, ApiError> {
    extract_user_id(&jar, &state).await?;
    let tracks = azuki_db::queries::playlists::get_playlist_tracks(&state.db, id).await?;
    let items: Vec<serde_json::Value> = tracks.iter().enumerate().map(|(i, t)| {
        serde_json::json!({
            "track": t,
            "position": i,
            "added_by": null,
            "added_at": "",
        })
    }).collect();
    Ok(Json(serde_json::json!({ "tracks": items })))
}

pub async fn add_track(
    jar: CookieJar,
    State(state): State<WebState>,
    Path(id): Path<i64>,
    Json(body): Json<AddTrackRequest>,
) -> Result<StatusCode, ApiError> {
    let user_id = extract_user_id(&jar, &state).await?;
    azuki_db::queries::playlists::add_track_to_playlist(&state.db, id, &body.track_id, Some(&user_id))
        .await?;
    let _ = state.web_tx.send(crate::events::WebSeqEvent {
        seq: 0,
        event: crate::events::WebEvent::PlaylistUpdated { playlist_id: id },
    });
    Ok(StatusCode::OK)
}

pub async fn remove_track(
    jar: CookieJar,
    State(state): State<WebState>,
    Path((id, pos)): Path<(i64, i64)>,
) -> Result<StatusCode, ApiError> {
    extract_user_id(&jar, &state).await?;
    azuki_db::queries::playlists::remove_track_from_playlist(&state.db, id, pos).await?;
    let _ = state.web_tx.send(crate::events::WebSeqEvent {
        seq: 0,
        event: crate::events::WebEvent::PlaylistUpdated { playlist_id: id },
    });
    Ok(StatusCode::OK)
}

pub fn playlist_routes() -> axum::Router<WebState> {
    axum::Router::new()
        .route("/api/playlists", axum::routing::get(list_playlists).post(create_playlist))
        .route(
            "/api/playlists/{id}",
            axum::routing::put(rename_playlist).delete(delete_playlist),
        )
        .route("/api/playlists/{id}/tracks", axum::routing::get(get_tracks).post(add_track))
        .route(
            "/api/playlists/{id}/tracks/{pos}",
            axum::routing::delete(remove_track),
        )
}
