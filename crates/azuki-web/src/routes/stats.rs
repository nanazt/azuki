use axum::extract::{Path, State};
use axum::Json;
use axum_extra::extract::CookieJar;

use crate::auth::extract_user_id;
use crate::{ApiError, WebState};

fn track_stat_to_json(s: &azuki_db::queries::history::TrackStat) -> serde_json::Value {
    serde_json::json!({
        "track": {
            "id": s.track_id,
            "title": s.title,
            "artist": s.artist,
            "duration_ms": 0,
            "thumbnail_url": null,
            "source_url": "",
            "source_type": "",
            "file_path": null,
            "youtube_id": null,
        },
        "play_count": s.play_count,
    })
}

pub async fn my_stats(
    jar: CookieJar,
    State(state): State<WebState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let user_id = extract_user_id(&jar, &state).await?;
    let stats = azuki_db::queries::history::get_user_stats(&state.db, &user_id).await?;
    let top = azuki_db::queries::history::get_user_top_tracks(&state.db, &user_id, 10).await?;
    let top_tracks: Vec<serde_json::Value> = top.iter().map(track_stat_to_json).collect();
    Ok(Json(serde_json::json!({
        "total_plays": stats.total_plays,
        "total_time_ms": stats.total_time_ms,
        "top_tracks": top_tracks,
    })))
}

pub async fn server_stats(
    jar: CookieJar,
    State(state): State<WebState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    extract_user_id(&jar, &state).await?;
    let stats = azuki_db::queries::history::get_server_stats(&state.db).await?;
    let top = azuki_db::queries::history::get_top_tracks(&state.db, 10).await?;
    let hourly = azuki_db::queries::history::get_hourly_activity(&state.db).await?;

    let top_tracks: Vec<serde_json::Value> = top.iter().map(track_stat_to_json).collect();

    let mut hourly_activity = vec![0i64; 24];
    for h in &hourly {
        if (0..24).contains(&h.hour) {
            hourly_activity[h.hour as usize] = h.count;
        }
    }

    Ok(Json(serde_json::json!({
        "total_plays": stats.total_plays,
        "total_time_ms": stats.total_time_ms,
        "unique_tracks": stats.unique_tracks,
        "top_tracks": top_tracks,
        "hourly_activity": hourly_activity,
    })))
}

pub async fn track_stats(
    jar: CookieJar,
    State(state): State<WebState>,
    Path(track_id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    extract_user_id(&jar, &state).await?;
    let track = azuki_db::queries::tracks::get_track(&state.db, &track_id).await?;
    Ok(Json(serde_json::json!({
        "track": track,
    })))
}

pub fn stats_routes() -> axum::Router<WebState> {
    axum::Router::new()
        .route("/api/stats/me", axum::routing::get(my_stats))
        .route("/api/stats/server", axum::routing::get(server_stats))
        .route("/api/stats/track/{id}", axum::routing::get(track_stats))
}
