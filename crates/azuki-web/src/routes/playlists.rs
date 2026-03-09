use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use axum_extra::extract::CookieJar;
use serde::Deserialize;

use crate::auth::extract_user_id;
use crate::{ApiError, WebState};

#[derive(Deserialize)]
pub struct ImportPlaylistRequest {
    pub url: String,
}

// (video_id, title, artist, duration_ms, thumbnail_url, is_unavailable)
type PlaylistTrackTuple = (String, String, Option<String>, u64, Option<String>, bool);

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
    if body.name.trim().is_empty() || body.name.len() > 200 {
        return Err(ApiError::BadRequest("playlist name must be 1-200 characters".to_string()));
    }
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
    if body.name.trim().is_empty() || body.name.len() > 200 {
        return Err(ApiError::BadRequest("playlist name must be 1-200 characters".to_string()));
    }
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
    let user_id = extract_user_id(&jar, &state).await?;
    let playlist = azuki_db::queries::playlists::get_playlist(&state.db, id).await?;
    if playlist.owner_id.as_deref() != Some(&user_id) && !playlist.is_shared {
        return Err(ApiError::Forbidden);
    }
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
    let playlist = azuki_db::queries::playlists::get_playlist(&state.db, id).await?;
    if playlist.owner_id.as_deref() != Some(&user_id) && !playlist.is_shared {
        return Err(ApiError::Forbidden);
    }
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
    let user_id = extract_user_id(&jar, &state).await?;
    let playlist = azuki_db::queries::playlists::get_playlist(&state.db, id).await?;
    if playlist.owner_id.as_deref() != Some(&user_id) && !playlist.is_shared {
        return Err(ApiError::Forbidden);
    }
    azuki_db::queries::playlists::remove_track_from_playlist(&state.db, id, pos).await?;
    let _ = state.web_tx.send(crate::events::WebSeqEvent {
        seq: 0,
        event: crate::events::WebEvent::PlaylistUpdated { playlist_id: id },
    });
    Ok(StatusCode::OK)
}

/// POST /api/playlists/import
pub async fn import_playlist(
    jar: CookieJar,
    State(state): State<WebState>,
    Json(body): Json<ImportPlaylistRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let user_id = extract_user_id(&jar, &state).await?;

    // Validate URL is a playlist
    let detected = azuki_media::detect_url(&body.url);
    let (source_kind, source_id_hint) = match &detected {
        azuki_media::DetectedUrl::YoutubePlaylist { playlist_id } => {
            ("youtube", playlist_id.clone())
        }
        _ => return Err(ApiError::BadRequest("Only YouTube playlists are supported".to_string())),
    };

    // Per-user concurrency check
    {
        let mut importing = state.importing_users.lock().await;
        if importing.contains(&user_id) {
            return Err(ApiError::BadRequest("already importing a playlist".to_string()));
        }
        importing.insert(user_id.clone());
    }

    // Global concurrency limit (try_acquire — non-blocking)
    let _permit = match state.import_semaphore.try_acquire() {
        Ok(p) => p,
        Err(_) => {
            state.importing_users.lock().await.remove(&user_id);
            return Err(ApiError::BadRequest("too many concurrent imports".to_string()));
        }
    };

    let result: Result<(azuki_db::models::Playlist, u32, u32), ApiError> = async {
        // Try YouTube API first, then fall back to yt-dlp
        let (title, playlist_id_resolved, entries, unavailable_count) = {
            let yt_client_opt = state.youtube.read().unwrap().clone();
            let yt_result = if let Some(yt_client) = yt_client_opt {
                match yt_client.get_playlist_items(&source_id_hint, 300).await {
                    Ok(items) => match yt_client.get_playlist_meta(&source_id_hint).await {
                        Ok(meta) => {
                            let unavail = items.iter().filter(|i| i.is_unavailable).count() as u32;
                            let converted: Vec<PlaylistTrackTuple> =
                                items.into_iter().map(|i| {
                                    (i.video_id, i.title, i.channel_title, i.duration_ms, i.thumbnail_url, i.is_unavailable)
                                }).collect();
                            Some((meta.title, source_id_hint.clone(), converted, unavail))
                        }
                        Err(_) => None,
                    },
                    Err(_) => None,
                }
            } else {
                None
            };

            if let Some(result) = yt_result {
                result
            } else {
                // yt-dlp fallback
                let (title, pid, flat_entries) =
                    state.ytdlp.get_playlist_metadata(&body.url, 300).await?;
                let unavail = flat_entries.iter().filter(|e| e.is_unavailable).count() as u32;
                let entries: Vec<PlaylistTrackTuple> =
                    flat_entries.into_iter().map(|e| {
                        (
                            e.id,
                            e.title.unwrap_or_default(),
                            e.uploader,
                            e.duration.map(|d| (d * 1000.0) as u64).unwrap_or(0),
                            e.thumbnail,
                            e.is_unavailable,
                        )
                    }).collect();
                (title, pid, entries, unavail)
            }
        };

        // Truncate title to 200 chars
        let title = if title.len() > 200 {
            title[..200].to_string()
        } else {
            title
        };

        // Check for existing playlist with same source
        if let Some(existing) =
            azuki_db::queries::playlists::find_by_source(&state.db, source_kind, &playlist_id_resolved)
                .await?
        {
            return Ok((existing, entries.len() as u32, unavailable_count));
        }

        // Create playlist in DB
        let params = azuki_db::queries::playlists::ExternalPlaylistParams {
            name: &title,
            owner_id: &user_id,
            source_kind,
            source_id: &playlist_id_resolved,
            source_url: &body.url,
            description: None,
            thumbnail_url: None,
            channel_name: None,
            track_count: entries.len() as i64,
        };
        let playlist =
            azuki_db::queries::playlists::create_external_playlist(&state.db, &params).await?;

        // Insert tracks and playlist_tracks
        let mut track_count = 0u32;
        for (video_id, track_title, artist, duration_ms, thumbnail_url, is_unavailable) in &entries {
            if *is_unavailable {
                continue;
            }

            let source_url = if source_kind == "youtube" {
                format!("https://www.youtube.com/watch?v={video_id}")
            } else {
                video_id.clone()
            };

            let track_id = crate::util::sha_id(&source_url);
            let youtube_id = if source_kind == "youtube" {
                Some(video_id.as_str())
            } else {
                None
            };

            azuki_db::queries::tracks::upsert_track(
                &state.db,
                &track_id,
                track_title,
                artist.as_deref(),
                *duration_ms as i64,
                thumbnail_url.as_deref(),
                &source_url,
                source_kind,
                None,
                youtube_id,
                None,
            )
            .await?;

            azuki_db::queries::playlists::add_track_to_playlist(
                &state.db,
                playlist.id,
                &track_id,
                Some(&user_id),
            )
            .await?;

            track_count += 1;
        }

        Ok((playlist, track_count, unavailable_count))
    }
    .await;

    // Remove user from importing set
    state.importing_users.lock().await.remove(&user_id);

    let (playlist, track_count, unavailable_count) = result?;

    let _ = state.web_tx.send(crate::events::WebSeqEvent {
        seq: 0,
        event: crate::events::WebEvent::PlaylistUpdated { playlist_id: playlist.id },
    });

    Ok(Json(serde_json::json!({
        "playlist": playlist,
        "track_count": track_count,
        "unavailable_count": unavailable_count,
    })))
}

