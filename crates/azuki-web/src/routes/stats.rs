use crate::auth::extract_user_id;
use crate::routes::content::{CursorQuery, decode_cursor, encode_cursor};
use crate::{ApiError, WebState};
use axum::Json;
use axum::extract::{Path, Query, State};
use axum_extra::extract::CookieJar;

pub async fn stats_overview(
    jar: CookieJar,
    State(state): State<WebState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    extract_user_id(&jar, &state).await?;

    let tz_offset = load_tz_offset(&state.db).await;
    let server = azuki_db::queries::history::get_server_stats(&state.db).await?;
    let streak = azuki_db::queries::history::get_streak(&state.db, &tz_offset).await?;
    let peak_day = azuki_db::queries::history::get_peak_day(&state.db, &tz_offset).await?;
    let heatmap = azuki_db::queries::history::get_heatmap(&state.db, &tz_offset).await?;
    let trend = azuki_db::queries::history::get_trend(&state.db, &tz_offset).await?;
    let dow_rows = azuki_db::queries::history::get_dow_activity(&state.db, &tz_offset).await?;

    // Convert dow rows to 7-element array (Mon=0 .. Sun=6)
    let mut dow_activity = vec![0i64; 7];
    for entry in &dow_rows {
        if (0..7).contains(&entry.dow) {
            dow_activity[entry.dow as usize] = entry.avg_listened_ms;
        }
    }

    Ok(Json(serde_json::json!({
        "total_plays": server.total_plays,
        "total_time_ms": server.total_time_ms,
        "unique_tracks": server.unique_tracks,
        "streak": { "current": streak.current, "max": streak.max },
        "peak_day": peak_day.map(|p| serde_json::json!({ "date": p.date, "play_count": p.play_count })),
        "heatmap": heatmap,
        "trend": trend,
        "dow_activity": dow_activity,
    })))
}

pub async fn top_tracks(
    jar: CookieJar,
    State(state): State<WebState>,
    Query(params): Query<CursorQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    extract_user_id(&jar, &state).await?;
    let limit = params.limit.unwrap_or(20).clamp(1, 100);

    let cursor: Option<(i64, String)> = params.cursor.as_deref().map(decode_cursor).transpose()?;

    if let Some((count, ref id)) = cursor
        && (count < 0 || id.len() > 64)
    {
        return Err(ApiError::BadRequest("invalid cursor values".into()));
    }

    let rows =
        azuki_db::queries::history::get_top_tracks_paginated(&state.db, limit, cursor).await?;

    let next_cursor = if rows.len() as i64 == limit {
        rows.last()
            .map(|r| encode_cursor(&(r.play_count, &r.track_id)))
    } else {
        None
    };

    let items: Vec<serde_json::Value> = rows
        .iter()
        .map(|r| {
            serde_json::json!({
                "track": {
                    "id": r.track_id,
                    "title": r.title,
                    "artist": r.artist,
                    "duration_ms": r.duration_ms,
                    "thumbnail_url": r.thumbnail_url,
                    "source_url": "",
                    "source_type": "",
                    "file_path": null,
                    "youtube_id": null,
                },
                "play_count": r.play_count,
            })
        })
        .collect();

    Ok(Json(serde_json::json!({
        "items": items,
        "next_cursor": next_cursor,
    })))
}

pub async fn top_artists(
    jar: CookieJar,
    State(state): State<WebState>,
    Query(params): Query<CursorQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    extract_user_id(&jar, &state).await?;
    let limit = params.limit.unwrap_or(20).clamp(1, 100);

    let cursor: Option<(i64, String)> = params.cursor.as_deref().map(decode_cursor).transpose()?;

    if let Some((count, ref artist)) = cursor
        && (count < 0 || artist.len() > 64)
    {
        return Err(ApiError::BadRequest("invalid cursor values".into()));
    }

    let rows = azuki_db::queries::history::get_top_artists(&state.db, limit, cursor).await?;

    let next_cursor = if rows.len() as i64 == limit {
        rows.last()
            .map(|r| encode_cursor(&(r.play_count, &r.artist)))
    } else {
        None
    };

    Ok(Json(serde_json::json!({
        "items": rows,
        "next_cursor": next_cursor,
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

async fn load_tz_offset(db: &sqlx::SqlitePool) -> String {
    let tz_name = azuki_db::config::get_config(db, "timezone")
        .await
        .ok()
        .flatten()
        .unwrap_or_else(|| "UTC".to_string());

    let Ok(tz) = tz_name.parse::<chrono_tz::Tz>() else {
        return "+00:00".to_string();
    };

    use chrono::Offset;
    let now = chrono::Utc::now().with_timezone(&tz);
    let offset_secs = now.offset().fix().local_minus_utc();
    let sign = if offset_secs >= 0 { '+' } else { '-' };
    let abs = offset_secs.unsigned_abs();
    let hours = abs / 3600;
    let mins = (abs % 3600) / 60;
    let result = format!("{sign}{hours:02}:{mins:02}");

    // Validate format to prevent SQLite modifier injection
    static RE: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"^[+-]\d{2}:\d{2}$").unwrap());
    if RE.is_match(&result) && hours <= 14 {
        result
    } else {
        "+00:00".to_string()
    }
}

pub fn stats_routes() -> axum::Router<WebState> {
    axum::Router::new()
        .route("/api/stats", axum::routing::get(stats_overview))
        .route("/api/stats/top-tracks", axum::routing::get(top_tracks))
        .route("/api/stats/top-artists", axum::routing::get(top_artists))
        .route("/api/stats/track/{id}", axum::routing::get(track_stats))
}