/// POST /api/playlists/{id}/play
pub async fn play_playlist(
    jar: CookieJar,
    State(state): State<WebState>,
    Path(id): Path<i64>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let user_id = extract_user_id(&jar, &state).await?;

    // Ownership/share check
    let playlist = azuki_db::queries::playlists::get_playlist(&state.db, id).await?;
    if playlist.owner_id.as_deref() != Some(&user_id) && !playlist.is_shared {
        return Err(ApiError::Forbidden);
    }

    // Load tracks
    let tracks = azuki_db::queries::playlists::get_playlist_tracks(&state.db, id).await?;
    if tracks.is_empty() {
        return Err(ApiError::BadRequest("playlist is empty".to_string()));
    }

    // Get user info for added_by
    let user = azuki_db::queries::users::get_user(&state.db, &user_id).await?;
    let user_info = azuki_player::UserInfo {
        id: user.id,
        username: user.username,
        avatar_url: user.avatar_url,
    };

    // Convert tracks to QueueEntry — first 50 go into queue, rest into overflow
    let all_entries: Vec<azuki_player::QueueEntry> = tracks
        .iter()
        .map(|t| azuki_player::QueueEntry {
            track: azuki_player::TrackInfo {
                id: t.id.clone(),
                title: t.title.clone(),
                artist: t.artist.clone(),
                duration_ms: t.duration_ms as u64,
                thumbnail_url: t.thumbnail_url.clone(),
                source_url: t.source_url.clone(),
                source_type: t.source_type.clone(),
                file_path: t.file_path.clone(),
                youtube_id: t.youtube_id.clone(),
                volume: t.volume as u8,
            },
            added_by: user_info.clone(),
        })
        .collect();

    let total = all_entries.len();
    let (queue_entries, overflow_entries) = if all_entries.len() > 50 {
        let mut it = all_entries.into_iter();
        let queue: Vec<_> = it.by_ref().take(50).collect();
        let overflow: Vec<_> = it.collect();
        (queue, overflow)
    } else {
        (all_entries, Vec::new())
    };

    let slot_id = state
        .player
        .play_playlist(id, queue_entries, overflow_entries, total, user_info)
        .await?;

    Ok(Json(serde_json::json!({ "slot_id": slot_id })))
}

pub fn playlist_routes() -> axum::Router<WebState> {
    axum::Router::new()
        // /api/playlists/import MUST come before /api/playlists/{id} to avoid path conflict
        .route("/api/playlists/import", axum::routing::post(import_playlist))
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
        .route("/api/playlists/{id}/play", axum::routing::post(play_playlist))
}
